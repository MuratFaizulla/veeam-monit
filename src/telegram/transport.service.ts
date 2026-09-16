import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/configuration';
import { TelegramDestination, TelegramKeyboard } from './types';

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** The seam the tests replace: one Bot API call, no retries, no queueing. */
export type TelegramTransportFn = <T>(
  method: string,
  payload: Record<string, unknown>,
) => Promise<TelegramApiResponse<T>>;

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method} -> ${code} ${description}`);
    this.name = 'TelegramApiError';
  }

  /** The topic was deleted or never existed; the cached thread id is stale. */
  get isMissingThread(): boolean {
    return /thread not found|TOPIC_DELETED|topic_deleted/i.test(this.description);
  }

  /** The bot was removed from the chat or blocked; stop addressing it. */
  get isChatGone(): boolean {
    return this.code === 403 || /chat not found/i.test(this.description);
  }

  get isRateLimited(): boolean {
    return this.code === 429;
  }
}

interface QueuedMessage {
  destination: TelegramDestination;
  text: string;
  /** Buttons to hang under it, when the message is an answer worth acting on. */
  markup?: TelegramKeyboard;
  attempts: number;
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

interface ChatQueue {
  items: QueuedMessage[];
  draining: boolean;
  /** Epoch ms before which this chat must not be written to again. */
  nextAt: number;
}

const MAX_ATTEMPTS = 4;

/**
 * Owns every outbound Bot API call.
 *
 * Per-job routing multiplies the message count, and Telegram answers a burst
 * with 429 plus a `retry_after` hint rather than queueing for us. So messages
 * are serialised per chat, spaced by a configurable minimum interval, and a
 * 429 parks that chat's queue for exactly as long as Telegram asked. One slow
 * chat never blocks another because each chat drains independently.
 */
@Injectable()
export class TelegramTransportService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramTransportService.name);
  private readonly config: AppConfig['telegram'];
  private readonly client: AxiosInstance | null;
  private readonly transport: TelegramTransportFn | null;
  private readonly queues = new Map<string, ChatQueue>();
  private stopping = false;
  private dropped = 0;

  constructor(config: ConfigService, transport?: TelegramTransportFn) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.client =
      !transport && this.config.botToken
        ? axios.create({
            baseURL: `https://api.telegram.org/bot${this.config.botToken}`,
            // Long polling holds getUpdates for 25s, so the socket must outlive it.
            timeout: 35000,
            // Bot API failures carry their reason in the body, so the status is
            // inspected by hand instead of being thrown away by axios.
            validateStatus: () => true,
          })
        : null;
    this.transport = transport ?? null;
  }

  onModuleDestroy(): void {
    this.stopping = true;
    for (const queue of this.queues.values()) {
      for (const item of queue.items) item.reject(new Error('Telegram transport is shutting down'));
      queue.items.length = 0;
    }
  }

  get enabled(): boolean {
    return this.transport !== null || this.client !== null;
  }

  /**
   * What is waiting and what was thrown away, as the status endpoint reports
   * it. One getter rather than two: nobody has ever wanted one number without
   * the other, and a queue that is draining is only alarming next to a drop
   * count that is not.
   */
  get queue(): { pending: number; dropped: number } {
    let pending = 0;
    for (const queue of this.queues.values()) pending += queue.items.length;
    return { pending, dropped: this.dropped };
  }

  /** Direct Bot API call, used for everything that is not a chat message. */
  async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.transport) return this.unwrap(method, await this.transport<T>(method, payload));
    if (!this.client) throw new Error('Telegram is not configured');
    const response = await this.client.post<TelegramApiResponse<T>>(`/${method}`, payload);
    return this.unwrap(method, response.data);
  }

  /** Queues a message and resolves with its message_id once Telegram took it. */
  sendMessage(
    destination: TelegramDestination,
    text: string,
    markup?: TelegramKeyboard,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (!this.enabled) {
        reject(new Error('Telegram is not configured'));
        return;
      }
      const queue = this.queueFor(destination.chatId);
      if (queue.items.length >= this.config.queueLimit) {
        // Losing the oldest alert is better than growing without bound while a
        // chat is unreachable; the count surfaces in GET /api/telegram/status.
        queue.items.shift()?.reject(new Error('Telegram queue overflow'));
        this.dropped += 1;
      }
      queue.items.push({ destination, text, markup, attempts: 0, resolve, reject });
      void this.drain(destination.chatId);
    });
  }

  private queueFor(chatId: string): ChatQueue {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = { items: [], draining: false, nextAt: 0 };
      this.queues.set(chatId, queue);
    }
    return queue;
  }

  private async drain(chatId: string): Promise<void> {
    const queue = this.queueFor(chatId);
    if (queue.draining) return;
    queue.draining = true;
    try {
      while (queue.items.length && !this.stopping) {
        const wait = queue.nextAt - Date.now();
        if (wait > 0) await this.sleep(wait);
        const item = queue.items[0];
        try {
          const message = await this.call<{ message_id: number }>('sendMessage', {
            chat_id: item.destination.chatId,
            message_thread_id: item.destination.threadId,
            text: item.text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: item.markup,
          });
          queue.items.shift();
          queue.nextAt = Date.now() + this.config.sendIntervalMs;
          item.resolve(message.message_id);
        } catch (error) {
          if (this.giveUp(queue, item, error)) {
            queue.items.shift();
            item.reject(error as Error);
          }
        }
      }
    } finally {
      queue.draining = false;
    }
  }

  /** Returns true when the message must be given up on and rejected. */
  private giveUp(queue: ChatQueue, item: QueuedMessage, error: unknown): boolean {
    item.attempts += 1;

    if (error instanceof TelegramApiError) {
      if (error.isRateLimited) {
        // Telegram states exactly how long to wait; guessing would only earn
        // another 429. Rate limiting does not count against the attempt budget.
        const pause = (error.retryAfter ?? 5) * 1000;
        item.attempts -= 1;
        queue.nextAt = Date.now() + pause;
        this.logger.warn(
          `Telegram rate limit on chat ${item.destination.chatId}, waiting ${pause}ms`,
        );
        return false;
      }
      // A missing topic, a dead chat or a malformed request cannot be fixed by
      // retrying; the caller decides whether to re-create the topic.
      if (error.isMissingThread || error.isChatGone || error.code === 400) return true;
    }

    if (item.attempts >= MAX_ATTEMPTS) {
      this.logger.error(
        `Telegram message to ${item.destination.chatId} gave up after ${item.attempts} attempts: ${(error as Error).message}`,
      );
      return true;
    }

    queue.nextAt = Date.now() + this.config.sendIntervalMs * 2 ** item.attempts;
    return false;
  }

  private unwrap<T>(method: string, body: TelegramApiResponse<T> | undefined): T {
    if (!body || !body.ok) {
      throw new TelegramApiError(
        method,
        body?.error_code ?? 0,
        // Never log the axios request config: it keeps the bot token in the URL.
        body?.description ?? 'no response body',
        body?.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

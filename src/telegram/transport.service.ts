import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AppConfig } from '../config/configuration';
import { TelegramDestination, TelegramMarkup } from './types';

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/**
 * The seam the tests replace: one Bot API call, no retries, no queueing. It
 * resolves with what came back — Telegram's JSON, or whatever a proxy put in
 * its place — and rejects when nothing did.
 */
export type TelegramTransportFn = <T>(
  method: string,
  payload: Record<string, unknown>,
) => Promise<TelegramApiResponse<T> | unknown>;

/**
 * How one Bot API call ended. Every caller acts on this, and none reads
 * Telegram's codes or wording:
 *
 * - `done`: Telegram did it. An edit that would leave the message as it is
 *   counts — the message already says what was wanted.
 * - `gone`: what the call addressed, a message or a topic, no longer exists.
 * - `refused`: Telegram's own answer that it will not, and asking again
 *   changes nothing — too old, no right, a request it cannot take.
 * - `later`: no answer that counts — a dropped connection, a 5xx, a 429, or a
 *   page that is not Telegram's answer at all. Asking again may work.
 * - `chat-gone`: the bot was removed from the chat, or the chat is not there.
 */
export type TelegramOutcome = 'done' | 'gone' | 'refused' | 'later' | 'chat-gone';

/** What a call came to: its result, or how it did not get one. */
export type TelegramCall<T> =
  | { outcome: 'done'; result: T }
  | { outcome: Exclude<TelegramOutcome, 'done'>; error: TelegramApiError };

/** A call that did not end in `done`: how it ended, and what the log says of it. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly outcome: Exclude<TelegramOutcome, 'done'>,
    reason: string,
    /** Seconds Telegram asked this chat to be left alone for, after a 429. */
    readonly retryAfter?: number,
  ) {
    super(`${method} -> ${reason}`);
    this.name = 'TelegramApiError';
  }
}

/**
 * How a call that threw ended: as the transport said, or `later` for what
 * never reached Telegram — a message dropped from a full queue, or one the
 * stopping service gave up on.
 */
export const outcomeOf = (error: unknown): Exclude<TelegramOutcome, 'done'> =>
  error instanceof TelegramApiError ? error.outcome : 'later';

/** A file to send, by name and contents. */
export interface TelegramFile {
  filename: string;
  content: Buffer;
}

interface QueuedMessage {
  destination: TelegramDestination;
  /** The message, or the caption of `document`. */
  text: string;
  /** Sent as a file, `text` under it, rather than as a message. */
  document?: TelegramFile;
  /** Buttons to hang under it, when the message is an answer worth acting on. */
  markup?: TelegramMarkup;
  /** The message this one answers, shown as a reply. */
  replyTo?: number;
  attempts: number;
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

interface ChatQueue {
  items: QueuedMessage[];
  draining: boolean;
  /** Epoch ms before which the next message is not sent: the spacing, or the backoff after a failure. */
  nextAt: number;
}

const MAX_ATTEMPTS = 4;

/**
 * Owns every outbound Bot API call.
 *
 * Per-job routing multiplies the message count, and Telegram answers a burst
 * with 429 plus a `retry_after` hint rather than queueing for us. So messages
 * are serialised per chat, spaced by a configurable minimum interval, and a
 * 429 — to a message or to any other call — holds every call to that chat for
 * exactly as long as Telegram asked. One slow chat never blocks another
 * because each chat drains independently.
 *
 * It is also the one place that says how a call ended (`TelegramOutcome`):
 * callers act on that, and none of them reads Telegram's codes.
 */
@Injectable()
export class TelegramTransportService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramTransportService.name);
  private readonly config: AppConfig['telegram'];
  private readonly client: AxiosInstance | null;
  private readonly transport: TelegramTransportFn | null;
  private readonly queues = new Map<string, ChatQueue>();
  /** Epoch ms before which a chat is not called at all, as a 429 asked. */
  private readonly held = new Map<string, number>();
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

  /**
   * Direct Bot API call, for a caller that wants the result: throws a
   * `TelegramApiError`, which says how the call ended, when there is none.
   */
  async call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const called = await this.ask<T>(method, payload);
    if (called.outcome !== 'done') throw called.error;
    return called.result;
  }

  /**
   * Direct Bot API call that says how it ended rather than throwing. Never
   * throws.
   *
   * A chat Telegram asked to be left alone (a 429, on any method) is not
   * called again until its `retry_after` has passed: the call waits. Only the
   * queued messages used to, and the live topics' edits and deletes went on
   * at once into the same chat, each earning another 429.
   */
  async ask<T>(method: string, payload: Record<string, unknown> = {}): Promise<TelegramCall<T>> {
    const chatId = payload.chat_id === undefined ? undefined : String(payload.chat_id);
    const wait = chatId === undefined ? 0 : (this.held.get(chatId) ?? 0) - Date.now();
    if (wait > 0) await this.sleep(wait);
    const called = await this.exchange<T>(method, payload);
    if (chatId !== undefined && called.outcome === 'later' && called.error.retryAfter !== undefined) {
      this.hold(chatId, called.error.retryAfter * 1000);
    }
    return called;
  }

  private hold(chatId: string, pause: number): void {
    const until = Date.now() + pause;
    if (until <= (this.held.get(chatId) ?? 0)) return;
    this.held.set(chatId, until);
    this.logger.warn(`Telegram rate limit on chat ${chatId}, holding its calls for ${pause}ms`);
  }

  /** One call, read into how it ended; no waiting, no retries. */
  private async exchange<T>(method: string, payload: Record<string, unknown>): Promise<TelegramCall<T>> {
    let reply: unknown;
    let status: number | undefined;
    try {
      if (this.transport) {
        reply = await this.transport<T>(method, payload);
      } else if (this.client) {
        const response = await this.client.post(`/${method}`, carriesFile(payload) ? formOf(payload) : payload);
        reply = response.data;
        status = response.status;
      } else {
        return { outcome: 'refused', error: new TelegramApiError(method, 'refused', 'Telegram is not configured') };
      }
    } catch (error) {
      // Nothing came back: a dropped connection, a timeout, a name that did
      // not resolve. Its message only: the axios error's config holds the token.
      return { outcome: 'later', error: new TelegramApiError(method, 'later', (error as Error).message) };
    }
    return endOf<T>(method, reply, status);
  }

  /** Queues a message and resolves with its message_id once Telegram took it. */
  sendMessage(
    destination: TelegramDestination,
    text: string,
    markup?: TelegramMarkup,
    replyTo?: number,
  ): Promise<number> {
    return this.enqueue(destination, text, undefined, markup, replyTo);
  }

  /**
   * Queues a file, `caption` under it, behind the chat's messages and spaced
   * like them; resolves with its message_id once Telegram took it.
   */
  sendDocument(
    destination: TelegramDestination,
    document: TelegramFile,
    caption: string,
    markup?: TelegramMarkup,
    replyTo?: number,
  ): Promise<number> {
    return this.enqueue(destination, caption, document, markup, replyTo);
  }

  private enqueue(
    destination: TelegramDestination,
    text: string,
    document: TelegramFile | undefined,
    markup: TelegramMarkup | undefined,
    replyTo: number | undefined,
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
      queue.items.push({ destination, text, document, markup, replyTo, attempts: 0, resolve, reject });
      void this.drain(destination.chatId);
    });
  }

  /**
   * Deletes one message, and says how that ended: `done` once it is gone —
   * gone already counts: deleted by somebody, or with its topic, is what was
   * wanted. `refused` is older than Telegram lets a bot delete, or not the
   * bot's to delete; `later`, a call that got no answer that counts;
   * `chat-gone`, a chat the bot is no longer in. Never throws.
   */
  async deleteMessage(chatId: string, messageId: number): Promise<TelegramCall<true>> {
    const deleted = await this.ask<true>('deleteMessage', { chat_id: chatId, message_id: messageId });
    return deleted.outcome === 'gone' ? { outcome: 'done', result: true } : deleted;
  }

  /**
   * Deletes up to 100 messages in one call, and says how that ended as
   * `deleteMessage` does. Telegram skips the ones already gone, but one it
   * will not delete — too old, or not the bot's — refuses the whole call.
   * Never throws.
   */
  async deleteMessages(chatId: string, messageIds: number[]): Promise<TelegramCall<true>> {
    const deleted = await this.ask<true>('deleteMessages', { chat_id: chatId, message_ids: messageIds });
    return deleted.outcome === 'gone' ? { outcome: 'done', result: true } : deleted;
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
        const common = {
          chat_id: item.destination.chatId,
          message_thread_id: item.destination.threadId,
          parse_mode: 'HTML',
          reply_markup: item.markup,
          // Sent anyway if the message it answers is gone by then.
          reply_parameters:
            item.replyTo === undefined
              ? undefined
              : { message_id: item.replyTo, allow_sending_without_reply: true },
        };
        const sent = item.document
          ? await this.ask<{ message_id: number }>('sendDocument', { ...common, caption: item.text, document: item.document })
          : await this.ask<{ message_id: number }>('sendMessage', { ...common, text: item.text, disable_web_page_preview: true });
        if (sent.outcome === 'done') {
          queue.items.shift();
          queue.nextAt = Date.now() + this.config.sendIntervalMs;
          item.resolve(sent.result.message_id);
        } else if (this.giveUp(queue, item, sent.error)) {
          queue.items.shift();
          item.reject(sent.error);
        }
      }
    } finally {
      queue.draining = false;
    }
  }

  /** Returns true when the message must be given up on and rejected. */
  private giveUp(queue: ChatQueue, item: QueuedMessage, error: TelegramApiError): boolean {
    // A missing topic, a dead chat or a refusal cannot be fixed by retrying;
    // the caller decides whether to re-create the topic.
    if (error.outcome !== 'later') return true;

    // Telegram states exactly how long to wait, and the chat is held for it;
    // guessing would only earn another 429. Rate limiting does not count
    // against the attempt budget.
    if (error.retryAfter !== undefined) return false;

    item.attempts += 1;
    if (item.attempts >= MAX_ATTEMPTS) {
      this.logger.error(
        `Telegram message to ${item.destination.chatId} gave up after ${item.attempts} attempts: ${error.message}`,
      );
      return true;
    }

    queue.nextAt = Date.now() + this.config.sendIntervalMs * 2 ** item.attempts;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

/**
 * How a call ended, from what came back. The one reading of Telegram's codes
 * and wording in the service.
 *
 * Only Telegram's own JSON with a 4xx is a refusal. The client takes any HTTP
 * status, so that a refusal's reason is read from its body; a proxy's error
 * page then arrives where the JSON should be, with no code at all, and used
 * to be read as code 0 — which the live module took for a refusal, writing
 * off a message it should have deleted on a later pass.
 */
const endOf = <T>(method: string, reply: unknown, status?: number): TelegramCall<T> => {
  const failed = (outcome: Exclude<TelegramOutcome, 'done'>, reason: string, retryAfter?: number): TelegramCall<T> =>
    ({ outcome, error: new TelegramApiError(method, outcome, reason, retryAfter) });
  if (typeof reply !== 'object' || reply === null || typeof (reply as TelegramApiResponse<T>).ok !== 'boolean') {
    // The page itself is not worth a log line, and may be a long one.
    return failed('later', `${status === undefined ? '' : `HTTP ${status}, `}not a Bot API answer`);
  }
  const answer = reply as TelegramApiResponse<T>;
  if (answer.ok) return { outcome: 'done', result: answer.result as T };

  const code = answer.error_code;
  const description = answer.description ?? '';
  const reason = `${code ?? 'no code'} ${description}`.trim();
  // Telegram states how long to wait; the transport holds the chat for it.
  if (code === 429) return failed('later', reason, answer.parameters?.retry_after ?? 5);
  if (code === undefined || code < 400 || code >= 500) return failed('later', reason);
  // Refused, but the message already says what the edit wanted it to: for a
  // caller that asked for a state rather than a change, this is success.
  if (/message is not modified/i.test(description)) return { outcome: 'done', result: true as T };
  if (/message to (edit|delete) not found|thread not found|TOPIC_DELETED/i.test(description)) return failed('gone', reason);
  if (code === 403 || /chat not found/i.test(description)) return failed('chat-gone', reason);
  return failed('refused', reason);
};

const isFile = (value: unknown): value is TelegramFile =>
  typeof value === 'object' && value !== null && Buffer.isBuffer((value as TelegramFile).content);

const carriesFile = (payload: Record<string, unknown>): boolean => Object.values(payload).some(isFile);

/**
 * A call that uploads a file goes as multipart form data, the only way the
 * Bot API takes one: the file as a part of its own, every object field as
 * JSON, everything else as text.
 */
const formOf = (payload: Record<string, unknown>): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (isFile(value)) form.append(key, new Blob([value.content]), value.filename);
    else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
};

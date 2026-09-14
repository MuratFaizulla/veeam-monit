import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml, renderEvent } from './telegram.format';
import { TelegramRoutingService } from './telegram-routing.service';
import { TelegramStateStore } from './telegram-state.store';
import { TelegramApiError, TelegramTransportService } from './telegram-transport.service';
import { TelegramTopicsService } from './telegram-topics.service';
import {
  NotificationEvent,
  TelegramChat,
  TelegramDestination,
  TelegramUpdate,
} from './telegram.types';

/**
 * Why an event did or did not reach Telegram. Every non-delivery used to
 * collapse into `skipped: true`, which made "the alert never arrived" an
 * unanswerable question without reading four modules.
 */
export type DeliveryOutcome =
  | 'delivered'
  /** A rule in the routes file matched and asked for silence. */
  | 'dropped-by-rule'
  /** TELEGRAM_SEVERITIES excludes this severity. */
  | 'severity-filtered'
  /** The same condition was reported recently and is still inside its window. */
  | 'cooldown'
  /** No bot token, so there is nowhere to send. */
  | 'transport-disabled'
  /** The bot belongs to no chat yet. */
  | 'no-chats'
  /** Delivery was attempted against every chat and none accepted it. */
  | 'failed';

export interface DeliveryReport {
  outcome: DeliveryOutcome;
  sent: number;
  failed: number;
  /** True when nothing was attempted, as opposed to attempted and rejected. */
  skipped: boolean;
  topic: string | null;
  /** Which part of the routing configuration chose the topic. */
  reason: string;
}

const NOT_ATTEMPTED: DeliveryOutcome[] = [
  'dropped-by-rule',
  'severity-filtered',
  'cooldown',
  'transport-disabled',
  'no-chats',
];

/**
 * Entry point for every notification. It owns the chat registry and the update
 * stream, and turns a NotificationEvent into one message per target chat,
 * addressed to the topic the routing layer picked.
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly config: AppConfig['telegram'];
  private polling = false;
  private stopping = false;
  private updateOffset = 0;

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly routing: TelegramRoutingService,
    private readonly store: TelegramStateStore,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    for (const id of this.config.chatIds) {
      // A configured chat is usable before any update arrives; onModuleInit
      // then fills in the title and, crucially, whether it is a forum.
      this.store.seedChat(id, { id: Number(id), type: 'supergroup' });
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.transport.enabled) {
      this.logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN is empty');
      return;
    }
    await Promise.all(this.store.chats().map(([id]) => this.refreshChat(id)));

    if (this.config.webhookUrl) {
      await this.configureWebhook();
    } else {
      await this.startPolling();
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.polling = false;
  }

  get enabled(): boolean {
    return this.transport.enabled;
  }

  get webhookConfigured(): boolean {
    return Boolean(this.config.webhookUrl);
  }

  get pollingEnabled(): boolean {
    return this.polling;
  }

  get pendingMessages(): number {
    return this.transport.pending;
  }

  get droppedMessages(): number {
    return this.transport.droppedCount;
  }

  acceptsWebhookSecret(value: string | undefined): boolean {
    return Boolean(this.config.webhookSecret) && value === this.config.webhookSecret;
  }

  acceptsAdminKey(value: string | undefined): boolean {
    return Boolean(this.config.adminKey) && value === this.config.adminKey;
  }

  listChats(): Array<TelegramChat & { topics: Record<string, number> }> {
    return this.store.chats().map(([id, chat]) => ({
      ...chat,
      topics: this.topics.list(id),
    }));
  }

  /**
   * Routes one event and delivers it to every chat it belongs in.
   *
   * Delivery failures are reported, never thrown: a broken chat must not abort
   * the monitor cycle that produced the event.
   */
  async notify(event: NotificationEvent): Promise<DeliveryReport> {
    const decision = this.routing.route(event);
    const report = (outcome: DeliveryOutcome, sent = 0, failed = 0): DeliveryReport => ({
      outcome,
      sent,
      failed,
      skipped: NOT_ATTEMPTED.includes(outcome),
      topic: decision.topic,
      reason: decision.reason,
    });

    if (decision.drop === true) return report('dropped-by-rule');
    if (!this.config.severities.includes(event.severity)) return report('severity-filtered');
    if (this.store.isSuppressed(event.dedupeKey)) return report('cooldown');
    if (!this.transport.enabled) return report('transport-disabled');

    const text = renderEvent(event);
    const chats = this.store
      .chats()
      .filter(([id]) => !decision.chatId || decision.chatId === id);
    if (chats.length === 0) return report('no-chats');

    let sent = 0;
    let failed = 0;
    for (const [id, chat] of chats) {
      try {
        await this.deliver(chat, decision.topic, text);
        sent += 1;
      } catch (error) {
        failed += 1;
        this.onDeliveryFailure(id, error);
      }
    }

    if (sent === 0) return report('failed', 0, failed);
    // Only a delivered report starts the quiet period. Arming on the way in
    // would silence the next window after a send that never happened.
    this.store.armCooldown(event.dedupeKey, event.cooldownMs);
    return report('delivered', sent, failed);
  }

  /**
   * Sends to the resolved topic, and retries once in General if the topic
   * turned out to be gone — somebody deleting a topic in the group must not
   * silently stop the alerts that were routed to it.
   */
  private async deliver(chat: TelegramChat, topic: string | null, text: string): Promise<void> {
    const destination = await this.topics.destination(chat, topic);
    try {
      await this.transport.sendMessage(destination, text);
    } catch (error) {
      if (!(error instanceof TelegramApiError) || !error.isMissingThread) throw error;
      this.topics.forget(destination.chatId, destination.topic);
      const retry = await this.topics.destination(chat, topic);
      await this.transport.sendMessage(
        retry.threadId === destination.threadId ? { chatId: destination.chatId } : retry,
        text,
      );
    }
  }

  private onDeliveryFailure(chatId: string, error: unknown): void {
    if (error instanceof TelegramApiError && error.isChatGone) {
      this.store.dropChat(chatId);
      this.logger.warn(`Telegram chat ${chatId} is no longer reachable and was unregistered`);
      return;
    }
    this.logger.error(`Telegram send failed for chat ${chatId}: ${(error as Error).message}`);
  }

  /** Free-form announcement, used by POST /api/telegram/notify. */
  async broadcast(text: string): Promise<DeliveryReport> {
    return this.notify({ kind: 'manual', severity: 'info', title: text });
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chat = message?.chat ?? update.my_chat_member?.chat;
    if (!chat) return;
    this.registerChat(chat);

    // The Bot API cannot enumerate forum topics, so a topic the bot did not
    // create is only ever learned from a message that mentions it.
    if (message?.forum_topic_created && message.message_thread_id) {
      this.topics.remember(
        String(chat.id),
        message.forum_topic_created.name,
        message.message_thread_id,
      );
    }

    const command = message?.text?.trim().toLowerCase().split(/[\s@]/)[0];
    if (!command?.startsWith('/')) return;
    const reply: TelegramDestination = {
      chatId: String(chat.id),
      threadId: message?.is_topic_message ? message.message_thread_id : undefined,
    };
    await this.respond(command, chat, reply);
  }

  private async respond(
    command: string,
    chat: TelegramChat,
    reply: TelegramDestination,
  ): Promise<void> {
    const lines: string[] = [];
    if (command === '/start' || command === '/status' || command === '/chatid') {
      lines.push(
        '<b>Veeam Monitor</b>',
        `<b>Chat ID:</b> <code>${escapeHtml(chat.id)}</code>`,
        `<b>Форум:</b> ${chat.is_forum ? 'да' : 'нет'}`,
        `<b>Топик:</b> <code>${escapeHtml(reply.threadId ?? 'General')}</code>`,
        `<b>Маршрутизация:</b> ${escapeHtml(this.config.routingMode)}`,
      );
    } else if (command === '/topics') {
      const known = this.topics.list(String(chat.id));
      lines.push('<b>Известные топики</b>');
      for (const [name, threadId] of Object.entries(known)) {
        lines.push(`${escapeHtml(name)} — <code>${threadId}</code>`);
      }
      if (Object.keys(known).length === 0) lines.push('пока ни одного');
    } else {
      return;
    }

    try {
      await this.transport.sendMessage(reply, lines.join('\n'));
    } catch (error) {
      this.logger.error(`Telegram reply failed: ${(error as Error).message}`);
    }
  }

  private registerChat(chat: TelegramChat): void {
    const { becameForum } = this.store.mergeChat(chat);
    if (becameForum) this.topics.unblock();
  }

  /** Learns title and forum flag for chats that were configured, not discovered. */
  private async refreshChat(chatId: string): Promise<void> {
    try {
      const chat = await this.transport.call<TelegramChat>('getChat', { chat_id: chatId });
      this.registerChat(chat);
      this.logger.log(
        `Telegram chat ${chatId} "${chat.title ?? ''}" forum=${chat.is_forum === true}`,
      );
    } catch (error) {
      this.logger.warn(`Telegram chat ${chatId} could not be inspected: ${(error as Error).message}`);
    }
  }

  private async configureWebhook(): Promise<void> {
    try {
      const webhook = new URL(this.config.webhookUrl);
      if (webhook.protocol !== 'https:' || !webhook.hostname.includes('.')) {
        throw new Error('TELEGRAM_WEBHOOK_URL must be a public HTTPS origin');
      }
      await this.transport.call('setWebhook', {
        url: `${this.config.webhookUrl}/api/telegram/webhook`,
        secret_token: this.config.webhookSecret || undefined,
        allowed_updates: ['message', 'my_chat_member'],
      });
      this.logger.log('Telegram webhook configured');
    } catch (error) {
      this.logger.error(`Telegram webhook was not configured: ${(error as Error).message}`);
    }
  }

  private async startPolling(): Promise<void> {
    try {
      // getUpdates and webhooks are mutually exclusive. Removing a stale
      // webhook makes local, domain-free operation deterministic.
      await this.transport.call('deleteWebhook', { drop_pending_updates: false });
      this.polling = true;
      this.logger.log('Telegram long polling enabled (no public domain required)');
      void this.pollUpdates();
    } catch (error) {
      this.logger.error(`Telegram polling could not start: ${(error as Error).message}`);
    }
  }

  private async pollUpdates(): Promise<void> {
    while (!this.stopping) {
      try {
        const updates = await this.transport.call<TelegramUpdate[]>('getUpdates', {
          offset: this.updateOffset,
          timeout: 25,
          allowed_updates: ['message', 'my_chat_member'],
        });
        for (const update of updates ?? []) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopping) return;
        this.logger.error(`Telegram polling error: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
}

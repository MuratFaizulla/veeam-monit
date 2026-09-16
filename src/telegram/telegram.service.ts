import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { renderEvent } from './format';
import { TelegramRoutingService } from './routing.service';
import { TelegramStateStore } from './state.store';
import { TelegramApiError, TelegramTransportService } from './transport.service';
import { TelegramTopicsService } from './topics.service';
import { NotificationEvent, TelegramChat } from './types';

/**
 * Why an event did or did not reach Telegram. Every non-delivery used to
 * collapse into `skipped: true`, which made "the alert never arrived" an
 * unanswerable question without reading four modules.
 */
export const DELIVERY_OUTCOMES = [
  'delivered',
  /** A rule in the routes file matched and asked for silence. */
  'dropped-by-rule',
  /** TELEGRAM_SEVERITIES excludes this severity. */
  'severity-filtered',
  /** The same condition was reported recently and is still inside its window. */
  'cooldown',
  /** No bot token, so there is nowhere to send. */
  'transport-disabled',
  /** The bot belongs to no chat yet. */
  'no-chats',
  /** Delivery was attempted against every chat and none accepted it. */
  'failed',
] as const;

/** The list above is the definition, so the published API documents exactly it. */
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

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
 * Delivery: an event goes in, and a report of what became of it comes out.
 *
 * One method wide on purpose. Routing, severity filtering, the cooldown, the
 * fan-out across chats, the retry in General and the eviction of a chat that
 * kicked the bot are all behind `notify`, so a caller that has an event to
 * report needs to know nothing else — and `DeliveryReport` is how it finds out
 * what happened without reading the log.
 *
 * Hearing from Telegram is a different question with a different answer, and
 * lives in TelegramUpdatesService.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly routing: TelegramRoutingService,
    private readonly store: TelegramStateStore,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  get enabled(): boolean {
    return this.transport.enabled;
  }

  listChats(): Array<TelegramChat & { topics: Record<string, number> }> {
    return this.store.chats().map(([id, chat]) => ({
      ...chat,
      topics: this.topics.list(id),
    }));
  }

  /** How far this bot can currently deliver: is it armed, and to how many places. */
  get reach(): { enabled: boolean; chats: number; topics: number; queue: { pending: number; dropped: number } } {
    const chats = this.listChats();
    return {
      enabled: this.transport.enabled,
      chats: chats.length,
      topics: chats.reduce((total, chat) => total + Object.keys(chat.topics).length, 0),
      queue: this.transport.queue,
    };
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
        // Sends to the resolved topic, and retries once in General if the topic
        // turned out to be gone — somebody deleting a topic in the group must
        // not silently stop the alerts that were routed to it.
        await this.topics.send(chat, decision.topic, text);
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

  private onDeliveryFailure(chatId: string, error: unknown): void {
    if (error instanceof TelegramApiError && error.isChatGone) {
      this.store.dropChat(chatId);
      this.logger.warn(`Telegram chat ${chatId} is no longer reachable and was unregistered`);
      return;
    }
    this.logger.error(`Telegram send failed for chat ${chatId}: ${(error as Error).message}`);
  }
}

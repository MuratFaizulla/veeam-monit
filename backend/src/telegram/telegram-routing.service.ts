import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { AppConfig } from '../config/configuration';
import { topicName } from './telegram.format';
import {
  NotificationEvent,
  TelegramRouteRule,
  TelegramRoutesFile,
} from './telegram.types';

export interface RoutingDecision {
  /** Topic name, or null for the General topic. */
  topic: string | null;
  /** Restricts the event to a single chat when a rule asked for it. */
  chatId?: string;
  drop?: boolean;
  /** Which part of the configuration produced this decision. */
  reason: string;
}

/**
 * Decides which forum topic an event belongs in.
 *
 * Two layers, in order: an optional rules file for installation-specific
 * routing ("everything matching ^SQL- goes to the DBA topic"), then the
 * configured strategy. Keeping the strategy declarative means adding a Veeam
 * job never requires a code change or a restart — the topic is created on the
 * first event that needs it.
 */
@Injectable()
export class TelegramRoutingService {
  private readonly logger = new Logger(TelegramRoutingService.name);
  private readonly config: AppConfig['telegram'];
  private rules: TelegramRouteRule[] = [];

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.reload();
  }

  /** Re-reads TELEGRAM_ROUTES_FILE. Returns the number of active rules. */
  reload(): number {
    if (!this.config.routesFile) {
      this.rules = [];
      return 0;
    }
    try {
      const parsed = JSON.parse(
        readFileSync(this.config.routesFile, 'utf8'),
      ) as TelegramRoutesFile;
      this.rules = Array.isArray(parsed.routes) ? parsed.routes : [];
      this.logger.log(`Loaded ${this.rules.length} Telegram route(s) from ${this.config.routesFile}`);
    } catch (error) {
      // Bad routing rules must not take notifications down: the built-in
      // strategy still delivers everything, just without the overrides.
      this.rules = [];
      this.logger.error(
        `Telegram routes file ${this.config.routesFile} was not applied: ${(error as Error).message}`,
      );
    }
    return this.rules.length;
  }

  get activeRules(): TelegramRouteRule[] {
    return this.rules;
  }

  route(event: NotificationEvent): RoutingDecision {
    for (const [index, rule] of this.rules.entries()) {
      if (!this.matches(rule, event)) continue;
      if (rule.drop) return { topic: null, drop: true, reason: `rule #${index + 1} (drop)` };
      return {
        topic: rule.topic ? topicName(rule.topic) : null,
        chatId: rule.chatId,
        reason: `rule #${index + 1}`,
      };
    }
    return this.byStrategy(event);
  }

  private byStrategy(event: NotificationEvent): RoutingDecision {
    const mode = this.config.routingMode;
    if (mode === 'single') return { topic: null, reason: 'mode=single' };
    if (mode === 'severity') {
      return { topic: this.severityTopic(event), reason: 'mode=severity' };
    }
    if (mode === 'job' && event.kind === 'job' && event.subject) {
      return {
        topic: topicName(`${this.config.jobTopicPrefix}${event.subject}`),
        reason: 'mode=job',
      };
    }
    // Everything that is not a single job — reachability, repository capacity,
    // digests — shares one topic per category rather than flooding job threads.
    const kindTopic = this.config.kindTopics[event.kind];
    return {
      topic: kindTopic ? topicName(kindTopic) : this.severityTopic(event),
      reason: `mode=${mode} kind=${event.kind}`,
    };
  }

  private severityTopic(event: NotificationEvent): string | null {
    const topic = this.config.severityTopics[event.severity];
    return topic ? topicName(topic) : null;
  }

  private matches(rule: TelegramRouteRule, event: NotificationEvent): boolean {
    const match = rule.match;
    if (!match) return true;
    if (match.kind && !this.oneOf(match.kind, event.kind)) return false;
    if (match.severity && !this.oneOf(match.severity, event.severity)) return false;
    if (match.subject) {
      try {
        if (!new RegExp(match.subject, 'i').test(event.subject ?? '')) return false;
      } catch {
        // An invalid pattern matches nothing rather than throwing mid-alert.
        return false;
      }
    }
    return true;
  }

  private oneOf<T extends string>(expected: T | T[], actual: T): boolean {
    return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
  }
}

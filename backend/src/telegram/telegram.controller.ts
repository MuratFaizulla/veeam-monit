import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { TelegramMonitorService } from './telegram-monitor.service';
import { TelegramRoutingService } from './telegram-routing.service';
import { TelegramService } from './telegram.service';
import { TelegramUpdatesService } from './telegram-updates.service';
import {
  TelegramAdminGuard,
  TelegramEnabledGuard,
  TelegramWebhookGuard,
} from './telegram-access.guard';
import { announcement, ManualEvent, probe } from './telegram-manual-event';
import { DeliveryReport } from './telegram.service';
import { TelegramUpdate } from './telegram.types';

/**
 * HTTP in, JSON out. Every endpoint here is a shape and an access rule; the
 * decisions behind them belong to the modules above, so that nothing this file
 * knows can only be tested by standing up a web server.
 */
@Controller('telegram')
export class TelegramController {
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly telegram: TelegramService,
    private readonly updates: TelegramUpdatesService,
    private readonly routing: TelegramRoutingService,
    private readonly monitor: TelegramMonitorService,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  @Get('status')
  status() {
    const reach = this.telegram.reach;
    return {
      enabled: reach.enabled,
      mode: this.updates.mode,
      webhookConfigured: this.updates.webhookConfigured,
      routingMode: this.config.routingMode,
      discoveredChats: reach.chats,
      knownTopics: reach.topics,
      queue: reach.queue,
      monitor: this.monitor.status,
    };
  }

  @Post('webhook')
  @UseGuards(TelegramWebhookGuard)
  async webhook(@Body() update: TelegramUpdate): Promise<{ ok: true }> {
    await this.updates.handleUpdate(update);
    return { ok: true };
  }

  @Get('chats')
  @UseGuards(TelegramAdminGuard)
  chats() {
    return { chats: this.telegram.listChats() };
  }

  /** The effective routing table, so an operator can see where an alert will land. */
  @Get('routes')
  @UseGuards(TelegramAdminGuard)
  routes() {
    return {
      mode: this.config.routingMode,
      jobTopicPrefix: this.config.jobTopicPrefix,
      severityTopics: this.config.severityTopics,
      kindTopics: this.config.kindTopics,
      severities: this.config.severities,
      createTopics: this.config.createTopics,
      rulesFile: this.config.routesFile || null,
      rules: this.routing.activeRules,
    };
  }

  /** Picks up edits to TELEGRAM_ROUTES_FILE without a restart. */
  @Post('routes/reload')
  @UseGuards(TelegramAdminGuard)
  reload() {
    return { rules: this.routing.reload() };
  }

  @Post('notify')
  @UseGuards(TelegramAdminGuard, TelegramEnabledGuard)
  async notify(@Body() body: { text?: string }): Promise<DeliveryReport> {
    return this.telegram.notify(this.accepted(announcement(body.text)));
  }

  /**
   * Sends a synthetic event through the real routing path. This is how a
   * deployment is verified end to end — including topic creation — without
   * waiting for a job to actually fail.
   */
  @Post('test')
  @UseGuards(TelegramAdminGuard, TelegramEnabledGuard)
  async test(
    @Body()
    body: { kind?: string; severity?: string; subject?: string; title?: string; body?: string },
  ): Promise<DeliveryReport> {
    return this.telegram.notify(this.accepted(probe(body)));
  }

  /**
   * Runs one monitor pass immediately instead of waiting for the timer.
   *
   * `ran` says whether this request actually caused a pass. A cycle already in
   * flight is declined rather than queued, and the status below it then belongs
   * to that other cycle — which used to be indistinguishable from a pass this
   * request had just completed.
   */
  @Post('check')
  @UseGuards(TelegramAdminGuard)
  async check() {
    const ran = (await this.monitor.check()) === 'ran';
    return { ran, ...this.monitor.status };
  }

  private accepted(built: ManualEvent) {
    if (!built.ok) throw new BadRequestException(built.message);
    return built.event;
  }
}

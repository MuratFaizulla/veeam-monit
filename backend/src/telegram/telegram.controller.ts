import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { TelegramMonitorService } from './telegram-monitor.service';
import { TelegramRoutingService } from './telegram-routing.service';
import { TelegramService } from './telegram.service';
import { NotificationEvent, NotificationKind, NotificationSeverity, TelegramUpdate } from './telegram.types';

const KINDS: NotificationKind[] = [
  'job',
  'infrastructure',
  'repository',
  'security',
  'digest',
  'manual',
];
const SEVERITIES: NotificationSeverity[] = ['critical', 'warning', 'success', 'info'];

@Controller('telegram')
export class TelegramController {
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly telegram: TelegramService,
    private readonly routing: TelegramRoutingService,
    private readonly monitor: TelegramMonitorService,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  @Get('status')
  status() {
    return {
      enabled: this.telegram.enabled,
      mode: !this.telegram.enabled
        ? 'disabled'
        : this.telegram.pollingEnabled
          ? 'polling'
          : 'webhook',
      webhookConfigured: this.telegram.webhookConfigured,
      routingMode: this.config.routingMode,
      discoveredChats: this.telegram.listChats().length,
      knownTopics: this.telegram
        .listChats()
        .reduce((total, chat) => total + Object.keys(chat.topics).length, 0),
      queue: { pending: this.telegram.pendingMessages, dropped: this.telegram.droppedMessages },
      monitor: this.monitor.status,
    };
  }

  @Post('webhook')
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true }> {
    if (!this.telegram.acceptsWebhookSecret(secret)) throw new ForbiddenException();
    await this.telegram.handleUpdate(update);
    return { ok: true };
  }

  @Get('chats')
  chats(@Headers('x-telegram-admin-key') key: string | undefined) {
    this.assertAdmin(key);
    return { chats: this.telegram.listChats() };
  }

  /** The effective routing table, so an operator can see where an alert will land. */
  @Get('routes')
  routes(@Headers('x-telegram-admin-key') key: string | undefined) {
    this.assertAdmin(key);
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
  reload(@Headers('x-telegram-admin-key') key: string | undefined) {
    this.assertAdmin(key);
    return { rules: this.routing.reload() };
  }

  @Post('notify')
  async notify(
    @Headers('x-telegram-admin-key') key: string | undefined,
    @Body() body: { text?: string },
  ) {
    this.assertAdmin(key);
    this.assertEnabled();
    const text = body.text?.trim();
    if (!text) throw new BadRequestException('text is required');
    return this.telegram.broadcast(text);
  }

  /**
   * Sends a synthetic event through the real routing path. This is how a
   * deployment is verified end to end — including topic creation — without
   * waiting for a job to actually fail.
   */
  @Post('test')
  async test(
    @Headers('x-telegram-admin-key') key: string | undefined,
    @Body()
    body: { kind?: string; severity?: string; subject?: string; title?: string; body?: string },
  ) {
    this.assertAdmin(key);
    this.assertEnabled();
    const kind = (body.kind ?? 'job') as NotificationKind;
    const severity = (body.severity ?? 'info') as NotificationSeverity;
    if (!KINDS.includes(kind)) throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
    if (!SEVERITIES.includes(severity)) {
      throw new BadRequestException(`severity must be one of ${SEVERITIES.join(', ')}`);
    }

    const event: NotificationEvent = {
      kind,
      severity,
      subject: body.subject,
      title: body.title ?? 'Проверка маршрутизации Veeam Monitor',
      fields: [
        ['Категория', kind],
        ['Важность', severity],
        ['Объект', body.subject ?? '—'],
      ],
      body: body.body,
    };
    return this.telegram.notify(event);
  }

  /** Runs one monitor pass immediately instead of waiting for the timer. */
  @Post('check')
  async check(@Headers('x-telegram-admin-key') key: string | undefined) {
    this.assertAdmin(key);
    await this.monitor.check();
    return this.monitor.status;
  }

  private assertAdmin(key: string | undefined): void {
    if (!this.telegram.acceptsAdminKey(key)) throw new ForbiddenException();
  }

  private assertEnabled(): void {
    if (!this.telegram.enabled) throw new ServiceUnavailableException('Telegram is not configured');
  }
}

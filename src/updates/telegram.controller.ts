import { BadRequestException, Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppConfig } from '../config/configuration';
import { MONITOR, Monitor } from '../monitor/monitor';
import { TelegramRoutingService } from '../telegram/routing.service';
import { DELIVERY_OUTCOMES, DeliveryReport, TelegramService } from '../telegram/telegram.service';
import { TelegramUpdatesService } from './updates.service';
import {
  TelegramAdminGuard,
  TelegramEnabledGuard,
  TelegramWebhookGuard,
} from './access.guard';
import { announcement, ManualEvent, probe } from './manual-event';
import { AnnouncementBody, ProbeBody } from './dto';
import { TelegramUpdate } from '../telegram/types';

/** Shape of what `notify` reports back, for the published document. */
const DELIVERY_REPORT = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: [...DELIVERY_OUTCOMES],
      description: 'Что стало с событием. «Не доставлено» — это пять разных причин.',
    },
    sent: { type: 'integer', description: 'В скольких чатах сообщение принято.' },
    failed: { type: 'integer', description: 'В скольких чатах отправка сорвалась.' },
    skipped: { type: 'boolean', description: 'true — отправку не пробовали вовсе.' },
    topic: { type: 'string', nullable: true, description: 'Выбранная тема, null — General.' },
    reason: { type: 'string', description: 'Какое правило маршрутизации выбрало тему.' },
  },
};

/**
 * HTTP in, JSON out. Every endpoint here is a shape and an access rule; the
 * decisions behind them belong to the modules above, so that nothing this file
 * knows can only be tested by standing up a web server.
 */
@ApiTags('telegram')
@Controller('telegram')
export class TelegramController {
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly telegram: TelegramService,
    private readonly updates: TelegramUpdatesService,
    private readonly routing: TelegramRoutingService,
    @Inject(MONITOR) private readonly monitor: Monitor,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  @Get('status')
  @UseGuards(TelegramAdminGuard)
  @ApiSecurity('adminKey')
  @ApiOperation({
    summary: 'Готовность интеграции и здоровье монитора',
    description:
      'Открыт без ключа: это проба, по которой судят, жив ли мониторинг.\n\n' +
      '`mode` — чем бот действительно принимает обновления: `polling`, `webhook`,' +
      ' `disabled` (нет токена) или `starting` (токен есть, но ни один способ ещё не' +
      ' поднялся — например, запуск long polling не удался).\n\n' +
      '`monitor` — выбранный сервер Veeam, `servers` — все серверы и их состояние.',
  })
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
      servers: this.monitor.servers(),
    };
  }

  @Post('webhook')
  @UseGuards(TelegramWebhookGuard)
  @ApiSecurity('webhookSecret')
  @ApiOperation({
    summary: 'Колбэк Telegram',
    description:
      'Вызывает не человек, а Telegram. Используется, только если задан' +
      ' TELEGRAM_WEBHOOK_URL; иначе бот сам опрашивает Bot API (long polling).',
  })
  @ApiForbiddenResponse({ description: 'Секрет не совпал или не задан в конфигурации.' })
  async webhook(@Body() update: TelegramUpdate): Promise<{ ok: true }> {
    await this.updates.handleUpdate(update);
    return { ok: true };
  }

  @Get('chats')
  @UseGuards(TelegramAdminGuard)
  @ApiSecurity('adminKey')
  @ApiOperation({ summary: 'Зарегистрированные чаты и известные темы' })
  @ApiForbiddenResponse({ description: 'Неверный или незаданный TELEGRAM_ADMIN_KEY.' })
  chats() {
    return { chats: this.telegram.listChats() };
  }

  /** The effective routing table, so an operator can see where an alert will land. */
  @Get('routes')
  @UseGuards(TelegramAdminGuard)
  @ApiSecurity('adminKey')
  @ApiOperation({
    summary: 'Действующая таблица маршрутизации',
    description: 'Где окажется событие, до того как оно случится.',
  })
  @ApiForbiddenResponse({ description: 'Неверный или незаданный TELEGRAM_ADMIN_KEY.' })
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
  @ApiSecurity('adminKey')
  @ApiOperation({
    summary: 'Перечитать файл правил',
    description: 'Подхватывает правки TELEGRAM_ROUTES_FILE без перезапуска сервиса.',
  })
  @ApiForbiddenResponse({ description: 'Неверный или незаданный TELEGRAM_ADMIN_KEY.' })
  reload() {
    return { rules: this.routing.reload() };
  }

  @Post('notify')
  @UseGuards(TelegramAdminGuard, TelegramEnabledGuard)
  @ApiSecurity('adminKey')
  @ApiOperation({ summary: 'Отправить произвольное сообщение' })
  @ApiOkResponse({ description: 'Что стало с событием.', schema: DELIVERY_REPORT })
  @ApiBadRequestResponse({ description: 'Пустой text.' })
  @ApiForbiddenResponse({ description: 'Неверный или незаданный TELEGRAM_ADMIN_KEY.' })
  @ApiServiceUnavailableResponse({ description: 'TELEGRAM_BOT_TOKEN не задан — отправлять некуда.' })
  async notify(@Body() body: AnnouncementBody): Promise<DeliveryReport> {
    return this.telegram.notify(this.accepted(announcement(body.text)));
  }

  @Post('test')
  @UseGuards(TelegramAdminGuard, TelegramEnabledGuard)
  @ApiSecurity('adminKey')
  @ApiOperation({
    summary: 'Синтетическое событие через реальный маршрутизатор',
    description:
      'Так проверяют развёртывание целиком — включая создание тем — не дожидаясь,' +
      ' пока какое-нибудь задание действительно упадёт.',
  })
  @ApiOkResponse({ description: 'Что стало с событием.', schema: DELIVERY_REPORT })
  @ApiBadRequestResponse({ description: 'Неизвестный kind или severity; в ответе — список допустимых.' })
  @ApiForbiddenResponse({ description: 'Неверный или незаданный TELEGRAM_ADMIN_KEY.' })
  @ApiServiceUnavailableResponse({ description: 'TELEGRAM_BOT_TOKEN не задан — отправлять некуда.' })
  async test(@Body() body: ProbeBody): Promise<DeliveryReport> {
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
  @ApiSecurity('adminKey')
  @ApiOperation({
    summary: 'Прогнать цикл проверки Veeam немедленно',
    description:
      '`ran: true` — цикл выполнил именно этот запрос. `ran: false` — цикл уже шёл,' +
      ' запрос отклонён, а состояние рядом относится к тому, другому циклу.',
  })
  @ApiForbiddenResponse({ description: 'Неверный или незаданный TELEGRAM_ADMIN_KEY.' })
  async check() {
    const ran = (await this.monitor.check()) === 'ran';
    return { ran, ...this.monitor.status };
  }

  private accepted(built: ManualEvent) {
    if (!built.ok) throw new BadRequestException(built.message);
    return built.event;
  }
}

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml, truncate } from './format';
import { TelegramStateStore } from './state.store';
import { TelegramTopicsService } from './topics.service';
import { TelegramTransportService } from './transport.service';
import {
  TelegramCallbackQuery,
  TelegramChat,
  TelegramDestination,
  TelegramKeyboard,
  TelegramMessage,
  TelegramUpdate,
} from './types';
import { MONITOR, Monitor, MonitorAnswer } from '../monitor/monitor';
import { plural, stampOf } from '../live/format';
import {
  Action,
  BOT_COMMANDS,
  cardKeyboard,
  decode,
  jobsKeyboard,
  mainKeyboard,
} from './keyboard';

/** Shortest gap between two passes asked for by hand, in the group. */
const CHECK_COOLDOWN_MS = 30_000;
const CHECK_COOLDOWN_KEY = 'command:check';

/**
 * The read-only commands are cheap — two requests at most — but they are still
 * requests against a production Veeam, and a group is a room full of people
 * with a keyboard each.
 */
const READ_COOLDOWN_MS = 5_000;
const READ_COOLDOWN_KEY = 'command:read';

/** Telegram takes at most 100 message ids in one deleteMessages call. */
const DELETE_BATCH = 100;

/**
 * The command list, spelled out.
 *
 * It used to hang off `/start`, which in a group nobody presses — the bot was
 * added by one person years ago and the rest of the room inherited it. Each
 * line says what the command *does*, not what it is called: "/check" tells
 * somebody who already knows nothing.
 */
const HELP = [
  '🤖 <b>Veeam Monitor — команды</b>',
  '',
  '<b>/status</b> — отвечает ли Veeam, авторизована ли служебная учётная запись,',
  'когда была последняя проверка. Ничего не запускает.',
  '',
  '<b>/check</b> — прогнать цикл опроса немедленно, не дожидаясь минутного таймера.',
  'Не чаще раза в полминуты.',
  '',
  '<b>/digest</b> — сводка по всем заданиям: сколько успешных, сколько с ошибкой',
  'и какие именно не в порядке. Это состояние на сейчас, а не за сутки.',
  '',
  '<b>/job &lt;имя&gt;</b> — карточка одного задания: последний результат и причина,',
  'длительность, следующий запуск, точки восстановления, последние запуски.',
  'Имя можно писать частями и в любом регистре: <code>/job kingston db</code>',
  '',
  '<b>/topics</b> — какие темы форума бот уже знает.',
  '',
  '<b>/clear</b> — убрать мои ответы в General, когда их накопилось много.',
  'Оповещения и живые сообщения не трогает — это записи о событиях.',
  '',
  '<i>Перезапустить службу из чата нельзя: процесс не может перезапустить сам себя,</i>',
  '<i>а кнопка перезагрузки, доступная всей группе, — это новая проблема вместо старой.</i>',
];

/** One message the bot is about to send, and what it lets the reader do next. */
interface Reply {
  lines: string[];
  markup?: TelegramKeyboard;
}

type ButtonRow = Array<[string, Action]>;

/** Offered under a list of jobs, so the way back is never retyping a command. */
const SUMMARY_BUTTON: ButtonRow = [['📊 Сводка', { kind: 'summary' }]];
/** Under the summary itself, where another "Сводка" would say nothing. */
const REFRESH_SUMMARY_BUTTON: ButtonRow = [['🔄 Обновить', { kind: 'summary' }]];

/**
 * How the bot hears from Telegram.
 *
 * This used to sit inside the notifier, which made one class answer two
 * unrelated questions: "how does an event become a message" and "how does the
 * outside world reach this process". They share dependencies and nothing else —
 * no caller of one ever wants the other — so a change to the polling loop had
 * to be read past the delivery rules and vice versa.
 *
 * The whole module is one method wide: an update goes in, and whatever it
 * implies happens. Everything else is lifecycle. Which of the two transports is
 * in use is not a choice a caller makes: it follows from TELEGRAM_WEBHOOK_URL
 * being set, and is reported through `mode` for the status endpoint.
 */
@Injectable()
export class TelegramUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramUpdatesService.name);
  private readonly config: AppConfig['telegram'];
  private polling = false;
  private stopping = false;
  private updateOffset = 0;

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly store: TelegramStateStore,
    @Inject(MONITOR) private readonly monitor: Monitor,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  async onModuleInit(): Promise<void> {
    if (!this.transport.enabled) {
      this.logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN is empty');
      return;
    }
    await Promise.all(this.store.chats().map(([id]) => this.refreshChat(id)));
    await this.publishCommands();

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

  /**
   * How this process is actually reached right now.
   *
   * "webhook" used to be whatever was left after "disabled" and "polling" were
   * ruled out, so a polling loop that failed to start reported itself as a
   * webhook — the one answer that made the status endpoint look healthy while
   * no update could arrive at all. Each mode is now claimed on its own
   * evidence, and the gap between them has its own name.
   */
  get mode(): 'disabled' | 'polling' | 'webhook' | 'starting' {
    if (!this.transport.enabled) return 'disabled';
    if (this.polling) return 'polling';
    return this.config.webhookUrl ? 'webhook' : 'starting';
  }

  /** True when a webhook URL was configured, whether or not Telegram took it. */
  get webhookConfigured(): boolean {
    return Boolean(this.config.webhookUrl);
  }

  /**
   * Everything one update implies: the chat is registered, a topic somebody
   * created by hand is remembered, and a bot command is answered.
   *
   * Called from the webhook endpoint and from the polling loop, which is why
   * the two transports need no further difference anywhere else.
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

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

    if (!message || !this.isGeneral(chat, message)) return;

    // Split rather than tokenised: everything after the command word is one
    // argument, kept in the case it was typed in, because a job name has
    // underscores and capitals and the person asking copied it from somewhere.
    const text = message?.text?.trim() ?? '';
    const gap = text.search(/\s/);
    const head = gap === -1 ? text : text.slice(0, gap);
    const command = head.toLowerCase().split('@')[0];
    if (!command.startsWith('/')) return;
    const argument = gap === -1 ? '' : text.slice(gap + 1).trim();

    const reply: TelegramDestination = { chatId: String(chat.id) };
    // The "/clear" somebody typed is clutter of the same kind, but it is their
    // message: deleting it needs administrator rights the bot may not have, so
    // it is attempted and never depended on.
    if (command === '/clear' && message) {
      await this.removeOne(String(chat.id), message.message_id);
    }

    const answer = await this.respond(command, argument, chat, reply);
    if (answer) await this.send(reply, answer);
  }

  /**
   * A button was pressed.
   *
   * The press is acknowledged first and unconditionally: Telegram shows the
   * sender a spinner until it is, and a read that takes two seconds would
   * otherwise look like a bot that ignored them.
   */
  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    await this.acknowledge(query.id);
    const chat = query.message?.chat;
    if (!chat) return;
    this.registerChat(chat);
    if (!query.message || !this.isGeneral(chat, query.message)) return;

    // An unknown action is an old message from a version that had buttons this
    // one does not. Acknowledged and then ignored, rather than answered wrongly.
    const action = decode(query.data);
    if (!action) return;

    const reply: TelegramDestination = { chatId: String(chat.id) };
    await this.send(reply, await this.act(action, chat, reply));
  }

  /** General has id 1; Telegram may also omit the topic fields for it. */
  private isGeneral(chat: TelegramChat, message: TelegramMessage): boolean {
    if (!chat.is_forum) return true;
    return (
      message.message_thread_id === 1 ||
      (!message.is_topic_message && message.message_thread_id === undefined)
    );
  }

  /** Every button leads to an answer one of the commands could also produce. */
  private async act(
    action: Action,
    chat: TelegramChat,
    reply: TelegramDestination,
  ): Promise<Reply> {
    if (action.kind === 'summary') return this.summaryReply();
    if (action.kind === 'check') return { lines: await this.runCheck(), markup: mainKeyboard() };
    if (action.kind === 'help') return { lines: HELP, markup: mainKeyboard() };
    if (action.kind === 'status') return this.statusReply(chat, reply);
    return this.reading(() => this.monitor.describeJobById(action.id));
  }

  private async respond(
    command: string,
    argument: string,
    chat: TelegramChat,
    reply: TelegramDestination,
  ): Promise<Reply | undefined> {
    if (command === '/start' || command === '/status' || command === '/chatid') {
      return this.statusReply(chat, reply);
    }
    if (command === '/help') return { lines: HELP, markup: mainKeyboard() };
    if (command === '/check') return { lines: await this.runCheck(), markup: mainKeyboard() };
    if (command === '/digest') return this.summaryReply();
    if (command === '/clear') return this.clear(reply);
    if (command === '/job') {
      return this.reading(() => this.monitor.describeJob(argument), SUMMARY_BUTTON);
    }
    if (command === '/topics') {
      const known = this.topics.list(String(chat.id));
      const lines = ['<b>Известные топики</b>'];
      for (const [name, threadId] of Object.entries(known)) {
        lines.push(`${escapeHtml(name)} — <code>${threadId}</code>`);
      }
      if (Object.keys(known).length === 0) lines.push('пока ни одного');
      return { lines, markup: mainKeyboard() };
    }
    return undefined;
  }

  private statusReply(chat: TelegramChat, reply: TelegramDestination): Reply {
    return {
      lines: [
        '<b>Veeam Monitor</b>',
        `<b>Chat ID:</b> <code>${escapeHtml(chat.id)}</code>`,
        `<b>Форум:</b> ${chat.is_forum ? 'да' : 'нет'}`,
        `<b>Топик:</b> <code>${escapeHtml(reply.threadId ?? 'General')}</code>`,
        `<b>Маршрутизация:</b> ${escapeHtml(this.config.routingMode)}`,
        '',
        ...this.healthLines(),
      ],
      markup: mainKeyboard(),
    };
  }

  private summaryReply(): Promise<Reply> {
    return this.reading(() => this.monitor.summary(), REFRESH_SUMMARY_BUTTON);
  }

  private async send(destination: TelegramDestination, answer: Reply): Promise<void> {
    try {
      // Cut to Telegram's limit rather than rejected by it: a job card is
      // bounded, but a forum with a hundred topics is not.
      const messageId = await this.transport.sendMessage(
        destination,
        truncate(answer.lines.join('\n')),
        answer.markup,
      );
      // Written down here and nowhere else, which is what makes `/clear` reach
      // the chatter and nothing else: alerts and live slots are sent by other
      // modules and never pass through this method.
      this.store.answerLog.remember(destination.chatId, messageId, destination.threadId);
    } catch (error) {
      this.logger.error(`Telegram reply failed: ${(error as Error).message}`);
    }
  }

  /**
   * `/clear` — take back the bot's own answers in this topic.
   *
   * Not "clear the chat": the Bot API has no such thing. A bot may delete a
   * message only by id, cannot enumerate a chat's history, and loses the right
   * after 48 hours. So what can be removed is exactly what this module wrote
   * down as it sent it — the cards, summaries and status replies that pile up.
   *
   * Alerts are left alone deliberately. They are the record of what happened,
   * and a command that quietly erased the evidence of last night's failures
   * would be a worse problem than a long chat.
   */
  private async clear(reply: TelegramDestination): Promise<Reply> {
    const ids = this.store.answerLog.inTopic(reply.chatId, reply.threadId);
    if (ids.length === 0) {
      return {
        lines: [
          '🧹 <b>Нечего убирать</b>',
          '',
          'В этой теме нет моих ответов за последние двое суток.',
          'Оповещения и живые сообщения я не удаляю — это записи о событиях.',
        ],
        markup: mainKeyboard(),
      };
    }

    const removed = await this.removeAll(reply.chatId, ids);
    this.store.answerLog.forget(reply.chatId, ids);
    const stuck = ids.length - removed;
    return {
      lines: [
        `🧹 <b>Убрано ${removed} ${plural(removed, 'сообщение', 'сообщения', 'сообщений')}</b>`,
        ...(stuck > 0
          ? ['', `${stuck} не поддались — Telegram не даёт удалять сообщения старше двух суток.`]
          : []),
      ],
      markup: mainKeyboard(),
    };
  }

  /** Deletes in batches, falling back to one at a time. Returns how many went. */
  private async removeAll(chatId: string, ids: number[]): Promise<number> {
    let removed = 0;
    for (let from = 0; from < ids.length; from += DELETE_BATCH) {
      const batch = ids.slice(from, from + DELETE_BATCH);
      try {
        await this.transport.call('deleteMessages', { chat_id: chatId, message_ids: batch });
        removed += batch.length;
      } catch {
        // One undeletable message — too old, or already gone — fails the whole
        // batch, so the rest is retried individually rather than abandoned.
        for (const messageId of batch) {
          if (await this.removeOne(chatId, messageId)) removed += 1;
        }
      }
    }
    return removed;
  }

  /** True when the message is gone. False is an answer, not a failure. */
  private async removeOne(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.transport.call('deleteMessage', { chat_id: chatId, message_id: messageId });
      return true;
    } catch {
      /* too old, already gone, or the bot is not an administrator here */
      return false;
    }
  }

  /** Best effort: an unacknowledged press only ever leaves a spinner behind. */
  private async acknowledge(id: string): Promise<void> {
    try {
      await this.transport.call('answerCallbackQuery', { callback_query_id: id });
    } catch (error) {
      this.logger.debug(`Callback not acknowledged: ${(error as Error).message}`);
    }
  }

  /**
   * `/check` — run a monitoring pass now instead of waiting for the timer.
   *
   * Everything the command can do is read Veeam and refresh what the bot
   * already publishes, so it is open to the group rather than gated behind the
   * admin key. What it is not is free: a pass can pull the whole restore-point
   * scan behind it, so it is rate-limited, and a pass already in flight is
   * reported rather than queued.
   */
  private async runCheck(): Promise<string[]> {
    if (this.store.cooldowns.isSuppressed(CHECK_COOLDOWN_KEY)) {
      return [
        '⏳ <b>Проверка уже была только что</b>',
        '',
        'Цикл запускается сам раз в минуту; вручную — не чаще одного раза в полминуты.',
        '',
        ...this.healthLines(),
      ];
    }
    this.store.cooldowns.arm(CHECK_COOLDOWN_KEY, CHECK_COOLDOWN_MS);

    const outcome = await this.monitor.check();
    return [
      outcome === 'ran'
        ? '✅ <b>Цикл проверки выполнен</b>'
        : '⏳ <b>Цикл уже шёл, этот запрос отклонён</b>',
      // Said plainly: when a pass was declined, the state below belongs to the
      // pass that was already running, not to this request.
      outcome === 'ran' ? '' : 'Ниже — состояние того цикла, а не этого запроса.',
      '',
      ...this.healthLines(),
    ];
  }

  /**
   * A question put to the monitor, answered in place.
   *
   * These ask Veeam and say what it said; they publish nothing and change
   * nothing, so unlike `/check` they need no cycle and cannot collide with one.
   * A failure is answered too: an unanswered command reads as a dead bot.
   */
  private async reading(
    ask: () => Promise<MonitorAnswer>,
    tail: ButtonRow = [],
  ): Promise<Reply> {
    if (this.store.cooldowns.isSuppressed(READ_COOLDOWN_KEY)) {
      return {
        lines: ['⏳ <b>Слишком часто</b>', '', 'Подождите несколько секунд и повторите.'],
        markup: mainKeyboard(),
      };
    }
    this.store.cooldowns.arm(READ_COOLDOWN_KEY, READ_COOLDOWN_MS);
    try {
      return this.offered(await ask(), tail);
    } catch (error) {
      this.logger.error(`Telegram command failed: ${(error as Error).message}`);
      return {
        lines: ['⚠️ <b>Не удалось ответить</b>', '', escapeHtml((error as Error).message)],
        markup: mainKeyboard(),
      };
    }
  }

  /**
   * What the answer lets somebody do next.
   *
   * An answer about one job offers that job again; an answer listing jobs
   * offers each of them. Which is why the monitor hands back ids alongside the
   * text: a button has to address a job, and the name printed in the message
   * is not an address.
   */
  private offered(answer: MonitorAnswer, tail: ButtonRow): Reply {
    const lines = [answer.text];
    if (answer.jobId) return { lines, markup: cardKeyboard(answer.jobId) };
    if (answer.jobs && answer.jobs.length > 0) {
      return { lines, markup: jobsKeyboard(answer.jobs, tail) };
    }
    return { lines, markup: mainKeyboard() };
  }

  /** The monitor's own state, compact enough to sit under any answer. */
  private healthLines(): string[] {
    const health = this.monitor.status;
    const mark = (value: boolean | null): string =>
      value === null ? '⚪ неизвестно' : value ? '🟢 да' : '🔴 нет';
    return [
      `<b>Veeam отвечает:</b> ${mark(health.reachable)}`,
      `<b>Учётная запись:</b> ${mark(health.authenticated)}`,
      `<b>Заданий под наблюдением:</b> ${health.trackedJobs}`,
      `<b>Последняя проверка:</b> ${health.lastCheckAt ? stampOf(new Date(health.lastCheckAt), { now: new Date(), timezone: this.config.timezone }) : 'ещё не было'}`,
      ...(health.lastError ? [`<b>Последняя ошибка:</b> ${escapeHtml(health.lastError)}`] : []),
    ];
  }

  private registerChat(chat: TelegramChat): void {
    const { becameForum } = this.store.mergeChat(chat);
    if (becameForum) this.topics.unblock();
  }

  /**
   * Registers the command menu Telegram shows next to the input field.
   *
   * The commands existed and were discoverable only by reading `/help`, which
   * in a group is not how anybody finds anything: the bot was added once, by
   * one person, and everyone else inherited a silent box. This is the one place
   * Telegram will show them without being asked.
   *
   * Best effort — a bot that could not publish its menu still answers every
   * command typed by hand.
   */
  private async publishCommands(): Promise<void> {
    try {
      await this.transport.call('setMyCommands', { commands: BOT_COMMANDS });
      this.logger.log(`Telegram command menu published (${BOT_COMMANDS.length} commands)`);
    } catch (error) {
      this.logger.warn(`Telegram command menu was not published: ${(error as Error).message}`);
    }
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
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
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
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
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

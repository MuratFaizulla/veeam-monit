import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { plural, stampOf } from '../telegram/time';
import { MONITOR, Monitor, Answer, ServerStatus } from '../monitor/monitor';
import { Answers, Asked, commandNamed, commandPressed, Reply } from './commands';
import { escapeHtml } from '../telegram/format';
import { Action, cardKeyboard, clearKeyboard, decode, jobsKeyboard, mainKeyboard, pointsKeyboard } from './keyboard';
import { mainMenu, MENU_TEXT, menuPressed, Pressed, serverMenu } from './menu';
import { serverIcon } from '../live/format';
import { TelegramStateStore } from '../telegram/state.store';
import { TelegramTopicsService } from '../telegram/topics.service';
import { TelegramTransportService } from '../telegram/transport.service';
import { Access } from './chat-access';
import { TelegramGeneral } from './general';
import {
  TelegramCallbackQuery,
  TelegramChat,
  TelegramDestination,
  TelegramMessage,
  TelegramUpdate,
} from '../telegram/types';

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

/** What somebody setting the bot up types to learn the chat's id. */
const SETUP_WORDS = ['/chatid', '/start', '/status'];

type ButtonRow = Array<[string, Action]>;

/** Offered under a list of jobs, so the way back is never retyping a command. */
const SUMMARY_BUTTON: ButtonRow = [['📊 Сводка', { kind: 'summary' }]];
/** Under the summary itself, where another "Сводка" would say nothing. */
const REFRESH_SUMMARY_BUTTON: ButtonRow = [['🔄 Обновить', { kind: 'summary' }]];

/**
 * What an Update means: a command typed, a key of the menu pressed or a Button
 * pressed in General, answered there.
 *
 * Split from `TelegramUpdatesService`, which is how an Update *arrives* — the
 * webhook, the long-polling loop, the startup calls. With both in one class, a
 * test of a command had to construct the class that owns the polling loop, and
 * one that started it on a polling world hung the whole test run. Nothing here
 * has a lifecycle: construct it and hand it Updates. What is said in General,
 * the menu kept there and `/clear` are General's (`./general`).
 *
 * `answer` is the interface. The `Answers` methods are public only because
 * the declaration in `./commands` dispatches to them.
 */
@Injectable()
export class TelegramCommandsService implements Answers {
  private readonly logger = new Logger(TelegramCommandsService.name);
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly store: TelegramStateStore,
    @Inject(MONITOR) private readonly monitor: Monitor,
    private readonly general: TelegramGeneral,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  /**
   * Whatever one Update asks of the bot, answered. A command outside General,
   * a message that is not a command, and a command this bot does not declare
   * are all answered with silence — and so is everything from a chat the bot
   * does not talk to (see `Access`).
   */
  async answer(update: TelegramUpdate, access: Access = 'recipient'): Promise<void> {
    if (access === 'none') return;
    if (access === 'setup') return this.untilConfigured(update.message);
    if (update.callback_query) await this.pressed(update.callback_query);
    else if (update.message) await this.typed(update.message);
  }

  /**
   * Before any chat is configured, the one thing said is the chat's id — what
   * somebody setting the bot up needs, and nothing about the estate.
   */
  private async untilConfigured(message: TelegramMessage | undefined): Promise<void> {
    const word = message?.text?.trim().split(/\s/)[0].toLowerCase().split('@')[0];
    if (!message || !word || !SETUP_WORDS.includes(word)) return;
    await this.general.say(this.whereAnswered({ chat: message.chat, argument: '' }), {
      lines: [
        '🤖 <b>Бот ещё не настроен</b>',
        '',
        `ID этого чата: <code>${escapeHtml(message.chat.id)}</code>`,
        'Добавьте его в TELEGRAM_CHAT_IDS и перезапустите сервис.',
      ],
    });
  }

  private async typed(message: TelegramMessage): Promise<void> {
    if (!this.isGeneral(message.chat, message)) return;
    this.general.heard(message);
    const text = message.text?.trim() ?? '';

    // A key of the menu under the input field arrives as its label, as if it
    // had been typed.
    const key = menuPressed(text, this.monitor.servers());
    if (key) {
      const asked: Asked = { chat: message.chat, argument: '', messageId: message.message_id };
      await this.general.say(this.whereAnswered(asked), await this.keyed(key, asked), message.message_id);
      return;
    }

    // Split rather than tokenised: everything after the command word is one
    // argument, kept in the case it was typed in.
    const gap = text.search(/\s/);
    const head = gap === -1 ? text : text.slice(0, gap);
    const word = head.toLowerCase().split('@')[0];
    if (!word.startsWith('/')) return;
    const command = commandNamed(word.slice(1));
    if (!command) return;

    const asked: Asked = {
      chat: message.chat,
      argument: gap === -1 ? '' : text.slice(gap + 1).trim(),
      messageId: message.message_id,
    };
    await this.general.say(this.whereAnswered(asked), await command.answer(this, asked), message.message_id);
  }

  /** A key of the menu: one that stands for a command, the way back, or a server's. */
  private async keyed(key: Pressed, asked: Asked): Promise<Reply> {
    if (key.kind === 'home') {
      return { lines: ['🤖 <b>Главное меню</b>'], markup: mainMenu({ selective: true }) };
    }
    if (key.kind === 'server') return this.selected(key.name);
    // A key is pressed by accident far more easily than a command is typed,
    // and this one deletes: it asks first, with the Button that does it.
    if (key.name === 'clear') {
      return {
        lines: [
          '🧹 <b>Очистить General?</b>',
          '',
          'Удалю всё, что видел здесь за двое суток: команды, ответы, сообщения людей и меню.',
          'Оповещения и живые сообщения в темах не трону.',
        ],
        markup: clearKeyboard(),
      };
    }
    const command = commandNamed(key.name);
    return command ? command.answer(this, asked) : this.menu();
  }

  /**
   * A button was pressed.
   *
   * The press is acknowledged first and unconditionally: Telegram shows the
   * sender a spinner until it is, and a read that takes two seconds would
   * otherwise look like a bot that ignored them.
   */
  private async pressed(query: TelegramCallbackQuery): Promise<void> {
    await this.acknowledge(query.id);
    const message = query.message;
    if (!message || !this.isGeneral(message.chat, message)) return;

    // An unknown action is an old message from a version that had buttons this
    // one does not. Acknowledged and then ignored, rather than answered wrongly.
    const action = decode(query.data);
    if (!action) return;

    const asked: Asked = { chat: message.chat, argument: '' };
    const answer = await this.act(action, asked);
    if (answer) await this.general.say(this.whereAnswered(asked), answer);
  }

  /**
   * A Button stands for a command, and is answered as that command typed with
   * nothing after it — except a job's own, which carries the job's id and the
   * key of its server.
   */
  private async act(action: Action, asked: Asked): Promise<Reply | undefined> {
    if (action.kind === 'job') {
      return this.reading(() => this.monitor.describeJobById(action.id, action.server));
    }
    if (action.kind === 'points') {
      return this.reading(() => this.monitor.describePointsById(action.id, action.server));
    }
    return commandPressed(action.kind)?.answer(this, asked);
  }

  /** General has id 1; Telegram may also omit the topic fields for it. */
  private isGeneral(chat: TelegramChat, message: TelegramMessage): boolean {
    if (!chat.is_forum) return true;
    return (
      message.message_thread_id === 1 ||
      (!message.is_topic_message && message.message_thread_id === undefined)
    );
  }

  /** Commands are answered only in General, so that is where every Answer goes. */
  private whereAnswered(asked: Asked): TelegramDestination {
    return { chatId: String(asked.chat.id) };
  }

  status(asked: Asked): Reply {
    const where = this.whereAnswered(asked);
    return {
      lines: [
        '<b>Veeam Monitor</b>',
        `<b>Chat ID:</b> <code>${escapeHtml(asked.chat.id)}</code>`,
        `<b>Форум:</b> ${asked.chat.is_forum ? 'да' : 'нет'}`,
        `<b>Топик:</b> <code>${escapeHtml(where.threadId ?? 'General')}</code>`,
        `<b>Маршрутизация:</b> ${escapeHtml(this.config.routingMode)}`,
        '',
        ...this.healthLines(),
      ],
      markup: mainKeyboard(),
    };
  }

  /** `/menu` — the menu under the input field, for everybody in the chat. */
  menu(): Reply {
    return { lines: MENU_TEXT, markup: mainMenu() };
  }

  /**
   * `/servers` — every Veeam server, how it is doing, and which one the live
   * slots and the commands show. The menu under the input field turns into a
   * key per server, for whoever asked.
   */
  servers(): Reply {
    const servers = this.monitor.servers();
    return {
      lines: [
        '🖥 <b>Серверы Veeam</b>',
        '',
        ...servers.map(
          (server) =>
            `${server.selected ? '✅' : '▫️'} <b>${escapeHtml(server.name)}</b> — ${serverIcon(server)} ${standing(server)}`,
        ),
        '',
        'Живые темы, /digest и /job показывают сервер с ✅.',
        'Оповещения приходят со всех.',
        '',
        'Выберите сервер кнопкой под полем ввода.',
      ],
      markup: serverMenu(servers),
    };
  }

  /**
   * A server's key was pressed: show that server, and put the main menu back
   * for whoever pressed it.
   */
  private selected(name: string): Reply {
    const server = this.monitor.servers().find((candidate) => candidate.name === name);
    const outcome = server ? this.monitor.select(server.key) : 'unknown';
    const shown = escapeHtml(name);
    const lines =
      outcome === 'unknown'
        ? ['⚠️ Этого сервера больше нет в настройках.']
        : outcome === 'already'
          ? [`🖥 <b>${shown}</b> уже показан.`]
          : [
              `✅ <b>Показан сервер ${shown}</b>`,
              '',
              'Живые темы, /digest и /job теперь про него; живые темы перерисуются в течение минуты.',
              'Оповещения по-прежнему приходят со всех серверов.',
            ];
    return { lines, markup: mainMenu({ selective: true }) };
  }

  summary(): Promise<Reply> {
    return this.reading(() => this.monitor.summary(), REFRESH_SUMMARY_BUTTON);
  }

  job(name: string): Promise<Reply> {
    return this.reading(() => this.monitor.describeJob(name), SUMMARY_BUTTON);
  }

  points(name: string): Promise<Reply> {
    return this.reading(() => this.monitor.describePoints(name), SUMMARY_BUTTON);
  }

  knownTopics(asked: Asked): Reply {
    const known = this.topics.list(String(asked.chat.id));
    const lines = ['<b>Известные топики</b>'];
    for (const [name, threadId] of Object.entries(known)) {
      lines.push(`${escapeHtml(name)} — <code>${threadId}</code>`);
    }
    if (Object.keys(known).length === 0) lines.push('пока ни одного');
    return { lines, markup: mainKeyboard() };
  }

  /**
   * `/clear` — empty General of everything said there, and put the menu back.
   *
   * Not the whole chat: the Bot API has no such thing. A bot may delete a
   * message only by id, cannot enumerate a chat's history, and loses the right
   * after 48 hours. So what can be removed is what the Answer log wrote down —
   * everything said in General since, by anybody — and nothing older.
   *
   * The topics are left alone deliberately. An alert there is the record of
   * what happened, and a command that quietly erased the evidence of last
   * night's failures would be a worse problem than a long chat.
   *
   * It ends on the menu, for everybody: the messages that carried it are among
   * what went, and the keyboard lives as long as the message that put it there.
   */
  async clear(asked: Asked): Promise<Reply> {
    // The "/clear" itself goes too, but is not counted as work done.
    const cleared = await this.general.clear(this.whereAnswered(asked), asked.messageId);
    if (cleared === 'nothing') {
      return {
        lines: [
          '🧹 <b>Нечего убирать</b>',
          '',
          'В General нет сообщений моложе двух суток, которые я видел.',
          'Оповещения и живые сообщения в темах я не удаляю — это записи о событиях.',
        ],
        markup: mainKeyboard(),
      };
    }

    const { removed, stuck } = cleared;
    return {
      lines: [
        `🧹 <b>Убрано ${removed} ${plural(removed, 'сообщение', 'сообщения', 'сообщений')}</b>`,
        ...(stuck > 0
          ? ['', `${stuck} не поддались — у меня нет права удалять чужие сообщения, или им больше двух суток.`]
          : []),
        '',
        ...MENU_TEXT,
      ],
      markup: mainMenu(),
    };
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
  async check(): Promise<Reply> {
    if (this.store.cooldowns.isSuppressed(CHECK_COOLDOWN_KEY)) {
      return {
        lines: [
          '⏳ <b>Проверка уже была только что</b>',
          '',
          'Цикл запускается сам раз в минуту; вручную — не чаще одного раза в полминуты.',
          '',
          ...this.healthLines(),
        ],
        markup: mainKeyboard(),
      };
    }
    this.store.cooldowns.arm(CHECK_COOLDOWN_KEY, CHECK_COOLDOWN_MS);

    const outcome = await this.monitor.check();
    return {
      lines: [
        outcome === 'ran'
          ? '✅ <b>Цикл проверки выполнен</b>'
          : '⏳ <b>Цикл уже шёл, этот запрос отклонён</b>',
        // Said plainly: when a pass was declined, the state below belongs to the
        // pass that was already running, not to this request.
        outcome === 'ran' ? '' : 'Ниже — состояние того цикла, а не этого запроса.',
        '',
        ...this.healthLines(),
      ],
      markup: mainKeyboard(),
    };
  }

  /**
   * A question put to the monitor, answered in place.
   *
   * These ask Veeam and say what it said; they publish nothing and change
   * nothing, so unlike `/check` they need no cycle and cannot collide with one.
   * A failure is answered too: an unanswered command reads as a dead bot.
   */
  private async reading(
    ask: () => Promise<Answer>,
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
  private offered(answer: Answer, tail: ButtonRow): Reply {
    const lines = [answer.text];
    const points = answer.about === 'points';
    if (answer.jobId) {
      const markup = points ? pointsKeyboard(answer.jobId, answer.server) : cardKeyboard(answer.jobId, answer.server);
      return { lines, markup };
    }
    if (answer.jobs && answer.jobs.length > 0) {
      return { lines, markup: jobsKeyboard(answer.jobs, tail, answer.server, points ? 'points' : 'job') };
    }
    return { lines, markup: mainKeyboard() };
  }

  /** The monitor's own state, compact enough to sit under any answer. */
  private healthLines(): string[] {
    const health = this.monitor.status;
    const servers = this.monitor.servers();
    const shown = servers.find((server) => server.selected);
    const mark = (value: boolean | null): string =>
      value === null ? '⚪ неизвестно' : value ? '🟢 да' : '🔴 нет';
    return [
      ...(servers.length > 1 && shown
        ? [`<b>Сервер:</b> ${escapeHtml(shown.name)} (из ${servers.length}, сменить — /servers)`]
        : []),
      `<b>Veeam отвечает:</b> ${mark(health.reachable)}`,
      `<b>Учётная запись:</b> ${mark(health.authenticated)}`,
      `<b>Заданий под наблюдением:</b> ${health.trackedJobs}`,
      `<b>Последняя проверка:</b> ${health.lastCheckAt ? stampOf(new Date(health.lastCheckAt), { now: new Date(), timezone: this.config.timezone }) : 'ещё не было'}`,
      ...(health.lastError ? [`<b>Последняя ошибка:</b> ${escapeHtml(health.lastError)}`] : []),
    ];
  }
}

/** How a server is doing, in the words of the server menu. */
const standing = (server: ServerStatus): string => {
  if (server.reachable === null) return 'ещё не проверялся';
  if (!server.reachable) return 'не отвечает';
  if (server.authenticated === false) return 'отвечает, вход не выполнен';
  if (server.authenticated === null) return 'отвечает, мониторинг заданий выключен';
  if (!server.jobs) return 'отвечает';
  const { total, failed, warning } = server.jobs;
  const problems = [
    ...(failed ? [`с ошибкой: ${failed}`] : []),
    ...(warning ? [`с предупреждением: ${warning}`] : []),
  ];
  return `${total} ${plural(total, 'задание', 'задания', 'заданий')}${problems.length ? `, ${problems.join(', ')}` : ', всё в порядке'}`;
};

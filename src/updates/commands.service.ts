import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { plural, stampOf } from '../telegram/time';
import { MONITOR, Monitor, ServerStatus } from '../monitor/monitor';
import { Answer } from '../estate/answer';
import { EstateAnswers } from '../estate/estate-answers';
import { Answers, Asked, commandNamed, commandPressed, Reply } from './commands';
import { escapeHtml } from '../telegram/format';
import { Action, cardKeyboard, clearKeyboard, decode, jobsKeyboard, mainKeyboard, pointsKeyboard } from './keyboard';
import {
  EVERY_REPOSITORY,
  JOB_MARK,
  jobMenu,
  jobPage,
  mainMenu,
  MENU_TEXT,
  menuPressed,
  POINTS_MARK,
  pointsMenu,
  Pressed,
  REPOSITORY,
  reportMenu,
  serverMenu,
} from './menu';
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
  /** The Replies said to be coming, until each is said. */
  private readonly following = new Set<Promise<void>>();

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly store: TelegramStateStore,
    @Inject(MONITOR) private readonly monitor: Monitor,
    private readonly estate: EstateAnswers,
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
      await this.respond(asked, await this.keyed(key, asked));
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
    await this.respond(asked, await command.answer(this, asked));
  }

  /**
   * Says `reply` in General, and when it says more is coming, makes that and
   * says it too — not waited for, so the next Update is answered meanwhile.
   */
  private async respond(asked: Asked, reply: Reply): Promise<void> {
    const where = this.whereAnswered(asked);
    await this.general.say(where, reply, asked.messageId);
    if (!reply.later) return;
    const following: Promise<void> = reply
      .later()
      .then((next) => this.general.say(where, next, asked.messageId))
      .then(
        () => undefined,
        (error: Error) => this.logger.error(`Telegram reply failed: ${error.message}`),
      )
      .finally(() => this.following.delete(following));
    this.following.add(following);
  }

  /** Resolves once every Reply said to be coming has been said. */
  async settled(): Promise<void> {
    while (this.following.size) await Promise.all(this.following);
  }

  /** A key of the menu: one that stands for a command, the way back, a server's or a repository's. */
  private async keyed(key: Pressed, asked: Asked): Promise<Reply> {
    if (key.kind === 'home') {
      return { lines: ['🤖 <b>Главное меню</b>'], markup: mainMenu({ selective: true }) };
    }
    if (key.kind === 'server') return this.selected(key.name);
    if (key.kind === 'repository') return this.repositories({ ...asked, argument: key.name });
    if (key.kind === 'job') return this.job(key.name);
    if (key.kind === 'jobs') return this.jobChoices(key.page);
    if (key.kind === 'points') return this.points({ ...asked, argument: key.name });
    if (key.kind === 'pointsPage') return this.pointsChoices(key.page);
    // Asked which repository first, as the server key asks which server.
    if (key.name === 'repos') return this.reportChoices();
    // And which job, rather than typing its name: for its card, or its points.
    if (key.name === 'job') return this.jobChoices();
    if (key.name === 'points') return this.pointsChoices();
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
    if (answer) await this.respond(asked, answer);
  }

  /**
   * A Button stands for a command, and is answered as that command typed with
   * nothing after it — except a job's own, which carries the job's id and the
   * key of its server.
   */
  private async act(action: Action, asked: Asked): Promise<Reply | undefined> {
    if (action.kind === 'job') {
      return this.reading(() => this.estate.describeJobById(action.id, action.server));
    }
    if (action.kind === 'points') {
      return this.reading(() => this.estate.describePointsById(action.id, action.server), [], asked);
    }
    if (action.kind === 'report') return this.jobReport(asked, action.id, action.server);
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
    return this.reading(() => this.estate.summary(), REFRESH_SUMMARY_BUTTON);
  }

  job(name: string): Promise<Reply> {
    return this.reading(() => this.estate.describeJob(name), SUMMARY_BUTTON);
  }

  /**
   * `/points`, a key of the points menu, and a Button for one job's points:
   * a PDF, so what is said at once is that it is coming, and the PDF follows;
   * the choices, when the name is none or several jobs share it.
   */
  points(asked: Asked): Promise<Reply> {
    return this.reading(() => this.estate.describePoints(asked.argument), SUMMARY_BUTTON, asked);
  }

  /**
   * `/repos` and the keys of the report menu — the Repository report as a
   * PDF. Reading every server takes a minute or two, so what is said at once
   * is what the report says it comes to — that it is coming and how long it
   * takes — and the PDF follows; a name that matches no repository is said
   * at once too, and nothing follows.
   */
  repositories(asked: Asked): Reply {
    const tooSoon = this.tooSoon();
    if (tooSoon) return tooSoon;
    const { text, later } = this.estate.repositoryReport(asked.argument.trim());
    if (!later) return { lines: [text], markup: mainKeyboard() };
    // Whoever pressed a repository's key gets the main menu back.
    return { lines: [text], markup: mainMenu({ selective: true }), later: this.sending(asked, later) };
  }

  /**
   * The 📄 Button under a Job card: that job's month as a PDF. A few dozen
   * requests and a print, so what the report says it comes to is said at
   * once, and the PDF follows, as the Repository report does.
   */
  private jobReport(asked: Asked, id: string, server?: string): Reply {
    const tooSoon = this.tooSoon();
    if (tooSoon) return tooSoon;
    const { text, later } = this.estate.jobReport(id, server);
    return { lines: [text], ...(later ? { later: this.sending(asked, later) } : {}) };
  }

  /** The report `later` makes, as the Reply that follows: the chat shows a file being sent meanwhile. */
  private sending(asked: Asked, later: () => Promise<Answer>): () => Promise<Reply> {
    return () => this.uploading(String(asked.chat.id), () => this.answered(later));
  }

  /**
   * The 📄 key: which repository the report is to be about. The keyboard
   * turns into a key per repository for whoever pressed it, as the 🖥 key
   * turns it into the servers.
   */
  private reportChoices(): Reply {
    const { repositories, takes } = this.estate.repositoryChoices();
    const sites = [...new Set(repositories.map(({ site }) => site))];
    const listed = sites.flatMap((site) => [
      ...(site ? [`<b>${escapeHtml(site)}</b>`] : []),
      ...repositories
        .filter((repository) => repository.site === site)
        .map(({ short, freePercent }) =>
          `${REPOSITORY}${escapeHtml(short)}${freePercent === undefined ? '' : ` — свободно ${Math.round(freePercent)}%`}`,
        ),
      '',
    ]);
    return {
      lines: [
        '📄 <b>Отчёт по репозиториям</b>',
        '',
        ...(repositories.length ? listed : ['Список репозиториев появится после первой проверки, через минуту.', '']),
        `Выберите репозиторий кнопкой под полем ввода или «${EVERY_REPOSITORY}».`,
        // How long it takes is the report's to say, as is what it says while it is read.
        takes,
      ],
      markup: reportMenu(repositories),
    };
  }

  /**
   * The 📦 key: which job's card to show. The keyboard turns into a key per
   * job of the Selected server for whoever pressed it, the ones not in order
   * first, and stays so while cards are opened from it.
   *
   * Not rate-limited, as the cards are: it is one request, and a limit armed
   * by the list would refuse the card picked from it a moment later.
   */
  private async jobChoices(page = 1): Promise<Reply> {
    const { server, jobs, unavailable } = await this.estate.jobChoices();
    if (!jobs) return { lines: [unavailable ?? '⚠️ Veeam не ответил.'], markup: mainKeyboard() };
    if (!jobs.length) {
      return { lines: [`📦 <b>Задания · ${escapeHtml(server)}</b>`, '', 'На этом сервере нет заданий.'], markup: mainKeyboard() };
    }
    const counted = (['failed', 'warning', 'running', 'disabled'] as const)
      .map((mark) => [mark, jobs.filter((job) => job.mark === mark).length] as const)
      .filter(([, count]) => count)
      .map(([mark, count]) => `${JOB_MARK[mark]} ${count} ${STANDING_WORD[mark]}`);
    const { at, pages } = jobPage(jobs.length, page);
    return {
      lines: [
        `📦 <b>Задания · ${escapeHtml(server)}</b> — ${jobs.length}`,
        ...(counted.length ? ['', counted.join(' · ')] : []),
        '',
        'Выберите задание кнопкой под полем ввода: сначала те, что не в порядке, дальше по алфавиту.',
        ...(pages > 1 ? [`Страница ${at} из ${pages}.`] : []),
        'Другой сервер — «🖥 Серверы». По части имени — <code>/job часть имени</code>.',
      ],
      markup: jobMenu(jobs, at),
    };
  }

  /**
   * The 🗂 key: which job's points to send. The keyboard turns into a key per
   * job of the Selected server for whoever pressed it, by 🛡's verdict, the
   * worst first, and stays so while the PDFs are sent from it.
   *
   * Not rate-limited, as the job menu is not: one request, the job list.
   */
  private async pointsChoices(page = 1): Promise<Reply> {
    const { server, jobs, unavailable, pending } = await this.estate.pointsChoices();
    if (!jobs) return { lines: [unavailable ?? '⚠️ Veeam не ответил.'], markup: mainKeyboard() };
    if (!jobs.length) {
      return { lines: [`🗂 <b>Точки восстановления · ${escapeHtml(server)}</b>`, '', 'На этом сервере нет заданий.'], markup: mainKeyboard() };
    }
    const counted = (['critical', 'warning', 'notice'] as const)
      .map((mark) => [mark, jobs.filter((job) => job.mark === mark).length] as const)
      .filter(([, count]) => count)
      .map(([mark, count]) => `${POINTS_MARK[mark]} ${count}`);
    const { at, pages } = jobPage(jobs.length, page);
    return {
      lines: [
        `🗂 <b>Точки восстановления · ${escapeHtml(server)}</b> — ${jobs.length}`,
        '',
        pending
          ? `${escapeHtml(pending)} Пока задания — по алфавиту.`
          : counted.length
            ? `Нужно внимание: ${counted.join(' · ')}.`
            : '🟢 Внимание не нужно ни одному.',
        '',
        'Выберите задание кнопкой под полем ввода — придёт PDF по его точкам: сначала те, кому нужно внимание, как в 🛡, дальше по алфавиту.',
        ...(pages > 1 ? [`Страница ${at} из ${pages}.`] : []),
        'Другой сервер — «🖥 Серверы». По части имени — <code>/points часть имени</code>.',
      ],
      markup: pointsMenu(jobs, at),
    };
  }

  /** While `make` runs, the chat shows the bot sending a file. */
  private async uploading(chatId: string, make: () => Promise<Reply>): Promise<Reply> {
    const sending = () =>
      void this.transport.call('sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => undefined);
    sending();
    // Telegram shows an action for five seconds.
    const timer = setInterval(sending, 4_500);
    timer.unref();
    try {
      return await make();
    } finally {
      clearInterval(timer);
    }
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
   * What Telegram was not answering for goes on a later pass, and is said so.
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

    const { removed, stuck, pending } = cleared;
    return {
      lines: [
        `🧹 <b>Убрано ${removed} ${plural(removed, 'сообщение', 'сообщения', 'сообщений')}</b>`,
        ...(stuck > 0
          ? ['', `${stuck} не поддались — у меня нет права удалять чужие сообщения, или им больше двух суток.`]
          : []),
        // Not among the ones above: these go by themselves, on a later pass.
        ...(pending > 0 ? ['', `${pending} удалю чуть позже — Telegram сейчас не отвечает.`] : []),
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
   * A question put to the estate, answered in place.
   *
   * These ask Veeam and say what it said; they publish nothing and change
   * nothing, so unlike `/check` they need no cycle and cannot collide with one
   * — which is why they are asked of `EstateAnswers` and not of the monitor.
   * A failure is answered too: an unanswered command reads as a dead bot.
   */
  private async reading(
    ask: () => Promise<Answer>,
    tail: ButtonRow = [],
    asked?: Asked,
  ): Promise<Reply> {
    return this.tooSoon() ?? this.answered(ask, tail, asked);
  }

  /** The rate limit on reads: what is said when it holds, and otherwise it is armed. */
  private tooSoon(): Reply | undefined {
    if (this.store.cooldowns.isSuppressed(READ_COOLDOWN_KEY)) {
      return {
        lines: ['⏳ <b>Слишком часто</b>', '', 'Подождите несколько секунд и повторите.'],
        markup: mainKeyboard(),
      };
    }
    this.store.cooldowns.arm(READ_COOLDOWN_KEY, READ_COOLDOWN_MS);
    return undefined;
  }

  /**
   * The Answer to `ask` and what it lets somebody do next, or why there is
   * none; and the one it says is coming, said to `asked`'s chat once made.
   */
  private async answered(ask: () => Promise<Answer>, tail: ButtonRow = [], asked?: Asked): Promise<Reply> {
    try {
      return this.offered(await ask(), tail, asked);
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
   * offers each of them. Which is why the estate hands back ids alongside the
   * text: a button has to address a job, and the name printed in the message
   * is not an address.
   */
  private offered(answer: Answer, tail: ButtonRow, asked?: Asked): Reply {
    const lines = [answer.text];
    const points = answer.about === 'points';
    // An answer about one job offers it again — its points' file too: ask
    // again, or open its card.
    if (answer.jobId) {
      const markup = points ? pointsKeyboard(answer.jobId, answer.server) : cardKeyboard(answer.jobId, answer.server);
      return { lines, markup, ...(answer.document ? { document: answer.document } : {}) };
    }
    // Any other file is its own next step: nothing to press under it.
    if (answer.document) return { lines, document: answer.document };
    // Said to be coming: the answer that follows offers what it offers.
    if (answer.later) return { lines, ...(asked ? { later: this.sending(asked, answer.later) } : {}) };
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

/** How many jobs stand so, in the words of the job menu: «🔴 2 с ошибкой». */
const STANDING_WORD = {
  failed: 'с ошибкой',
  warning: 'с предупреждением',
  running: 'в работе',
  disabled: 'выключено',
} as const;

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

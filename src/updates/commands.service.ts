import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { plural, stampOf } from '../telegram/time';
import { MONITOR, Monitor, Answer, ServerStatus } from '../monitor/monitor';
import { Answers, Asked, commandNamed, commandPressed, Reply } from './commands';
import { escapeHtml, truncate } from '../telegram/format';
import { Action, cardKeyboard, decode, jobsKeyboard, mainKeyboard } from './keyboard';
import {
  isMenu,
  isSelective,
  mainMenu,
  MENU_SIGNATURE,
  MENU_TEXT,
  menuPressed,
  Pressed,
  serverMenu,
} from './menu';
import { serverIcon } from '../live/format';
import { TelegramStateStore } from '../telegram/state.store';
import { TelegramTopicsService } from '../telegram/topics.service';
import { TelegramApiError, TelegramTransportService } from '../telegram/transport.service';
import { Access } from './chat-access';
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

/** Telegram takes at most 100 message ids in one deleteMessages call. */
const DELETE_BATCH = 100;

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
 * has a lifecycle: construct it and hand it Updates.
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
    await this.send(this.whereAnswered({ chat: message.chat, argument: '' }), {
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
    const chatId = String(message.chat.id);
    // Everything said in General, by anybody, so /clear can take it back: the
    // commands people type, the keys they press, and whatever else. Only the
    // bot's answers were written down once, and "/clear" left a column of
    // "/digest" and "/status" with nothing after them.
    if (this.store.isConfigured(chatId)) this.store.answerLog.remember(chatId, message.message_id);
    const text = message.text?.trim() ?? '';

    // A key of the menu under the input field arrives as its label, as if it
    // had been typed.
    const key = menuPressed(text, this.monitor.servers());
    if (key) {
      const asked: Asked = { chat: message.chat, argument: '', messageId: message.message_id };
      await this.send(this.whereAnswered(asked), await this.keyed(key, asked), message.message_id);
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
    await this.send(this.whereAnswered(asked), await command.answer(this, asked), message.message_id);
  }

  /** A key of the menu: one that stands for a command, the way back, or a server's. */
  private async keyed(key: Pressed, asked: Asked): Promise<Reply> {
    if (key.kind === 'home') {
      return { lines: ['🤖 <b>Главное меню</b>'], markup: mainMenu({ selective: true }) };
    }
    if (key.kind === 'server') return this.selected(key.name);
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
    if (answer) await this.send(this.whereAnswered(asked), answer);
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
   * Keeps the menu under the input field of every chat, and is called on
   * start and then every few minutes.
   *
   * In a group nobody presses Start: the bot was added once, by one person, and
   * a menu that waited to be asked for would never be seen. The keyboard lives
   * as long as the message that put it there, and that message used to be
   * posted once and forgotten — so deleting it, by hand or with the topic it
   * was answered in, took the menu away for good. The message is remembered
   * now and looked at, and posted again only when Telegram says it is gone or
   * the layout changed; a restart, or a failed look, says nothing.
   */
  async keepMenu(): Promise<void> {
    for (const [chatId] of this.store.chats()) {
      const held = this.store.menuOf(chatId);
      const current = held?.signature === MENU_SIGNATURE ? held.messageId : undefined;
      if (current !== undefined && (await this.present(chatId, current))) continue;
      const posted = await this.send({ chatId }, this.menu());
      // A menu of an older layout is replaced, not left beside the new one.
      if (posted !== undefined && held?.messageId !== undefined && held.messageId !== current) {
        await this.removeOne(chatId, held.messageId);
      }
    }
  }

  /**
   * Whether Telegram still holds this message, asked without changing it.
   *
   * An empty markup edit is refused for a message that is there — "not
   * modified", or "can't be edited" for one that carries the menu — and
   * answered "not found" for one that is gone. Anything else says nothing
   * about the message and is read as "still there": the cost of that mistake
   * is one late repost, and the cost of the other is a second menu.
   */
  private async present(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.transport.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId });
      return true;
    } catch (error) {
      return !(error instanceof TelegramApiError && error.isMessageGone);
    }
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
   * `asked` is the message being answered. A menu for one person must reply to
   * it, which is how Telegram knows whose keyboard to change.
   */
  private async send(destination: TelegramDestination, answer: Reply, asked?: number): Promise<number | undefined> {
    try {
      // Cut to Telegram's limit rather than rejected by it: a job card is
      // bounded, but a forum with a hundred topics is not.
      const messageId = await this.transport.sendMessage(
        destination,
        truncate(answer.lines.join('\n')),
        answer.markup,
        isSelective(answer.markup) ? asked : undefined,
      );
      // Every answer, the ones carrying the menu too: /clear ends by putting
      // the menu back, so taking an old one away no longer takes the keyboard.
      this.store.answerLog.remember(destination.chatId, messageId, destination.threadId);
      // The newest menu for everybody is the one kept under the input field.
      if (isMenu(answer.markup) && !isSelective(answer.markup) && this.store.isConfigured(destination.chatId)) {
        this.store.rememberMenu(destination.chatId, MENU_SIGNATURE, messageId);
      }
      return messageId;
    } catch (error) {
      this.logger.error(`Telegram reply failed: ${(error as Error).message}`);
      return undefined;
    }
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
    const where = this.whereAnswered(asked);
    // The "/clear" itself goes too, but is not counted as work done.
    const ids = this.store.answerLog.inTopic(where.chatId, where.threadId).filter((id) => id !== asked.messageId);
    if (asked.messageId !== undefined) {
      await this.removeOne(where.chatId, asked.messageId);
      this.store.answerLog.forget(where.chatId, [asked.messageId]);
    }
    if (ids.length === 0) {
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

    const removed = await this.removeAll(where.chatId, ids);
    this.store.answerLog.forget(where.chatId, ids);
    const stuck = ids.length - removed;
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

  /** True when the message is gone, including gone already. False is an answer, not a failure. */
  private async removeOne(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.transport.call('deleteMessage', { chat_id: chatId, message_id: messageId });
      return true;
    } catch (error) {
      /* too old, or the bot may not delete other people's messages here */
      return error instanceof TelegramApiError && error.isMessageGone;
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
    if (answer.jobId) return { lines, markup: cardKeyboard(answer.jobId, answer.server) };
    if (answer.jobs && answer.jobs.length > 0) {
      return { lines, markup: jobsKeyboard(answer.jobs, tail, answer.server) };
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

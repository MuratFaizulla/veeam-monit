import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { plural, stampOf } from '../live/format';
import { MONITOR, Monitor, MonitorAnswer } from '../monitor/monitor';
import { Answers, Asked, commandNamed, commandPressed, Reply } from './commands';
import { escapeHtml, truncate } from './format';
import { Action, cardKeyboard, decode, jobsKeyboard, mainKeyboard } from './keyboard';
import { TelegramStateStore } from './state.store';
import { TelegramTopicsService } from './topics.service';
import { TelegramTransportService } from './transport.service';
import {
  TelegramCallbackQuery,
  TelegramChat,
  TelegramDestination,
  TelegramMessage,
  TelegramUpdate,
} from './types';

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

type ButtonRow = Array<[string, Action]>;

/** Offered under a list of jobs, so the way back is never retyping a command. */
const SUMMARY_BUTTON: ButtonRow = [['📊 Сводка', { kind: 'summary' }]];
/** Under the summary itself, where another "Сводка" would say nothing. */
const REFRESH_SUMMARY_BUTTON: ButtonRow = [['🔄 Обновить', { kind: 'summary' }]];

/**
 * What an Update means: a command typed or a Button pressed in General,
 * answered there.
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
   * are all answered with silence.
   */
  async answer(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) await this.pressed(update.callback_query);
    else if (update.message) await this.typed(update.message);
  }

  private async typed(message: TelegramMessage): Promise<void> {
    if (!this.isGeneral(message.chat, message)) return;

    // Split rather than tokenised: everything after the command word is one
    // argument, kept in the case it was typed in.
    const text = message.text?.trim() ?? '';
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
    await this.send(this.whereAnswered(asked), await command.answer(this, asked));
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
   * nothing after it — except a job's own, which carries the job's id.
   */
  private async act(action: Action, asked: Asked): Promise<Reply | undefined> {
    if (action.kind === 'job') return this.reading(() => this.monitor.describeJobById(action.id));
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
    const reply = this.whereAnswered(asked);
    return {
      lines: [
        '<b>Veeam Monitor</b>',
        `<b>Chat ID:</b> <code>${escapeHtml(asked.chat.id)}</code>`,
        `<b>Форум:</b> ${asked.chat.is_forum ? 'да' : 'нет'}`,
        `<b>Топик:</b> <code>${escapeHtml(reply.threadId ?? 'General')}</code>`,
        `<b>Маршрутизация:</b> ${escapeHtml(this.config.routingMode)}`,
        '',
        ...this.healthLines(),
      ],
      markup: mainKeyboard(),
    };
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
   * `/clear` — take back the bot's own answers in General.
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
  async clear(asked: Asked): Promise<Reply> {
    const reply = this.whereAnswered(asked);
    // The "/clear" somebody typed is clutter of the same kind, but it is their
    // message: deleting it needs administrator rights the bot may not have, so
    // it is attempted and never depended on.
    if (asked.messageId !== undefined) await this.removeOne(reply.chatId, asked.messageId);

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
}

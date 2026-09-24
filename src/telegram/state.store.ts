import { Logger, OnModuleDestroy } from '@nestjs/common';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { LiveMessageRef, LiveMessages } from '../live/live-messages';
import { JobResults } from '../monitor/job-results';
import { AnswerLog, AnswerRef } from './answer-log';
import { Cooldowns } from './cooldowns';
import { TelegramChat } from './types';

interface TelegramState {
  version: 1;
  /** Chats the bot may post to, keyed by chat id. */
  chats: Record<string, TelegramChat>;
  /** Forum topic name -> message_thread_id, keyed by chat id. */
  topics: Record<string, Record<string, number>>;
  /** Last reported Veeam job result, keyed by job id. */
  jobResults: Record<string, string>;
  /** dedupeKey -> epoch ms after which the same condition may be reported again. */
  cooldowns: Record<string, number>;
  /** chat id -> slot -> the one message that slot keeps current. */
  liveMessages: Record<string, Record<string, LiveMessageRef>>;
  /** chat id -> answers this bot sent there, oldest first. */
  answers: Record<string, AnswerRef[]>;
}

const empty = (): TelegramState => ({
  version: 1,
  chats: {},
  topics: {},
  jobResults: {},
  cooldowns: {},
  liveMessages: {},
  answers: {},
});

/**
 * Everything the notifier must not forget across a restart, in one file.
 *
 * The store owns the file, the chats and the forum topics. The four other
 * things kept in it — job results, cooldowns, live messages and the answer log
 * — are each their own module, handed their part of the state and a way to
 * save it. They carry their own rules (48 hours, 500 answers, "never arm on
 * the way in") where somebody looking for those rules will find them, and are
 * tested on a plain object without a file.
 *
 * The state graph is deliberately private. It used to be handed out through a
 * public `data` getter, which made "mutate the object, then remember to call
 * save()" an unenforced ordering constraint spread over 18 call sites in three
 * modules — one of which forgot the save. Each operation below performs its own
 * write, so persistence is a property of the module rather than a habit of its
 * callers.
 *
 * The file is tiny and written rarely, so write-temp-then-rename is enough; no
 * database is introduced for it.
 */
export class TelegramStateStore implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramStateStore.name);
  private readonly state: TelegramState;
  private writeQueued = false;

  readonly jobResults: JobResults;
  readonly cooldowns: Cooldowns;
  readonly liveMessages: LiveMessages;
  readonly answerLog: AnswerLog;

  /**
   * `chatIds` are the chats named in configuration. They are registered here
   * rather than by whichever service happens to be constructed first: a
   * configured chat is usable before any update arrives, and making that depend
   * on provider order is how a monitor tick can find an empty registry.
   */
  constructor(
    private readonly filePath: string,
    chatIds: string[] = [],
  ) {
    this.state = this.load();
    const save = () => this.save();
    this.jobResults = new JobResults(this.state.jobResults, save);
    this.cooldowns = new Cooldowns(this.state.cooldowns, save);
    this.liveMessages = new LiveMessages(this.state.liveMessages, save);
    this.answerLog = new AnswerLog(this.state.answers, save);
    for (const id of chatIds) this.seedChat(id, { id: Number(id), type: 'supergroup' });
  }

  /** The debounced write may still be pending when the process stops. */
  onModuleDestroy(): void {
    this.flush();
  }

  /* ---------------------------------------------------------------- *
   * Chats
   * ---------------------------------------------------------------- */

  /** Every registered chat, as id/chat pairs. */
  chats(): Array<[string, TelegramChat]> {
    return Object.entries(this.state.chats);
  }

  /** Registers a configured chat id, without overwriting what is already known. */
  seedChat(id: string, chat: TelegramChat): void {
    if (this.state.chats[id]) return;
    this.state.chats[id] = chat;
    this.save();
  }

  /**
   * Merges freshly observed chat facts. Reports whether the chat is only now
   * known to be a forum, which is what lets topic creation be retried after an
   * administrator enables topics.
   */
  mergeChat(chat: TelegramChat): { becameForum: boolean } {
    const id = String(chat.id);
    const previous = this.state.chats[id];
    this.state.chats[id] = { ...previous, ...chat };
    this.save();
    return { becameForum: chat.is_forum === true && previous?.is_forum !== true };
  }

  /** Forgets a chat, every topic mapping belonging to it, and its live slots. */
  dropChat(chatId: string): void {
    delete this.state.chats[chatId];
    delete this.state.topics[chatId];
    this.liveMessages.dropChat(chatId);
    this.save();
  }

  /* ---------------------------------------------------------------- *
   * Forum topics
   * ---------------------------------------------------------------- */

  threadId(chatId: string, name: string): number | undefined {
    return this.state.topics[chatId]?.[name];
  }

  /** Copy, so a caller iterating topics cannot mutate the stored record. */
  topics(chatId: string): Record<string, number> {
    return { ...(this.state.topics[chatId] ?? {}) };
  }

  rememberTopic(chatId: string, name: string, threadId: number): void {
    const topics = (this.state.topics[chatId] ??= {});
    if (topics[name] === threadId) return;
    topics[name] = threadId;
    this.save();
  }

  forgetTopic(chatId: string, name: string): boolean {
    const topics = this.state.topics[chatId];
    if (!topics || topics[name] === undefined) return false;
    delete topics[name];
    this.save();
    return true;
  }

  /** Visible for tests: the persisted file, parsed. */
  snapshot(): TelegramState {
    return JSON.parse(JSON.stringify(this.state)) as TelegramState;
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  private load(): TelegramState {
    for (const path of [this.filePath, `${this.filePath}.bak`]) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TelegramState>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('state is not an object');
        }
        for (const key of ['chats', 'topics', 'jobResults', 'cooldowns', 'liveMessages'] as const) {
          const field = parsed[key];
          if (!field || typeof field !== 'object' || Array.isArray(field)) {
            throw new Error(`state field ${key} is invalid`);
          }
        }
        if (path !== this.filePath) {
          this.logger.warn(`Telegram state restored from ${path}`);
        }
        return { ...empty(), ...parsed, version: 1 };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(`Telegram state at ${path} is unreadable: ${(error as Error).message}`);
        }
      }
    }
    return empty();
  }

  /** Coalesces the burst of writes a single monitor tick produces. */
  private save(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    setImmediate(() => {
      this.writeQueued = false;
      this.flush();
    });
  }

  flush(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger.error(`Telegram state was not persisted: ${(error as Error).message}`);
      return;
    }
    try {
      // A second complete copy survives a damaged primary file on the next boot.
      copyFileSync(this.filePath, `${this.filePath}.bak`);
    } catch (error) {
      this.logger.warn(`Telegram state backup was not written: ${(error as Error).message}`);
    }
  }
}

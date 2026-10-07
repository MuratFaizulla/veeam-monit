import { Logger, OnModuleDestroy } from '@nestjs/common';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { LiveMessageRef, LiveMessages } from './live-messages';
import { JobMemory, memoryFromFile, RetryingRun } from './job-memory';
import { ServerMemory, ServerSeen, serversFromFile } from './server-memory';
import { AnswerLog, AnswerRef } from './answer-log';
import { Cooldowns } from './cooldowns';
import { TelegramChat } from './types';

/** The menu under a chat's input field: which layout, and the message that put it there. */
export interface MenuRef {
  signature: string;
  /** Unknown for a menu an older version posted, which did not keep it. */
  messageId?: number;
}

interface TelegramState {
  version: 1;
  /** Chats the bot may post to, keyed by chat id. */
  chats: Record<string, TelegramChat>;
  /** Forum topic name -> message_thread_id, keyed by chat id. */
  topics: Record<string, Record<string, number>>;
  /**
   * Last reported Veeam job result: server key -> job id -> result.
   *
   * A file written before there were several servers holds job id -> result
   * directly; it is read as the first server's.
   */
  jobResults: Record<string, Record<string, string>>;
  /**
   * Failed runs Veeam was still retrying when announced: server key -> job id
   * -> the run. Absent from files written before it existed, and read as empty.
   */
  retrying: Record<string, Record<string, RetryingRun>>;
  /**
   * server key -> whether it last answered and its account last signed in, as
   * the alerts said it. Absent from files written before it existed.
   */
  servers: Record<string, ServerSeen>;
  /** Key of the server the live slots and commands show; absent means the first. */
  selectedServer?: string;
  /**
   * chat id -> the menu under its input field and the message that put it
   * there. A bare string is what versions that did not keep the message wrote.
   */
  menus?: Record<string, string | MenuRef>;
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
  retrying: {},
  servers: {},
  cooldowns: {},
  liveMessages: {},
  answers: {},
});

/**
 * Everything the notifier must not forget across a restart, in one file.
 *
 * The store owns the file, the chats, the forum topics and which Veeam server
 * is selected. The other things kept in it — what is remembered about the
 * jobs and the servers, cooldowns, live messages and the answer log — are each their own
 * module, handed their part of the state and a way to save it. They carry their own rules (48 hours, 500 answers, "never arm on
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

  readonly cooldowns: Cooldowns;
  readonly liveMessages: LiveMessages;
  readonly answerLog: AnswerLog;
  private readonly memories = new Map<string, JobMemory>();
  private readonly serverMemories = new Map<string, ServerMemory>();
  /** The chats named in configuration: the only ones anything is sent to. */
  private readonly configured: ReadonlySet<string>;

  /**
   * `chatIds` are the chats named in configuration, and the only chats this
   * registry holds. They are registered here rather than by whichever service
   * happens to be constructed first: a configured chat is usable before any
   * update arrives, and making that depend on provider order is how a monitor
   * tick can find an empty registry.
   *
   * Nothing else is ever a recipient. The registry used to take any chat an
   * update came from, so whoever found the bot and wrote to it was sent every
   * alert and every live slot from then on. A chat remembered that way by an
   * older version is forgotten here, with its topics and live messages.
   *
   * `firstServer` is the key of the server listed first: the one whose job
   * results a file from before the server list holds.
   */
  constructor(
    private readonly filePath: string,
    chatIds: string[] = [],
    private readonly firstServer = '',
  ) {
    this.state = this.load();
    const save = () => this.save();
    this.cooldowns = new Cooldowns(this.state.cooldowns, save);
    this.liveMessages = new LiveMessages(this.state.liveMessages, save);
    this.answerLog = new AnswerLog(this.state.answers, save);
    this.configured = new Set(chatIds);
    // Only against a list: an empty one is a service not set up yet, and
    // wiping what it knew over a variable left blank would be the wrong trade.
    if (this.configured.size > 0) {
      for (const id of Object.keys(this.state.chats)) {
        if (this.configured.has(id)) continue;
        this.logger.warn(`Telegram chat ${id} is not in TELEGRAM_CHAT_IDS; forgotten`);
        this.dropChat(id);
      }
    }
    for (const id of chatIds) this.seedChat(id, { id: Number(id), type: 'supergroup' });
  }

  /** The debounced write may still be pending when the process stops. */
  onModuleDestroy(): void {
    this.flush();
  }

  /* ---------------------------------------------------------------- *
   * Veeam servers
   * ---------------------------------------------------------------- */

  /**
   * What is remembered about one server's jobs.
   *
   * Per server, because what the monitor compares against is per server: a
   * server added to the list has never been observed and must be seeded
   * quietly, whatever the others remember, and pruning one server's deleted
   * jobs must not take the other servers' jobs with them.
   */
  jobMemoryOf(server: string): JobMemory {
    let memory = this.memories.get(server);
    if (!memory) {
      const record = {
        results: (this.state.jobResults[server] ??= {}),
        retrying: (this.state.retrying[server] ??= {}),
      };
      memory = new JobMemory(record, () => this.save());
      this.memories.set(server, memory);
    }
    return memory;
  }

  /** What the alerts last said about one server: whether it answered, whether its account signed in. */
  serverMemoryOf(server: string): ServerMemory {
    let memory = this.serverMemories.get(server);
    if (!memory) {
      memory = new ServerMemory((this.state.servers[server] ??= {}), () => this.save());
      this.serverMemories.set(server, memory);
    }
    return memory;
  }

  /** Drops what is remembered about servers no longer configured. */
  keepServers(servers: ReadonlySet<string>): void {
    let changed = false;
    for (const part of [this.state.jobResults, this.state.retrying, this.state.servers]) {
      for (const server of Object.keys(part)) {
        if (servers.has(server)) continue;
        delete part[server];
        this.memories.delete(server);
        this.serverMemories.delete(server);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  selectedServer(): string | undefined {
    return this.state.selectedServer;
  }

  selectServer(server: string): void {
    if (this.state.selectedServer === server) return;
    this.state.selectedServer = server;
    this.save();
  }

  /* ---------------------------------------------------------------- *
   * The menu under the input field
   * ---------------------------------------------------------------- */

  /** The menu last put under this chat's input field, and the message it came with if known. */
  menuOf(chatId: string): MenuRef | undefined {
    const menu = this.state.menus?.[chatId];
    return typeof menu === 'string' ? { signature: menu } : menu;
  }

  rememberMenu(chatId: string, signature: string, messageId: number): void {
    (this.state.menus ??= {})[chatId] = { signature, messageId };
    this.save();
  }

  /* ---------------------------------------------------------------- *
   * Chats
   * ---------------------------------------------------------------- */

  /** Every chat things are sent to, as id/chat pairs: the configured ones. */
  chats(): Array<[string, TelegramChat]> {
    return Object.entries(this.state.chats).filter(([id]) => this.configured.has(id));
  }

  /** Whether this chat is one things are sent to. */
  isConfigured(chatId: string): boolean {
    return this.configured.has(chatId);
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
    if (!this.configured.has(id)) return { becameForum: false };
    const previous = this.state.chats[id];
    this.state.chats[id] = { ...previous, ...chat };
    this.save();
    return { becameForum: chat.is_forum === true && previous?.is_forum !== true };
  }

  /** Forgets a chat, every topic mapping belonging to it, its live slots and its answers. */
  dropChat(chatId: string): void {
    delete this.state.chats[chatId];
    delete this.state.topics[chatId];
    delete this.state.menus?.[chatId];
    delete this.state.answers[chatId];
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

  /**
   * Job results keyed by server. A file from before the server list keyed them
   * by job id alone, and every one of them was the first server's; read any
   * other way, the first cycle after the upgrade would find nothing remembered
   * and either stay quiet about a failure or repeat one already reported.
   */
  private byServer(jobResults: Record<string, unknown>): Record<string, unknown> {
    // Every value a string, not any: one stray string beside the servers' own
    // records used to have the whole map read as that older file, and every
    // server's memory lost to it.
    const values = Object.values(jobResults);
    const flat = values.length > 0 && values.every((value) => typeof value === 'string');
    if (!flat) return jobResults;
    const results: Record<string, string> = {};
    for (const [job, result] of Object.entries(jobResults)) {
      if (typeof result === 'string') results[job] = result;
    }
    return { [this.firstServer]: results };
  }

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
        // What is remembered about the jobs is checked entry by entry: one
        // entry this version cannot read is not worth the chats and topics.
        const memory = memoryFromFile(this.byServer(parsed.jobResults!), parsed.retrying, (message) =>
          this.logger.warn(message),
        );
        const servers = serversFromFile(parsed.servers, (message) => this.logger.warn(message));
        return { ...empty(), ...parsed, ...memory, servers, version: 1 };
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
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      this.logger.error(`Telegram state was not persisted: ${(error as Error).message}`);
      return;
    }
    try {
      // A second complete copy survives a damaged primary file on the next boot.
      copyFileSync(this.filePath, `${this.filePath}.bak`);
      chmodSync(`${this.filePath}.bak`, 0o600);
    } catch (error) {
      this.logger.warn(`Telegram state backup was not written: ${(error as Error).message}`);
    }
  }
}

import { Logger, OnModuleDestroy } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
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
}

/**
 * The single message a live slot owns. Surviving a restart is the whole point:
 * without the id, every start would post a fresh "current state" message next
 * to the previous one, which is exactly the pile this replaces.
 */
export interface LiveMessageRef {
  messageId: number;
  /** Hash of the meaningful content, so an unchanged message is not rewritten. */
  hash: string;
  /** Epoch ms of the last write, for the heartbeat refresh. */
  at: number;
}

const empty = (): TelegramState => ({
  version: 1,
  chats: {},
  topics: {},
  jobResults: {},
  cooldowns: {},
  liveMessages: {},
});

/**
 * Everything the notifier must not forget across a restart: which chats and
 * forum topics exist, what each job's last reported result was, and which
 * alerts are still inside their cooldown.
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

  /** Forgets a chat and every topic mapping belonging to it. */
  dropChat(chatId: string): void {
    delete this.state.chats[chatId];
    delete this.state.topics[chatId];
    delete this.state.liveMessages[chatId];
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

  /* ---------------------------------------------------------------- *
   * Job results
   * ---------------------------------------------------------------- */

  /** False on a installation never observed before — the seeding cycle. */
  hasJobResults(): boolean {
    return Object.keys(this.state.jobResults).length > 0;
  }

  trackedJobs(): number {
    return Object.keys(this.state.jobResults).length;
  }

  jobResult(jobId: string): string | undefined {
    return this.state.jobResults[jobId];
  }

  recordJobResult(jobId: string, result: string): void {
    if (this.state.jobResults[jobId] === result) return;
    this.state.jobResults[jobId] = result;
    this.save();
  }

  /** Jobs deleted in Veeam must not keep a slot in the file forever. */
  forgetJobsExcept(liveIds: Set<string | undefined>): void {
    let changed = false;
    for (const id of Object.keys(this.state.jobResults)) {
      if (liveIds.has(id)) continue;
      delete this.state.jobResults[id];
      changed = true;
    }
    if (changed) this.save();
  }

  /* ---------------------------------------------------------------- *
   * Cooldowns
   * ---------------------------------------------------------------- */

  /**
   * True when the condition is still inside its cooldown window.
   *
   * Checking and arming are two operations on purpose. Arming on the way in
   * burns the window even when the message never reaches Telegram, which
   * silences the next stretch of a real outage.
   */
  isSuppressed(key: string | undefined): boolean {
    if (!key) return false;
    return (this.state.cooldowns[key] ?? 0) > Date.now();
  }

  /** Starts the cooldown window. Call after the report actually went out. */
  armCooldown(key: string | undefined, cooldownMs: number | undefined): void {
    if (!key || !cooldownMs) return;
    const now = Date.now();
    this.state.cooldowns[key] = now + cooldownMs;
    for (const [existing, until] of Object.entries(this.state.cooldowns)) {
      if (until <= now) delete this.state.cooldowns[existing];
    }
    this.save();
  }

  /** Drops a cooldown so the next occurrence reports immediately. */
  clearCooldown(key: string): void {
    if (this.state.cooldowns[key] === undefined) return;
    delete this.state.cooldowns[key];
    this.save();
  }

  /* ---------------------------------------------------------------- *
   * Live messages
   * ---------------------------------------------------------------- */

  liveMessage(chatId: string, slot: string): LiveMessageRef | undefined {
    return this.state.liveMessages[chatId]?.[slot];
  }

  rememberLiveMessage(chatId: string, slot: string, ref: LiveMessageRef): void {
    (this.state.liveMessages[chatId] ??= {})[slot] = ref;
    this.save();
  }

  /** Called when Telegram no longer holds the message, so the next pass resends. */
  forgetLiveMessage(chatId: string, slot: string): void {
    if (this.state.liveMessages[chatId]?.[slot] === undefined) return;
    delete this.state.liveMessages[chatId][slot];
    this.save();
  }

  /** Visible for tests: the persisted file, parsed. */
  snapshot(): TelegramState {
    return JSON.parse(JSON.stringify(this.state)) as TelegramState;
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  private load(): TelegramState {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<TelegramState>;
      return { ...empty(), ...parsed, version: 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt file must not stop the service from booting: monitoring
        // restarts from a clean slate instead, which costs one quiet cycle.
        this.logger.warn(`Telegram state at ${this.filePath} is unreadable, starting empty`);
      }
      return empty();
    }
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
    }
  }
}

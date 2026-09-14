import { Logger } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { TelegramChat } from './telegram.types';

export interface TelegramState {
  version: 1;
  /** Chats the bot may post to, keyed by chat id. */
  chats: Record<string, TelegramChat>;
  /** Forum topic name -> message_thread_id, keyed by chat id. */
  topics: Record<string, Record<string, number>>;
  /** Last seen Veeam job result, keyed by job id. */
  jobResults: Record<string, string>;
  /** dedupeKey -> epoch ms after which the same condition may be reported again. */
  cooldowns: Record<string, number>;
}

const empty = (): TelegramState => ({
  version: 1,
  chats: {},
  topics: {},
  jobResults: {},
  cooldowns: {},
});

/**
 * Small JSON file holding everything the notifier must not forget across a
 * restart: which chats and forum topics exist, what each job's last reported
 * result was, and which alerts are still inside their cooldown.
 *
 * Without it a restart re-creates every topic and either re-announces every
 * currently failing job or (as the first implementation did) silently swallows
 * the first round of changes. The file is tiny and written rarely, so a plain
 * write-temp-then-rename is enough; no database is introduced for it.
 */
export class TelegramStateStore {
  private readonly logger = new Logger(TelegramStateStore.name);
  private readonly state: TelegramState;
  private writeQueued = false;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  get data(): TelegramState {
    return this.state;
  }

  private load(): TelegramState {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<TelegramState>;
      return { ...empty(), ...parsed, version: 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt file must not stop the backend from booting: monitoring
        // restarts from a clean slate instead, which only costs one quiet cycle.
        this.logger.warn(`Telegram state at ${this.filePath} is unreadable, starting empty`);
      }
      return empty();
    }
  }

  /** Coalesces the bursts of writes a single monitor tick produces. */
  save(): void {
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

  /**
   * True when the condition is still inside its cooldown window.
   *
   * Checking and arming are deliberately two operations. Arming on the way in
   * — as a single `allow()` used to — burns the window even when the message
   * never reaches Telegram, which silences the next N minutes of a real
   * outage. Callers arm only once delivery actually succeeded.
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
    this.prune(now);
    this.save();
  }

  /** Drops a cooldown so the next occurrence reports immediately. */
  clearCooldown(key: string): void {
    if (this.state.cooldowns[key] === undefined) return;
    delete this.state.cooldowns[key];
    this.save();
  }

  private prune(now: number): void {
    for (const [key, until] of Object.entries(this.state.cooldowns)) {
      if (until <= now) delete this.state.cooldowns[key];
    }
  }
}

/**
 * The message each live slot owns, per chat. Surviving a restart is the whole
 * point: without the id, every start would post a fresh "current state"
 * message next to the previous one, which is exactly the pile this replaces.
 *
 * Holds a record owned by the state store and calls `save` after each change;
 * it knows nothing about files. A test hands it a plain object.
 */

/** The single message a live slot owns. */
export interface LiveMessageRef {
  messageId: number;
  /** Hash of the meaningful content, so an unchanged message is not rewritten. */
  hash: string;
  /** Epoch ms of the last write, for the heartbeat refresh. */
  at: number;
  /**
   * Epoch ms the message was posted.
   *
   * Distinct from `at`, and the distinction is the whole point: Telegram stops
   * letting a bot edit or delete its own message about two days after it was
   * *sent*, however recently it was last written to. A slot kept current for
   * three days therefore cannot go on being one message, and the id has to be
   * retired while it can still be deleted.
   *
   * Absent on a ref written before this existed; such a message is of unknown
   * age, which is treated as "old enough to retire now".
   */
  createdAt?: number;
  /**
   * The forum topic the message was posted into.
   *
   * Preferred over resolving the configured topic name again. Editing a
   * message needs no name, so a topic renamed in Telegram stays invisible for
   * as long as the message survives — and then, the first time a new message
   * is needed, the configured name matches nothing and a second topic is
   * created beside the first.
   */
  threadId?: number;
}

export class LiveMessages {
  constructor(
    private readonly byChat: Record<string, Record<string, LiveMessageRef>>,
    private readonly save: () => void,
  ) {}

  of(chatId: string, slot: string): LiveMessageRef | undefined {
    return this.byChat[chatId]?.[slot];
  }

  remember(chatId: string, slot: string, ref: LiveMessageRef): void {
    (this.byChat[chatId] ??= {})[slot] = ref;
    this.save();
  }

  /** Called when Telegram no longer holds the message, so the next pass resends. */
  forget(chatId: string, slot: string): void {
    if (this.byChat[chatId]?.[slot] === undefined) return;
    delete this.byChat[chatId][slot];
    this.save();
  }

  /** A chat that removed the bot takes its slots with it. */
  dropChat(chatId: string): void {
    if (this.byChat[chatId] === undefined) return;
    delete this.byChat[chatId];
    this.save();
  }
}

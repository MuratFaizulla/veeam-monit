/**
 * The Answer log: which answers the bot sent, per chat and topic, so `/clear`
 * has something to take back.
 *
 * The Bot API cannot enumerate a chat's history and cannot clear it: a bot may
 * delete a message only if it knows the id, so the ids it will ever be able to
 * delete are exactly the ones it wrote down at the time.
 *
 * Alerts and live slot messages are deliberately not here. An alert is the
 * record of something that happened and deleting it destroys that record; a
 * live message is the slot, and deleting it orphans the id the slot is kept
 * under. `/clear` is for the chatter, which is what actually piles up.
 *
 * Holds a record owned by the state store and calls `save` after each change;
 * it knows nothing about files. A test hands it a plain object.
 */

/** One message the bot sent as an answer — a command reply or a button's result. */
export interface AnswerRef {
  messageId: number;
  /** The forum topic it was sent to; absent means General. */
  threadId?: number;
  /** Epoch ms, so answers Telegram will no longer let a bot delete are dropped. */
  at: number;
}

/**
 * Telegram refuses to let a bot delete its own message after 48 hours, so an
 * older id is worth neither storing nor trying.
 */
export const DELETABLE_MS = 48 * 3_600_000;

/** Ceiling per chat. A deep backlog is not what anybody is trying to clear. */
export const ANSWERS_KEPT = 500;

export class AnswerLog {
  constructor(
    private readonly byChat: Record<string, AnswerRef[]>,
    private readonly save: () => void,
  ) {}

  /** Records an answer so `/clear` has something to take back. */
  remember(chatId: string, messageId: number, threadId?: number): void {
    const kept = this.fresh(chatId);
    kept.push({ messageId, threadId, at: Date.now() });
    this.byChat[chatId] = kept.slice(-ANSWERS_KEPT);
    this.save();
  }

  /**
   * The answers still worth deleting in one topic, newest first.
   *
   * Scoped to the thread on purpose: clearing a forum topic must not reach into
   * the others, where somebody may be mid-conversation. `undefined` is General,
   * and is its own scope rather than "everything".
   */
  inTopic(chatId: string, threadId?: number): number[] {
    return this.fresh(chatId)
      .filter((answer) => answer.threadId === threadId)
      .map((answer) => answer.messageId)
      .reverse();
  }

  /** Called once the messages are gone, or Telegram says they already were. */
  forget(chatId: string, messageIds: number[]): void {
    const gone = new Set(messageIds);
    const kept = this.fresh(chatId).filter((answer) => !gone.has(answer.messageId));
    if (kept.length === 0) delete this.byChat[chatId];
    else this.byChat[chatId] = kept;
    this.save();
  }

  /** Drops what Telegram would refuse to delete anyway, without a write. */
  private fresh(chatId: string): AnswerRef[] {
    const cutoff = Date.now() - DELETABLE_MS;
    return (this.byChat[chatId] ?? []).filter((answer) => answer.at > cutoff);
  }
}

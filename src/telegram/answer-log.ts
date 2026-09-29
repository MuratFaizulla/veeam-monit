/**
 * The Answer log: the messages said in General, per chat, so `/clear` has
 * something to take back. Named for what it first held — the bot's answers —
 * and now everything there: what people typed, the keys they pressed, the
 * bot's answers and menus, and the events it posts to General.
 *
 * The Bot API cannot enumerate a chat's history and cannot clear it: a bot may
 * delete a message only if it knows the id, so the ids it will ever be able to
 * delete are exactly the ones it wrote down at the time.
 *
 * Alerts in their topics and live slot messages are not here. An alert is the
 * record of something that happened; a live message is the slot, and deleting
 * it orphans the id the slot is kept under. `/clear` is for General, which is
 * where the chatter piles up.
 *
 * Holds a record owned by the state store and calls `save` after each change;
 * it knows nothing about files. A test hands it a plain object.
 */

/** One message said in General, by anybody. */
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

  /** Records a message so `/clear` has something to take back. Once per message. */
  remember(chatId: string, messageId: number, threadId?: number): void {
    const kept = this.fresh(chatId).filter((answer) => answer.messageId !== messageId);
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

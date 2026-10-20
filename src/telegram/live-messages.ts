import type { PostedRef } from './posted-messages';

/**
 * The messages the bot answers for, per chat: the one each page of a live
 * slot owns, and those waiting to be deleted (`PostedMessages`). Surviving a
 * restart is the whole point: without the id, every start would post a fresh
 * "current state" message next to the previous one, which is exactly the pile
 * this replaces; and a message that could not be deleted would stay for good.
 *
 * How they are keyed in the record is this module's alone: a slot's first
 * page under the slot's name, the next ones as `slot#1`, `slot#2`, and a
 * message waiting to be deleted as `~id`. The state file keeps them so, which
 * older versions read too.
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

/**
 * The key prefix of a message no slot owns any more but Telegram has not yet
 * deleted. Kept in the same record as the slots, which no slot name begins with.
 */
const LEFTOVER = '~';

/**
 * The key of one page of a slot. Page 0 keeps the bare slot name, so that a
 * slot which never grew past one message keeps the id it already has.
 */
const pageKey = (slot: string, page: number): string => (page === 0 ? slot : `${slot}#${page}`);

export class LiveMessages {
  constructor(
    /** A slot's page holds a whole ref, a leftover only what deleting it needs. */
    private readonly byChat: Record<string, Record<string, LiveMessageRef | PostedRef>>,
    private readonly save: () => void,
  ) {}

  /** The message this page of the slot owns in this chat. */
  of(chatId: string, slot: string, page = 0): LiveMessageRef | undefined {
    // A page's key is only ever written by `remember`, with a whole ref.
    return this.byChat[chatId]?.[pageKey(slot, page)] as LiveMessageRef | undefined;
  }

  remember(chatId: string, slot: string, ref: LiveMessageRef, page = 0): void {
    (this.byChat[chatId] ??= {})[pageKey(slot, page)] = ref;
    this.save();
  }

  /** Called when the page no longer owns its message, so the next pass posts one. */
  forget(chatId: string, slot: string, page = 0): void {
    this.drop(chatId, pageKey(slot, page));
  }

  /**
   * A message the bot gave up that Telegram would not delete just then — a
   * dropped connection, a 429. Remembered, across restarts, for a later
   * pass to delete; forgotten at once, a slot's stayed in the topic for
   * good, frozen at its last content beside the slot's new message.
   */
  leave(chatId: string, message: PostedRef): void {
    const { messageId, createdAt } = message;
    (this.byChat[chatId] ??= {})[`${LEFTOVER}${messageId}`] = { messageId, createdAt };
    this.save();
  }

  /** The messages of this chat still waiting to be deleted. */
  leftovers(chatId: string): PostedRef[] {
    return Object.entries(this.byChat[chatId] ?? {})
      .filter(([key]) => key.startsWith(LEFTOVER))
      .map(([, ref]) => ref);
  }

  /** The leftover is deleted, or never will be. */
  cleared(chatId: string, messageId: number): void {
    this.drop(chatId, `${LEFTOVER}${messageId}`);
  }

  /** A chat that removed the bot takes its slots with it. */
  dropChat(chatId: string): void {
    if (this.byChat[chatId] === undefined) return;
    delete this.byChat[chatId];
    this.save();
  }

  private drop(chatId: string, key: string): void {
    if (this.byChat[chatId]?.[key] === undefined) return;
    delete this.byChat[chatId][key];
    this.save();
  }
}

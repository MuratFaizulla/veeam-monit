import { Logger } from '@nestjs/common';
import type { LiveMessageRef, LiveMessages } from './live-messages';
import type { TelegramTransportService } from './transport.service';

/** Telegram lets a bot delete a message for 48 hours after it was sent, and no longer. */
export const DELETABLE_MS = 48 * 3_600_000;

/**
 * How long a message is kept before a fresh one takes its place.
 *
 * Under Telegram's own limit of roughly 48 hours, with room for a monitor that
 * was down for a few hours and comes back to a message nearly out of time.
 */
const REPLACE_AFTER_MS = 36 * 3_600_000;

/** Telegram takes at most 100 message ids in one deleteMessages call. */
const DELETE_BATCH = 100;

/** A message the bot answers for: its id, and when it was sent where that is known. */
export type PostedRef = Pick<LiveMessageRef, 'messageId' | 'createdAt'>;

/** What deleting asks of the transport: the transport's, or a test's that says how each call ended. */
export type Deleting = Pick<TelegramTransportService, 'deleteMessage' | 'deleteMessages'>;

/**
 * The life of a message the bot posted, against Telegram's clock. Telegram
 * lets a bot edit and delete its own message for about two days after it was
 * sent, however recently it was written to, and then never again.
 *
 * So a message kept current — a live slot's — is replaced 36 hours after it
 * was sent (`due`). One the bot no longer wants — a slot's replaced message,
 * a menu of an older layout, what /clear takes back — is deleted until it is
 * gone or refused (`delete`): one Telegram was not answering for is kept in
 * the state file, across restarts, and deleted on a later pass (`sweep`), and
 * one still there 48 hours after it was sent is written off to the log, for a
 * person to remove. The same goes for a message people wrote, which /clear
 * takes back with the bot's own.
 *
 * It used to be three protocols with three answers. The live module kept what
 * it could not delete for a later cycle; General asked once to delete the menu
 * it replaced and ignored the answer, so one dropped connection left the old
 * menu for good; and /clear forgot every message it tried, deleted or not, and
 * counted a 429 among the ones the bot may not delete.
 *
 * How a call ended is the transport's to say. A chat the bot was removed from
 * is no answer about a message: the transport's error is thrown, for the
 * caller to let the chat go as Delivery does.
 */
export class PostedMessages {
  private readonly logger = new Logger(PostedMessages.name);

  constructor(
    private readonly transport: Deleting,
    private readonly messages: LiveMessages,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Whether it is time to replace this message with a fresh one: 36 hours
   * after it was sent, or at once when that is not known.
   *
   * Replacing early costs one extra message every day and a half. Replacing
   * late costs a message nobody can remove, saying something wrong, for as
   * long as the chat exists.
   */
  due(message: PostedRef): boolean {
    return this.now() - (message.createdAt ?? 0) > REPLACE_AFTER_MS;
  }

  /**
   * Deletes these messages, many to a call where Telegram takes them, and
   * says what became of each. One Telegram was not answering for is kept for
   * `sweep`.
   */
  async delete(chatId: string, messages: PostedRef[]): Promise<Deleted> {
    const ended = await this.attempt(chatId, messages);
    for (const message of messages) {
      if (ended.pending.includes(message.messageId)) this.messages.leave(chatId, message);
    }
    return ended;
  }

  /**
   * The later pass: deletes what Telegram was not answering for before. One
   * Telegram refuses now, or still there 48 hours after it was sent — or of
   * an age nobody knows, which counts as old — is not asked about again but
   * said in the log, for a person to remove.
   */
  async sweep(chatId: string): Promise<void> {
    const left = this.messages.leftovers(chatId);
    const late = left.filter((message) => this.now() - (message.createdAt ?? 0) > DELETABLE_MS);
    const ended = await this.attempt(chatId, left.filter((message) => !late.includes(message)));
    for (const messageId of ended.deleted) this.messages.cleared(chatId, messageId);
    for (const messageId of [...late.map((message) => message.messageId), ...ended.stuck]) {
      this.messages.cleared(chatId, messageId);
      this.logger.warn(`Message ${messageId} in chat ${chatId} could not be deleted in time: delete it by hand`);
    }
  }

  private async attempt(chatId: string, messages: PostedRef[]): Promise<Deleted> {
    const ended: Deleted = { deleted: [], pending: [], stuck: [] };
    for (let from = 0; from < messages.length; from += DELETE_BATCH) {
      const batch = messages.slice(from, from + DELETE_BATCH).map(({ messageId }) => messageId);
      if (batch.length > 1) {
        const all = await this.transport.deleteMessages(chatId, batch);
        if (all.outcome === 'chat-gone') throw all.error;
        if (all.outcome === 'done' || all.outcome === 'later') {
          // Unanswered as a whole, each would be too: asked one by one, a
          // hundred calls would go to a chat Telegram is not answering.
          ended[all.outcome === 'done' ? 'deleted' : 'pending'].push(...batch);
          continue;
        }
      }
      // One message that cannot go — too old, or not the bot's to delete —
      // fails the whole call, so the rest go one at a time.
      for (const messageId of batch) {
        const one = await this.transport.deleteMessage(chatId, messageId);
        if (one.outcome === 'chat-gone') throw one.error;
        if (one.outcome === 'done') ended.deleted.push(messageId);
        else if (one.outcome === 'later') ended.pending.push(messageId);
        else ended.stuck.push(messageId);
      }
    }
    return ended;
  }
}

/** What deleting some messages came to, by message id. */
export interface Deleted {
  /** Gone: deleted now, or by somebody before. */
  deleted: number[];
  /** Telegram was not answering — a dropped connection, a 429, a 5xx: deleted on a later pass. */
  pending: number[];
  /** Telegram refused — too old, or not the bot's to delete: only a person can remove them. */
  stuck: number[];
}

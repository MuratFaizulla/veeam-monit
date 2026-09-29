import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppConfig } from '../config/configuration';
import { TelegramStateStore } from '../telegram/state.store';
import { TelegramTopicsService } from '../telegram/topics.service';
import { TelegramApiError, TelegramTransportService } from '../telegram/transport.service';
import { TelegramChat } from '../telegram/types';
import { isFooter } from './format';
import { LiveSlot, specOf } from './slots';
import { LiveMessageRef } from '../telegram/live-messages';

/**
 * How long a live slot keeps one message before posting a fresh one.
 *
 * Under Telegram's own limit of roughly 48 hours, with room for a monitor that
 * was down for a few hours and comes back to a message nearly out of time.
 */
const ROTATE_AFTER_MS = 36 * 3_600_000;

export { LiveSlot };

/**
 * The "one message, always current" module.
 *
 * A notification is an event: it happened, it is worth a ping, and it stays in
 * the history. State is not. Posting the current state as an event produced the
 * pile this replaces — six identical "monitor started" messages in a row, each
 * one a notification, none of them the answer to "is it working right now?".
 *
 * So a live slot owns a single message and edits it in place. The id is
 * persisted, which is what makes a restart continue the same message instead of
 * starting a second one; if Telegram no longer has it, the stale one is deleted
 * and a new one takes over the slot.
 */
@Injectable()
export class TelegramLiveService {
  private readonly logger = new Logger(TelegramLiveService.name);
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly store: TelegramStateStore,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  /**
   * Makes `content` the content of this slot in every registered chat.
   *
   * A slot usually owns one message. Where a list is too long for Telegram's
   * limit to be an honest cap, it may own several: each page is its own message
   * in the same topic, edited in place like the first, and pages that are no
   * longer needed are deleted rather than left behind saying something stale.
   *
   * Never throws: a status message that could not be refreshed must not abort
   * the monitor cycle that produced it.
   */
  async publish(slot: LiveSlot, content: string | string[]): Promise<void> {
    if (!this.config.live || !this.transport.enabled) return;
    const pages = (Array.isArray(content) ? content : [content]).filter((page) => page.length > 0);
    if (pages.length === 0) return;

    for (const [chatId, chat] of this.store.chats()) {
      try {
        for (const [index, page] of pages.entries()) {
          await this.publishTo(chatId, chat, slot, page, index);
        }
        await this.prune(chatId, slot, pages.length);
      } catch (error) {
        this.logger.error(
          `Live "${slot}" was not refreshed in chat ${chatId}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * The store key for one page of a slot. Page 0 keeps the bare slot name so
   * that a slot which never grew past one message keeps the id it already has.
   */
  private key(slot: LiveSlot, index: number): string {
    return index === 0 ? slot : `${slot}#${index}`;
  }

  /** Removes the pages a now-shorter list no longer fills. */
  private async prune(chatId: string, slot: LiveSlot, pages: number): Promise<void> {
    for (let index = Math.max(pages, 1); ; index += 1) {
      const key = this.key(slot, index);
      const ref = this.store.liveMessages.of(chatId, key);
      if (!ref) return;
      this.store.liveMessages.forget(chatId, key);
      await this.remove(chatId, ref.messageId);
    }
  }

  private async publishTo(
    chatId: string,
    chat: TelegramChat,
    slot: LiveSlot,
    text: string,
    index = 0,
  ): Promise<void> {
    const key = this.key(slot, index);
    const hash = this.hash(text);
    const held = this.store.liveMessages.of(chatId, key);

    // Retired while Telegram still answers for it. A slot's message is edited
    // for as long as the slot exists, but the right to edit or delete one's own
    // message runs out about two days after it was *sent*, however recently it
    // was last written. A long-lived slot therefore eventually meets an edit
    // that fails and a delete that fails with it, and is left with a message
    // frozen at its last good content and a second one posted beside it. That
    // is what the ▶️ topic did: two messages, one stuck a day behind.
    const previous = held && !this.expired(held) ? held : undefined;
    if (held && !previous) {
      this.store.liveMessages.forget(chatId, key);
      await this.remove(chatId, held.messageId);
    }

    // Unchanged content is not rewritten, or a bot that is merely alive would
    // edit two messages a minute forever. The heartbeat still refreshes it now
    // and then, so a frozen "обновлено" is evidence the monitor stopped.
    const spec = specOf(slot);
    let current = previous;
    if (current && current.hash === hash) {
      if (Date.now() - current.at < this.config.liveRefreshMs) return;

      // A pinned slot is never rewritten on the heartbeat, because moving its
      // timestamp is churn the whole room sees. That left it with no reason to
      // ever look at its message again — so when somebody deleted the message
      // by hand, the topic stayed empty for good and nothing anywhere noticed.
      // Asked about instead of written to: this changes nothing and still says
      // whether the message is there.
      if (!spec.heartbeat) {
        if (await this.present(chatId, current.messageId)) {
          this.store.liveMessages.remember(chatId, key, { ...current, at: Date.now() });
          return;
        }
        this.logger.warn(`Live "${slot}" message ${current.messageId} is gone from chat ${chatId}, posting a new one`);
        this.store.liveMessages.forget(chatId, key);
        current = undefined;
      }
    }

    if (current) {
      const outcome = await this.edit(chatId, current.messageId, text);
      if (outcome === 'written') {
        this.store.liveMessages.remember(chatId, key, {
          messageId: current.messageId,
          hash,
          at: Date.now(),
          createdAt: current.createdAt,
          threadId: current.threadId,
        });
        return;
      }

      // A failed call is not a lost message. Every failure used to count as
      // one, so a 429 or a dropped connection — which failed the delete tried
      // next just the same — posted a second message beside a first that was
      // still there: the ▶️ topic gained one every hour or two. Kept instead,
      // and written on the next cycle, because the stored hash still differs.
      if (outcome !== 'lost') {
        this.logger.warn(
          `Live "${slot}" message ${current.messageId} in chat ${chatId} was not refreshed, ` +
            `kept for the next cycle: ${outcome.message}`,
        );
        return;
      }

      this.store.liveMessages.forget(chatId, key);
      // An edit that failed on a message too old to delete leaves it in the
      // chat for good, and only a person can clear it. Said out loud rather
      // than swallowed, because the alternative is somebody reading a stale
      // status for weeks and nobody knowing why it is there.
      if (!(await this.remove(chatId, current.messageId))) {
        this.logger.warn(
          `Live "${slot}" left message ${current.messageId} behind in chat ${chatId}: ` +
            'Telegram refused both the edit and the deletion, so it must be removed by hand',
        );
      }
    }

    const now = Date.now();
    // The thread the slot was last posted in, preferred over resolving the
    // configured name again. Somebody renaming the topic in Telegram used to
    // be invisible for as long as the message survived — nothing resolves a
    // name to edit a message — and then produced a second topic the moment a
    // new message was needed. That is how this chat ended up with both
    // "📅 Ближайшие запуски" and "📅 Upcoming runs", one of them empty.
    const posted = await this.send(chat, slot, text, held?.threadId ?? previous?.threadId);
    this.store.liveMessages.remember(chatId, key, {
      messageId: posted.messageId,
      hash,
      at: now,
      createdAt: now,
      threadId: posted.threadId,
    });
    if (spec.pinned) await this.pin(chatId, posted.messageId);
  }

  /**
   * Whether Telegram still holds this message, asked without changing it.
   *
   * An empty markup edit on a message that has none is refused as "not
   * modified", which is the answer: the message is there. A message that is
   * gone answers "not found" instead. Anything else says nothing about the
   * message and is read as "still there", because the cost of being wrong that
   * way is one late refresh, and the cost of the other way is a duplicate.
   */
  private async present(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.transport.call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
      });
      return true;
    } catch (error) {
      return !(error instanceof TelegramApiError && error.isMessageGone);
    }
  }

  /**
   * Whether this message is close enough to Telegram's two-day limit that the
   * next edit might fail — or is of unknown age, which amounts to the same.
   *
   * Retiring early costs one extra message per slot every day and a half.
   * Retiring late costs a message nobody can remove, saying something wrong,
   * for as long as the chat exists.
   */
  private expired(ref: LiveMessageRef): boolean {
    return Date.now() - (ref.createdAt ?? 0) > ROTATE_AFTER_MS;
  }

  /**
   * Writes `text` into the existing message and says what became of it:
   * `written`, `lost` when Telegram says the message is deleted or too old to
   * edit — the only answers a new message fixes — or the error of a call that
   * merely failed, with the message still there.
   */
  private async edit(chatId: string, messageId: number, text: string): Promise<'written' | 'lost' | Error> {
    try {
      await this.transport.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return 'written';
    } catch (error) {
      if (error instanceof TelegramApiError) {
        // Telegram refuses a no-op edit. The message already says what we
        // wanted it to say, so the slot is current either way.
        if (error.isUnchanged) return 'written';
        if (error.isMessageGone || error.isUneditable) return 'lost';
      }
      return error as Error;
    }
  }

  /**
   * Posts the slot's new message and says where it landed.
   *
   * `remembered` is the thread this slot used last time, preferred over the
   * configured topic name so that renaming the topic in Telegram does not
   * silently split the slot across two. A thread Telegram no longer has is
   * recovered from inside `topics.send`, which falls back to the name.
   *
   * A slot with a thread id set by hand in configuration outranks both: that
   * one is somebody saying explicitly where the slot belongs.
   */
  private async send(
    chat: TelegramChat,
    slot: LiveSlot,
    text: string,
    remembered?: number,
  ): Promise<{ messageId: number; threadId?: number }> {
    const fixedThread = specOf(slot).fixedThread;
    const configured = fixedThread ? this.config[fixedThread] : 0;
    const thread = configured > 0 ? configured : remembered ?? 0;
    return this.topics.send(chat, this.config.liveTopics[slot], text, thread);
  }

  /** Pinning is optional: missing administrator rights must not break updates. */
  private async pin(chatId: string, messageId: number): Promise<void> {
    try {
      await this.transport.call('pinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true,
      });
    } catch (error) {
      this.logger.debug(`Performance message could not be pinned in ${chatId}: ${(error as Error).message}`);
    }
  }

  /**
   * Best effort: an orphaned status message is noise, not a failure. True when
   * the message is no longer in the chat — including when it was already gone,
   * deleted by somebody or together with its topic, which is what was wanted.
   */
  private async remove(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.transport.call('deleteMessage', { chat_id: chatId, message_id: messageId });
      return true;
    } catch (error) {
      /* older than Telegram lets a bot delete, or the call itself failed */
      return error instanceof TelegramApiError && error.isMessageGone;
    }
  }

  /**
   * The "обновлено" line moves every cycle by design, so it is excluded from
   * the comparison; otherwise nothing would ever count as unchanged. Which
   * line that is, is asked of the module that writes it.
   */
  private hash(text: string): string {
    const meaningful = text
      .split('\n')
      .filter((line) => !isFooter(line))
      .join('\n');
    return createHash('sha1').update(meaningful).digest('hex');
  }
}

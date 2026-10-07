import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppConfig } from '../config/configuration';
import { TelegramStateStore } from '../telegram/state.store';
import { TelegramTopicsService } from '../telegram/topics.service';
import { TelegramApiError, TelegramTransportService } from '../telegram/transport.service';
import { TelegramChat } from '../telegram/types';
import { isFooter } from './format';
import { LIVE_SLOTS, LivePage, LiveSlot, RETIRED_SLOTS, specOf } from './slots';
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
 *
 * It is handed a whole cycle's pages, and a slot not among them is taken down:
 * one switched off by a setting, one that no longer exists, or every slot while
 * TELEGRAM_LIVE is off. Each used to be somebody else's to remember. The
 * monitor deleted the retired slots itself, and nothing deleted a slot switched
 * off — 🧹, turned off, kept its last message, frozen, until it was too old for
 * the bot to delete.
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
   * Makes the live topics say this cycle's pages, in every registered chat, and
   * nothing else: a slot not among them has its messages deleted, once, while
   * Telegram still lets the bot delete them.
   *
   * Never throws: a status message that could not be refreshed must not abort
   * the monitor cycle that produced it.
   */
  async publish(pages: readonly LivePage[]): Promise<void> {
    if (!this.transport.enabled) return;
    const shown = this.config.live ? pages : [];
    for (const { slot, content } of shown) await this.publishSlot(slot, content);
    const given = new Set<string>(shown.map(({ slot }) => slot));
    for (const slot of [...Object.keys(LIVE_SLOTS), ...RETIRED_SLOTS]) {
      if (!given.has(slot)) await this.takeDown(slot);
    }
  }

  /**
   * Makes `content` the content of this slot in every registered chat.
   *
   * A slot usually owns one message. Where a list is too long for Telegram's
   * limit to be an honest cap, it may own several: each page is its own message
   * in the same topic, edited in place like the first, and pages that are no
   * longer needed are deleted rather than left behind saying something stale.
   */
  private async publishSlot(slot: LiveSlot, content: string | string[]): Promise<void> {
    const pages = (Array.isArray(content) ? content : [content]).filter((page) => page.length > 0);
    if (pages.length === 0) return;

    for (const [chatId, chat] of this.store.chats()) {
      try {
        // A page posted anew lands at the bottom of the topic, under the pages
        // after it, so those are posted again too. Each page used to be
        // retired on its own clock: 🗂's continuation was replaced at 11:48,
        // its first page at 11:54, and the topic read "— продолжение" above
        // the list it continued for a day and a half at a time.
        let reposted = false;
        for (const [index, page] of pages.entries()) {
          reposted = (await this.publishTo(chatId, chat, slot, page, index, reposted)) || reposted;
        }
        // The pages a now-shorter list no longer fills.
        await this.removeFrom(chatId, slot, Math.max(pages.length, 1));
      } catch (error) {
        this.logger.error(
          `Live "${slot}" was not refreshed in chat ${chatId}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Deletes what a slot nobody writes to left in every chat: its message and
   * its further pages. Nothing is asked of Telegram once they are gone.
   */
  private async takeDown(slot: string): Promise<void> {
    for (const [chatId] of this.store.chats()) {
      for (const messageId of await this.removeFrom(chatId, slot, 0)) {
        this.logger.warn(`Live "${slot}" left message ${messageId} behind in chat ${chatId}: delete it by hand`);
      }
    }
  }

  /**
   * Forgets a slot's pages from `from` on and deletes their messages; says
   * which of them Telegram would not delete.
   */
  private async removeFrom(chatId: string, slot: string, from: number): Promise<number[]> {
    const left: number[] = [];
    for (let index = from; ; index += 1) {
      const key = pageKey(slot, index);
      const ref = this.store.liveMessages.of(chatId, key);
      if (!ref) return left;
      this.store.liveMessages.forget(chatId, key);
      if (!(await this.transport.deleteMessage(chatId, ref.messageId))) left.push(ref.messageId);
    }
  }

  /**
   * Makes one page current, and says whether that took a new message.
   * `repost` replaces the page's message even when it could be edited, because
   * a page before it was just posted below it.
   */
  private async publishTo(
    chatId: string,
    chat: TelegramChat,
    slot: LiveSlot,
    text: string,
    index = 0,
    repost = false,
  ): Promise<boolean> {
    const key = pageKey(slot, index);
    const hash = this.hash(text);
    const held = this.store.liveMessages.of(chatId, key);

    // Retired while Telegram still answers for it. A slot's message is edited
    // for as long as the slot exists, but the right to edit or delete one's own
    // message runs out about two days after it was *sent*, however recently it
    // was last written. A long-lived slot therefore eventually meets an edit
    // that fails and a delete that fails with it, and is left with a message
    // frozen at its last good content and a second one posted beside it. That
    // is what the ▶️ topic did: two messages, one stuck a day behind.
    const previous = held && !repost && !this.expired(held) ? held : undefined;
    if (held && !previous) {
      this.store.liveMessages.forget(chatId, key);
      await this.transport.deleteMessage(chatId, held.messageId);
    }

    // Unchanged content is not rewritten, or a bot that is merely alive would
    // edit two messages a minute forever. The heartbeat still refreshes it now
    // and then, so a frozen "обновлено" is evidence the monitor stopped — and
    // a message somebody deleted, or took with its topic, is noticed.
    const current = previous;
    if (current && current.hash === hash && Date.now() - current.at < this.config.liveRefreshMs) return false;

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
        return false;
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
        return false;
      }

      this.store.liveMessages.forget(chatId, key);
      // An edit that failed on a message too old to delete leaves it in the
      // chat for good, and only a person can clear it. Said out loud rather
      // than swallowed, because the alternative is somebody reading a stale
      // status for weeks and nobody knowing why it is there.
      if (!(await this.transport.deleteMessage(chatId, current.messageId))) {
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
    return true;
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

/**
 * The store key for one page of a slot. Page 0 keeps the bare slot name so
 * that a slot which never grew past one message keeps the id it already has.
 */
const pageKey = (slot: string, index: number): string => (index === 0 ? slot : `${slot}#${index}`);

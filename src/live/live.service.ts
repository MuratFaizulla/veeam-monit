import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppConfig } from '../config/configuration';
import { TelegramStateStore } from '../telegram/state.store';
import { TelegramTopicsService } from '../telegram/topics.service';
import { TelegramApiError, TelegramTransportService } from '../telegram/transport.service';
import { TelegramChat } from '../telegram/types';
import { LiveSlot, specOf } from './slots';
import { LiveMessageRef } from '../telegram/state.store';

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
      const ref = this.store.liveMessage(chatId, key);
      if (!ref) return;
      this.store.forgetLiveMessage(chatId, key);
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
    const held = this.store.liveMessage(chatId, key);

    // Retired while Telegram still answers for it. A slot's message is edited
    // for as long as the slot exists, but the right to edit or delete one's own
    // message runs out about two days after it was *sent*, however recently it
    // was last written. A long-lived slot therefore eventually meets an edit
    // that fails and a delete that fails with it, and is left with a message
    // frozen at its last good content and a second one posted beside it. That
    // is what the ▶️ topic did: two messages, one stuck a day behind.
    const previous = held && !this.expired(held) ? held : undefined;
    if (held && !previous) {
      this.store.forgetLiveMessage(chatId, key);
      await this.remove(chatId, held.messageId);
    }

    // Unchanged content is not rewritten, or a bot that is merely alive would
    // edit two messages a minute forever. The heartbeat still refreshes it now
    // and then, so a frozen "обновлено" is evidence the monitor stopped.
    const spec = specOf(slot);
    if (
      previous &&
      previous.hash === hash &&
      (!spec.heartbeat || Date.now() - previous.at < this.config.liveRefreshMs)
    ) {
      return;
    }

    if (previous && (await this.edit(chatId, previous.messageId, text))) {
      this.store.rememberLiveMessage(chatId, key, {
        messageId: previous.messageId,
        hash,
        at: Date.now(),
        createdAt: previous.createdAt,
      });
      return;
    }

    if (previous) {
      this.store.forgetLiveMessage(chatId, key);
      // An edit that failed on a message too old to delete leaves it in the
      // chat for good, and only a person can clear it. Said out loud rather
      // than swallowed, because the alternative is somebody reading a stale
      // status for weeks and nobody knowing why it is there.
      if (!(await this.remove(chatId, previous.messageId))) {
        this.logger.warn(
          `Live "${slot}" left message ${previous.messageId} behind in chat ${chatId}: ` +
            'Telegram refused both the edit and the deletion, so it must be removed by hand',
        );
      }
    }

    const now = Date.now();
    const messageId = await this.send(chat, slot, text);
    this.store.rememberLiveMessage(chatId, key, { messageId, hash, at: now, createdAt: now });
    if (spec.pinned) await this.pin(chatId, messageId);
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

  /** True when the existing message now carries `text`. */
  private async edit(chatId: string, messageId: number, text: string): Promise<boolean> {
    try {
      await this.transport.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      return true;
    } catch (error) {
      // Telegram refuses a no-op edit. The message already says what we wanted
      // it to say, so the slot is current either way.
      if (error instanceof TelegramApiError && /not modified/i.test(error.description)) return true;
      return false;
    }
  }

  private async send(chat: TelegramChat, slot: LiveSlot, text: string): Promise<number> {
    const fixedThread = specOf(slot).fixedThread;
    return this.topics.send(
      chat,
      this.config.liveTopics[slot],
      text,
      fixedThread ? this.config[fixedThread] : 0,
    );
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

  /** Best effort: an orphaned status message is noise, not a failure. */
  private async remove(chatId: string, messageId: number): Promise<boolean> {
    try {
      await this.transport.call('deleteMessage', { chat_id: chatId, message_id: messageId });
      return true;
    } catch {
      /* already gone, or older than Telegram lets a bot delete */
      return false;
    }
  }

  /**
   * The "обновлено" line moves every cycle by design, so it is excluded from
   * the comparison; otherwise nothing would ever count as unchanged.
   */
  private hash(text: string): string {
    const meaningful = text
      .split('\n')
      .filter((line) => !line.startsWith('<i>Обновлено'))
      .join('\n');
    return createHash('sha1').update(meaningful).digest('hex');
  }
}

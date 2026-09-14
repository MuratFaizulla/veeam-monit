import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppConfig } from '../config/configuration';
import { TelegramStateStore } from './telegram-state.store';
import { TelegramTopicsService } from './telegram-topics.service';
import { TelegramApiError, TelegramTransportService } from './telegram-transport.service';
import { TelegramChat } from './telegram.types';

/** A topic that holds exactly one message, kept current. */
export type LiveSlot = 'health' | 'running' | 'schedule' | 'performance';

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
   * Makes `text` the content of this slot in every registered chat.
   *
   * Never throws: a status message that could not be refreshed must not abort
   * the monitor cycle that produced it.
   */
  async publish(slot: LiveSlot, text: string): Promise<void> {
    if (!this.config.live || !this.transport.enabled) return;
    for (const [chatId, chat] of this.store.chats()) {
      try {
        await this.publishTo(chatId, chat, slot, text);
      } catch (error) {
        this.logger.error(
          `Live "${slot}" was not refreshed in chat ${chatId}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async publishTo(
    chatId: string,
    chat: TelegramChat,
    slot: LiveSlot,
    text: string,
  ): Promise<void> {
    const hash = this.hash(text);
    const previous = this.store.liveMessage(chatId, slot);

    // Unchanged content is not rewritten, or a bot that is merely alive would
    // edit two messages a minute forever. The heartbeat still refreshes it now
    // and then, so a frozen "обновлено" is evidence the monitor stopped.
    if (
      previous &&
      previous.hash === hash &&
      (slot === 'performance' || Date.now() - previous.at < this.config.liveRefreshMs)
    ) {
      return;
    }

    if (previous && (await this.edit(chatId, previous.messageId, text))) {
      this.store.rememberLiveMessage(chatId, slot, {
        messageId: previous.messageId,
        hash,
        at: Date.now(),
      });
      return;
    }

    if (previous) {
      this.store.forgetLiveMessage(chatId, slot);
      await this.remove(chatId, previous.messageId);
    }

    const messageId = await this.send(chat, slot, text);
    this.store.rememberLiveMessage(chatId, slot, { messageId, hash, at: Date.now() });
    if (slot === 'performance') await this.pin(chatId, messageId);
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
    const topic = this.config.liveTopics[slot];
    const destination =
      slot === 'performance' && this.config.performanceTopicId > 0 && chat.is_forum
        ? { chatId: String(chat.id), threadId: this.config.performanceTopicId, topic }
        : await this.topics.destination(chat, topic);
    try {
      return await this.transport.sendMessage(destination, text);
    } catch (error) {
      if (!(error instanceof TelegramApiError) || !error.isMissingThread) throw error;
      // Somebody deleted the topic; re-create it rather than losing the slot.
      this.topics.forget(destination.chatId, destination.topic);
      return this.transport.sendMessage(await this.topics.destination(chat, topic), text);
    }
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
  private async remove(chatId: string, messageId: number): Promise<void> {
    try {
      await this.transport.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch {
      /* already gone, or older than Telegram lets a bot delete */
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

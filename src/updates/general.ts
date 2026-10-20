import { Injectable, Logger } from '@nestjs/common';
import { CAPTION_LENGTH, truncate } from '../telegram/format';
import { TelegramStateStore } from '../telegram/state.store';
import { outcomeOf, TelegramOutcome, TelegramTransportService } from '../telegram/transport.service';
import { TelegramDestination, TelegramMessage } from '../telegram/types';
import { Reply } from './commands';
import { isMenu, isSelective, mainMenu, MENU_SIGNATURE, MENU_TEXT } from './menu';

/** Telegram takes at most 100 message ids in one deleteMessages call. */
const DELETE_BATCH = 100;

/** What `/clear` came to. */
export type Cleared = 'nothing' | { removed: number; stuck: number };

/**
 * General as the bot keeps it: what was said there, so `/clear` can take it
 * back; the menu under the input field, kept there; and the taking back.
 *
 * The Bot API offers no way to clear a chat: a bot may delete a message only by
 * id, cannot enumerate history, and loses the right after 48 hours. So what can
 * be removed is exactly what the **Answer log** wrote down as it went — what
 * people say here, the bot's answers and the messages that carry the menu — and
 * this module is where it is written down and where it is read back.
 *
 * It used to be lodged in the commands module, beside what the commands mean:
 * a timer that keeps the menu, in a module that said nothing in it had a
 * lifecycle, and a deletion protocol of its own beside the live module's copy.
 */
@Injectable()
export class TelegramGeneral {
  private readonly logger = new Logger(TelegramGeneral.name);

  constructor(
    private readonly transport: TelegramTransportService,
    private readonly store: TelegramStateStore,
  ) {}

  /**
   * Something said in General, by anybody: the commands people type, the keys
   * they press, and whatever else. Only the bot's answers were written down
   * once, and "/clear" left a column of "/digest" and "/status" with nothing
   * after them.
   */
  heard(message: TelegramMessage): void {
    const chatId = String(message.chat.id);
    if (this.store.isConfigured(chatId)) this.store.answerLog.remember(chatId, message.message_id);
  }

  /**
   * Says `reply` in General and writes it down. `replyTo` is the message being
   * answered: a menu for one person must reply to it, which is how Telegram
   * knows whose keyboard to change. Undefined when Telegram did not take it.
   */
  async say(destination: TelegramDestination, reply: Reply, replyTo?: number): Promise<number | undefined> {
    try {
      // Cut to Telegram's limit rather than rejected by it: a job card is
      // bounded, but a forum with a hundred topics is not.
      const text = reply.lines.join('\n');
      const answering = isSelective(reply.markup) ? replyTo : undefined;
      const messageId = reply.document
        ? await this.transport.sendDocument(destination, reply.document, truncate(text, CAPTION_LENGTH), reply.markup, answering)
        : await this.transport.sendMessage(destination, truncate(text), reply.markup, answering);
      // Every answer, the ones carrying the menu too: /clear ends by putting
      // the menu back, so taking an old one away no longer takes the keyboard.
      this.store.answerLog.remember(destination.chatId, messageId, destination.threadId);
      // The newest menu for everybody is the one kept under the input field.
      if (isMenu(reply.markup) && !isSelective(reply.markup) && this.store.isConfigured(destination.chatId)) {
        this.store.rememberMenu(destination.chatId, MENU_SIGNATURE, messageId);
      }
      return messageId;
    } catch (error) {
      if (outcomeOf(error) === 'chat-gone' && this.store.isConfigured(destination.chatId)) this.letGo(destination.chatId);
      else this.logger.error(`Telegram reply failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Keeps the menu under the input field of every chat. Asked on start and
   * then every few minutes, by whoever keeps the clock.
   *
   * In a group nobody presses Start: the bot was added once, by one person, and
   * a menu that waited to be asked for would never be seen. The keyboard lives
   * as long as the message that put it there, and that message used to be
   * posted once and forgotten — so deleting it, by hand or with the topic it
   * was answered in, took the menu away for good. The message is remembered
   * now and looked at, and posted again only when Telegram says it is gone or
   * the layout changed; a restart, or a failed look, says nothing.
   */
  async keepMenu(): Promise<void> {
    for (const [chatId] of this.store.chats()) {
      const held = this.store.menuOf(chatId);
      const current = held?.signature === MENU_SIGNATURE ? held.messageId : undefined;
      if (current !== undefined) {
        const looked = await this.look(chatId, current);
        if (looked === 'chat-gone') this.letGo(chatId);
        // Anything but gone says nothing against the message being there:
        // the cost of that mistake is one late repost, and the cost of the
        // other is a second menu.
        if (looked !== 'gone') continue;
      }
      const posted = await this.say({ chatId }, { lines: MENU_TEXT, markup: mainMenu() });
      // A menu of an older layout is replaced, not left beside the new one.
      if (posted !== undefined && held?.messageId !== undefined && held.messageId !== current) {
        await this.transport.deleteMessage(chatId, held.messageId);
      }
    }
  }

  /**
   * Takes back everything written down in this chat's General, `asked` — the
   * "/clear" itself — included but not counted as work done.
   */
  async clear(destination: TelegramDestination, asked?: number): Promise<Cleared> {
    const { chatId, threadId } = destination;
    const ids = this.store.answerLog.inTopic(chatId, threadId).filter((id) => id !== asked);
    if (asked !== undefined) {
      await this.transport.deleteMessage(chatId, asked);
      this.store.answerLog.forget(chatId, [asked]);
    }
    if (ids.length === 0) return 'nothing';

    const removed = await this.removeAll(chatId, ids);
    this.store.answerLog.forget(chatId, ids);
    return { removed, stuck: ids.length - removed };
  }

  /**
   * Looks at a message without changing it, and says how that ended. An
   * empty markup edit is done ("not modified") or refused ("can't be edited",
   * for one that carries the menu) for a message that is there, and gone for
   * one that is not.
   */
  private async look(chatId: string, messageId: number): Promise<TelegramOutcome> {
    return (await this.transport.ask('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId })).outcome;
  }

  /**
   * A chat Telegram says the bot is no longer in, let go as Delivery lets it
   * go — forgotten with its topics, menu and what was said there — rather
   * than looked at and posted to every few minutes for ever.
   */
  private letGo(chatId: string): void {
    this.store.dropChat(chatId);
    this.logger.warn(`Telegram chat ${chatId} is no longer reachable and was unregistered`);
  }

  /** Deletes in batches, falling back to one at a time. Returns how many went. */
  private async removeAll(chatId: string, ids: number[]): Promise<number> {
    let removed = 0;
    for (let from = 0; from < ids.length; from += DELETE_BATCH) {
      const batch = ids.slice(from, from + DELETE_BATCH);
      if ((await this.transport.ask('deleteMessages', { chat_id: chatId, message_ids: batch })).outcome === 'done') {
        removed += batch.length;
        continue;
      }
      // One undeletable message — too old, or already gone — fails the whole
      // batch, so the rest is retried individually rather than abandoned.
      for (const messageId of batch) {
        if ((await this.transport.deleteMessage(chatId, messageId)).outcome === 'done') removed += 1;
      }
    }
    return removed;
  }
}

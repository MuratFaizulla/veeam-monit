import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { SEVERITY_TOPIC_COLOR, topicName } from './telegram.format';
import { TelegramStateStore } from './telegram-state.store';
import { TelegramApiError, TelegramTransportService } from './telegram-transport.service';
import { NotificationSeverity, TelegramChat, TelegramDestination } from './telegram.types';

interface ForumTopic {
  message_thread_id: number;
  name: string;
}

/**
 * Maps a human topic name onto a forum `message_thread_id`.
 *
 * This is the piece that was missing: in a forum supergroup a sendMessage
 * without `message_thread_id` always lands in General, which is why every
 * alert ended up in one thread. The Bot API has no method to list topics, so
 * the mapping can only be built from two sources — topics the bot creates
 * itself, and topics it sees in incoming updates — and it must be persisted,
 * or a restart would create a second "Failed" topic next to the first one.
 */
@Injectable()
export class TelegramTopicsService {
  private readonly logger = new Logger(TelegramTopicsService.name);
  private readonly config: AppConfig['telegram'];
  /** Chats whose topic creation failed, so one missing right is not retried per event. */
  private readonly creationBlocked = new Set<string>();
  /** In-flight createForumTopic calls, keyed by chat+name, to avoid duplicates. */
  private readonly creating = new Map<string, Promise<number | undefined>>();

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly store: TelegramStateStore,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  /**
   * Resolves the address to post to. A non-forum chat, an unnamed topic or a
   * chat where the bot may not manage topics all fall back to General, which
   * keeps delivery working while an administrator fixes the rights.
   */
  async destination(chat: TelegramChat, topic: string | null): Promise<TelegramDestination> {
    const chatId = String(chat.id);
    if (!topic || !chat.is_forum) return { chatId };

    const name = topicName(topic);
    const known = this.store.threadId(chatId, name);
    if (known !== undefined) return { chatId, threadId: known, topic: name };

    if (!this.config.createTopics || this.creationBlocked.has(chatId)) return { chatId };

    const threadId = await this.create(chat, name);
    return threadId === undefined ? { chatId } : { chatId, threadId, topic: name };
  }

  private async create(chat: TelegramChat, name: string): Promise<number | undefined> {
    const chatId = String(chat.id);
    const key = `${chatId}|${name}`;
    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;

    const pending = this.transport
      .call<ForumTopic>('createForumTopic', {
        chat_id: chatId,
        name,
        icon_color: this.iconColor(name),
      })
      .then((topic) => {
        this.remember(chatId, name, topic.message_thread_id);
        this.logger.log(`Created Telegram topic "${name}" (${topic.message_thread_id}) in ${chatId}`);
        return topic.message_thread_id;
      })
      .catch((error: Error) => {
        this.creationBlocked.add(chatId);
        this.logger.error(
          `Cannot create Telegram topics in ${chatId} (${error.message}). Grant the bot "Manage topics" or pre-create them; alerts go to General meanwhile.`,
        );
        return undefined;
      })
      .finally(() => this.creating.delete(key));

    this.creating.set(key, pending);
    return pending;
  }

  /** Records a topic seen in an update or created by the bot. */
  remember(chatId: string, name: string, threadId: number): void {
    this.store.rememberTopic(chatId, name, threadId);
  }

  /**
   * Drops a mapping whose topic Telegram no longer knows, so the next event
   * re-creates it instead of failing forever against a deleted thread.
   */
  /**
   * Sends into a topic, surviving somebody deleting it.
   *
   * The recovery was written twice — once for alerts and once for the live
   * slots — because resolving a destination and repairing a dead one are the
   * same knowledge, and only the first half lived here. A topic that has been
   * deleted is forgotten and re-created rather than losing what was being sent
   * to it; if re-resolving hands back the same dead thread, the message goes to
   * General, because a delivered alert in the wrong place beats none.
   *
   * `fixedThread` addresses a topic somebody created by hand, which the bot
   * cannot re-create and so never forgets.
   */
  async send(
    chat: TelegramChat,
    topic: string | null,
    text: string,
    fixedThread = 0,
  ): Promise<number> {
    const destination =
      fixedThread > 0 && chat.is_forum
        ? { chatId: String(chat.id), threadId: fixedThread, topic: topic ?? undefined }
        : await this.destination(chat, topic);

    try {
      return await this.transport.sendMessage(destination, text);
    } catch (error) {
      if (!(error instanceof TelegramApiError) || !error.isMissingThread) throw error;
      this.forget(destination.chatId, destination.topic);
      const retry = await this.destination(chat, topic);
      return this.transport.sendMessage(
        retry.threadId === destination.threadId ? { chatId: destination.chatId } : retry,
        text,
      );
    }
  }

  forget(chatId: string, name: string | undefined): void {
    if (!name) return;
    // A topic that had to be re-created is evidence the chat is usable again.
    if (this.store.forgetTopic(chatId, name)) this.creationBlocked.delete(chatId);
  }

  list(chatId: string): Record<string, number> {
    return this.store.topics(chatId);
  }

  /** Re-allows topic creation after an administrator fixed the bot rights. */
  unblock(): void {
    this.creationBlocked.clear();
  }

  /**
   * Severity topics get the matching colour; per-job topics get a stable one
   * derived from the name, so a job keeps the same icon across re-creations.
   */
  private iconColor(name: string): number {
    for (const [severity, topic] of Object.entries(this.config.severityTopics)) {
      if (topic && topicName(topic) === name) {
        return SEVERITY_TOPIC_COLOR[severity as NotificationSeverity];
      }
    }
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
    return Object.values(SEVERITY_TOPIC_COLOR)[hash % 4];
  }
}

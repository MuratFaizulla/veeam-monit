import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { BOT_COMMANDS } from './commands';
import { TelegramCommandsService } from './commands.service';
import { TelegramStateStore } from '../telegram/state.store';
import { TelegramTopicsService } from '../telegram/topics.service';
import { TelegramTransportService } from '../telegram/transport.service';
import { TelegramChat, TelegramUpdate } from '../telegram/types';

/**
 * How the bot hears from Telegram.
 *
 * This used to sit inside the notifier, which made one class answer two
 * unrelated questions: "how does an event become a message" and "how does the
 * outside world reach this process". They share dependencies and nothing else —
 * no caller of one ever wants the other — so a change to the polling loop had
 * to be read past the delivery rules and vice versa.
 *
 * It then held what an Update *means* as well — every command and Button —
 * until that moved to `TelegramCommandsService`. What is left is intake: an
 * Update arrives by webhook (the controller) or by the polling loop here, the
 * chat and any topic it mentions are registered, and the Update is handed on.
 * Which of the two transports is in use is not a choice a caller makes: it
 * follows from TELEGRAM_WEBHOOK_URL being set, and is reported through `mode`
 * for the status endpoint.
 */
@Injectable()
export class TelegramUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramUpdatesService.name);
  private readonly config: AppConfig['telegram'];
  private readonly allowedChats: ReadonlySet<string>;
  private polling = false;
  private stopping = false;
  private updateOffset = 0;

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly store: TelegramStateStore,
    private readonly commands: TelegramCommandsService,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.allowedChats = new Set(this.config.chatIds);
  }

  async onModuleInit(): Promise<void> {
    if (!this.transport.enabled) {
      this.logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN is empty');
      return;
    }
    await Promise.all(this.store.chats().map(([id]) => this.refreshChat(id)));
    await this.publishCommands();
    await this.commands.offerMenu();

    if (this.config.webhookUrl) {
      await this.configureWebhook();
    } else {
      await this.startPolling();
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.polling = false;
  }

  /**
   * How this process is actually reached right now.
   *
   * "webhook" used to be whatever was left after "disabled" and "polling" were
   * ruled out, so a polling loop that failed to start reported itself as a
   * webhook — the one answer that made the status endpoint look healthy while
   * no update could arrive at all. Each mode is now claimed on its own
   * evidence, and the gap between them has its own name.
   */
  get mode(): 'disabled' | 'polling' | 'webhook' | 'starting' {
    if (!this.transport.enabled) return 'disabled';
    if (this.polling) return 'polling';
    return this.config.webhookUrl ? 'webhook' : 'starting';
  }

  /** True when a webhook URL was configured, whether or not Telegram took it. */
  get webhookConfigured(): boolean {
    return Boolean(this.config.webhookUrl);
  }

  /**
   * Everything one update implies: the chat is registered, a topic somebody
   * created by hand is remembered, and the commands module answers whatever
   * it asks.
   *
   * Called from the webhook endpoint and from the polling loop, which is why
   * the two transports need no further difference anywhere else.
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chat = message?.chat ?? update.callback_query?.message?.chat ?? update.my_chat_member?.chat;
    // A bot can be added to an arbitrary group or contacted in private. Only
    // explicitly configured destinations may read Veeam data or run commands.
    if (!chat || !this.allowedChats.has(String(chat.id))) return;
    if (chat) this.registerChat(chat);

    // The Bot API cannot enumerate forum topics, so a topic the bot did not
    // create is only ever learned from a message that mentions it.
    if (message?.forum_topic_created && message.message_thread_id) {
      this.topics.remember(
        String(message.chat.id),
        message.forum_topic_created.name,
        message.message_thread_id,
      );
    }

    await this.commands.answer(update);
  }

  private registerChat(chat: TelegramChat): void {
    const { becameForum } = this.store.mergeChat(chat);
    if (becameForum) this.topics.unblock();
  }

  /**
   * Registers the command menu Telegram shows next to the input field.
   *
   * The commands existed and were discoverable only by reading `/help`, which
   * in a group is not how anybody finds anything: the bot was added once, by
   * one person, and everyone else inherited a silent box. This is the one place
   * Telegram will show them without being asked.
   *
   * Best effort — a bot that could not publish its menu still answers every
   * command typed by hand.
   */
  private async publishCommands(): Promise<void> {
    try {
      await this.transport.call('setMyCommands', { commands: BOT_COMMANDS });
      this.logger.log(`Telegram command menu published (${BOT_COMMANDS.length} commands)`);
    } catch (error) {
      this.logger.warn(`Telegram command menu was not published: ${(error as Error).message}`);
    }
  }

  /** Learns title and forum flag for chats that were configured, not discovered. */
  private async refreshChat(chatId: string): Promise<void> {
    try {
      const chat = await this.transport.call<TelegramChat>('getChat', { chat_id: chatId });
      this.registerChat(chat);
      this.logger.log(
        `Telegram chat ${chatId} "${chat.title ?? ''}" forum=${chat.is_forum === true}`,
      );
    } catch (error) {
      this.logger.warn(`Telegram chat ${chatId} could not be inspected: ${(error as Error).message}`);
    }
  }

  private async configureWebhook(): Promise<void> {
    try {
      const webhook = new URL(this.config.webhookUrl);
      if (webhook.protocol !== 'https:' || !webhook.hostname.includes('.')) {
        throw new Error('TELEGRAM_WEBHOOK_URL must be a public HTTPS origin');
      }
      await this.transport.call('setWebhook', {
        url: `${this.config.webhookUrl}/api/telegram/webhook`,
        secret_token: this.config.webhookSecret || undefined,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      });
      this.logger.log('Telegram webhook configured');
    } catch (error) {
      this.logger.error(`Telegram webhook was not configured: ${(error as Error).message}`);
    }
  }

  private async startPolling(): Promise<void> {
    try {
      // getUpdates and webhooks are mutually exclusive. Removing a stale
      // webhook makes local, domain-free operation deterministic.
      await this.transport.call('deleteWebhook', { drop_pending_updates: false });
      this.polling = true;
      this.logger.log('Telegram long polling enabled (no public domain required)');
      void this.pollUpdates();
    } catch (error) {
      this.logger.error(`Telegram polling could not start: ${(error as Error).message}`);
    }
  }

  private async pollUpdates(): Promise<void> {
    while (!this.stopping) {
      try {
        const updates = await this.transport.call<TelegramUpdate[]>('getUpdates', {
          offset: this.updateOffset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        });
        for (const update of updates ?? []) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopping) return;
        this.logger.error(`Telegram polling error: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { escapeHtml } from './telegram.format';
import { TelegramStateStore } from './telegram-state.store';
import { TelegramTopicsService } from './telegram-topics.service';
import { TelegramTransportService } from './telegram-transport.service';
import { TelegramChat, TelegramDestination, TelegramUpdate } from './telegram.types';

/**
 * How the bot hears from Telegram.
 *
 * This used to sit inside the notifier, which made one class answer two
 * unrelated questions: "how does an event become a message" and "how does the
 * outside world reach this process". They share dependencies and nothing else —
 * no caller of one ever wants the other — so a change to the polling loop had
 * to be read past the delivery rules and vice versa.
 *
 * The whole module is one method wide: an update goes in, and whatever it
 * implies happens. Everything else is lifecycle. Which of the two transports is
 * in use is not a choice a caller makes: it follows from TELEGRAM_WEBHOOK_URL
 * being set, and is reported through `mode` for the status endpoint.
 */
@Injectable()
export class TelegramUpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramUpdatesService.name);
  private readonly config: AppConfig['telegram'];
  private polling = false;
  private stopping = false;
  private updateOffset = 0;

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
    private readonly topics: TelegramTopicsService,
    private readonly store: TelegramStateStore,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  async onModuleInit(): Promise<void> {
    if (!this.transport.enabled) {
      this.logger.warn('Telegram disabled: TELEGRAM_BOT_TOKEN is empty');
      return;
    }
    await Promise.all(this.store.chats().map(([id]) => this.refreshChat(id)));

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
   * created by hand is remembered, and a bot command is answered.
   *
   * Called from the webhook endpoint and from the polling loop, which is why
   * the two transports need no further difference anywhere else.
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chat = message?.chat ?? update.my_chat_member?.chat;
    if (!chat) return;
    this.registerChat(chat);

    // The Bot API cannot enumerate forum topics, so a topic the bot did not
    // create is only ever learned from a message that mentions it.
    if (message?.forum_topic_created && message.message_thread_id) {
      this.topics.remember(
        String(chat.id),
        message.forum_topic_created.name,
        message.message_thread_id,
      );
    }

    const command = message?.text?.trim().toLowerCase().split(/[\s@]/)[0];
    if (!command?.startsWith('/')) return;
    const reply: TelegramDestination = {
      chatId: String(chat.id),
      threadId: message?.is_topic_message ? message.message_thread_id : undefined,
    };
    await this.respond(command, chat, reply);
  }

  private async respond(
    command: string,
    chat: TelegramChat,
    reply: TelegramDestination,
  ): Promise<void> {
    const lines: string[] = [];
    if (command === '/start' || command === '/status' || command === '/chatid') {
      lines.push(
        '<b>Veeam Monitor</b>',
        `<b>Chat ID:</b> <code>${escapeHtml(chat.id)}</code>`,
        `<b>Форум:</b> ${chat.is_forum ? 'да' : 'нет'}`,
        `<b>Топик:</b> <code>${escapeHtml(reply.threadId ?? 'General')}</code>`,
        `<b>Маршрутизация:</b> ${escapeHtml(this.config.routingMode)}`,
      );
    } else if (command === '/topics') {
      const known = this.topics.list(String(chat.id));
      lines.push('<b>Известные топики</b>');
      for (const [name, threadId] of Object.entries(known)) {
        lines.push(`${escapeHtml(name)} — <code>${threadId}</code>`);
      }
      if (Object.keys(known).length === 0) lines.push('пока ни одного');
    } else {
      return;
    }

    try {
      await this.transport.sendMessage(reply, lines.join('\n'));
    } catch (error) {
      this.logger.error(`Telegram reply failed: ${(error as Error).message}`);
    }
  }

  private registerChat(chat: TelegramChat): void {
    const { becameForum } = this.store.mergeChat(chat);
    if (becameForum) this.topics.unblock();
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
        allowed_updates: ['message', 'my_chat_member'],
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
          allowed_updates: ['message', 'my_chat_member'],
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

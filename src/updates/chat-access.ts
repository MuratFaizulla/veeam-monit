import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { TelegramTransportService } from '../telegram/transport.service';
import { TelegramChat } from '../telegram/types';

/**
 * Who the bot talks to.
 *
 * The bot is public: anybody can find it by name, write to it, or add it to a
 * group of their own. It used to answer all of them and remember each as a
 * chat to send to, so a stranger who pressed Start got every alert about the
 * company's backups and could read any job's card. Now:
 *
 *   - `recipient` — a chat named in TELEGRAM_CHAT_IDS. Everything: alerts,
 *     live slots, commands and the menu.
 *   - `member` — a private chat with somebody who is in one of those chats.
 *     Commands and the menu, as in the company's other bots; nothing is pushed
 *     there, so a private chat never fills with alerts nobody asked for.
 *   - `setup` — nothing is configured yet. Only the chat's id is told, which is
 *     what somebody setting the bot up needs and all they get.
 *   - `none` — anybody else. Silence; a group the bot was added to is left.
 */
export type Access = 'recipient' | 'member' | 'setup' | 'none';

/** How long a membership answer stands before Telegram is asked again. */
const MEMBER_TTL_MS = 10 * 60_000;
/** Shorter for a refusal: somebody just added to the group should not wait ten minutes. */
const STRANGER_TTL_MS = 60_000;

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

/** Answers kept before the expired ones are swept out. */
const REMEMBERED = 500;

interface ChatMember {
  status?: string;
  /** Set for a restricted member: whether they are still in the chat. */
  is_member?: boolean;
}

@Injectable()
export class TelegramChatAccess {
  private readonly logger = new Logger(TelegramChatAccess.name);
  private readonly configured: readonly string[];
  private readonly members = new Map<number, { member: boolean; until: number }>();

  constructor(
    config: ConfigService,
    private readonly transport: TelegramTransportService,
  ) {
    this.configured = config.getOrThrow<AppConfig['telegram']>('telegram').chatIds;
  }

  async of(chat: TelegramChat): Promise<Access> {
    if (this.configured.length === 0) return 'setup';
    if (this.configured.includes(String(chat.id))) return 'recipient';
    // In a private chat the chat's id is the person's.
    if (chat.type === 'private' && (await this.isMember(chat.id))) return 'member';
    return 'none';
  }

  /**
   * Whether this person is in one of the configured chats, by asking Telegram.
   * No list of people to keep: whoever is added to the group may use the bot,
   * and whoever leaves it may not, within ten minutes.
   *
   * A failure to ask is a no: the answer is about who may read the estate.
   */
  private async isMember(userId: number): Promise<boolean> {
    const known = this.members.get(userId);
    if (known && Date.now() < known.until) return known.member;

    let member = false;
    for (const chatId of this.configured) {
      try {
        const found = await this.transport.call<ChatMember>('getChatMember', {
          chat_id: chatId,
          user_id: userId,
        });
        if (MEMBER_STATUSES.has(found.status ?? '') || (found.status === 'restricted' && found.is_member)) {
          member = true;
          break;
        }
      } catch (error) {
        this.logger.debug(`Membership of ${userId} in ${chatId} unknown: ${(error as Error).message}`);
      }
    }
    // Strangers are remembered only for a minute; the ones whose minute is up
    // are let go, so a crowd of them writing to the bot cannot grow this.
    if (this.members.size >= REMEMBERED) {
      for (const [id, entry] of this.members) if (Date.now() >= entry.until) this.members.delete(id);
    }
    this.members.set(userId, { member, until: Date.now() + (member ? MEMBER_TTL_MS : STRANGER_TTL_MS) });
    return member;
  }
}

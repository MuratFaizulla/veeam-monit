/**
 * Subset of the Telegram Bot API models this application consumes, plus the
 * internal notification contract that sits between the Veeam monitor and the
 * Telegram transport.
 */

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  /** True for supergroups with topics enabled. Only forums accept a thread id. */
  is_forum?: boolean;
}

export interface TelegramForumTopicCreated {
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: TelegramChat;
  /** Present on messages posted inside a forum topic. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: TelegramForumTopicCreated;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: { chat: TelegramChat };
}

/** A resolved delivery address: a chat and, for forums, a topic inside it. */
export interface TelegramDestination {
  chatId: string;
  /** Undefined means the General topic (or a non-forum chat). */
  threadId?: number;
  /** Topic name this destination was resolved from, for logging. */
  topic?: string;
}

/**
 * The lists are the definition and the types are derived from them, so that
 * anything needing to *check* a value — configuration parsing, the admin
 * endpoint that accepts one over HTTP — reads the same six words the type does.
 * They used to be written out three times, and the copies had already started
 * to be maintained separately.
 *
 * Order matters: it is the order an operator sees them listed in.
 */
export const NOTIFICATION_SEVERITIES = ['critical', 'warning', 'success', 'info'] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * Routing category. Job events carry the job name in `subject` and are the only
 * kind that can fan out to per-job topics; everything else is infrastructure
 * chatter that belongs in a fixed topic.
 */
export const NOTIFICATION_KINDS = [
  'job',
  'infrastructure',
  'repository',
  'security',
  'digest',
  'manual',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationEvent {
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** Job or repository name. Drives per-subject topic routing. */
  subject?: string;
  title: string;
  /** Label/value rows rendered under the title. Values are HTML-escaped. */
  fields?: Array<[string, string | number | null | undefined]>;
  /** Free-form trailing block, HTML-escaped. */
  body?: string;
  /**
   * Identity of the condition being reported. Two events with the same key
   * inside `cooldownMs` produce one message, which is what keeps a permanently
   * broken Veeam login from posting every monitor tick.
   */
  dedupeKey?: string;
  cooldownMs?: number;
}

/** One entry of the optional TELEGRAM_ROUTES_FILE. First match wins. */
export interface TelegramRouteRule {
  /** All present conditions must match. */
  match?: {
    kind?: NotificationKind | NotificationKind[];
    severity?: NotificationSeverity | NotificationSeverity[];
    /** Case-insensitive regular expression tested against `subject`. */
    subject?: string;
  };
  /** Restrict this rule to one chat. Omit to apply it in every target chat. */
  chatId?: string;
  /** Topic name. `null` or "" sends to the General topic explicitly. */
  topic?: string | null;
  /** Stop processing without sending anything. */
  drop?: boolean;
}

export interface TelegramRoutesFile {
  routes?: TelegramRouteRule[];
}

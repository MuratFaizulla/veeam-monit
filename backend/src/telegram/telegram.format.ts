import { NotificationEvent, NotificationSeverity } from './telegram.types';

/**
 * Messages are sent with parse_mode=HTML because Veeam job names routinely
 * contain `_`, `*` and `[`, which MarkdownV2 would reject with a 400. Only
 * `<`, `>` and `&` need escaping in HTML mode.
 */
export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const SEVERITY_ICON: Record<NotificationSeverity, string> = {
  critical: '🔴',
  warning: '🟡',
  success: '🟢',
  info: 'ℹ️',
};

/** Telegram only accepts these six colours for a forum topic icon. */
export const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f] as const;

export const SEVERITY_TOPIC_COLOR: Record<NotificationSeverity, number> = {
  critical: 0xfb6f5f,
  warning: 0xffd67e,
  success: 0x8eee98,
  info: 0x6fb9f0,
};

/** Telegram rejects sendMessage over 4096 characters. */
const MAX_LENGTH = 4096;

export const renderEvent = (event: NotificationEvent): string => {
  const lines = [`${SEVERITY_ICON[event.severity]} <b>${escapeHtml(event.title)}</b>`];

  for (const [label, value] of event.fields ?? []) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`);
  }

  if (event.body) lines.push('', `<pre>${escapeHtml(event.body)}</pre>`);

  return truncate(lines.join('\n'));
};

/**
 * Cuts an over-long message at the last newline that still fits, so a trimmed
 * message never ends inside an HTML tag Telegram would then refuse to parse.
 */
export const truncate = (text: string): string => {
  if (text.length <= MAX_LENGTH) return text;
  const suffix = '\n…';
  const head = text.slice(0, MAX_LENGTH - suffix.length);
  const cut = head.lastIndexOf('\n');
  return `${cut > MAX_LENGTH / 2 ? head.slice(0, cut) : head}${suffix}`;
};

/** Telegram forum topic names are capped at 128 characters. */
export const topicName = (name: string): string => name.trim().slice(0, 128) || 'Veeam';

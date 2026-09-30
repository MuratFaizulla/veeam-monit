import { escapeHtml } from './format';

/**
 * How the bot writes time and counts, in Russian, in the operator's zone.
 *
 * Every message the bot sends — alerts, answers, live slots — says when
 * things happened and how many of them there were, and says it the same way.
 * These lived in the live slots' formatter, which made the Job card and the
 * schedule reading import the live slots to write a date: a module below
 * reaching up into one above it for a helper both needed.
 */

/** Now, and the zone to write it in. */
export interface Clock {
  now: Date;
  /** IANA zone, or empty for the server's own. */
  timezone: string;
}

/**
 * Constructing an Intl.DateTimeFormat is the expensive half of formatting a
 * date; `.format()` on an existing one is cheap. A message listing a hundred
 * jobs asks for hundreds of them, so the handful of shapes actually used are
 * built once and kept.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

const parts = (value: Date, clock: Clock, options: Intl.DateTimeFormatOptions): string => {
  const key = `${clock.timezone}|${Object.entries(options).join(',')}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('ru-RU', {
      timeZone: clock.timezone || undefined,
      ...options,
    });
    formatters.set(key, formatter);
  }
  return formatter.format(value);
};

/** An ISO instant as "14.09.2026, 14:27:39", or the raw string if unparsable. */
export const moment = (iso: string, clock: Clock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return parts(date, clock, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

/**
 * A moment as `dayOf` writes it, from epoch milliseconds: "вчера в 22:25".
 *
 * Where the reader is about to go and look a point up in Veeam: a date and a
 * minute find it there, and a relative age ("5 дней назад") would have to be
 * turned back into one first. It replaces "29 сентября 2026 г. в 22:25:26",
 * which said the same eighty-five times down 🗂 and split it over two
 * messages.
 */
export const momentOf = (at: number, clock: Clock): string => dayOf(new Date(at).toISOString(), clock);

export const stampOf = (value: Date, clock: Clock): string =>
  parts(value, clock, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const timeOnly = (iso: string, clock: Clock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return parts(date, clock, { hour: '2-digit', minute: '2-digit' });
};

/**
 * Which calendar day an instant falls on, in the display timezone. "Today" is
 * a question about the operator's clock, not about UTC, so every comparison
 * goes through this rather than through Date's own local-time methods.
 */
export const dayKey = (value: Date, clock: Clock): string =>
  parts(value, clock, { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * "сегодня в 18:00", "вчера в 22:25", "завтра в 03:00", "16.09 в 03:00", or
 * "01.04.2025 в 22:38" — the year only when it is not this one, which is the
 * only time it tells the reader anything.
 */
export const dayOf = (iso: string, clock: Clock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  const time = timeOnly(iso, clock);

  const today = dayKey(clock.now, clock);
  const yesterday = dayKey(new Date(clock.now.getTime() - 86_400_000), clock);
  const tomorrow = dayKey(new Date(clock.now.getTime() + 86_400_000), clock);
  const target = dayKey(date, clock);

  if (target === today) return `сегодня в ${time}`;
  if (target === yesterday) return `вчера в ${time}`;
  if (target === tomorrow) return `завтра в ${time}`;
  // dayKey is "dd.mm.yyyy": the year is its last four characters.
  const sameYear = target.slice(-4) === today.slice(-4);
  return `${sameYear ? target.slice(0, 5) : target} в ${time}`;
};

/**
 * How often something happens, from a cadence in days: "раз в сутки",
 * "раз в 5 дней", "раз в 7 часов". 🛡 and the job card each wrote their own,
 * and the card's said "раз в 5.0 сут".
 */
export const everyLabel = (days: number): string => {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    if (hours === 1) return 'раз в час';
    if (hours < 24) return `раз в ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
    return 'раз в сутки';
  }
  const whole = Math.round(days);
  if (whole === 1) return 'раз в сутки';
  if (whole === 7) return 'раз в неделю';
  if (whole >= 28 && whole <= 31) return 'раз в месяц';
  return `раз в ${whole} ${plural(whole, 'день', 'дня', 'дней')}`;
};

/** "45 с", "22 мин", "3 ч 33 мин", "2 д 4 ч" — never more than two units. */
export const duration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} д ${rest} ч` : `${days} д`;
};

/** Russian needs three forms; "1 задание, 2 задания, 5 заданий". */
export const plural = (count: number, one: string, few: string, many: string): string => {
  const mod100 = Math.abs(count) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = mod100 % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};

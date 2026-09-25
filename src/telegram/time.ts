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
export interface LiveClock {
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

const parts = (value: Date, clock: LiveClock, options: Intl.DateTimeFormatOptions): string => {
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
export const moment = (iso: string, clock: LiveClock): string => {
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
 * A moment written out in full: "17 июня 2026 г., 21:32:09".
 *
 * Used where the reader is about to go and look the point up in Veeam. A
 * relative age ("5 дней назад") has to be turned back into a date before it can
 * be matched against anything on screen, so it is the wrong shape there.
 */
export const longMoment = (at: number, clock: LiveClock): string =>
  parts(new Date(at), clock, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const stampOf = (value: Date, clock: LiveClock): string =>
  parts(value, clock, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const timeOnly = (iso: string, clock: LiveClock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return parts(date, clock, { hour: '2-digit', minute: '2-digit' });
};

/**
 * Which calendar day an instant falls on, in the display timezone. "Today" is
 * a question about the operator's clock, not about UTC, so every comparison
 * goes through this rather than through Date's own local-time methods.
 */
export const dayKey = (value: Date, clock: LiveClock): string =>
  parts(value, clock, { day: '2-digit', month: '2-digit', year: 'numeric' });

/** "сегодня в 18:00", "завтра в 03:00", or "16.09 в 03:00". */
export const dayOf = (iso: string, clock: LiveClock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  const time = timeOnly(iso, clock);

  const today = dayKey(clock.now, clock);
  const tomorrow = dayKey(new Date(clock.now.getTime() + 86_400_000), clock);
  const target = dayKey(date, clock);

  if (target === today) return `сегодня в ${time}`;
  if (target === tomorrow) return `завтра в ${time}`;
  return `${parts(date, clock, { day: '2-digit', month: '2-digit' })} в ${time}`;
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

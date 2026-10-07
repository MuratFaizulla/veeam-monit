import { VeeamFullBackups, VeeamJobStorage } from '../veeam/types';
import { daysOf } from './schedule-planner';

/**
 * When a job is set to take a Full, and which of those days went by without one.
 *
 * A chain that keeps growing is a Full that is not happening, and the setting
 * says when one was owed. Veeam takes it on the day whether or not that day is
 * in the job's own schedule — OPS_3CX runs on Wednesdays and took its Full on
 * every Saturday — so a scheduled day that passed with no Full is a Full that
 * was missed: OPS_TelegramBot had none on 12, 19 or 26 September, and sixteen
 * increments on the one of the 5th.
 *
 * Veeam offers a Full on chosen weekdays or once a month; there is no "every
 * other week" to read.
 */

const DAY = 86_400_000;

/**
 * How long after a scheduled day ends before it is called missed. A Full that
 * starts at 23:40 and is still queued at midnight is late, not missing, and the
 * points it writes reach the Evidence only with the next scan.
 */
const GRACE = 12 * 3_600_000;

/** How far back missed days are counted from, at most. */
const LOOKBACK_DAYS = 366;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
/** Veeam's `dayNumberInMonth`, as a week of the month; -1 is the last. */
const NTH: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/** One kind of periodic Full a job is set to take. */
export interface FullSchedule {
  kind: 'active' | 'synthetic';
  /** Weekly: the weekdays it is owed on, 0 being Sunday. */
  weekdays?: number[];
  /**
   * Monthly: the nth weekday of the month (-1 the last), or a date, in the
   * listed months (1–12; every month when empty).
   */
  monthly?: { nth?: number; weekday?: number; date?: number; months: number[] };
}

/**
 * The periodic Fulls a job's storage settings ask for. Empty when it asks for
 * none; undefined when its configuration did not say, which is not the same.
 */
export const fullSchedulesOf = (storage: VeeamJobStorage | undefined): FullSchedule[] | undefined => {
  const advanced = storage?.advancedSettings;
  if (!advanced) return undefined;
  return [scheduleOf('active', advanced.activeFulls), scheduleOf('synthetic', advanced.synthenticFulls)].filter(
    (schedule): schedule is FullSchedule => schedule !== undefined,
  );
};

const scheduleOf = (kind: FullSchedule['kind'], fulls: VeeamFullBackups | undefined): FullSchedule | undefined => {
  if (!fulls?.isEnabled) return undefined;
  if (fulls.weekly?.isEnabled) {
    const weekdays = (fulls.weekly.days ?? [])
      .map((day) => WEEKDAYS.indexOf(day.toLowerCase()))
      .filter((day) => day >= 0);
    return weekdays.length > 0 ? { kind, weekdays } : undefined;
  }
  const monthly = fulls.monthly;
  if (!monthly?.isEnabled) return undefined;
  const months = (monthly.months ?? [])
    .map((month) => MONTHS.indexOf(month.toLowerCase()) + 1)
    .filter((month) => month > 0);
  const which = (monthly.dayNumberInMonth ?? '').toLowerCase();
  if (which === 'onday') {
    return monthly.dayOfMonths ? { kind, monthly: { date: monthly.dayOfMonths, months } } : undefined;
  }
  const nth = NTH[which];
  const weekday = WEEKDAYS.indexOf((monthly.dayOfWeek ?? '').toLowerCase());
  return nth && weekday >= 0 ? { kind, monthly: { nth, weekday, months } } : undefined;
};

/**
 * The days a Full was owed after `since` and none was taken, oldest first, as
 * `Date.UTC` midnights of the calendar day in `timezone`.
 *
 * `since` is the newest Full the job has. A day counts once it has ended and
 * the grace after it has passed.
 */
export const missedFullDays = (
  schedules: FullSchedule[],
  since: number,
  now: number,
  timezone: string,
): number[] => {
  const until = dayIn(now - GRACE, timezone);
  const from = Math.max(dayIn(since, timezone) + DAY, until - LOOKBACK_DAYS * DAY);
  const missed: number[] = [];
  for (let day = from; day < until; day += DAY) {
    if (schedules.some((schedule) => isOwed(schedule, day))) missed.push(day);
  }
  return missed;
};

/**
 * The Fulls owed on the calendar day `at` falls on in `timezone`: what a run
 * that began then was set to take, Veeam taking it whatever the job's own
 * schedule says.
 */
export const fullsOwedOn = (schedules: FullSchedule[], at: number, timezone: string): FullSchedule[] => {
  const day = dayIn(at, timezone);
  return schedules.filter((schedule) => isOwed(schedule, day));
};

/** Whether `schedule` owes a Full on `day`, a `Date.UTC` midnight. */
const isOwed = (schedule: FullSchedule, day: number): boolean => {
  const date = new Date(day);
  const weekday = date.getUTCDay();
  if (schedule.weekdays) return schedule.weekdays.includes(weekday);
  const monthly = schedule.monthly;
  if (!monthly) return false;
  if (monthly.months.length > 0 && !monthly.months.includes(date.getUTCMonth() + 1)) return false;
  if (monthly.date !== undefined) return date.getUTCDate() === monthly.date;
  if (weekday !== monthly.weekday) return false;
  if (monthly.nth === -1) return new Date(day + 7 * DAY).getUTCMonth() !== date.getUTCMonth();
  return Math.ceil(date.getUTCDate() / 7) === monthly.nth;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day `at` falls on in `timezone`, as its `Date.UTC` midnight:
 * stepping a day is adding a day, whatever the zone does with its clocks.
 */
const dayIn = (at: number, timezone: string): number => {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
};

const KIND: Record<FullSchedule['kind'], string> = { active: 'Active Full', synthetic: 'Synthetic Full' };
/** "в 3-ю ср месяца": the week of the month, as it is said after "в". */
const NTH_SAID: Record<number, string> = { 1: '1-ю', 2: '2-ю', 3: '3-ю', 4: '4-ю', [-1]: 'последнюю' };

/**
 * "Active Full по сб", "Active Full в 3-ю ср месяца", "Synthetic Full 1-го
 * числа"; both kinds when the job takes both.
 */
export const describeFulls = (schedules: FullSchedule[]): string => {
  if (schedules.length === 0) return 'без периодического Full';
  return schedules
    .map((schedule) => {
      const kind = KIND[schedule.kind];
      if (schedule.weekdays) return `${kind} по ${daysOf(schedule.weekdays.map((day) => WEEKDAYS[day]))}`;
      const monthly = schedule.monthly;
      if (monthly?.date !== undefined) return `${kind} ${monthly.date}-го числа`;
      if (monthly?.nth !== undefined && monthly.weekday !== undefined) {
        return `${kind} в ${NTH_SAID[monthly.nth]} ${daysOf([WEEKDAYS[monthly.weekday]])} месяца`;
      }
      return `${kind} ежемесячно`;
    })
    .join(', ');
};

/** "Active Full", "Synthetic Full", or "Full" when a job takes both. */
export const fullKindOf = (schedules: FullSchedule[]): string => {
  const kinds = new Set(schedules.map((schedule) => schedule.kind));
  return kinds.size === 1 ? KIND[[...kinds][0]] : 'Full';
};

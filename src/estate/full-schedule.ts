import { VeeamFullBackups, VeeamJobStorage } from '../veeam/types';
import { dayIn, daysOf, isMonthDay, MonthDay, monthDayOf, monthDaySaid, weekdayOf } from './schedule-planner';

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

/** One kind of periodic Full a job is set to take. */
export interface FullSchedule {
  kind: 'active' | 'synthetic';
  /** Weekly: the weekdays it is owed on, 0 being Sunday. */
  weekdays?: number[];
  /** Monthly: the day of the month, read as a monthly start's is. */
  monthly?: MonthDay;
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
    const weekdays = (fulls.weekly.days ?? []).map(weekdayOf).filter((day): day is number => day !== undefined);
    return weekdays.length > 0 ? { kind, weekdays } : undefined;
  }
  const monthly = fulls.monthly;
  if (!monthly?.isEnabled) return undefined;
  // The Full's date is `dayOfMonths`, a monthly start's `dayOfMonth`.
  const day = monthDayOf(monthly, monthly.dayOfMonths);
  return day ? { kind, monthly: day } : undefined;
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
 * The next day, today included, a Full is owed on, as for `missedFullDays`;
 * undefined when none is owed in the coming year.
 */
export const nextFullDay = (
  schedules: FullSchedule[],
  now: number,
  timezone: string,
): { day: number; kind: FullSchedule['kind'] } | undefined => {
  const today = dayIn(now, timezone);
  for (let day = today; day < today + LOOKBACK_DAYS * DAY; day += DAY) {
    const owed = schedules.find((schedule) => isOwed(schedule, day));
    if (owed) return { day, kind: owed.kind };
  }
  return undefined;
};

/** Whether any of `schedules` owes a Full on `day`, a `Date.UTC` midnight: a day /points marks as a Full's. */
export const isFullDay = (schedules: FullSchedule[], day: number): boolean =>
  schedules.some((schedule) => isOwed(schedule, day));

/** What one start of a job writes: either kind of Full, a job's first Full, or an increment. */
export type RunWrites = FullSchedule['kind'] | 'first' | 'increment';

/**
 * What a job's start at `at` writes, for 📅.
 *
 * The Full its settings owe that day, unless the newest run on disk already
 * wrote that day's — Veeam takes it once, with the first run of the day, as
 * /points reads it too. A job with nothing on disk begins its chain with a
 * Full whatever the day, which is how a job moved to another server starts.
 */
export const startWrites = (
  schedules: FullSchedule[],
  newest: { at: number; full?: boolean } | undefined,
  at: number,
  timezone: string,
): RunWrites => {
  if (!newest) return 'first';
  const day = dayIn(at, timezone);
  if (newest.full === true && dayIn(newest.at, timezone) === day) return 'increment';
  return schedules.find((schedule) => isOwed(schedule, day))?.kind ?? 'increment';
};

/** Whether `schedule` owes a Full on `day`, a `Date.UTC` midnight. */
const isOwed = (schedule: FullSchedule, day: number): boolean => {
  if (schedule.weekdays) return schedule.weekdays.includes(new Date(day).getUTCDay());
  return schedule.monthly ? isMonthDay(schedule.monthly, day) : false;
};

const KIND: Record<FullSchedule['kind'], string> = { active: 'Active Full', synthetic: 'Synthetic Full' };

/**
 * "Active Full по сб", "Active Full в 3-ю ср месяца", "Synthetic Full 1-го
 * числа"; both kinds when the job takes both.
 */
export const describeFulls = (schedules: FullSchedule[]): string => {
  if (schedules.length === 0) return 'без периодического Full';
  return schedules
    .map((schedule) => {
      const kind = KIND[schedule.kind];
      if (schedule.weekdays) return `${kind} по ${daysOf(schedule.weekdays)}`;
      return schedule.monthly ? `${kind} ${monthDaySaid(schedule.monthly)}` : `${kind} ежемесячно`;
    })
    .join(', ');
};

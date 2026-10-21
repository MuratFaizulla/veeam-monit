import { fromServerClock, Job } from '../veeam/estate';
import { VeeamBackupWindow, VeeamSchedule } from '../veeam/types';
import { isDisabled } from './job-state';

/**
 * When a job's schedule starts it, read once from Veeam's schedule model.
 *
 * `timetableOf` is the one reading of `daily`, `monthly` and `periodically`.
 * The starts a schedule owes (`scheduledStarts`, which the Job report counts
 * its missed starts against), the words the Job card and the reports say it
 * in, 📅's kind of schedule and the Repository report's chart all ask it, and
 * a Full's day of the month is read by the same rule. The model used to be
 * read four times: here twice, by the Repository report for its chart, and by
 * the Job report for its missed starts — daily ones only, with a weekday table
 * of its own, so a monthly or a periodic job never missed a start.
 */

const DAY = 86_400_000;
const MINUTE = 60_000;

/* ------------------------------------------------------------------ *
 * Veeam's calendar
 * ------------------------------------------------------------------ */

/** Veeam's weekdays, Sunday 0 as Date counts them. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
/** Veeam's `dayNumberInMonth`, as a week of the month; -1 is the last. */
const NTH: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/** The weekday Veeam names, in any case, Sunday 0; undefined for a name it does not use. */
export const weekdayOf = (name: string | undefined): number | undefined => {
  const day = WEEKDAYS.indexOf((name ?? '').toLowerCase());
  return day === -1 ? undefined : day;
};

/**
 * A day of the month, as Veeam sets one for a monthly start or a monthly
 * Full: a date, or the nth weekday (-1 the last); in the listed months (1–12;
 * every month when empty).
 */
export type MonthDay = { months: number[] } & ({ date: number } | { nth: number; weekday: number });

/**
 * The day of the month Veeam's fields name. `dayNumberInMonth` decides:
 * `OnDay` is `date`, a week is that weekday of it — and the date beside it,
 * which Veeam fills in all the same, is not the day. Undefined when they name
 * none.
 */
export const monthDayOf = (
  fields: { dayNumberInMonth?: string; dayOfWeek?: string; months?: string[] },
  date: number | null | undefined,
): MonthDay | undefined => {
  const months = (fields.months ?? []).map((month) => MONTHS.indexOf(month.toLowerCase()) + 1).filter((month) => month > 0);
  const which = (fields.dayNumberInMonth ?? '').toLowerCase();
  if (which === 'onday') return date ? { date, months } : undefined;
  const nth = NTH[which];
  const weekday = weekdayOf(fields.dayOfWeek);
  return nth && weekday !== undefined ? { nth, weekday, months } : undefined;
};

/** Whether `day`, a `Date.UTC` midnight, is the day of the month `rule` names. */
export const isMonthDay = (rule: MonthDay, day: number): boolean => {
  const date = new Date(day);
  if (rule.months.length > 0 && !rule.months.includes(date.getUTCMonth() + 1)) return false;
  if ('date' in rule) return date.getUTCDate() === rule.date;
  if (date.getUTCDay() !== rule.weekday) return false;
  if (rule.nth === -1) return new Date(day + 7 * DAY).getUTCMonth() !== date.getUTCMonth();
  return Math.ceil(date.getUTCDate() / 7) === rule.nth;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day `at` falls on in `timezone`, as its `Date.UTC` midnight:
 * stepping a day is adding a day, whatever the zone does with its clocks.
 */
export const dayIn = (at: number, timezone: string): number => {
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

/* ------------------------------------------------------------------ *
 * The reading
 * ------------------------------------------------------------------ */

/** When a schedule has Veeam start the job. Times are minutes after midnight on the server's clock. */
export type Timetable =
  | { kind: 'manual' }
  | {
      kind: 'daily';
      /** As Veeam's `dailyKind` says it: the words differ even where the days do not. */
      days: 'every' | 'weekdays' | 'chosen';
      /** Sunday 0, in that order. */
      weekdays: number[];
      /** Absent when Veeam gave no time. */
      minute?: number;
    }
  | {
      kind: 'monthly';
      /** Absent when Veeam's fields name no day. */
      day?: MonthDay;
      minute?: number;
    }
  | {
      kind: 'periodic';
      /** Minutes between starts; absent when Veeam did not say, or said it in a unit nothing here can place. */
      every?: number;
      /** The minute of the first start of a day: «Start time within an hour». */
      offset: number;
      /** Whether a start is permitted, by weekday (Sunday 0) and hour; absent when every hour is. */
      window?: boolean[][];
    }
  | { kind: 'continuous' }
  | { kind: 'after'; job?: string };

/**
 * The schedule, read; undefined when there is none, or none of its kinds is
 * switched on.
 */
export const timetableOf = (schedule: VeeamSchedule | undefined): Timetable | undefined => {
  if (!schedule) return undefined;
  // Checked first: a job with a filled-in schedule that Veeam will never
  // start on its own is common, and reading that schedule would be a lie.
  if (schedule.runAutomatically === false) return { kind: 'manual' };
  const { daily, monthly, periodically } = schedule;
  if (daily?.isEnabled) {
    const kind = (daily.dailyKind ?? '').toLowerCase();
    const days = kind === 'everyday' ? 'every' : kind === 'weekdays' ? 'weekdays' : 'chosen';
    const chosen = (daily.days ?? []).map(weekdayOf).filter((day): day is number => day !== undefined);
    const weekdays = days === 'every' ? [0, 1, 2, 3, 4, 5, 6] : days === 'weekdays' ? [1, 2, 3, 4, 5] : [...new Set(chosen)].sort((a, b) => a - b);
    return { kind: 'daily', days, weekdays, minute: minuteOf(daily.localTime) };
  }
  if (monthly?.isEnabled) return { kind: 'monthly', day: monthDayOf(monthly, monthly.dayOfMonth), minute: minuteOf(monthly.localTime) };
  if (periodically?.isEnabled) {
    const unit = (periodically.periodicallyKind ?? '').toLowerCase();
    const frequency = periodically.frequency && periodically.frequency > 0 ? periodically.frequency : 0;
    // The model names Seconds and Days too; nothing says where a period of days begins, so none is claimed.
    const every = unit === 'hours' ? frequency * 60 : unit === 'minutes' ? frequency : 0;
    const within = periodically.startTimeWithinAnHour ?? 0;
    return {
      kind: 'periodic',
      ...(every ? { every } : {}),
      offset: unit === 'hours' && within > 0 && within < 60 ? within : 0,
      ...(periodically.backupWindow?.days?.length ? { window: windowOf(periodically.backupWindow) } : {}),
    };
  }
  if (schedule.continuously?.isEnabled) return { kind: 'continuous' };
  if (schedule.afterThisJob?.isEnabled) return { kind: 'after', ...(schedule.afterThisJob.jobName ? { job: schedule.afterThisJob.jobName } : {}) };
  return undefined;
};

/** "22:00", or "22:00:00", as minutes after midnight. */
const minuteOf = (time: string | undefined): number | undefined => {
  const spelled = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
  return spelled ? Number(spelled[1]) * 60 + Number(spelled[2]) : undefined;
};

/**
 * The hours a window permits a start in. Veeam describes every day; one it
 * did not would permit none, since a start nobody knows was owed is not one
 * to call missed.
 */
const windowOf = (window: VeeamBackupWindow): boolean[][] => {
  const permitted = WEEKDAYS.map(() => new Array<boolean>(24).fill(false));
  for (const { day, hours } of window.days ?? []) {
    const weekday = weekdayOf(day);
    const marks = (hours ?? '').split(',').map((mark) => mark.trim());
    if (weekday !== undefined && marks.length === 24) permitted[weekday] = marks.map((mark) => mark === '1');
  }
  return permitted;
};

/* ------------------------------------------------------------------ *
 * The starts it owes
 * ------------------------------------------------------------------ */

/**
 * The starts `schedule` owes from `from` until `to`, epoch ms, oldest first:
 * the moments Veeam starts the job by itself. Its times are the server's
 * clock, which is taken to be in `timezone`. None for a job started by hand,
 * after another job or continuously: nothing in its schedule says when.
 */
export const scheduledStarts = (schedule: VeeamSchedule | undefined, from: number, to: number, timezone: string): number[] => {
  const timetable = timetableOf(schedule);
  if (!timetable) return [];
  const starts: number[] = [];
  for (let day = dayIn(from, timezone); day <= dayIn(to, timezone); day += DAY) {
    for (const minute of minutesOn(timetable, day)) {
      const at = fromServerClock(day + minute * MINUTE, timezone);
      if (at >= from && at < to) starts.push(at);
    }
  }
  return starts;
};

/** The minutes `timetable` starts the job at on `day`, a `Date.UTC` midnight. */
const minutesOn = (timetable: Timetable, day: number): number[] => {
  const weekday = new Date(day).getUTCDay();
  switch (timetable.kind) {
    case 'daily':
      return timetable.minute !== undefined && timetable.weekdays.includes(weekday) ? [timetable.minute] : [];
    case 'monthly':
      return timetable.minute !== undefined && timetable.day && isMonthDay(timetable.day, day) ? [timetable.minute] : [];
    case 'periodic': {
      // Counted from each midnight, as the Repository report has always drawn them.
      const { every, offset, window } = timetable;
      const minutes: number[] = [];
      for (let minute = offset; every && minute < 1440; minute += every) {
        if (!window || window[weekday][Math.floor(minute / 60)]) minutes.push(minute);
      }
      return minutes;
    }
    default:
      return [];
  }
};

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

/** An operator reads a weekday in two letters; Sunday 0. */
const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
/** "в 3-ю ср месяца": the week of the month, as it is said after "в". */
const NTH_SAID: Record<number, string> = { 1: '1-ю', 2: '2-ю', 3: '3-ю', 4: '4-ю', [-1]: 'последнюю' };

/** "пн, ср, пт", Monday first, rather than in the order Veeam happened to list them. */
export const daysOf = (weekdays: number[]): string =>
  [...weekdays]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((day) => DAY_NAMES[day])
    .join(', ');

/** "1-го числа", "в 3-ю ср месяца": a day of the month, as the operator would say it. */
export const monthDaySaid = (day: MonthDay): string =>
  'date' in day ? `${day.date}-го числа` : `в ${NTH_SAID[day.nth]} ${daysOf([day.weekday])} месяца`;

/** " в 03:12", or nothing when Veeam gave no time. */
const atOf = (minute: number | undefined): string =>
  minute === undefined ? '' : ` в ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * The schedule in one line: "пн, ср, пт в 03:12", "ежедневно в 22:00",
 * "только вручную".
 *
 * Said from the one reading, like 📅's shorter `scheduleKind` below: a
 * reading of `dailyKind` living next to a renderer would be another copy of a
 * rule that already exists twice in Veeam's own UI. A copy of its own said a
 * job on the fourth Saturday ran on the 1st, the date Veeam fills in beside it.
 */
export const describeSchedule = (schedule: VeeamSchedule | undefined): string | undefined => {
  const timetable = timetableOf(schedule);
  if (!timetable) return undefined;
  switch (timetable.kind) {
    case 'manual':
      return 'только вручную';
    case 'daily': {
      const at = atOf(timetable.minute);
      if (timetable.days === 'every') return `ежедневно${at}`;
      if (timetable.days === 'weekdays') return `по рабочим дням${at}`;
      return `${daysOf(timetable.weekdays) || 'по выбранным дням'}${at}`;
    }
    case 'monthly':
      return `ежемесячно, ${timetable.day ? monthDaySaid(timetable.day) : 'раз в месяц'}${atOf(timetable.minute)}`;
    case 'periodic': {
      const { every } = timetable;
      if (!every) return 'периодически';
      return `каждые ${every % 60 === 0 ? `${every / 60} ч` : `${every} мин`}`;
    }
    case 'continuous':
      return 'непрерывно';
    case 'after':
      return timetable.job ? `после «${timetable.job}»` : 'после другого задания';
  }
};

/**
 * "3 раза через 10 мин", or that retries are off.
 *
 * Worth its own line: four failed twenty-second runs followed by a success is
 * not four incidents, it is one job retrying, and the run list reads as a
 * disaster until you know that.
 */
export const describeRetry = (schedule: VeeamSchedule | undefined): string | undefined => {
  const retry = schedule?.retry;
  if (!retry) return undefined;
  if (!retry.isEnabled) return 'выключен';
  const count = retry.retryCount ?? 0;
  const wait = retry.awaitMinutes ? ` через ${retry.awaitMinutes} мин` : '';
  return count ? `${count} раза${wait}` : `включён${wait}`;
};

/** "ежедневно", "по рабочим дням": how the schedule is set, for 📅. */
const scheduleKind = (schedule: VeeamSchedule | undefined): string | undefined => {
  const timetable = timetableOf(schedule);
  switch (timetable?.kind) {
    case 'daily':
      return timetable.days === 'every' ? 'ежедневно' : timetable.days === 'weekdays' ? 'по рабочим дням' : 'по выбранным дням';
    case 'monthly':
      return 'ежемесячно';
    case 'periodic':
      return 'периодически';
    case 'continuous':
      return 'непрерывно';
    case 'after':
      return 'после другой задачи';
    default:
      return undefined;
  }
};

/* ------------------------------------------------------------------ *
 * 📅
 * ------------------------------------------------------------------ */

/** One upcoming start of one job, as the 📅 and ▶️ slots list them. */
export interface ScheduledRun {
  name: string;
  /** ISO instant of the next scheduled start. */
  at: string;
  /** "ежедневно", "по рабочим дням" — how the schedule is set, not a Cadence. */
  scheduleKind?: string;
}

/** Today's authoritative nextRun values, checked against each job's config. */
export const todayRuns = (
  jobs: Job[],
  schedules: ReadonlyMap<string, VeeamSchedule>,
  now: Date,
  timezone: string,
): ScheduledRun[] => {
  const today = dayIn(now.getTime(), timezone);
  return jobs
    .flatMap((job): ScheduledRun[] => {
      if (!job.nextRun || isDisabled(job)) return [];
      const at = Date.parse(job.nextRun);
      if (!Number.isFinite(at) || at <= now.getTime()) return [];
      if (dayIn(at, timezone) !== today) return [];
      const schedule = schedules.get(job.id);
      if (schedule?.runAutomatically === false) return [];
      return [{
        name: job.name,
        at: new Date(at).toISOString(),
        scheduleKind: scheduleKind(schedule),
      }];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

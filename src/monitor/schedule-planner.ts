import { VeeamJobState, VeeamSchedule } from '../veeam/types';
import { ScheduledRun } from '../live/format';
import { isDisabled } from './job-state';

/** Veeam names weekdays in English; an operator reads them in two letters. */
const DAY_NAMES: Record<string, string> = {
  monday: 'пн',
  tuesday: 'вт',
  wednesday: 'ср',
  thursday: 'чт',
  friday: 'пт',
  saturday: 'сб',
  sunday: 'вс',
};

const WEEK_ORDER = Object.keys(DAY_NAMES);

/** "пн, ср, пт", in week order rather than the order Veeam happened to list. */
export const daysOf = (days: string[] | undefined): string =>
  (days ?? [])
    .map((day) => day.toLowerCase())
    .sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b))
    .map((day) => DAY_NAMES[day] ?? day)
    .join(', ');

/**
 * The schedule in one line: "пн, ср, пт в 03:12", "ежедневно в 22:00",
 * "только вручную".
 *
 * Shares its reading of the configuration with `cadence` below, which answers
 * the shorter version of the same question for the 📅 slot. Both are here
 * because this is the module that knows what a VeeamSchedule means; a second
 * reading of `dailyKind` living next to a renderer would be the third copy of
 * a rule that already exists twice in Veeam's own UI.
 */
export const describeSchedule = (schedule: VeeamSchedule | undefined): string | undefined => {
  if (!schedule) return undefined;
  // Checked first: a job with a filled-in daily schedule that Veeam will never
  // start on its own is common, and describing that schedule would be a lie.
  if (schedule.runAutomatically === false) return 'только вручную';

  if (schedule.daily?.isEnabled) {
    const at = schedule.daily.localTime ? ` в ${schedule.daily.localTime}` : '';
    const kind = (schedule.daily.dailyKind ?? '').toLowerCase();
    if (kind === 'everyday') return `ежедневно${at}`;
    if (kind === 'weekdays') return `по рабочим дням${at}`;
    const days = daysOf(schedule.daily.days);
    return days ? `${days}${at}` : `по выбранным дням${at}`;
  }

  if (schedule.monthly?.isEnabled) {
    const at = schedule.monthly.localTime ? ` в ${schedule.monthly.localTime}` : '';
    const which = [schedule.monthly.dayNumberInMonth, schedule.monthly.dayOfWeek]
      .filter(Boolean)
      .join(' ');
    const day = schedule.monthly.dayOfMonth
      ? `${schedule.monthly.dayOfMonth}-го числа`
      : which || 'раз в месяц';
    return `ежемесячно, ${day}${at}`;
  }

  if (schedule.periodically?.isEnabled) {
    const { frequency, periodicallyKind } = schedule.periodically;
    if (!frequency) return 'периодически';
    const unit = (periodicallyKind ?? '').toLowerCase() === 'hours' ? 'ч' : 'мин';
    return `каждые ${frequency} ${unit}`;
  }

  if (schedule.continuously?.isEnabled) return 'непрерывно';
  if (schedule.afterThisJob?.isEnabled) {
    const after = schedule.afterThisJob.jobName;
    return after ? `после «${after}»` : 'после другого задания';
  }
  return undefined;
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

const localDay = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || undefined,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);

const cadence = (schedule: VeeamSchedule | undefined): string | undefined => {
  if (schedule?.monthly?.isEnabled) return 'ежемесячно';
  if (schedule?.periodically?.isEnabled) return 'периодически';
  if (schedule?.daily?.isEnabled) {
    const kind = (schedule.daily.dailyKind ?? '').toLowerCase();
    if (kind === 'everyday') return 'ежедневно';
    if (kind === 'weekdays') return 'по рабочим дням';
    return 'по выбранным дням';
  }
  if (schedule?.afterThisJob?.isEnabled) return 'после другой задачи';
  if (schedule?.continuously?.isEnabled) return 'непрерывно';
  return undefined;
};

/** Today's authoritative nextRun values, checked against each job's config. */
export const todayRuns = (
  jobs: VeeamJobState[],
  schedules: ReadonlyMap<string, VeeamSchedule>,
  now: Date,
  timezone: string,
): ScheduledRun[] => {
  const today = localDay(now, timezone);
  return jobs
    .flatMap((job): ScheduledRun[] => {
      if (!job.nextRun || isDisabled(job)) return [];
      const at = Date.parse(job.nextRun);
      if (!Number.isFinite(at) || at <= now.getTime()) return [];
      if (localDay(new Date(at), timezone) !== today) return [];
      const schedule = job.id ? schedules.get(job.id) : undefined;
      if (schedule?.runAutomatically === false) return [];
      return [{
        name: job.name ?? job.id ?? 'без имени',
        at: new Date(at).toISOString(),
        cadence: cadence(schedule),
      }];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

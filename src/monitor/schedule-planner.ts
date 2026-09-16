import { VeeamJobState, VeeamSchedule } from '../veeam/types';
import { ScheduledRun } from '../live/format';

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
      if (!job.nextRun || (job.status ?? '').toLowerCase() === 'disabled') return [];
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

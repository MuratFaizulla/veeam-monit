/**
 * The Calendar report: one server's jobs over one month — when each of them
 * runs, which nights carry a Full, how every past night went and how the
 * nights to come are planned, and where the night window is too tight.
 *
 * What the page is drawn from. Times are minutes after the operator's
 * midnight; days are the days of the month, from 1.
 */

/** How one night's run of a job went; `missed` is a run the schedule asked for that never started. */
export type CalendarResult = 'success' | 'warning' | 'failed' | 'missed' | 'running';

/** One run of a job, on the day it started. */
export interface CalendarRun {
  day: number;
  /** When it started, in minutes after midnight. */
  start: number;
  /** How long it went, in minutes. */
  minutes: number;
  result: CalendarResult;
  /** It wrote a Full (.vbk). */
  full: boolean;
}

/** What the schedule asks of a job on one day: nothing, a run, or a run that writes a Full. */
export type CalendarPlan = 'run' | 'full' | undefined;

export interface CalendarJob {
  name: string;
  kind: 'backup' | 'copy' | 'replica';
  enabled: boolean;
  /** The schedule in words: «ежедневно в 21:00», «пн–пт в 23:30», «после SQL_prod». */
  schedule: string;
  /** How its Fulls come: «Active Full в первую субботу», «Synthetic по субботам». */
  fullRule?: string;
  repository?: string;
  /** «14 точек», «30 дней». */
  retention?: string;
  /** When the schedule starts it, in minutes after midnight; undefined for a job run by hand. */
  start?: number;
  /** Minutes between starts, for a job started every few hours. */
  every?: number;
  /** The job it runs after, when it is chained. */
  after?: string;
  /** How long a run usually goes and how long the longest went, in minutes. */
  usual?: number;
  longest?: number;
  /** Runs far longer than usual — hung, mostly — that the longest is not judged by. */
  outliers?: number;
  /** How long a run that writes a Full usually goes. */
  usualFull?: number;
  /** How long a run usually waits for a proxy or a repository slot after its start time. */
  waited?: number;
  /** Day by day (index 0 is the 1st), what the schedule asks of it. */
  planned: CalendarPlan[];
  /** What it did, on the days already past. */
  runs: CalendarRun[];
  /** Its next start in words: «сегодня 21:00». */
  next?: string;
  /** How many machines it keeps restore points of. */
  machines?: number;
  /** The vCenters (or hosts) the machines it names live on. */
  vcenters?: string[];
  /** What it names to back up: machines, folders, clusters, tags. */
  objects?: Array<{ name: string; kind?: string }>;
  /** The proxies it is pinned to; empty when Veeam picks one for each run. */
  proxies?: string[];
}

/** A vCenter, and the jobs that back up machines of it. */
export interface CalendarVCenter {
  name: string;
  jobs: string[];
  /** Machines of those jobs with restore points, each counted once. */
  machines: number;
}

/** A backup proxy and the jobs pinned to it. */
export interface CalendarProxy {
  name: string;
  /** Its transport mode in words: «Hot-Add», «NBD (сеть)». */
  mode?: string;
  /** How many disks it processes at once. */
  tasks?: number;
  pinned: string[];
}

/** What the jobs run on and back up: machines, vCenters, proxies. */
export interface CalendarInfrastructure {
  /** Machines with restore points, each counted once. */
  machines: number;
  vcenters: CalendarVCenter[];
  proxies: CalendarProxy[];
  /** Jobs that leave the proxy to Veeam. */
  automatic: string[];
}

export interface CalendarFinding {
  status: 'crit' | 'warn' | 'ok';
  /** What is wrong, and what to do about it, as plain text. */
  title: string;
  text: string;
}

export interface CalendarReport {
  server: string;
  year: number;
  /** 0 for January. */
  month: number;
  /** Today's day when the month is the current one. */
  today?: number;
  /** The night window, in minutes after midnight: 18:00–07:00 is 1080 and 420. */
  window: { from: number; to: number };
  jobs: CalendarJob[];
  /** Absent when none of it could be read. */
  infrastructure?: CalendarInfrastructure;
  verdict: { status: 'crit' | 'warn' | 'ok'; text: string };
  findings: CalendarFinding[];
}

/* ------------------------------------------------------------------ *
 * What the pages and the findings are both figured from
 * ------------------------------------------------------------------ */

export const DAY_MINUTES = 1440;

/** "21:05" for minutes after midnight, whatever day they fall on. */
export const hm = (minutes: number): string => {
  const m = ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Minutes after noon: a night is drawn from 12:00 to 12:00, so it does not break at midnight. */
export const fromNoon = (minutes: number): number => (((minutes - 720) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

/** When a job starts: its own time and its usual wait, or the usual end of the one it runs after. */
export const startOf = (report: Pick<CalendarReport, 'jobs'>, job: CalendarJob, depth = 0): number | undefined => {
  if (job.start !== undefined) return job.start + (job.waited ?? 0);
  if (!job.after || depth > 8) return undefined;
  const before = report.jobs.find((candidate) => candidate.name === job.after);
  if (!before) return undefined;
  const start = startOf(report, before, depth + 1);
  return start === undefined ? undefined : start + (before.usual ?? 0);
};

/**
 * Whether a run that began before the morning end of the window went on past
 * it. A run begun in the day is the day's business, not the night's.
 */
export const overran = (window: CalendarReport['window'], run: { start: number; minutes: number }): boolean =>
  fromNoon(run.start) < fromNoon(window.to) && fromNoon(run.start) + run.minutes > fromNoon(window.to);

/** The slot the night is counted in, minutes. */
export const LOAD_STEP = 10;

/**
 * How many jobs run at once, slot by slot from noon to noon: on an ordinary
 * night, or on `fullDay` (from 1), when the jobs owed a Full that day go as
 * long as a Full does.
 */
export const nightLoad = (report: Pick<CalendarReport, 'jobs'>, fullDay?: number): number[] => {
  const timed = report.jobs.filter((job) => job.enabled).flatMap((job) => {
    const start = startOf(report, job);
    if (start === undefined) return [];
    const full = fullDay !== undefined && job.planned[fullDay - 1] === 'full';
    return [{ from: fromNoon(start), minutes: (full ? job.usualFull : undefined) ?? job.usual ?? 0 }];
  });
  return Array.from({ length: DAY_MINUTES / LOAD_STEP }, (_, slot) => {
    const at = slot * LOAD_STEP;
    return timed.filter(({ from, minutes }) => at >= from && at < from + minutes).length;
  });
};

/** Stretches of an hour or more inside the window with nothing running, as minutes after noon. */
export const freeStretches = (window: CalendarReport['window'], load: number[]): Array<[number, number]> => {
  const from = fromNoon(window.from);
  const to = fromNoon(window.to);
  const free: Array<[number, number]> = [];
  let open: number | undefined;
  for (let slot = 0; slot <= load.length; slot++) {
    const at = slot * LOAD_STEP;
    const idle = slot < load.length && at >= from && at < to && load[slot] === 0;
    if (idle && open === undefined) open = at;
    if (!idle && open !== undefined) {
      if (at - open >= 60) free.push([open, at]);
      open = undefined;
    }
  }
  return free;
};

/** The day of the month with the most Fulls owed, and how many; undefined when none is. */
export const heaviestFullDay = (report: Pick<CalendarReport, 'jobs'>): { day: number; fulls: number } | undefined => {
  const days = Math.max(0, ...report.jobs.map((job) => job.planned.length));
  let best: { day: number; fulls: number } | undefined;
  for (let index = 0; index < days; index++) {
    const fulls = report.jobs.filter((job) => job.enabled && job.planned[index] === 'full').length;
    if (fulls && (!best || fulls > best.fulls)) best = { day: index + 1, fulls };
  }
  return best;
};

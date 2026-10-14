import { plural } from '../telegram/time';
import { Job } from '../veeam/estate';
import {
  VeeamBackupFile,
  VeeamJob,
  VeeamRepositoryState,
  VeeamRestorePoint,
  VeeamSession,
  VeeamTaskSession,
} from '../veeam/types';
import { dayIn, describeFulls, FullSchedule, fullSchedulesOf, nextFullDay } from './full-schedule';
import { localClock, shortOf, Status } from './repository-report';
import { retryWindowOf, runsOf } from './runs';
import { describeRetry, describeSchedule } from './schedule-planner';

/**
 * The Job report: one job over a month, as a PDF — every run, every machine
 * by run, the chain on disk, what Veeam said went wrong, who else writes to
 * the repository meanwhile, and what to do.
 *
 * Here is what it says, from what was read; nothing here asks Veeam. The
 * reading is `./job-reports`, the page `./job-report-page`.
 */

/** The period a Job report covers. */
export const JOB_REPORT_DAYS = 30;

const DAY = 86_400_000;
const MINUTE = 60_000;

/** What one job's report is made from. */
export interface JobReading {
  at: number;
  days: number;
  server: string;
  job: Job;
  configured?: VeeamJob;
  /** The job's sessions inside the period, newest first, each with its machines' tasks when they were read. */
  attempts: Array<{ session: VeeamSession; tasks?: VeeamTaskSession[] }>;
  /** Veeam's primary bottleneck of each of the newest runs: `Target`, `Source`, … */
  bottlenecks: string[];
  repository?: VeeamRepositoryState;
  files: VeeamBackupFile[];
  points: VeeamRestorePoint[];
  /** The other jobs that write to the same repository. */
  neighbours: Array<{ id: string; name: string }>;
  /** Their sessions around the job's newest run. */
  neighbourRuns: Array<{ jobId: string; start: string; end?: string }>;
  /** What could not be read, when something could not. */
  error?: string;
}

/** How one machine, attempt or run ended. */
export type Outcome = 'success' | 'warning' | 'failed' | 'none';

/** One run: the first attempt and Veeam's retries of it. */
export interface JobRun {
  start: number;
  end?: number;
  result: Outcome;
  /** Every attempt, first first: what it came to and how long it took. */
  pieces: Array<{ result: Outcome; minutes: number }>;
  /** All the attempts together. */
  minutes: number;
  /** Machines saved, of those the run went through; undefined when the tasks were not read. */
  saved?: number;
  machines?: number;
}

/** One machine over the period. */
export interface ReportMachine {
  name: string;
  /** Veeam's own words for its size: "553,3 MB". */
  size?: string;
  /** Its outcome in each run whose machines were read, oldest first; per day when there are many. */
  history: Outcome[];
  /** Runs it was in, and those it was saved in. */
  tookPart: number;
  succeeded: number;
  lastSaved?: number;
  points: number;
  oldestPoint?: number;
  newestPoint?: number;
  /** Its usual time when saved, minutes. */
  minutes?: number;
  /** Bytes sent when it was last saved. */
  transferred?: number;
  /** What Veeam last said went wrong with it, in a run or an attempt. */
  error?: string;
  /** `healed` when the attempt failed and a retry of the same run saved it. */
  errorTone?: 'crit' | 'warn' | 'healed';
  /** In runs, and never saved in any. */
  failing: boolean;
}

/** One thing Veeam said went wrong, and to which machines. */
export interface ErrorGroup {
  text: string;
  /** Veeam's message as written: a rule may need its second line. */
  raw: string;
  failed: boolean;
  machines: string[];
  runs: number;
  last: number;
}

/** The files written on one day. */
export interface ChainDay {
  /** The calendar day, as its `Date.UTC` midnight. */
  day: number;
  full: boolean;
  disk: number;
  data: number;
  files: number;
}

/** A job on the chart of who writes to the repository while the job's newest run does. */
export interface Neighbour {
  name: string;
  spans: Array<{ start: number; end: number }>;
  own?: boolean;
}

export type FindingIcon = 'fail' | 'alert' | 'layers' | 'clock' | 'disk';

/** What is wrong, in one line and the fact under it. */
export interface Finding {
  severity: 'crit' | 'warn';
  icon: FindingIcon;
  title: string;
  detail: string;
}

/** What to do. `tags` are the machines or jobs it is about. */
export interface Step {
  severity: 'crit' | 'warn' | 'ok';
  title: string;
  detail: string;
  tags: string[];
}

export interface JobReport {
  at: number;
  days: number;
  server: string;
  name: string;
  type?: string;
  status: Status;
  verdict: string;
  schedule?: string;
  retry?: string;
  fulls?: string;
  retention?: string;
  repository?: { name: string; short: string; type: string; freeGB: number; capacityGB: number };
  /** Oldest first. */
  runs: JobRun[];
  /** Scheduled starts no run came for. */
  missed: number[];
  /** The runs the machines' history is about: their first and last start, and how many. */
  history: { from?: number; to?: number; runs: number; byDay: boolean };
  machines: ReportMachine[];
  errors: ErrorGroup[];
  /** Newest first. */
  chain: ChainDay[];
  disk: number;
  data: number;
  newestPoint?: number;
  /** How far back a typical saved machine can be restored. */
  depth?: { points: number; oldest: number };
  /** The usual first attempt, minutes. */
  usual: number;
  longest?: JobRun;
  neighbours: { rows: Neighbour[]; jobs: number; of: number; origin: number; window?: { start: number; end: number } };
  bottleneck?: string;
  nextFull?: { day: number; kind: FullSchedule['kind'] };
  lastFull?: ChainDay;
  findings: Finding[];
  steps: Step[];
  partial?: string;
}

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

const runsWord = (count: number) => plural(count, 'запуск', 'запуска', 'запусков');
/** After «из»: из 1 запуска, из 5 запусков. */
const ofRuns = (count: number) => plural(count, 'запуска', 'запусков', 'запусков');
const ofMachines = (count: number) => plural(count, 'машины', 'машин', 'машин');

/** Veeam's message as worth reading: no "Processing <machine>", no "Error:", its first line. */
export const saidOf = (message: string | undefined): string =>
  (String(message ?? '')
    .replace(/^Processing \S+\s*/, '')
    .replace(/^Error:\s*/, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '').replace(/\s+/g, ' ');

const outcomeOf = (result: string | undefined): Outcome => {
  const lower = (result ?? '').toLowerCase();
  return lower === 'success' || lower === 'warning' || lower === 'failed' ? lower : 'none';
};
const saved = (outcome: Outcome) => outcome === 'success' || outcome === 'warning';
const WORST: Record<Outcome, number> = { failed: 3, warning: 2, success: 1, none: 0 };

/** When a session ended; one still going has none, or Veeam's year-1900 placeholder. */
export const endOf = (session: { endTime?: string }): string | undefined =>
  session.endTime && Date.parse(session.endTime) > Date.UTC(2000, 0, 1) ? session.endTime : undefined;

/** "00:02:00" or "1.02:03:04", in minutes. */
const minutesOf = (text: string | null | undefined): number | undefined => {
  const parts = /(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(text ?? '');
  return parts ? Number(parts[1] ?? 0) * 1440 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 60 : undefined;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};

/** How far `timezone` is ahead of UTC at `at`, in milliseconds. */
const offsetAt = (at: number, timezone: string): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at))
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
};

/** The instant `minute` past midnight of `day` (a `Date.UTC` midnight) is in `timezone`. */
const instantOf = (day: number, minute: number, timezone: string): number => {
  const guess = day + minute * MINUTE;
  return guess - offsetAt(guess - offsetAt(guess, timezone), timezone);
};

/**
 * A time Veeam wrote. A task's or a backup file's carries no offset: it is the
 * Veeam server's own clock, taken to be in the bot's zone — read as the
 * process's local time instead, a file written at 22:00 would land on the next day.
 */
const veeamTime = (text: string | undefined, timezone: string): number => {
  if (!text) return NaN;
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(text)) return Date.parse(text);
  const wall = Date.parse(`${text}Z`);
  return Number.isFinite(wall) ? wall - offsetAt(wall - offsetAt(wall, timezone), timezone) : NaN;
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export const jobReportOf = (reading: JobReading, timezone: string): JobReport => {
  const { at, days } = reading;
  const from = at - days * DAY;
  const configured = reading.configured;
  const schedule = configured?.schedule;
  const local = localClock(timezone);

  // Runs, oldest first.
  const attempts = reading.attempts.map(({ session, tasks }) => ({
    startedAt: session.creationTime,
    endedAt: endOf(session),
    result: session.result?.result,
    tasks,
  }));
  const runs = runsOf(attempts, retryWindowOf(schedule))
    .map((run) => {
      const oldestFirst = [...run.attempts].reverse();
      const read = oldestFirst.every((attempt) => attempt.tasks !== undefined);
      // A machine's outcome is its newest attempt's: a retry goes back for the failed ones only.
      const machines = new Map<string, VeeamTaskSession>();
      for (const attempt of oldestFirst) for (const task of attempt.tasks ?? []) if (task.name) machines.set(task.name, task);
      const pieces = oldestFirst.map((attempt) => {
        const start = Date.parse(attempt.startedAt ?? '');
        const end = attempt.endedAt ? Date.parse(attempt.endedAt) : at;
        return { result: outcomeOf(attempt.result), minutes: Math.max(0, (end - start) / MINUTE) };
      });
      return {
        start: Date.parse(oldestFirst[0].startedAt ?? ''),
        end: run.attempts[0].endedAt ? Date.parse(run.attempts[0].endedAt) : undefined,
        result: outcomeOf(run.result),
        pieces,
        minutes: pieces.reduce((sum, piece) => sum + piece.minutes, 0),
        read,
        machines,
        tasks: oldestFirst.flatMap((attempt) => attempt.tasks ?? []),
      };
    })
    .filter((run) => Number.isFinite(run.start) && run.start >= from)
    .reverse();

  // Machines: what the job names, and what its runs went through.
  const listed = (configured?.virtualMachines?.includes ?? []).filter((object) => /virtualmachine/i.test(object.type ?? '') && object.name);
  const withTasks = runs.filter((run) => run.read && run.machines.size);
  const names = [...new Set([...listed.map((object) => object.name as string), ...withTasks.flatMap((run) => [...run.machines.keys()])])];
  const pointsOf = new Map<string, number[]>();
  for (const point of reading.points) {
    const when = Date.parse(point.creationTime ?? '');
    if (point.name && Number.isFinite(when)) pointsOf.set(point.name, [...(pointsOf.get(point.name) ?? []), when]);
  }
  const byDay = withTasks.length > 31;
  const columns = byDay
    ? [...new Set(withTasks.map((run) => dayIn(run.start, timezone)))].map((day) => withTasks.filter((run) => dayIn(run.start, timezone) === day))
    : withTasks.map((run) => [run]);

  const machines: ReportMachine[] = names.map((name) => {
    const history = columns.map((group) =>
      group.map((run) => outcomeOf(run.machines.get(name)?.result?.result)).reduce<Outcome>((worst, outcome) => (WORST[outcome] > WORST[worst] ? outcome : worst), 'none'),
    );
    const finals = withTasks.flatMap((run) => (run.machines.has(name) ? [{ run, task: run.machines.get(name) as VeeamTaskSession }] : []));
    const good = finals.filter(({ task }) => saved(outcomeOf(task.result?.result)));
    // Every attempt's word, a first attempt a retry made good included.
    const bad = withTasks.flatMap((run) =>
      run.tasks
        .filter((task) => task.name === name && ['failed', 'warning'].includes(outcomeOf(task.result?.result)) && saidOf(task.result?.message))
        .map((task) => ({ task, healed: outcomeOf(task.result?.result) === 'failed' && saved(outcomeOf(run.machines.get(name)?.result?.result)) })),
    );
    const last = bad.at(-1);
    const newest = good.at(-1);
    const points = (pointsOf.get(name) ?? []).sort((a, b) => a - b);
    const durations = good.map(({ task }) => minutesOf(task.progress?.duration)).filter((value): value is number => value !== undefined);
    return {
      name,
      size: listed.find((object) => object.name === name)?.size,
      history,
      tookPart: finals.length,
      succeeded: good.length,
      lastSaved: newest?.run.start,
      points: points.length,
      oldestPoint: points[0],
      newestPoint: points.at(-1),
      minutes: durations.length ? median(durations) : undefined,
      transferred: newest?.task.progress?.transferredSize ?? undefined,
      error: last ? saidOf(last.task.result?.message) : undefined,
      errorTone: last ? (last.healed ? 'healed' : outcomeOf(last.task.result?.result) === 'failed' ? 'crit' : 'warn') : undefined,
      failing: finals.length > 0 && good.length === 0,
    };
  });
  machines.sort((a, b) => a.succeeded / (a.tookPart || 1) - b.succeeded / (b.tookPart || 1) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  // What went wrong, grouped by what it says.
  const groups = new Map<string, ErrorGroup & { runSet: Set<number>; machineSet: Set<string> }>();
  for (const run of withTasks) {
    for (const task of run.tasks) {
      const outcome = outcomeOf(task.result?.result);
      const text = saidOf(task.result?.message);
      if ((outcome !== 'failed' && outcome !== 'warning') || !text || !task.name) continue;
      const key = text.replace(/vm-\d+/g, 'vm').replace(/\[[^\]]*\]/g, '[]').slice(0, 90);
      const group = groups.get(key) ?? { text, raw: task.result?.message ?? text, failed: false, machines: [], runs: 0, last: 0, runSet: new Set(), machineSet: new Set() };
      group.failed ||= outcome === 'failed';
      group.machineSet.add(task.name);
      group.runSet.add(run.start);
      group.last = Math.max(group.last, run.start);
      groups.set(key, group);
    }
  }
  const errors: ErrorGroup[] = [...groups.values()]
    .map(({ runSet, machineSet, ...group }) => ({ ...group, machines: [...machineSet], runs: runSet.size }))
    .sort((a, b) => Number(b.failed) - Number(a.failed) || b.machines.length - a.machines.length || b.runs - a.runs);

  const missed = missedStarts(runs, schedule, from, at, timezone);

  // The chain, a day a row.
  const files = reading.files
    .map((file) => ({ at: veeamTime(file.creationTime, timezone), full: /\.vbk$/i.test(file.name ?? ''), disk: file.backupSize ?? 0, data: file.dataSize ?? 0 }))
    .filter((file) => Number.isFinite(file.at));
  const chainDays = new Map<number, ChainDay>();
  for (const file of files) {
    const day = dayIn(file.at, timezone);
    const entry = chainDays.get(day) ?? { day, full: false, disk: 0, data: 0, files: 0 };
    entry.full ||= file.full;
    entry.disk += file.disk;
    entry.data += file.data;
    entry.files += 1;
    chainDays.set(day, entry);
  }
  const chain = [...chainDays.values()].sort((a, b) => b.day - a.day);
  const disk = files.reduce((sum, file) => sum + file.disk, 0);
  const data = files.reduce((sum, file) => sum + file.data, 0);

  const withPoints = machines.filter((machine) => machine.points);
  const newestPoint = withPoints.length ? Math.max(...withPoints.map((machine) => machine.newestPoint as number)) : undefined;
  const depth = withPoints.length
    ? { points: median(withPoints.map((machine) => machine.points)), oldest: median(withPoints.map((machine) => machine.oldestPoint as number)) }
    : undefined;

  const usual = median(runs.filter((run) => run.end !== undefined).map((run) => run.pieces[0].minutes));
  const longest = [...runs].sort((a, b) => b.minutes - a.minutes)[0];

  // Who else writes to the repository while the newest run does.
  const newest = runs.at(-1);
  const named = new Map(reading.neighbours.map((neighbour) => [neighbour.id, neighbour.name]));
  const window = newest ? { start: newest.start, end: newest.end ?? at } : undefined;
  const overlapping = window
    ? reading.neighbourRuns
        .map((run) => ({ name: named.get(run.jobId), start: Date.parse(run.start), end: run.end ? Date.parse(run.end) : at }))
        .filter((run): run is { name: string; start: number; end: number } => Boolean(run.name) && run.start < window.end && run.end > window.start)
        .sort((a, b) => a.start - b.start)
    : [];
  const byJob = new Map<string, Array<{ start: number; end: number }>>();
  for (const { name, start, end } of overlapping) byJob.set(name, [...(byJob.get(name) ?? []), { start, end }]);
  // From the noon before the run, so a night stays in one piece.
  const origin = window ? window.start - ((local(window.start).minute - 720 + 1440) % 1440) * MINUTE : at;
  const neighbours = {
    rows: [
      ...(window ? [{ name: reading.job.name, spans: [window], own: true }] : []),
      ...[...byJob].slice(0, 11).map(([name, spans]) => ({ name, spans })),
    ],
    jobs: byJob.size,
    of: reading.neighbours.length,
    origin,
    window,
  };

  const counted = reading.bottlenecks.reduce<Record<string, number>>((tally, stage) => ({ ...tally, [stage]: (tally[stage] ?? 0) + 1 }), {});
  const bottleneck = Object.entries(counted).sort((a, b) => b[1] - a[1])[0]?.[0];

  const fullSchedules = fullSchedulesOf(configured?.storage);
  const nextFull = fullSchedules?.length ? nextFullDay(fullSchedules, at, timezone) : undefined;
  const lastFull = chain.find((day) => day.full);

  const repositoryName = reading.repository?.name;
  const repository = reading.repository && repositoryName
    ? {
        name: repositoryName,
        short: shortOf(repositoryName.replace(/_\d+$/, '')),
        type: reading.repository.type ?? '',
        freeGB: reading.repository.freeGB ?? 0,
        capacityGB: reading.repository.capacityGB ?? 0,
      }
    : undefined;
  const retention = configured?.storage?.retentionPolicy;

  const base = {
    at,
    days,
    server: reading.server,
    name: reading.job.name,
    type: reading.job.type,
    schedule: describeSchedule(schedule),
    retry: describeRetry(schedule),
    fulls: fullSchedules ? describeFulls(fullSchedules) : undefined,
    retention: retention?.quantity
      ? retention.type === 'Days'
        ? `хранить ${retention.quantity} ${plural(retention.quantity, 'день', 'дня', 'дней')}`
        : `хранить ${retention.quantity} ${plural(retention.quantity, 'точку', 'точки', 'точек')}`
      : undefined,
    repository,
    runs: runs.map(({ start, end, result, pieces, minutes, read, machines: done }) => ({
      start,
      end,
      result,
      pieces,
      minutes,
      ...(read && done.size ? { saved: [...done.values()].filter((task) => saved(outcomeOf(task.result?.result))).length, machines: done.size } : {}),
    })),
    missed,
    history: { from: withTasks[0]?.start, to: withTasks.at(-1)?.start, runs: withTasks.length, byDay },
    machines,
    errors,
    chain,
    disk,
    data,
    newestPoint,
    depth,
    usual,
    neighbours,
    bottleneck,
    nextFull,
    lastFull,
    ...(reading.error ? { partial: reading.error } : {}),
  };
  const report: JobReport = { ...base, longest: longest && base.runs[runs.indexOf(longest)], status: 'ok', verdict: '', findings: [], steps: [] };
  report.findings = findingsOf(report, schedule, timezone);
  report.steps = stepsOf(report, schedule, timezone);
  report.status = report.findings.some((finding) => finding.severity === 'crit') ? 'crit' : report.findings.length ? 'warn' : 'ok';
  report.verdict = verdictOf(report);
  return report;
};

/**
 * Scheduled starts of a daily schedule no run came for, after the job's first
 * run in the period: a job created last week owes nothing before it.
 */
const missedStarts = (runs: Array<{ start: number }>, schedule: VeeamJob['schedule'], from: number, at: number, timezone: string): number[] => {
  const daily = schedule?.daily;
  if (schedule?.runAutomatically === false || !daily?.isEnabled || !daily.localTime || !runs.length) return [];
  const kind = (daily.dailyKind ?? '').toLowerCase();
  const allowed = kind === 'everyday' ? WEEKDAYS : kind === 'weekdays' ? WEEKDAYS.slice(1, 6) : (daily.days ?? []).map((day) => day.toLowerCase());
  const [hour, minute] = daily.localTime.split(':').map(Number);
  const missed: number[] = [];
  const first = dayIn(Math.max(from, runs[0].start), timezone) + DAY;
  const today = dayIn(at, timezone);
  for (let day = first; day < today; day += DAY) {
    if (!allowed.includes(WEEKDAYS[new Date(day).getUTCDay()])) continue;
    const due = instantOf(day, hour * 60 + minute, timezone);
    // Late is not missing: a start queued for hours, past midnight even, still came.
    if (!runs.some((run) => run.start >= due - 2 * 3_600_000 && run.start < due + 12 * 3_600_000)) missed.push(due);
  }
  return missed;
};

export const dayLabel = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, day: '2-digit', month: '2-digit' }).format(new Date(at));
export const calendarLabel = (day: number): string => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }).format(new Date(day));
export const sizeOf = (bytes: number): string => {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1000) return `${(gb / 1024).toFixed(1).replace('.', ',')} ТБ`;
  if (gb >= 10) return `${Math.round(gb)} ГБ`;
  if (gb >= 0.1) return `${gb.toFixed(1).replace('.', ',')} ГБ`;
  return `${Math.round(bytes / 1024 ** 2)} МБ`;
};
export const spanOf = (minutes: number): string => {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} мин`;
  const rest = whole % 60;
  return rest ? `${Math.floor(whole / 60)} ч ${rest} мин` : `${Math.floor(whole / 60)} ч`;
};

const isVShield = (text: string | undefined) => /vShield_SVM|MethodDisabled/i.test(text ?? '');

/** What is wrong, the worst first. */
const findingsOf = (report: JobReport, schedule: VeeamJob['schedule'], timezone: string): Finding[] => {
  const findings: Finding[] = [];
  const { runs, machines, days } = report;
  const never = machines.filter((machine) => machine.failing);
  const failed = runs.filter((run) => run.result === 'failed');
  const retried = runs.filter((run) => run.pieces.length > 1 && run.pieces[0].result === 'failed' && saved(run.result));
  const firstFailure = report.errors.find((group) => group.failed);

  if (!runs.length && schedule?.runAutomatically !== false) {
    findings.push({ severity: 'crit', icon: 'alert', title: `За ${days} дней ни одного запуска`, detail: report.schedule ? `по расписанию — ${report.schedule}` : 'расписание не прочитано' });
  }
  if (never.length) {
    findings.push({
      severity: 'crit',
      icon: 'fail',
      title: `${never.length} из ${machines.length} ${ofMachines(machines.length)} ${plural(never.length, 'не сохранена', 'не сохранены', 'не сохранены')} ни разу за ${days} дней`,
      detail: never[0].error ? `«${never[0].error}»` : '',
    });
  }
  if (runs.length && failed.length === runs.length) {
    const withRetries = runs.filter((run) => run.pieces.length > 1).length;
    findings.push({
      severity: 'crit',
      icon: 'alert',
      title: runs.length === 1 ? 'Единственный запуск закончился ошибкой' : `Все ${runs.length} ${runsWord(runs.length)} закончились ошибкой`,
      detail: withRetries ? `повторы не помогают: ${withRetries} из ${runs.length} ${ofRuns(runs.length)} шли с повторами` : 'повторов не было',
    });
  } else if (runs.at(-1)?.result === 'failed') {
    const last = runs.at(-1) as JobRun;
    findings.push({ severity: 'crit', icon: 'fail', title: `Последний запуск ${dayLabel(last.start, timezone)} закончился ошибкой`, detail: firstFailure ? `«${firstFailure.text}»` : '' });
  }
  if (retried.length) {
    findings.push({
      severity: 'warn',
      icon: 'layers',
      title: `Первая попытка падает в ${retried.length} из ${runs.length} ${ofRuns(runs.length)} — спасает повтор`,
      detail: firstFailure ? `«${firstFailure.text}»` : '',
    });
  }
  if (report.missed.length) {
    findings.push({
      severity: 'warn',
      icon: 'clock',
      title: `Не было ${report.missed.length} ${ofRuns(report.missed.length)} по расписанию`,
      detail: report.missed.slice(0, 6).map((at) => dayLabel(at, timezone)).join(', '),
    });
  }
  const longest = report.longest;
  if (longest && report.usual && longest.minutes > Math.max(60, 4 * report.usual)) {
    const times = Math.round(longest.minutes / report.usual);
    findings.push({
      severity: 'warn',
      icon: 'clock',
      title: `${dayLabel(longest.start, timezone)} шёл ${spanOf(longest.minutes)} — в ${times} ${plural(times, 'раз', 'раза', 'раз')} дольше обычного`,
      detail: `обычно первая попытка — ${spanOf(report.usual)}`,
    });
  }
  const repository = report.repository;
  const freeBytes = repository ? repository.freeGB * 1024 ** 3 : 0;
  const freeShare = repository?.capacityGB ? Math.round((100 * repository.freeGB) / repository.capacityGB) : undefined;
  const tight = Boolean(report.nextFull && report.lastFull && repository && freeBytes < 3 * report.lastFull.disk);
  if (tight && report.nextFull && report.lastFull && repository) {
    findings.push({
      severity: freeBytes < 1.5 * report.lastFull.disk ? 'crit' : 'warn',
      icon: 'disk',
      title: `${report.nextFull.kind === 'active' ? 'Active' : 'Synthetic'} Full ${calendarLabel(report.nextFull.day)} займёт ≈ ${sizeOf(report.lastFull.disk)} — свободно ${sizeOf(freeBytes)}`,
      detail: `на ${repository.short} свободно ${freeShare}%`,
    });
  } else if (repository && freeShare !== undefined && freeShare < 20) {
    findings.push({ severity: freeShare < 10 ? 'crit' : 'warn', icon: 'disk', title: `На ${repository.short} свободно ${freeShare}%`, detail: `${sizeOf(freeBytes)} из ${sizeOf(repository.capacityGB * 1024 **3)}` });
  }
  if (report.neighbours.jobs >= 5 && report.neighbours.window) {
    findings.push({
      severity: 'warn',
      icon: 'disk',
      title: `В репозиторий одновременно пишут ещё ${report.neighbours.jobs} ${plural(report.neighbours.jobs, 'задача', 'задачи', 'задач')}`,
      detail: `во время запуска ${dayLabel(report.neighbours.window.start, timezone)}`,
    });
  }
  return findings;
};

/** What to do about it, the most urgent first. */
const stepsOf = (report: JobReport, schedule: VeeamJob['schedule'], timezone: string): Step[] => {
  const steps: Step[] = [];
  const never = report.machines.filter((machine) => machine.failing);
  const nsx = never.filter((machine) => isVShield(machine.error)).map((machine) => machine.name);
  const others = never.filter((machine) => !isVShield(machine.error));
  const tags = (names: string[], shown = 4) => [...names.slice(0, shown), ...(names.length > shown ? [`ещё ${names.length - shown}`] : [])];
  const retried = report.runs.some((run) => run.pieces.length > 1 && run.pieces[0].result === 'failed' && saved(run.result));

  if (nsx.length) {
    steps.push({
      severity: 'crit',
      title: `Исключить из задания ${nsx.length} ${plural(nsx.length, 'служебную машину', 'служебные машины', 'служебных машин')} NSX`,
      detail: 'VMware запрещает снимать их снимки (vShield_SVM), поэтому Veeam не может их сохранить и каждый запуск — с ошибкой. Конфигурацию NSX сохраняют бэкапом NSX Manager.',
      tags: tags(nsx),
    });
  }
  if (others.length) {
    steps.push({
      severity: 'crit',
      title: `Разобраться с ${others.length} ${plural(others.length, 'машиной', 'машинами', 'машинами')}, которые не сохраняются`,
      detail: others[0].error ? `«${others[0].error}»` : 'Veeam не объяснил причину.',
      tags: tags(others.map((machine) => machine.name)),
    });
  }
  const dns = report.errors.find((group) => /name resolution|getaddrinfo/i.test(group.raw));
  if (dns) {
    steps.push({ severity: 'warn', title: 'Проверить DNS на прокси', detail: `Прокси не нашёл vCenter по имени (${dayLabel(dns.last, timezone)}): «${dns.text}»`, tags: tags(dns.machines, 3) });
  }
  const timeout = report.errors.find((group) => group.failed && /истекло|timed? ?out|Getting VM info/i.test(group.text));
  if (timeout && retried) {
    steps.push({
      severity: 'warn',
      title: `Сдвинуть старт${schedule?.daily?.localTime ? ` с ${schedule.daily.localTime}` : ''} или проверить vCenter`,
      detail: `Первая попытка падает на «${timeout.text}» — vCenter не успевает ответить, когда стартует много задач. Повтор${schedule?.retry?.awaitMinutes ? ` через ${schedule.retry.awaitMinutes} мин` : ''} проходит.`,
      tags: tags(timeout.machines, 3),
    });
  }
  const readOnly = report.errors.find((group) => /VDDK|read-only/i.test(group.text));
  if (readOnly) {
    steps.push({ severity: 'warn', title: 'Разобраться с диском, который открывается только на чтение', detail: `«${readOnly.text.slice(0, 120)}»`, tags: tags(readOnly.machines, 3) });
  }
  const repository = report.repository;
  if (report.nextFull && report.lastFull && repository) {
    const free = repository.freeGB * 1024 ** 3;
    const tight = free < 3 * report.lastFull.disk;
    const share = repository.capacityGB ? ` (${Math.round((100 * repository.freeGB) / repository.capacityGB)}%)` : '';
    steps.push({
      severity: tight ? 'warn' : 'ok',
      title: tight ? `Освободить место на ${repository.short} до ${calendarLabel(report.nextFull.day)}` : `Следующий ${report.nextFull.kind === 'active' ? 'Active' : 'Synthetic'} Full — ${calendarLabel(report.nextFull.day)}`,
      detail: `Последний Full (${calendarLabel(report.lastFull.day)}) занял ${sizeOf(report.lastFull.disk)} на диске. На ${repository.short} свободно ${sizeOf(free)}${share}${tight ? ' — меньше трёх таких Full, а туда пишут и другие задачи.' : ' — места хватает.'}`,
      tags: [],
    });
  }
  if (report.neighbours.jobs >= 5 && report.neighbours.window) {
    steps.push({
      severity: 'warn',
      title: 'Развести старт с соседями по репозиторию',
      detail: `Во время запуска ${dayLabel(report.neighbours.window.start, timezone)} в репозиторий писали ещё ${report.neighbours.jobs} задач.${report.bottleneck ? ` Узкое место последних запусков — ${report.bottleneck}.` : ''}`,
      tags: tags(report.neighbours.rows.filter((row) => !row.own).map((row) => row.name), 3),
    });
  }
  if (!steps.some((step) => step.severity !== 'ok')) {
    steps.unshift({ severity: 'ok', title: 'Ничего срочного', detail: report.runs.length ? 'Запуски проходят, машины сохраняются.' : 'Запусков за период не было.', tags: [] });
  }
  return steps;
};

const verdictOf = (report: JobReport): string => {
  const [first, second] = report.findings;
  if (first) return second ? `${first.title}; ${second.title.charAt(0).toLowerCase()}${second.title.slice(1)}` : first.title;
  if (!report.runs.length) return `Запусков за ${report.days} дней не было`;
  return `${report.runs.length === 1 ? 'Запуск прошёл' : `Все ${report.runs.length} ${runsWord(report.runs.length)} прошли`}, все машины сохранены`;
};

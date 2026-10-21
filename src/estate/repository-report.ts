import { ReportSite } from '../config/configuration';
import { VeeamRepositoryState, VeeamSchedule } from '../veeam/types';
import { plural } from '../telegram/time';
import { Status } from './report-envelope';
import { ReportJob, writesTo } from './repository-writers';
import { Load, Stage } from './run-speed';
import { retryWindowOf, runsOf } from './runs';
import { timetableOf } from './schedule-planner';

/**
 * The Repository report: every repository of every server, what writes to it
 * and when, what is wrong with it and what to do — worked out from one
 * Repository reading, for the PDF that `/repos` sends.
 *
 * A repository here is the folder, not Veeam's object. One share attached to
 * four servers is four repositories to Veeam and one disk to everybody else:
 * four servers' jobs fill it, its free space is one number, and two of its
 * attachments on one server count that space twice. So the attachments are
 * grouped by the folder they point at, whatever address they reach it by.
 *
 * Pure: what was read goes in, what the report says comes out. Reading is
 * `RepositoryReports`; drawing it, `repository-report-page.ts`.
 */

/** One session of a job: an Attempt, with its result lower-cased. */
export interface ReportAttempt {
  jobId: string;
  startedAt: string;
  endedAt?: string;
  result: string;
}

/** One backup chain on a repository, and what its files take up. */
export interface ReportBackup {
  name: string;
  platform?: string;
  repositoryId?: string;
  jobId?: string;
  /** Bytes its files take up; 0 when they could not be read. */
  size: number;
  /** ISO instant of its newest file, when the files were read. */
  newest?: string;
}

/** What one server said for the report. */
export interface ServerReading {
  server: string;
  /** Why the server could not be read in full. Whatever was read before it is kept. */
  error?: string;
  repositories: VeeamRepositoryState[];
  jobs: ReportJob[];
  attempts: ReportAttempt[];
  /** How busy each stage was in a job's newest finished attempts, one entry per attempt. */
  loads: Array<{ jobId: string; load: Load }>;
  /** What runs now. */
  working: Array<{ jobId: string; since: string; percent?: number }>;
  backups: ReportBackup[];
}

/** One reading of every server, at one moment. */
export interface RepositoryReading {
  /** Epoch ms of the reading. */
  at: number;
  /** How many days of sessions it covers. */
  days: number;
  servers: ServerReading[];
}

export type { ReportSite } from '../config/configuration';

export type Severity = 'crit' | 'warn' | 'unknown';
export type Icon = 'disk' | 'clock' | 'fail' | 'layers' | 'target' | 'box' | 'link' | 'gear' | 'question';

export interface Problem {
  severity: Severity;
  icon: Icon;
  title: string;
  detail: string;
}

export interface Action {
  severity: 'crit' | 'warn';
  what: string;
  /** Where in the console, step by step. */
  where: string[];
  /** What it brings. */
  effect: string;
}

/** A job's schedule, as the report draws it. */
export interface Plan {
  /** "ежедневно", "пн–пт", "каждые 4 ч". */
  label: string;
  /** Weekdays it starts on, Sunday 0. */
  days: number[];
  /** Minutes after midnight it starts at. */
  starts: number[];
  /** "22:00", when it starts once a day. */
  time?: string;
  periodic: boolean;
}

/** One job that writes to a repository, as the report draws it. */
export interface Writer {
  server: string;
  name: string;
  disabled: boolean;
  /** Writes its backups there, or only a replica's metadata. */
  role: 'backup' | 'metadata';
  plan: Plan;
  /** Minute of the day it usually starts. */
  startMinute?: number;
  /** Its Runs in the period: when each began and ended, epoch ms, and whether it failed. */
  runs: Array<{ start: number; end?: number; failed: boolean }>;
  /** Hours a finished Run usually takes, and the longest. */
  usualHours?: number;
  longestHours?: number;
  failed: number;
  /** The stage that held it back most, on average over its newest attempts. */
  bottleneck?: { stage: Stage; percent: number };
  running?: { hours: number; percent?: number; sinceMinute: number };
  /** Running far longer than it ever takes. */
  hanging: boolean;
  /** Its spans of writing in the period, epoch ms: what the hour-by-hour load counts. */
  spans: Array<[number, number]>;
}

export interface Move {
  writer: Writer;
  from: string;
  fromMinute: number;
  to: string;
  toMinute: number;
  /** How long it usually writes, minutes. */
  minutes: number;
  /** How many jobs write at once around it by the schedules, before and after. */
  before: number;
  after: number;
}

export interface Settling {
  kind: 'name' | 'twice';
  server: string;
  /** For `name`: the repository and the folder it points at. For `twice`: the repositories. */
  repositories: string[];
  folder?: string;
}

/** One physical repository. */
export interface ReportRepository {
  name: string;
  /** "BKP03": what people call it. */
  short: string;
  site: string;
  type: string;
  path: string;
  /** Every attachment of it: the server and Veeam's name for it there. */
  members: Array<{ server: string; repository: string; answered: boolean }>;
  servers: string[];
  capacityGB: number;
  freeGB: number;
  freePercent: number;
  writers: Writer[];
  active: Writer[];
  /** Chains no job on any server owns, biggest first. */
  orphans: ReportBackup[];
  orphanBytes: number;
  /** What all the chains' files add up to — more than the disk holds when the array deduplicates. */
  allBytes: number;
  /** Chains of jobs switched off. */
  ofDisabled: ReportBackup[];
  disabledBytes: number;
  settings: Settling[];
  /** Its server did not answer: only the space is known. */
  unknown: boolean;
  /** Most jobs writing at once, per weekday (Monday first) and hour. */
  heat: number[][];
  peak: number;
  peakAt?: string;
  /** Main bottleneck of each job, counted: Source 14, Target 3. */
  spread: Array<[Stage, number]>;
  mainBottleneck?: Stage;
  /** Jobs whose load is known. */
  measured: number;
  hanging: Writer[];
  failing: Writer[];
  /** Most jobs at once by the schedules alone, before and after the moves. */
  plannedBefore: number;
  plannedAfter: number;
  moves: Move[];
  problems: Problem[];
  status: Status;
  verdict: string;
  /** How well a new job fits; absent when it does not. */
  fit?: number;
  actions: Action[];
  /** For ordering by need: the worse, the higher. */
  score: number;
}

/** What one server attaches of one repository: its jobs there working and all, or that it did not answer. */
export type Attachment = { on: number; all: number; twice: boolean } | 'unknown' | null;

export interface FirstThing {
  severity: 'crit' | 'warn';
  icon: Icon;
  title: string;
  detail: string;
}

export interface RepositoryReport {
  at: number;
  days: number;
  servers: Array<{ name: string; answered: boolean }>;
  /** Sites in the order configured, each with its repositories by name. */
  sites: Array<{ name: string; repositories: ReportRepository[] }>;
  repositories: ReportRepository[];
  /** Per repository, per server in `servers` order. */
  attachments: Map<ReportRepository, Attachment[]>;
  /** What to do first, across every repository. */
  first: FirstThing[];
}

const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
/** Weekdays in the order the report lists them, Monday first. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];
export const dayName = (day: number): string => DAY_NAMES[day];

const TB = 1024 ** 4;
/** Less than this is not worth a line. */
const NOTABLE_BYTES = 0.05 * TB;
const SLOT = 15;
const SLOTS = 1440 / SLOT;
/** The backup window: starts are moved only inside it, and whole runs must fit in it. */
const WINDOW_FROM = 18 * 60;
const WINDOW_TO = 7 * 60;
const MAX_MOVES = 8;

export const STAGE_NAMES: Record<Stage, string> = { source: 'Source', proxy: 'Proxy', network: 'Network', target: 'Target' };

export const num = (value: number, digits = 1): string => value.toFixed(digits).replace('.', ',');
export const tb = (bytes: number): string => num(bytes / TB);
export const tbOfGB = (gb: number): string => num(gb / 1024);
export const hours = (value: number | undefined): string =>
  value === undefined ? '—' : value < 1 ? `${Math.max(1, Math.round(value * 60))} мин` : `${num(value)} ч`;
export const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(Math.round(minute % 60)).padStart(2, '0')}`;
const jobs = (count: number): string => `${count} ${plural(count, 'задача', 'задачи', 'задач')}`;
const backupsWord = (count: number): string => plural(count, 'бэкап', 'бэкапа', 'бэкапов');

/** A title as the middle of a sentence: "Мало места" is "мало места", and ТБ stays ТБ. */
const inSentence = (title: string): string => title.charAt(0).toLowerCase() + title.slice(1);

const median = (values: number[]): number | undefined =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : undefined;

/**
 * Weekday and minute of the day of an instant, in the zone the schedules are
 * written in: Veeam's `localTime` is the server's clock, and the operator's
 * zone is taken to be the same.
 */
export const localClock = (timezone: string): ((at: number) => { day: number; minute: number }) => {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || undefined,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (at) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
    return { day: DAYS.indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute) };
  };
};

const dayRange = (days: number[]): string => {
  const order = WEEK.filter((day) => days.includes(day)).map((day) => WEEK.indexOf(day));
  const runs: number[][] = [];
  for (const index of order) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === index - 1) last.push(index);
    else runs.push([index]);
  }
  const name = (index: number) => DAY_NAMES[WEEK[index]].toLowerCase();
  return runs.map((run) => (run.length >= 3 ? `${name(run[0])}–${name(run[run.length - 1])}` : run.map(name).join(', '))).join(', ');
};

/** A schedule as the report draws it: the planner's reading of it, in the report's words. */
export const planOf = (schedule: VeeamSchedule | undefined): Plan => {
  const none: Plan = { label: 'вручную', days: [], starts: [], periodic: false };
  if (!schedule) return none;
  const timetable = timetableOf(schedule);
  const at = (minute: number | undefined) => (minute === undefined ? { starts: [] } : { starts: [minute], time: hhmm(minute) });
  switch (timetable?.kind) {
    case 'manual':
      return none;
    case 'daily': {
      const days = timetable.weekdays;
      return { label: days.length === 7 ? 'ежедневно' : dayRange(days), days, ...at(timetable.minute), periodic: false };
    }
    case 'monthly':
      return { label: 'раз в месяц', days: [], ...at(timetable.minute), periodic: false };
    case 'periodic': {
      // A day's starts counted from midnight, as the chart has always drawn them: the minutes past the hour and the window are not drawn.
      const { every } = timetable;
      if (!every) return { ...none, label: 'другое' };
      return {
        label: `каждые ${every >= 60 ? `${num(every / 60, 0)} ч` : `${every} мин`}`,
        days: [0, 1, 2, 3, 4, 5, 6],
        starts: Array.from({ length: Math.floor(1440 / every) }, (_, index) => index * every),
        periodic: true,
      };
    }
    case 'after':
      return { ...none, label: `после ${timetable.job ?? 'другой задачи'}` };
    case 'continuous':
      return { ...none, label: 'непрерывно' };
    default:
      return { ...none, label: 'другое' };
  }
};

/** The folder a repository points at, lower-cased, whatever address reaches it; undefined for a local disk. */
const folderOf = (path: string | undefined): string | undefined => {
  const plain = (path ?? '').toLowerCase().replace(/[\\/]+$/, '');
  if (plain.startsWith('\\\\')) return plain.split('\\').slice(3).join('\\') || undefined;
  const nfs = /^nfs\d*:\/\/[^:/]+:?(\/.*)$/.exec(plain);
  return nfs ? nfs[1].replace(/^\/+/, '') || undefined : undefined;
};
const tailOf = (folder: string): string => folder.split(/[\\/]/).pop() ?? folder;
const bare = (name: string): string => name.toLowerCase().replace(/_\d+$/, '');

/** "NAS01_SHARE_BKP03" is BKP03; a name without such an ending keeps its first part. */
export const shortOf = (name: string): string => /_([A-Z]+\d+)$/i.exec(name)?.[1] ?? name.split('_')[0];

const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/** The site of a repository by its name; '' when no site is configured. */
export const siteOf = (sites: readonly ReportSite[], name: string): string =>
  (sites.find((site) => site.patterns.some((pattern) => glob(pattern).test(name))) ?? sites.find((site) => !site.patterns.length))?.name ?? '';

const isDefault = (repository: VeeamRepositoryState): boolean =>
  (repository.type ?? '').toLowerCase() === 'winlocal' && /^default backup repository$/i.test(repository.name ?? '');

/**
 * What the report says, from what was read. `sites` sorts the repositories;
 * `timezone` is the zone the schedules are written in.
 */
export const reportOf = (reading: RepositoryReading, sites: readonly ReportSite[], timezone: string): RepositoryReport => {
  const local = localClock(timezone);
  const now = reading.at;

  // Every job name on any server: a chain whose job is on another server is not an orphan.
  const anywhere = new Set(reading.servers.flatMap((server) => server.jobs.map((job) => job.name)));

  // One physical repository may be attached to several servers, and to one twice.
  type Member = { server: ServerReading; repository: VeeamRepositoryState };
  const groups = new Map<string, Member[]>();
  for (const server of reading.servers) {
    for (const repository of server.repositories) {
      if (isDefault(repository)) continue;
      const folder = folderOf(repository.path);
      const key = folder
        ? `${(repository.type ?? '').toLowerCase()}:${folder}:${Math.round((repository.capacityGB ?? 0) / 1024)}`
        : `${server.server}:${(repository.path ?? repository.name ?? repository.id ?? '').toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), { server, repository }]);
    }
  }

  const repositories: ReportRepository[] = [];
  for (const members of groups.values()) {
    const first = members[0].repository;
    const folder = folderOf(first.path);
    const names = members.map((member) => (member.repository.name ?? member.repository.id ?? '').replace(/_\d+$/, ''));
    const name = names.find((candidate) => folder && candidate.toLowerCase() === bare(tailOf(folder))) ?? [...names].sort((a, b) => a.length - b.length)[0];

    const writers: Writer[] = [];
    for (const { server, repository } of members) {
      const attemptsOf = new Map<string, ReportAttempt[]>();
      for (const attempt of server.attempts) attemptsOf.set(attempt.jobId, [...(attemptsOf.get(attempt.jobId) ?? []), attempt]);
      const loadsOf = new Map<string, Load[]>();
      for (const { jobId, load } of server.loads) loadsOf.set(jobId, [...(loadsOf.get(jobId) ?? []), load]);
      const working = new Map(server.working.map((session) => [session.jobId, session]));
      for (const job of server.jobs) {
        const role = writesTo(job, repository.id);
        if (!role) continue;
        writers.push(writerOf(job, role, server.server, attemptsOf.get(job.id) ?? [], loadsOf.get(job.id) ?? [], working.get(job.id), now, local));
      }
    }

    // Backups: the attachment whose view holds the most bytes knows the chains best.
    const views = members.map(({ server, repository }) => {
      const own = new Set(server.jobs.map((job) => job.id));
      const list = server.backups
        .filter((backup) => backup.repositoryId === repository.id)
        .map((backup) => ({ backup, owned: Boolean(backup.jobId && own.has(backup.jobId)) || anywhere.has(backup.name) }));
      return { list, bytes: list.reduce((sum, { backup }) => sum + backup.size, 0) };
    });
    const view = views.sort((a, b) => b.bytes - a.bytes)[0] ?? { list: [], bytes: 0 };
    const switchedOff = new Set(writers.filter((writer) => writer.disabled).map((writer) => writer.name));
    const orphans = view.list.filter(({ owned }) => !owned).map(({ backup }) => backup).sort((a, b) => b.size - a.size);
    const ofDisabled = view.list.filter(({ owned, backup }) => owned && switchedOff.has(backup.name)).map(({ backup }) => backup);

    // Settings that do not add up: a name that points elsewhere, one folder twice on one server.
    const settings: Settling[] = [];
    for (const { server, repository } of members) {
      const label = repository.name ?? repository.id ?? '';
      if (folder && bare(label) !== bare(tailOf(folder))) {
        settings.push({ kind: 'name', server: server.server, repositories: [label], folder: tailOf(folder).toUpperCase() });
      }
    }
    const perServer = new Map<string, string[]>();
    for (const { server, repository } of members) perServer.set(server.server, [...(perServer.get(server.server) ?? []), repository.name ?? repository.id ?? '']);
    for (const [server, attached] of perServer) if (attached.length > 1) settings.push({ kind: 'twice', server, repositories: attached });

    const capacityGB = first.capacityGB ?? 0;
    const freeGB = first.freeGB ?? 0;
    const orphanBytes = orphans.reduce((sum, backup) => sum + backup.size, 0);
    repositories.push({
      name,
      short: shortOf(name),
      site: siteOf(sites, name),
      type: (first.type ?? '').toUpperCase(),
      path: first.path ?? '',
      members: members.map(({ server, repository }) => ({ server: server.server, repository: repository.name ?? repository.id ?? '', answered: !server.error })),
      servers: [...new Set(members.map(({ server }) => server.server))],
      capacityGB,
      freeGB,
      freePercent: capacityGB ? (100 * freeGB) / capacityGB : 0,
      writers,
      active: writers.filter((writer) => !writer.disabled),
      orphans,
      orphanBytes,
      allBytes: view.bytes,
      ofDisabled,
      disabledBytes: ofDisabled.reduce((sum, backup) => sum + backup.size, 0),
      settings,
      unknown: members.some(({ server }) => server.error) && !writers.length,
      heat: [],
      peak: 0,
      spread: [],
      measured: 0,
      hanging: [],
      failing: [],
      plannedBefore: 0,
      plannedAfter: 0,
      moves: [],
      problems: [],
      status: 'ok',
      verdict: '',
      actions: [],
      score: 0,
    });
  }

  // Two of one name (an SMB and an NFS repository of one site, say): said which is which.
  const clashing = repositories.filter((one) => repositories.some((other) => other !== one && other.name === one.name));
  for (const repository of clashing) {
    repository.name = `${repository.name} · ${repository.type}`;
    repository.short = `${repository.short} · ${repository.type}`;
  }

  for (const repository of repositories) judge(repository, local);

  const answered = reading.servers.map((server) => ({ name: server.server, answered: !server.error }));
  const attachments = new Map<ReportRepository, Attachment[]>(
    repositories.map((repository) => [
      repository,
      answered.map(({ name: server, answered: ok }) => {
        const here = repository.members.filter((member) => member.server === server);
        if (!here.length) return null;
        if (!ok) return 'unknown';
        const own = repository.writers.filter((writer) => writer.server === server);
        return { on: own.filter((writer) => !writer.disabled).length, all: own.length, twice: here.length > 1 };
      }),
    ]),
  );

  const order = (site: string) => {
    const index = sites.findIndex((candidate) => candidate.name === site);
    return index === -1 ? sites.length : index;
  };
  const sorted = [...repositories].sort((a, b) => order(a.site) - order(b.site) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const siteNames = [...new Set(sorted.map((repository) => repository.site))];
  return {
    at: reading.at,
    days: reading.days,
    servers: answered,
    sites: siteNames.map((site) => ({ name: site, repositories: sorted.filter((repository) => repository.site === site) })),
    repositories: sorted,
    attachments,
    first: firstThings(sorted),
  };
};

const writerOf = (
  job: ReportJob,
  role: 'backup' | 'metadata',
  server: string,
  attempts: ReportAttempt[],
  loads: Load[],
  live: ServerReading['working'][number] | undefined,
  now: number,
  local: (at: number) => { day: number; minute: number },
): Writer => {
  const newestFirst = [...attempts]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .map((attempt) => ({ startedAt: attempt.startedAt, endedAt: attempt.endedAt, result: attempt.result }));
  const runs = runsOf(newestFirst, retryWindowOf(job.schedule)).map((run) => {
    const oldest = run.attempts[run.attempts.length - 1];
    const end = run.attempts[0].endedAt ? Date.parse(run.attempts[0].endedAt) : undefined;
    return { start: Date.parse(oldest.startedAt ?? ''), end, failed: run.result === 'failed' };
  });
  const finished = runs.filter((run) => run.end !== undefined).map((run) => ((run.end as number) - run.start) / 3_600_000);
  const plan = planOf(job.schedule);
  let bottleneck: Writer['bottleneck'];
  if (loads.length) {
    const stages: Stage[] = ['source', 'proxy', 'network', 'target'];
    const average = stages.map((stage) => [stage, Math.round(loads.reduce((sum, load) => sum + load[stage], 0) / loads.length)] as const);
    const [stage, percent] = [...average].sort((a, b) => b[1] - a[1])[0];
    bottleneck = { stage, percent };
  }
  const usual = median(finished);
  const since = live ? Date.parse(live.since) : undefined;
  const runningHours = since !== undefined ? (now - since) / 3_600_000 : undefined;
  const startMinute = plan.starts[0] ?? median(runs.map((run) => local(run.start).minute));
  return {
    server,
    name: job.name,
    disabled: job.disabled,
    role,
    plan,
    startMinute,
    runs,
    usualHours: usual,
    longestHours: finished.length ? Math.max(...finished) : undefined,
    failed: runs.filter((run) => run.failed).length,
    bottleneck,
    running: since !== undefined && runningHours !== undefined ? { hours: runningHours, percent: live?.percent, sinceMinute: local(since).minute } : undefined,
    hanging: runningHours !== undefined && runningHours > Math.max(6, 3 * (usual ?? 0)),
    spans: attempts.map((attempt) => [Date.parse(attempt.startedAt), attempt.endedAt ? Date.parse(attempt.endedAt) : now] as [number, number]),
  };
};

/** Load, problems, status, moves, fit and actions of one repository. */
const judge = (repository: ReportRepository, local: (at: number) => { day: number; minute: number }): void => {
  // Most jobs writing in each weekday-hour: every hour a job wrote in counts it once.
  const byHour = new Map<number, Set<string>>();
  for (const writer of repository.writers) {
    for (const [start, end] of writer.spans) {
      for (let hour = start - (start % 3_600_000); hour < end; hour += 3_600_000) {
        byHour.set(hour, (byHour.get(hour) ?? new Set()).add(`${writer.server}/${writer.name}`));
      }
    }
  }
  repository.heat = WEEK.map(() => new Array<number>(24).fill(0));
  for (const [hour, writing] of byHour) {
    const { day, minute } = local(hour);
    const row = repository.heat[WEEK.indexOf(day)];
    row[Math.floor(minute / 60)] = Math.max(row[Math.floor(minute / 60)], writing.size);
  }
  repository.peak = Math.max(0, ...repository.heat.flat());
  repository.heat.forEach((row, index) =>
    row.forEach((value, hour) => {
      if (!repository.peakAt && value && value === repository.peak) repository.peakAt = `${DAY_NAMES[WEEK[index]]} ${String(hour).padStart(2, '0')}:00`;
    }),
  );

  const measured = repository.active.filter((writer) => writer.bottleneck);
  repository.measured = measured.length;
  const stages: Stage[] = ['source', 'target', 'network', 'proxy'];
  repository.spread = stages
    .map((stage) => [stage, measured.filter((writer) => writer.bottleneck?.stage === stage).length] as [Stage, number])
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1]);
  repository.mainBottleneck = repository.spread[0]?.[0];
  repository.hanging = repository.active.filter((writer) => writer.hanging);
  repository.failing = repository.active.filter((writer) => writer.runs.length >= 3 && writer.failed / writer.runs.length >= 0.5);

  planMoves(repository);

  const problems: Problem[] = [];
  const add = (severity: Severity, icon: Icon, title: string, detail: string) => problems.push({ severity, icon, title, detail });
  const silent = [...new Set(repository.members.filter((member) => !member.answered).map((member) => member.server))];
  const free = Math.round(repository.freePercent);
  if (repository.unknown) add('unknown', 'question', 'Нет данных о задачах', `${silent.join(', ')} не ответил — кто пишет сюда, неизвестно.`);
  if (repository.freePercent < 10) add('crit', 'disk', `Места почти нет: свободно ${free}%`, `${tbOfGB(repository.freeGB)} ТБ из ${tbOfGB(repository.capacityGB)} ТБ. Цель — не меньше 20%.`);
  else if (repository.freePercent < 20) add('warn', 'disk', `Мало места: свободно ${free}%`, `${tbOfGB(repository.freeGB)} ТБ из ${tbOfGB(repository.capacityGB)} ТБ. Цель — не меньше 20%.`);
  if (repository.hanging.length) {
    add(
      repository.hanging.some((writer) => (writer.running?.hours ?? 0) > 24) ? 'crit' : 'warn',
      'clock',
      `${repository.hanging.length === 1 ? 'Висит' : 'Висят'} ${jobs(repository.hanging.length)}`,
      repository.hanging.map((writer) => `${writer.name} — идёт ${hours(writer.running?.hours)}, обычно ${hours(writer.usualHours)}`).join('; '),
    );
  }
  if (repository.failing.length) {
    add('warn', 'fail', `Часто ${repository.failing.length === 1 ? 'падает' : 'падают'} ${jobs(repository.failing.length)}`, repository.failing.map((writer) => `${writer.name} — ${writer.failed} из ${writer.runs.length}`).join(', '));
  }
  if (repository.peak >= 6) {
    const moved = repository.moves.length
      ? ` Перенос ${repository.moves.length} ${plural(repository.moves.length, 'старта', 'стартов', 'стартов')} снизит пик по расписанию с ${repository.plannedBefore} до ${repository.plannedAfter}.`
      : '';
    add('warn', 'layers', `До ${jobs(repository.peak)} пишут одновременно`, `Пик — ${repository.peakAt}.${moved}`);
  }
  if (repository.mainBottleneck === 'target' && repository.spread[0][1] >= 2) {
    add('warn', 'target', 'Упирается в запись (Target)', `Target — узкое место у ${repository.spread[0][1]} из ${measured.length} задач.`);
  }
  if (repository.orphanBytes > NOTABLE_BYTES) {
    const disabled = repository.disabledBytes ? `; ещё ${tb(repository.disabledBytes)} ТБ — у выключенных задач` : '';
    add('warn', 'box', `${tb(repository.orphanBytes)} ТБ бэкапов без задачи`, `${repository.orphans.length} ${backupsWord(repository.orphans.length)} без задачи ни на одном сервере${disabled}.`);
  }
  for (const setting of repository.settings) {
    if (setting.kind === 'name') add('warn', 'gear', 'Имя репозитория не совпадает с папкой', `На ${setting.server} «${setting.repositories[0]}» пишет в папку ${setting.folder}.`);
    else add('warn', 'gear', 'Одна папка — два репозитория', `На ${setting.server}: ${setting.repositories.join(' и ')} смотрят в одну и ту же папку.`);
  }
  if (repository.servers.length > 1) {
    add('warn', 'link', `Подключён к ${repository.servers.length} серверам Veeam`, `${repository.servers.join(', ')}. Veeam не поддерживает одну папку под несколькими серверами.`);
  }
  const rank: Record<Severity, number> = { crit: 0, unknown: 0.5, warn: 1 };
  repository.problems = problems.sort((a, b) => rank[a.severity] - rank[b.severity]);
  repository.status = repository.unknown ? 'unknown' : problems.some((problem) => problem.severity === 'crit') ? 'crit' : problems.length ? 'warn' : 'ok';
  repository.score = (repository.status === 'crit' ? 300 : repository.status === 'warn' ? 100 : 0) + (100 - repository.freePercent) + 10 * problems.length;
  repository.verdict =
    repository.status === 'unknown'
      ? 'Сервер Veeam не ответил — видно только место на диске.'
      : repository.status === 'crit'
        ? `Нужны действия: ${problems.filter((problem) => problem.severity === 'crit').map((problem) => inSentence(problem.title)).join('; ')}.`
        : repository.status === 'warn'
          ? `Работает, но есть что поправить: ${problems.slice(0, 2).map((problem) => inSentence(problem.title)).join('; ')}.`
          : 'Всё в порядке: места достаточно, задачи идут без ошибок.';

  // A new job fits where there is room, the hours are quiet and writing is not what holds jobs back.
  const fit = repository.freePercent - 2 * repository.peak - (repository.mainBottleneck === 'target' ? 15 : 0) - 3 * repository.failing.length;
  if (!repository.unknown && repository.freePercent >= 25 && !repository.hanging.length && repository.peak < 9 && fit > 0) repository.fit = fit;

  repository.actions = actionsOf(repository, silent);
};

/**
 * Start times worth moving: a week of 15-minute slots filled by the schedules
 * and the usual length of each run, and the longest runs moved first to the
 * quietest start where the whole run stays inside the backup window.
 */
const planMoves = (repository: ReportRepository): void => {
  const plan = repository.active
    .filter((writer) => writer.plan.days.length && writer.plan.time && !writer.plan.periodic && writer.usualHours !== undefined)
    .map((writer) => ({ writer, days: writer.plan.days, start: writer.plan.starts[0], length: Math.max(1, Math.ceil(((writer.usualHours as number) * 60) / SLOT)) }));
  type Planned = (typeof plan)[number];
  const grid = Array.from({ length: 7 }, () => new Array<number>(SLOTS).fill(0));
  const cells = (job: Planned, start: number): Array<[number, number]> =>
    job.days.flatMap((day) =>
      Array.from({ length: job.length }, (_, index) => {
        const slot = Math.floor(start / SLOT) + index;
        return [(day + Math.floor(slot / SLOTS)) % 7, slot % SLOTS] as [number, number];
      }),
    );
  const put = (job: Planned, start: number, sign: number) => cells(job, start).forEach(([day, slot]) => (grid[day][slot] += sign));
  const worst = (job: Planned, start: number) => Math.max(...cells(job, start).map(([day, slot]) => grid[day][slot]));
  plan.forEach((job) => put(job, job.start, 1));
  repository.plannedBefore = Math.max(0, ...grid.flat());

  const fits = (minute: number, length: number) =>
    minute >= WINDOW_FROM ? minute + length * SLOT <= 1440 + WINDOW_TO : minute < WINDOW_TO && minute + length * SLOT <= WINDOW_TO;
  for (const job of [...plan].sort((a, b) => b.length - a.length)) {
    if (repository.moves.length >= MAX_MOVES || (repository.plannedBefore < 4 && repository.peak < 6)) break;
    put(job, job.start, -1);
    const now = worst(job, job.start) + 1;
    if (now < Math.max(3, repository.plannedBefore - 1)) {
      put(job, job.start, 1);
      continue;
    }
    let best = job.start;
    let bestLoad = now;
    for (let minute = 0; minute < 1440; minute += SLOT) {
      if (!fits(minute, job.length)) continue;
      const load = worst(job, minute) + 1;
      if (load < bestLoad || (load === bestLoad && load < now && Math.abs(minute - job.start) < Math.abs(best - job.start))) {
        best = minute;
        bestLoad = load;
      }
    }
    const shift = Math.min(Math.abs(best - job.start), 1440 - Math.abs(best - job.start));
    if (bestLoad <= now - 2 && shift >= 30) {
      repository.moves.push({
        writer: job.writer,
        from: job.writer.plan.time ?? hhmm(job.start),
        fromMinute: job.start,
        to: hhmm(best),
        toMinute: best,
        minutes: job.length * SLOT,
        before: now,
        after: bestLoad,
      });
      put(job, best, 1);
    } else put(job, job.start, 1);
  }
  repository.plannedAfter = Math.max(0, ...grid.flat());
};

const actionsOf = (repository: ReportRepository, silent: string[]): Action[] => {
  const actions: Action[] = [];
  const act = (severity: Action['severity'], what: string, where: string[], effect: string) => actions.push({ severity, what, where, effect });
  if (repository.unknown) act('warn', `Проверить, почему не отвечает ${silent.join(', ')}`, ['REST API Veeam', 'порт 9419', 'ответ дольше таймаута'], 'появятся задачи и нагрузка');
  if (repository.hanging.length) act('crit', `Разобраться с зависшими: ${repository.hanging.map((writer) => writer.name).join(', ')}`, ['Задача', 'последняя сессия', 'на каком шаге стоит'], 'перестанут держать репозиторий');
  if (repository.orphanBytes > NOTABLE_BYTES) act(repository.freePercent < 15 ? 'crit' : 'warn', 'Решить с владельцами судьбу бэкапов без задачи', ['Backups', 'Disk (Orphaned)', 'Delete from disk'], `до ${tb(repository.orphanBytes)} ТБ`);
  if (repository.disabledBytes > NOTABLE_BYTES) act('warn', `Проверить бэкапы выключенных задач: ${repository.ofDisabled.map((backup) => backup.name).join(', ')}`, ['Задача не нужна', 'удалить вместе с бэкапами'], `до ${tb(repository.disabledBytes)} ТБ`);
  for (const setting of repository.settings) {
    if (setting.kind === 'name') act('warn', `Переименовать «${setting.repositories[0]}» на ${setting.server} — фактически это ${setting.folder}`, ['Backup Repositories', setting.repositories[0], 'Edit', 'Name'], 'никто не выберет его по ошибке');
    else act('warn', `Оставить один репозиторий на папку на ${setting.server}`, ['Перенести задачи на один', 'второй — Remove'], 'нет двойного учёта места');
  }
  if (repository.moves.length) act('warn', `Перенести старты ${repository.moves.length} ${plural(repository.moves.length, 'задачи', 'задач', 'задач')}`, ['Задача', 'Edit', 'Schedule'], `пик ${repository.plannedBefore} → ${repository.plannedAfter}`);
  if (repository.failing.length) act('warn', `Починить часто падающие: ${repository.failing.map((writer) => writer.name).join(', ')}`, ['Лог последней неудачной сессии'], 'меньше повторов в пик');
  if (repository.peak >= 6 || repository.mainBottleneck === 'target') act('warn', 'Ограничить одновременные задачи на репозитории', ['Repository', 'Edit', 'Limit maximum concurrent tasks'], 'запись идёт ровнее');
  if (repository.writers.length && repository.path.startsWith('\\\\')) act('warn', 'Задать gateway-сервер явно, а не Automatic', ['Repository', 'Edit', 'Gateway server'], 'не грузит прокси и VBR');
  if (repository.servers.length > 1) act('warn', 'Оставить репозиторий за одним сервером Veeam', ['На остальных', 'Remove repository', 'данные остаются'], 'нет конфликтов retention');
  return actions;
};

/** What to do first across every repository: the same kind of work, said once. */
const firstThings = (repositories: ReportRepository[]): FirstThing[] => {
  const things: FirstThing[] = [];
  const known = repositories.filter((repository) => !repository.unknown);
  const hanging = repositories
    .flatMap((repository) => repository.hanging.map((writer) => ({ writer, repository })))
    .sort((a, b) => (b.writer.running?.hours ?? 0) - (a.writer.running?.hours ?? 0));
  if (hanging.length) {
    things.push({
      severity: hanging.some(({ writer }) => (writer.running?.hours ?? 0) > 24) ? 'crit' : 'warn',
      icon: 'clock',
      title: `Разобраться с ${hanging.length} ${plural(hanging.length, 'зависшей задачей', 'зависшими задачами', 'зависшими задачами')}`,
      detail: `${hanging.slice(0, 3).map(({ writer, repository }) => `${writer.name} — ${hours(writer.running?.hours)} (${repository.short})`).join(', ')}${hanging.length > 3 ? `, ещё ${hanging.length - 3}` : ''}`,
    });
  }
  for (const repository of known.filter((candidate) => candidate.freePercent < 20).sort((a, b) => a.freePercent - b.freePercent)) {
    things.push({
      severity: repository.freePercent < 15 ? 'crit' : 'warn',
      icon: 'disk',
      title: `Освободить место на ${repository.short} — свободно ${Math.round(repository.freePercent)}%`,
      detail: repository.orphanBytes > NOTABLE_BYTES ? `Там ${tb(repository.orphanBytes)} ТБ бэкапов без задачи` : 'Перенести часть задач туда, где есть запас',
    });
  }
  const orphaned = repositories.reduce((sum, repository) => sum + repository.orphanBytes, 0);
  if (orphaned > TB) {
    const biggest = [...known].sort((a, b) => b.orphanBytes - a.orphanBytes).slice(0, 3);
    things.push({ severity: 'warn', icon: 'box', title: `Разобрать ${tb(orphaned)} ТБ бэкапов без задачи`, detail: `Больше всего: ${biggest.map((repository) => `${repository.short} ${tb(repository.orphanBytes)} ТБ`).join(' · ')}` });
  }
  const settings = repositories.flatMap((repository) => repository.settings);
  if (settings.length) {
    things.push({
      severity: 'warn',
      icon: 'gear',
      title: 'Исправить настройки репозиториев',
      detail: settings
        .map((setting) =>
          setting.kind === 'name'
            ? `${setting.server}: «${shortOf(setting.repositories[0])}» пишет в ${shortOf(setting.folder ?? '')}`
            : `${setting.server}: ${setting.repositories.map(shortOf).join(' и ')} — одна папка`,
        )
        .join('; '),
    });
  }
  const moving = repositories.filter((repository) => repository.moves.length);
  if (moving.length) {
    const count = moving.reduce((sum, repository) => sum + repository.moves.length, 0);
    things.push({
      severity: 'warn',
      icon: 'layers',
      title: `Перенести старты ${count} ${plural(count, 'задачи', 'задач', 'задач')}, чтобы снять пики`,
      detail: moving.map((repository) => `${repository.short} ${repository.plannedBefore} → ${repository.plannedAfter}`).join(' · '),
    });
  }
  const shared = repositories.filter((repository) => repository.servers.length > 1);
  if (shared.length) {
    const counts = shared.map((repository) => repository.servers.length);
    const spread = Math.min(...counts) === Math.max(...counts) ? `${counts[0]}` : `${Math.min(...counts)}–${Math.max(...counts)}`;
    things.push({
      severity: 'warn',
      icon: 'link',
      title: 'Закрепить каждую папку за одним сервером Veeam',
      detail: `${shared.length} ${plural(shared.length, 'репозиторий подключён', 'репозитория подключены', 'репозиториев подключены')} к ${spread} серверам`,
    });
  }
  const failing = repositories.reduce((sum, repository) => sum + repository.failing.length, 0);
  if (failing) {
    things.push({
      severity: 'warn',
      icon: 'fail',
      title: `Починить ${failing} часто ${plural(failing, 'падающую задачу', 'падающие задачи', 'падающих задач')}`,
      detail: repositories.filter((repository) => repository.failing.length).map((repository) => `${repository.short} ${repository.failing.length}`).join(' · '),
    });
  }
  return things.sort((a, b) => (a.severity === 'crit' ? 0 : 1) - (b.severity === 'crit' ? 0 : 1)).slice(0, 6);
};

/** The repositories a name asks for: whole name or short name, then containment. */
export const repositoriesNamed = (report: RepositoryReport, query: string): ReportRepository[] => {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return report.repositories;
  const exact = report.repositories.filter((repository) => [repository.name, repository.short].some((name) => name.toLowerCase() === wanted));
  if (exact.length) return exact;
  return report.repositories.filter((repository) =>
    [repository.name, repository.short, ...repository.members.map((member) => member.repository)].some((name) => name.toLowerCase().includes(wanted)),
  );
};

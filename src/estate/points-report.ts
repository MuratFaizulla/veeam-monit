import { plural } from '../telegram/time';
import { Job } from '../veeam/estate';
import { VeeamBackupFile, VeeamSchedule } from '../veeam/types';
import { MachineFailure, PendingEvidence, RetainedRun, Retention } from './evidence';
import { describeFulls, nextFullDay } from './full-schedule';
import { calendarLabel, dayLabel, sizeOf } from './job-report';
import { JobJudgement, Verdict, VerdictWords, verdictWords } from './job-standing';
import { JobPoints, owedDaysWords, retentionWords } from './point-facts';
import { Calendar, calendarOf, CALENDAR_DAYS, Cell, MachineDays } from './points-calendar';
import { RunSize, runSizesOf, sizesOf } from './points-sizes';
import { Status, STATUS_WORD } from './report-envelope';
import { dayIn, daysOf, describeSchedule, timetableOf } from './schedule-planner';

/**
 * What the Points report says of one job: what /points sends, as a PDF.
 *
 * The verdict 🛡 lists the job by, in 🛡's words; five numbers — the newest
 * point, how far back it reaches, the chain, the next Full, the disk; the five
 * weeks a machine to a row; the machines' errors; what to do; and the chains
 * on disk. Every fact is the Evidence's, as 🛡 and the Job report have it —
 * the same verdict, the same depth, the same chain — with what /points reads
 * beside it when asked: the job's backup files, its configuration and what
 * Veeam said of the machines of its newest failed attempts. Nothing here asks
 * Veeam; the reading is `./points-reports`.
 */

const DAY = 86_400_000;

/** Days back a machine's failure is still worth a word after a run saved it again. */
const RECENT_DAYS = 7;

/** A machine's own failure, and what Veeam said of it, where that was read. */
export interface MachineError extends MachineFailure {
  /** A line of Veeam's, as worth showing (`saidOf`). */
  reason?: string;
}

/** The job as its server's Evidence judges it, and what the scan read of it beside. */
export interface PointsEvidence extends JobJudgement {
  status: 'ready';
  /** When the scan read it, epoch ms. */
  scannedAt: number;
  /** Its schedule, as the scan read its configuration. */
  schedule?: VeeamSchedule;
  /** The machines' failures the scan set a point aside for. */
  setAside: MachineFailure[];
}

/** What one job's Points report is made from. */
export interface PointsReading {
  /** When it was asked, epoch ms: the calendar's last day is this one's. */
  at: number;
  server: string;
  job: Job;
  /** The job as the Evidence judges it, or why there is no Evidence yet. */
  evidence: PointsEvidence | PendingEvidence;
  /** The machines of its newest failed attempts that failed, with what Veeam said: the Job reads'. */
  failures: MachineError[];
  /** Its backup files; undefined when Veeam would not give them. */
  files?: VeeamBackupFile[];
  /** Its repository's name, where its configuration and the Inventory said. */
  repository?: string;
  /** The machines its configuration names, in its order. */
  named: string[];
  /** The 🛡 topic's name, without its icon: where the page says its points are as they are seen. */
  topic: string;
}

/**
 * What is said of a job's points when there is nothing to draw: no Evidence
 * yet, or a job whose points Veeam keeps where the scan does not read — a
 * replica, judged by its runs.
 */
export interface PointsUnseen {
  drawn: false;
  at: number;
  server: string;
  name: string;
  /** 🛡's verdict, where there is one. */
  verdict?: VerdictWords;
  why: string;
}

/** One of the five numbers under the head. */
export interface Tile {
  label: string;
  value: string;
  note?: string;
  /** The note says what is wrong. */
  alarm?: boolean;
}

/** Days some machines went without a point of the same cause. */
export interface ErrorGroup {
  machines: string[];
  /** As `Date.UTC` midnights, oldest first. */
  days: number[];
  /** What Veeam said, a line; absent where it was not read, or nothing failed. */
  reason?: string;
  /** False for days the job ran and these machines got neither a point nor a failure. */
  failed: boolean;
}

/** One thing to do. */
export interface PointsStep {
  title: string;
  detail?: string;
  /** «Важно», or «К сведению». */
  important: boolean;
}

/** One chain on disk: a Full and the increments after it. */
export interface ChainSpan {
  /** The day its Full was written, a `Date.UTC` midnight; absent for increments whose Full retention let go. */
  full?: number;
  /** Where it begins and ends, in the calendar's days; it may begin before the calendar does. */
  from: number;
  to: number;
  increments: number;
  /** What its files hold and take up; absent when no file was read for it. */
  data?: number;
  disk?: number;
  current: boolean;
  /** The day it is let go, whole, by retention; on the oldest of several only. */
  leaves?: number;
}

export interface Chains {
  /** Oldest first. */
  spans: ChainSpan[];
  /** The calendar's days before the oldest point retention kept. */
  retired: number;
  /** The days a Full was missed, by their place in the calendar. */
  missed: number[];
  /** A typical increment. */
  increment?: RunSize;
  /** A Full whose files hold nothing yet, still being written: when it began. */
  writing?: number;
}

/** The next day a Full is owed: «сб 24.10, 22:00». */
export interface NextFull {
  day: number;
  weekday: string;
  /** The job's start that day, where its schedule says one. */
  time?: string;
}

export interface PointsReport {
  drawn: true;
  at: number;
  scannedAt: number;
  server: string;
  name: string;
  status: Status;
  /** «Критично», «Норма», «Выключено в Veeam». */
  word: string;
  /** What 🛡 says of the job, in its words. */
  verdict: VerdictWords;
  /** Why it owes nobody a point, when it does not. */
  excused?: JobJudgement['excused'];
  /** Under the name: repository, machines, schedule and Fulls, retention. */
  facts: string[];
  tiles: Tile[];
  calendar: Calendar;
  /** The newest first. */
  errors: ErrorGroup[];
  /** What matters most first. */
  steps: PointsStep[];
  next?: NextFull;
  /** Absent where Veeam did not say which points are full. */
  chains?: Chains;
  newest?: number;
  depth?: { points: number; oldest: number };
  /** What the foot says it is: the Evidence, as 🛡 sees it, and when that was read. */
  foot: string;
}

export type Points = PointsReport | PointsUnseen;

/** What a replica's points are, said for one with nothing to draw. */
export const ELSEWHERE =
  'Точки заданий этого типа Veeam хранит отдельно, поэтому о нём судят по успешным запускам — подробнее в /job.';

const machinesWord = (count: number) => plural(count, 'машина', 'машины', 'машин');
/** After «у всех», «из»: машины, машин. */
const ofMachines = (count: number) => plural(count, 'машины', 'машин', 'машин');
const pointsWord = (count: number) => plural(count, 'точка', 'точки', 'точек');
const pointsAfter = (count: number) => plural(count, 'точку', 'точки', 'точек');
const daysWord = (count: number) => plural(count, 'день', 'дня', 'дней');
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "01:14" in the operator's zone. */
export const timeOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
/** "22.10 01:14". */
export const momentLabel = (at: number, timezone: string): string => `${dayLabel(at, timezone)} ${timeOf(at, timezone)}`;

/** "19.10, 20.10", or "14.10–21.10, 6 дней" when there are more than three. */
export const daysWords = (days: number[]): string =>
  days.length <= 3
    ? days.map(calendarLabel).join(', ')
    : `${calendarLabel(days[0])}–${calendarLabel(days[days.length - 1])}, ${days.length} ${daysWord(days.length)}`;

/** "ex-mbx-01, ex-mbx-02 и ещё 3". */
export const namesWords = (names: string[], shown = 3): string =>
  names.length > shown ? `${names.slice(0, shown).join(', ')} и ещё ${names.length - shown}` : names.join(', ');

/** "сб 24.10, 22:00". */
export const nextFullWords = (next: NextFull): string => `${next.weekday} ${calendarLabel(next.day)}${next.time ? `, ${next.time}` : ''}`;

export const pointsReportOf = (reading: PointsReading, timezone: string): Points => {
  const { at, job, evidence } = reading;
  const clock = { now: new Date(at), timezone };
  const base = { at, server: reading.server, name: job.name };
  if (evidence.status === 'pending') return { drawn: false, ...base, why: evidence.reason };
  const words = evidence.verdict ? verdictWords(evidence.verdict, clock) : undefined;
  // Their points are not in the list the scan reads: drawn, every day would be empty whatever the job did.
  if (evidence.byRuns) return { drawn: false, ...base, ...(words ? { verdict: words } : {}), why: ELSEWHERE };

  const points = evidence.points;
  const retained = points?.retained ?? [];
  const owed = evidence.verdict?.owed ?? [];
  const failures: MachineError[] = [...evidence.setAside, ...reading.failures];
  const machines = machinesOf(reading.named, retained, failures);
  const calendar = calendarOf({ retained, failures, machines, fulls: points?.fulls, owed, now: at, timezone });
  const first = calendar.days[0].day;
  const reasons = reasonsOf(failures, first, timezone);
  const ran = ranOn(calendar);
  const states = calendar.rows.map((row) => stateOf(row, ran));

  const next = nextOf(points, evidence.schedule, retained, at, timezone);
  const chains = chainsOf(retained, reading.files, owed, points, first, at, timezone);
  const status: Status = evidence.excused
    ? 'unknown'
    : evidence.verdict?.severity === 'critical' ? 'crit' : evidence.verdict?.severity ? 'warn' : 'ok';

  const report: PointsReport = {
    drawn: true,
    ...base,
    scannedAt: evidence.scannedAt,
    status,
    word: evidence.excused === 'disabled' ? 'Выключено в Veeam' : evidence.excused === 'unscheduled' ? 'Только вручную' : STATUS_WORD[status],
    verdict: words ?? {
      icon: '⚪',
      problem: evidence.excused === 'unscheduled' ? 'по расписанию точек от него не ждут' : 'новых точек от него не ждут',
      facts: [],
    },
    ...(evidence.excused ? { excused: evidence.excused } : {}),
    facts: factsOf(reading, points, evidence.schedule, machines.length),
    tiles: [],
    calendar,
    errors: errorsOf(calendar, ran, reasons),
    steps: [],
    ...(next ? { next } : {}),
    ...(chains ? { chains } : {}),
    ...(points?.newest !== undefined ? { newest: points.newest } : {}),
    ...(points?.oldest !== undefined ? { depth: { points: points.runs, oldest: points.oldest } } : {}),
    foot: `Точки — как их видит тема ${reading.topic}, чтение ${momentLabel(evidence.scannedAt, timezone)}`,
  };
  report.tiles = tilesOf(report, points, states, reading.files, evidence.verdict, timezone);
  report.steps = evidence.excused ? [] : stepsOf(report, points, states, reasons, evidence.verdict, timezone);
  return report;
};

/** The machines the job names, in its order, then every other one a point or a failure names, by name. */
const machinesOf = (named: string[], retained: RetainedRun[], failures: MachineFailure[]): string[] => {
  const others = new Set([...retained.flatMap((run) => run.machines), ...failures.map((failure) => failure.machine)]);
  for (const name of named) others.delete(name);
  return [...new Set(named), ...[...others].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
};

/** What Veeam said of a machine on a day of the calendar, by machine and the day's place in it. */
const reasonsOf = (failures: MachineError[], first: number, timezone: string): Map<string, string> => {
  const reasons = new Map<string, string>();
  for (const { machine, at, reason } of failures) if (reason) reasons.set(`${machine}|${(dayIn(at, timezone) - first) / DAY}`, reason);
  return reasons;
};

/**
 * Where a machine stands at the newest day the job ran: saved, failing — its
 * newest run failed it — or lagging: the job ran and it got neither a point
 * nor a failure. Today counts only once it has something: its run may still
 * be going. `since` is where the streak of days without a point began.
 */
interface MachineState {
  state: 'saved' | 'failing' | 'lagging' | 'unknown';
  /** The newest day it was saved, or failed: a place in the calendar. */
  at?: number;
  since?: number;
}

/** The calendar's days the job ran: some machine got a point or a failure. */
const ranOn = (calendar: Calendar): Set<number> =>
  new Set(calendar.days.flatMap((_, at) => (calendar.rows.some((row) => row.cells[at] !== 'none' && row.cells[at] !== 'retired') ? [at] : [])));

const saved = (cell: Cell) => cell === 'full' || cell === 'increment';

const stateOf = (row: MachineDays, ran: Set<number>): MachineState => {
  const today = CALENDAR_DAYS - 1;
  const streakFrom = (at: number): number => {
    let since = at;
    for (let day = at - 1; day >= 0; day -= 1) {
      const cell = row.cells[day];
      if (saved(cell) || cell === 'retired') break;
      if (cell === 'failed' || ran.has(day)) since = day;
    }
    return since;
  };
  for (let at = today; at >= 0; at -= 1) {
    const cell = row.cells[at];
    if (saved(cell)) return { state: 'saved', at };
    if (cell === 'failed') return { state: 'failing', at, since: streakFrom(at) };
    if (cell === 'retired') break;
    if (at < today && ran.has(at)) return { state: 'lagging', since: streakFrom(at) };
  }
  return { state: 'unknown' };
};

/**
 * Every machine's days without a point, by what Veeam said of them: its
 * failures by their reason, and the days the job ran and it got nothing —
 * from its first day in the calendar on, and never today, whose run may still
 * be going. The newest first.
 */
const errorsOf = (calendar: Calendar, ran: Set<number>, reasons: Map<string, string>): ErrorGroup[] => {
  const today = CALENDAR_DAYS - 1;
  const groups = new Map<string, { machines: Set<string>; days: Set<number>; reason?: string; failed: boolean }>();
  const add = (key: string, machine: string, at: number, failed: boolean, reason?: string) => {
    const group = groups.get(key) ?? { machines: new Set<string>(), days: new Set<number>(), failed, ...(reason ? { reason } : {}) };
    group.machines.add(machine);
    group.days.add(calendar.days[at].day);
    groups.set(key, group);
  };
  for (const row of calendar.rows) {
    const begins = row.cells.findIndex((cell) => cell !== 'none' && cell !== 'retired');
    row.cells.forEach((cell, at) => {
      const reason = reasons.get(`${row.name}|${at}`);
      if (cell === 'failed') add(`failed|${reason ?? ''}`, row.name, at, true, reason);
      else if (cell === 'none' && at < today && ran.has(at) && (begins === -1 || at > begins)) add('none', row.name, at, false);
    });
  }
  return [...groups.values()]
    .map(({ machines, days, reason, failed }) => ({ machines: [...machines], days: [...days].sort((a, b) => a - b), ...(reason ? { reason } : {}), failed }))
    .sort((a, b) => (b.days.at(-1) ?? 0) - (a.days.at(-1) ?? 0) || b.machines.length - a.machines.length);
};

/** Under the name, in the order the job's settings read: repository, machines, schedule and Fulls, retention. The server is said beside the stamp. */
const factsOf = (reading: PointsReading, points: JobPoints | undefined, schedule: VeeamSchedule | undefined, machines: number): string[] => {
  const runs = describeSchedule(schedule);
  const timetable = [runs && capital(runs), points?.fulls && describeFulls(points.fulls)].filter(Boolean).join(', ');
  return [
    reading.repository ? `Репозиторий ${reading.repository}` : '',
    machines ? `${machines} ${machinesWord(machines)}` : '',
    timetable,
    points?.retention ? `Хранение ${retentionWords(points.retention)}` : '',
  ].filter(Boolean);
};

/** The next day a Full is owed — after today when today's is written already — and the job's start that day. */
const nextOf = (points: JobPoints | undefined, schedule: VeeamSchedule | undefined, retained: RetainedRun[], at: number, timezone: string): NextFull | undefined => {
  if (!points?.fulls?.length) return undefined;
  const newest = retained.at(-1);
  const doneToday = newest?.full === true && dayIn(newest.at, timezone) === dayIn(at, timezone);
  const next = nextFullDay(points.fulls, doneToday ? at + DAY : at, timezone);
  if (!next) return undefined;
  const timetable = timetableOf(schedule);
  const minute = timetable?.kind === 'daily' || timetable?.kind === 'monthly' ? timetable.minute : undefined;
  return {
    day: next.day,
    weekday: daysOf([new Date(next.day).getUTCDay()]),
    ...(minute === undefined ? {} : { time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` }),
  };
};

/**
 * The chains on disk, oldest first: a Full and the runs after it, each with
 * what its files hold and take up; the oldest of several says when retention
 * lets the whole of it go — by points, once the chains after it hold as many
 * as the job keeps, a run a cadence; by days, once its successor's Full is
 * that many days old.
 */
const chainsOf = (
  retained: RetainedRun[],
  files: VeeamBackupFile[] | undefined,
  owed: number[],
  points: JobPoints | undefined,
  first: number,
  at: number,
  timezone: string,
): Chains | undefined => {
  if (!points || !retained.some((run) => run.full !== undefined)) return undefined;
  const index = (instant: number) => (dayIn(instant, timezone) - first) / DAY;
  const sizes = files ? runSizesOf(files, retained) : undefined;
  const groups: RetainedRun[][] = [];
  for (const run of retained) {
    if (run.full || groups.length === 0) groups.push([run]);
    else groups[groups.length - 1].push(run);
  }
  const total = (runs: RetainedRun[], part: keyof RunSize) =>
    sizes && runs.some((run) => sizes.has(run)) ? runs.reduce((sum, run) => sum + (sizes.get(run)?.[part] ?? 0), 0) : undefined;
  const spans: ChainSpan[] = groups.map((runs, place) => {
    const [head] = runs;
    const data = total(runs, 'data');
    const disk = total(runs, 'disk');
    return {
      ...(head.full ? { full: dayIn(head.at, timezone) } : {}),
      from: index(head.at),
      to: place + 1 < groups.length ? index(groups[place + 1][0].at) : CALENDAR_DAYS,
      increments: head.full ? runs.length - 1 : runs.length,
      ...(data === undefined ? {} : { data }),
      ...(disk === undefined ? {} : { disk }),
      current: place === groups.length - 1,
    };
  });
  const leaves = leavesOf(groups, points, at, timezone);
  if (leaves !== undefined) spans[0].leaves = leaves;
  const whole = files ? sizesOf(files, retained) : undefined;
  return {
    spans,
    retired: Math.max(0, Math.min(CALENDAR_DAYS, index(retained[0].at))),
    missed: owed.map((day) => (day - first) / DAY).filter((place) => place >= 0 && place < CALENDAR_DAYS),
    ...(whole?.increment ? { increment: { data: whole.increment.data, disk: whole.increment.disk } } : {}),
    ...(whole?.fullWriting !== undefined ? { writing: whole.fullWriting } : {}),
  };
};

const leavesOf = (groups: RetainedRun[][], points: JobPoints, at: number, timezone: string): number | undefined => {
  const retention: Retention | undefined = points.retention;
  if (groups.length < 2 || !retention) return undefined;
  if (retention.unit === 'days') return dayIn(Math.max(at, groups[1][0].at + retention.quantity * DAY), timezone);
  const after = groups.slice(1).reduce((sum, runs) => sum + runs.length, 0);
  const newest = groups[groups.length - 1].at(-1);
  if (!points.intervalDays || !newest) return undefined;
  // The runs still to come, the first of them not before now: a job behind its rhythm lets nothing go meanwhile.
  const interval = points.intervalDays * DAY;
  const next = Math.max(newest.at + interval, at);
  return dayIn(next + (Math.max(1, retention.quantity - after) - 1) * interval, timezone);
};

/** What to find out about a job in trouble that no machine explains. */
const WHY = {
  none: 'Разобраться, почему у задания нет точек',
  stale: 'Выяснить, почему нет новых точек',
  failing: 'Разобраться, почему падают запуски',
} as const;

/** "8 дней назад", "5 часов назад": whole days since `at`, as 🛡 counts a job's age. */
const agoWords = (at: number, now: number): string => {
  const days = (now - at) / DAY;
  if (days >= 1) return `${Math.floor(days)} ${daysWord(Math.floor(days))} назад`;
  const hours = Math.max(1, Math.round(days * 24));
  return hours < 24 ? `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад` : '1 день назад';
};

/** The first sentence of what Veeam said: «Failed to create VM snapshot.» of the two it wrote. */
const briefOf = (reason: string): string => /^.*?[.!?](?=\s|$)/.exec(reason)?.[0] ?? reason;

/**
 * The five numbers. A job in trouble trades the chain and the next Full for
 * what a reader asks first of one: when its last Full was, and how many of its
 * machines fail.
 */
const tilesOf = (
  report: PointsReport,
  points: JobPoints | undefined,
  states: MachineState[],
  files: VeeamBackupFile[] | undefined,
  verdict: Verdict | undefined,
  timezone: string,
): Tile[] => {
  const { at, calendar } = report;
  const machines = calendar.rows.length;
  const owed = verdict?.owed ?? [];
  const trouble = report.status === 'crit';
  // Too old to say whom it covers: how old it is is the news.
  const stale = verdict?.trouble === 'none' || verdict?.trouble === 'stale';
  const newestRun = points?.retained?.at(-1);
  const covered = newestRun ? calendar.rows.filter((row) => newestRun.machines.includes(row.name)).length : 0;

  const newest: Tile = points?.newest === undefined
    ? { label: 'Последняя точка', value: '—', note: 'точек нет', alarm: true }
    : stale
      ? { label: 'Последняя точка', value: momentLabel(points.newest, timezone), note: agoWords(points.newest, at), alarm: true }
      : {
          label: 'Последняя точка',
          value: momentLabel(points.newest, timezone),
          note: covered >= machines
            ? machines === 1 ? 'у машины задания' : `у всех ${machines} ${ofMachines(machines)}`
            : `у ${covered} из ${machines} ${ofMachines(machines)}`,
          alarm: covered < machines,
        };
  const depth: Tile = points?.oldest === undefined
    ? { label: 'Можно откатиться', value: '—', note: 'точек нет' }
    : { label: 'Можно откатиться', value: `${points.runs} ${pointsWord(points.runs)}`, note: `до ${momentLabel(points.oldest, timezone)}` };

  const chain = points?.chain;
  const daysSince = (instant: number) => Math.floor((at - instant) / DAY);
  const missedWords = owed.length ? `Full ${owedDaysWords(owed, at, 2)} ${plural(owed.length, 'пропущен', 'пропущены', 'пропущены')}` : undefined;
  const third: Tile = trouble
    ? !chain
      ? { label: 'Последний Full', value: '—', note: 'Veeam не сказал, где Full' }
      : chain.lastFull === undefined
        ? { label: 'Последний Full', value: '—', note: 'Full среди точек нет', alarm: true }
        : owed.length
          ? { label: 'Последний Full', value: dayLabel(chain.lastFull, timezone), note: `Full не было ${daysSince(chain.lastFull)} ${daysWord(daysSince(chain.lastFull))}`, alarm: true }
          : { label: 'Последний Full', value: dayLabel(chain.lastFull, timezone), note: agoWords(chain.lastFull, at) }
    : !chain
      ? { label: 'Текущая цепочка', value: '—', note: 'Veeam не сказал, где Full' }
      : chain.lastFull === undefined
        ? { label: 'Текущая цепочка', value: '—', note: 'Full среди точек нет', alarm: true }
        : points && points.runs > 1 && chain.fulls === points.runs
          ? { label: 'Текущая цепочка', value: `Full ${dayLabel(chain.lastFull, timezone)}`, note: 'каждый запуск — Full' }
          : {
              label: 'Текущая цепочка',
              value: chain.sinceFull ? `Full ${dayLabel(chain.lastFull, timezone)} + ${chain.sinceFull}` : `Full ${dayLabel(chain.lastFull, timezone)}`,
              note: chain.sinceFull ? plural(chain.sinceFull, 'инкремент', 'инкремента', 'инкрементов') : 'инкрементов ещё нет',
            };

  const failing = states.filter((state) => state.state === 'failing').length;
  const lagging = states.filter((state) => state.state === 'lagging').length;
  const fourth: Tile = trouble
    ? {
        label: 'Машины с ошибками',
        value: `${failing} из ${machines}`,
        note: failing ? 'последние запуски упали' : lagging ? `без точек ещё ${lagging}` : 'ошибок не записано',
        alarm: failing > 0,
      }
    : report.next
      ? { label: 'Следующий Full', value: nextFullWords(report.next), note: missedWords ?? 'по расписанию', alarm: Boolean(missedWords) }
      : { label: 'Следующий Full', value: '—', note: points?.fulls ? 'периодического Full нет' : 'расписание Full не прочитано' };

  const onDisk = files?.reduce((sum, file) => sum + (file.backupSize ?? 0), 0);
  const data = files?.reduce((sum, file) => sum + (file.dataSize ?? 0), 0);
  const disk: Tile = files === undefined
    ? { label: 'На диске', value: '—', note: 'файлы не прочитаны' }
    : { label: 'На диске', value: sizeOf(onDisk ?? 0), note: `данных ${sizeOf(data ?? 0)}` };

  return [newest, depth, third, fourth, disk];
};

/**
 * What to do, what matters first: the machines that fail now, by what Veeam
 * said; the ones the job runs past without a point; why the job writes no
 * points, when no machine says; a missed Full; then, for information, a
 * machine a run saved again after failing, and retention holding more than it
 * keeps because a chain goes only whole. Nothing without a fact behind it.
 */
const stepsOf = (
  report: PointsReport,
  points: JobPoints | undefined,
  states: MachineState[],
  reasons: Map<string, string>,
  verdict: Verdict | undefined,
  timezone: string,
): PointsStep[] => {
  const { calendar, at } = report;
  const owed = verdict?.owed ?? [];
  const day = (place: number) => calendar.days[place].day;
  const steps: PointsStep[] = [];

  // Failing now, grouped by what Veeam said of the newest failure.
  const failing = new Map<string, Array<{ name: string; days: number[] }>>();
  calendar.rows.forEach((row, place) => {
    const state = states[place];
    if (state.state !== 'failing' || state.at === undefined) return;
    const reason = reasons.get(`${row.name}|${state.at}`) ?? '';
    const days = row.cells.flatMap((cell, at) => (cell === 'failed' && at >= (state.since ?? 0) ? [day(at)] : []));
    failing.set(reason, [...(failing.get(reason) ?? []), { name: row.name, days }]);
  });
  for (const [reason, machines] of [...failing].sort((a, b) => b[1].length - a[1].length)) {
    const days = [...new Set(machines.flatMap((machine) => machine.days))].sort((a, b) => a - b);
    const said = reason ? `«${briefOf(reason)}»` : 'Запуск падает на машине, причину Veeam не назвал';
    steps.push(
      machines.length === 1
        ? { title: `Посмотреть ${machines[0].name}`, detail: `${said} — ${daysWords(days)}.`, important: true }
        : {
            title: `Разобрать ошибку на ${machines.length} ${plural(machines.length, 'машине', 'машинах', 'машинах')}`,
            detail: `${said} ${days.length > 1 ? 'повторяется' : '—'} ${daysWords(days)}.`,
            important: true,
          },
    );
  }

  const lagging = calendar.rows.filter((_, place) => states[place].state === 'lagging');
  if (lagging.length) {
    const since = Math.min(...calendar.rows.flatMap((_, place) => (states[place].state === 'lagging' ? [states[place].since ?? 0] : [])));
    const names = lagging.map((row) => row.name);
    steps.push({
      title: names.length <= 2 ? `Проверить ${names.join(', ')}` : `Проверить ${names.length} ${plural(names.length, 'машину', 'машины', 'машин')} без точек`,
      detail: `С ${calendarLabel(day(since))} ${names.length === 1 ? 'у неё' : 'у них'} нет точек, хотя задание шло, а ошибки Veeam не записал${names.length > 2 ? `: ${namesWords(names, 2)}` : ''}.`,
      important: true,
    });
  }

  // Why the job writes nothing, or fails, when no machine says.
  const why = verdict?.trouble && verdict.trouble !== 'fullMissed' ? WHY[verdict.trouble] : undefined;
  if (!steps.length && why) {
    const { facts } = report.verdict;
    steps.push({ title: why, ...(facts.length ? { detail: `${capital(facts.join(' · '))}.` } : {}), important: true });
  }

  if (owed.length) {
    const chain = points?.chain;
    const files = chain?.lastFull !== undefined ? chain.sinceFull + 1 : undefined;
    steps.push({
      title: 'Запустить Active Full вручную',
      detail: [
        `Full ${owedDaysWords(owed, at, 2)} не было${files ? `: восстановление последней точки читает ${files} ${plural(files, 'файл', 'файла', 'файлов')}` : ''}.`,
        report.next ? `По расписанию следующий — ${nextFullWords(report.next)}.` : '',
      ].filter(Boolean).join(' '),
      important: true,
    });
  }

  // Saved again after failing in the last week: worth a look, not urgent.
  const recent = CALENDAR_DAYS - RECENT_DAYS;
  const recovered = calendar.rows.flatMap((row, place) => {
    const state = states[place];
    const failed = row.cells.flatMap((cell, at) => (cell === 'failed' && at >= recent ? [day(at)] : []));
    return state.state === 'saved' && state.at !== undefined && failed.length ? [{ name: row.name, failed, saved: day(state.at) }] : [];
  });
  if (recovered.length) {
    const [one] = recovered;
    steps.push(
      recovered.length === 1
        ? {
            title: `Посмотреть ${one.name}`,
            detail: `${one.failed.length === 1 ? 'Запуск' : 'Запуски'} ${daysWords(one.failed)} ${one.failed.length === 1 ? 'упал' : 'упали'}; ${calendarLabel(one.saved)} она снова сохранена.`,
            important: false,
          }
        : {
            title: `Посмотреть ${namesWords(recovered.map((machine) => machine.name), 2)}`,
            detail: `Запуски падали ${daysWords([...new Set(recovered.flatMap((machine) => machine.failed))].sort((a, b) => a - b))}; потом машины снова сохранены.`,
            important: false,
          },
    );
  }

  const retention = points?.retention;
  const oldest = report.chains?.spans[0];
  if (points && retention && oldest && report.chains && report.chains.spans.length > 1 && points.oldest !== undefined) {
    const kept = Math.round((dayIn(at, timezone) - dayIn(points.oldest, timezone)) / DAY);
    const over = retention.unit === 'points' ? points.runs > retention.quantity : kept > retention.quantity;
    if (over) {
      steps.push({
        title: retention.unit === 'points'
          ? `Хранение держит ${points.runs} ${pointsAfter(points.runs)} вместо ${retention.quantity}`
          : `Хранение держит точки за ${kept} ${daysWord(kept)} вместо ${retention.quantity}`,
        detail: `Veeam удаляет цепочку только целиком${oldest.full !== undefined && oldest.leaves !== undefined ? `: цепочка ${calendarLabel(oldest.full)} уйдёт около ${calendarLabel(oldest.leaves)}` : ''}.`,
        important: false,
      });
    }
  }
  return steps.sort((a, b) => Number(b.important) - Number(a.important));
};

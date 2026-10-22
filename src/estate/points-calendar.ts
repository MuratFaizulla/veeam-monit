import { MachineFailure, RetainedRun } from './evidence';
import { FullSchedule, isFullDay } from './full-schedule';
import { dayIn } from './schedule-planner';

/**
 * A job's last five weeks, a machine to a row and a day to a cell: the days
 * each machine was given a Full, an increment, a run that failed it, or
 * nothing — what /points draws.
 *
 * Open Backup UI draws a job's points as a calendar, and the bot drew one too,
 * as monospaced text, a week to a row and the job's runs in it. That said a
 * job had a point on a day; it could not say that one machine of fifteen did
 * not. A row a machine says it: OPS_vCloud_edge went nine nights without a
 * point in September, and one of its VMs went without one for a month while
 * the others kept theirs.
 *
 * A cell is red only on positive evidence that the machine's own run failed
 * that day — the Evidence's machine outcomes, or what Veeam said of the
 * machine in a failed attempt. A failed run is not a failed machine: Veeam
 * marks the whole run failed when one machine of fifteen does.
 */

/** The days drawn: five weeks reach past a weekly Full and the chain before it. */
export const CALENDAR_DAYS = 35;

const DAY = 86_400_000;

/**
 * What one machine has of one day: a Full, an increment, a run that failed it,
 * a day before the oldest point retention kept, or nothing — the day today
 * still is, until its run writes.
 */
export type Cell = 'full' | 'increment' | 'failed' | 'retired' | 'none';

export interface CalendarDay {
  /** The calendar day in the operator's zone, as its `Date.UTC` midnight. */
  day: number;
  weekend: boolean;
  /** A day the job's settings owe a Full on. */
  fullDay: boolean;
  /** One that passed with no Full: a missed Full, as 🛡 counts it. */
  missed: boolean;
}

/** One machine over the days. */
export interface MachineDays {
  name: string;
  /** A cell a day, oldest first. */
  cells: Cell[];
  /** The moments it can be restored to: the retained runs holding a point of it, however old. */
  points: number;
}

export interface Calendar {
  days: CalendarDay[];
  rows: MachineDays[];
  /** Whether Veeam said which points are full: without it every point is just a point. */
  typed: boolean;
}

export interface CalendarInput {
  /** The job's retained runs, each with the machines it holds a point of. */
  retained: RetainedRun[];
  /** The machines' own failures. */
  failures: MachineFailure[];
  /** The machines, a row each, in the order drawn. */
  machines: string[];
  /** The Fulls the job is set to take; absent when its configuration did not say. */
  fulls?: FullSchedule[];
  /** The days a Full was owed and none taken, as `Date.UTC` midnights. */
  owed: number[];
  now: number;
  timezone: string;
}

/**
 * The calendar of the five weeks up to `now`. A run is drawn on the day it
 * began writing, as the Evidence dates it; a day a machine has a point of
 * outranks a failure of it the same day — a retry saved it — and a Full
 * outranks an increment, being the one a chain begins with.
 */
export const calendarOf = ({ retained, failures, machines, fulls, owed, now, timezone }: CalendarInput): Calendar => {
  const today = dayIn(now, timezone);
  const first = today - (CALENDAR_DAYS - 1) * DAY;
  const missed = new Set(owed);
  const days: CalendarDay[] = Array.from({ length: CALENDAR_DAYS }, (_, index) => {
    const day = first + index * DAY;
    const weekday = new Date(day).getUTCDay();
    return { day, weekend: weekday === 0 || weekday === 6, fullDay: fulls ? isFullDay(fulls, day) : false, missed: missed.has(day) };
  });

  // What each machine has of each day, by the day's place in the calendar.
  const index = (at: number): number => (dayIn(at, timezone) - first) / DAY;
  const written = new Map<string, Map<number, 'full' | 'increment'>>();
  for (const run of retained) {
    const at = index(run.at);
    for (const machine of run.machines) {
      const marks = written.get(machine) ?? new Map<number, 'full' | 'increment'>();
      if (marks.get(at) !== 'full') marks.set(at, run.full ? 'full' : 'increment');
      written.set(machine, marks);
    }
  }
  const failed = new Map<string, Set<number>>();
  for (const failure of failures) failed.set(failure.machine, (failed.get(failure.machine) ?? new Set()).add(index(failure.at)));
  // Before the oldest point retention kept, nothing is known but that it went.
  const kept = retained.length ? Math.min(...retained.map((run) => index(run.at))) : -Infinity;

  const rows = machines.map((name) => ({
    name,
    cells: days.map((_, at): Cell => written.get(name)?.get(at) ?? (failed.get(name)?.has(at) ? 'failed' : at < kept ? 'retired' : 'none')),
    points: retained.filter((run) => run.machines.includes(name)).length,
  }));
  return { days, rows, typed: retained.some((run) => run.full !== undefined) };
};

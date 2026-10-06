import { Clock, dayKey } from '../telegram/time';
import { RetainedRun } from './evidence';

/**
 * A job's retained runs, a week to a row: the days that wrote a Full, the days
 * that wrote an increment, and the days that wrote nothing.
 *
 * Open Backup UI draws this as a calendar; a Telegram message holds it as
 * monospaced text. A gap reads as a gap before any number is read:
 * OPS_vCloud_edge went nine nights without a point in September, and a row
 * of dots says so.
 */

/** Rows at most: five weeks reaches past a monthly Full and still fits a phone. */
const WEEKS = 5;
const DAY = 86_400_000;
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export const MARKS = { full: '█', increment: '▒', none: '·', today: '○' } as const;

/** The calendar day an instant falls on in the display zone, as a `Date.UTC` midnight. */
const localDay = (at: number, clock: Clock): number => {
  const [day, month, year] = dayKey(new Date(at), clock).split('.').map(Number);
  return Date.UTC(year, month - 1, day);
};

const mondayOf = (day: number): number => day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;

const dayLabel = (day: number): string => {
  const date = new Date(day);
  return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * The calendar's lines, header first, each row labelled with its Monday.
 * Undefined when there is no run to draw.
 *
 * A day before the oldest retained point is left blank rather than dotted:
 * retention took it, and nothing is known about it.
 */
export const calendarOf = (runs: RetainedRun[], clock: Clock): string[] | undefined => {
  if (runs.length === 0) return undefined;
  const today = localDay(clock.now.getTime(), clock);
  const thisWeek = mondayOf(today);
  const oldest = Math.min(...runs.map((run) => localDay(run.at, clock)));
  const first = Math.max(oldest, thisWeek - (WEEKS - 1) * 7 * DAY);

  // A Full outranks an increment the same day: it is the one a chain begins with.
  const written = new Map<number, 'full' | 'increment'>();
  for (const run of runs) {
    const day = localDay(run.at, clock);
    if (written.get(day) !== 'full') written.set(day, run.full ? 'full' : 'increment');
  }

  const mark = (day: number): string => {
    if (day < first || day > today) return ' ';
    const kind = written.get(day);
    if (kind) return MARKS[kind];
    return day === today ? MARKS.today : MARKS.none;
  };

  const rows: string[] = [];
  for (let monday = mondayOf(first); monday <= thisWeek; monday += 7 * DAY) {
    const cells = WEEKDAYS.map((_, index) => `  ${mark(monday + index * DAY)}`).join('');
    rows.push(`${dayLabel(monday)}${cells}`.trimEnd());
  }
  return [`${' '.repeat(5)}${WEEKDAYS.map((weekday) => ` ${weekday}`).join('')}`, ...rows];
};

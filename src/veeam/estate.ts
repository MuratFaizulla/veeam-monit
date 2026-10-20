import { VeeamJobState, VeeamSession } from './types';

/**
 * What the estate reader hands out, as opposed to what Veeam sends.
 *
 * `types.ts` is Veeam's model, every field optional because builds differ.
 * This is the part of it the rest of the service is allowed to rely on, decided
 * once at the read rather than guarded against in every reader.
 */

/**
 * A job as the service reads it: always an id, one name, one spelling of its
 * result.
 *
 * Every reader of `VeeamJobState` used to decide these for itself. A job with
 * no name was "неизвестное задание" in its alert, "без имени" in the Summary,
 * ▶️ and 📅, and its bare id in 🛡 — seven decisions with three answers — and
 * `!job.id` was guarded against in seven places.
 */
export interface Job extends Omit<VeeamJobState, 'lastResult'> {
  id: string;
  /**
   * Veeam's name, or the id where it gave none: the one name every alert,
   * topic, slot, card and button uses.
   */
  name: string;
  /** The last result, lower-cased; `none` while a run is going and before the first. */
  result: string;
}

/**
 * The job, or undefined for one with no id — which nothing could address,
 * remember a result for, or match a session or a restore point to.
 */
export const jobOf = (state: VeeamJobState): Job | undefined =>
  state.id
    ? {
        ...state,
        id: state.id,
        name: state.name || state.id,
        result: (state.lastResult ?? '').toLowerCase() || 'none',
      }
    : undefined;

/**
 * A session or a task as the reader hands it out: its result lower-cased —
 * Veeam writes `Failed`, `failed` or `FAILED` depending on the build — and an
 * end only once it has one.
 *
 * Veeam writes "not yet" as nothing, as `0001-01-01T00:00:00` or as a day in
 * 1900. Each reader used to decide that for itself: the Session report took a
 * machine's 0001 for an end, and the Job reads and the Session history passed
 * either on as one, so to an alert or a Job card a session still going could
 * have ended in 1900.
 */
export const sessionOf = <T extends { result?: { result?: string }; endTime?: string | null }>({ endTime, ...item }: T): T =>
  ({
    ...item,
    ...(item.result?.result !== undefined ? { result: { ...item.result, result: item.result.result.toLowerCase() } } : {}),
    // Whether it is a time at all does not depend on the zone it is read in.
    ...(instantOf(endTime, 'UTC') !== undefined ? { endTime } : {}),
  }) as T;

/*
 * Veeam's times, read once: every reader of a session's, a task's or a
 * file's time asks `instantOf`, and of a duration `durationOf`. They used to
 * decode them each for itself — four copies between the Job report, the
 * Session report, the Repository report and the Job card's speed.
 */

/**
 * A time Veeam wrote before this means "not yet": .NET's least date,
 * `0001-01-01T00:00:00`, which the REST API documents for a session still
 * going, or a day in 1900, which some builds write instead. No Veeam ran then.
 */
const NOT_YET = Date.UTC(2000, 0, 1);

/** The end of a time that says its own offset, as a session's does. */
const OFFSET = /(?:[zZ]|[+-]\d\d:?\d\d)$/;

/**
 * The instant a time Veeam wrote names, epoch ms; undefined when it names
 * none — nothing, a placeholder for "not yet", or no time at all.
 *
 * A session's time carries its offset. A task's and a backup file's carry
 * none: they are the Veeam server's own clock, which is in `timezone` — read
 * as the process's local time instead, a file written at 22:00 would land on
 * the next day.
 */
export const instantOf = (text: string | null | undefined, timezone: string): number | undefined => {
  if (!text) return undefined;
  const offset = OFFSET.test(text);
  const written = Date.parse(offset ? text : `${text}Z`);
  if (!Number.isFinite(written) || written <= NOT_YET) return undefined;
  return offset ? written : fromServerClock(written, timezone);
};

/**
 * The instant the Veeam server's clock reads `wall`, which is that reading
 * taken as if it were UTC, epoch ms. The server's clock is taken to be in the
 * bot's zone, `timezone`: nothing Veeam says names its own.
 */
export const fromServerClock = (wall: number, timezone: string): number =>
  wall - offsetAt(wall - offsetAt(wall, timezone), timezone);

/**
 * How long Veeam says something took, ms, as it spells it — "04:40:31", and
 * past a day "1.02:03:04" — to the whole second, as its console shows it;
 * undefined when it does not say.
 */
export const durationOf = (text: string | null | undefined): number | undefined => {
  const spelled = /^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})/.exec(text?.trim() ?? '');
  if (!spelled) return undefined;
  const [days, hours, minutes, seconds] = spelled.slice(1).map((part) => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
};

/** Built once per zone: a report reads a time for every machine of every session. */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** How far `timezone` is ahead of UTC at `at`, in milliseconds. */
const offsetAt = (at: number, timezone: string): number => {
  let clock = clocks.get(timezone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    clocks.set(timezone, clock);
  }
  const parts = Object.fromEntries(clock.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
};

/**
 * Session states that mean "running right now", lower-cased.
 *
 * `stateFilter=Working` is asked for as well; this is what decides, because a
 * server that ignores the filter hands back finished sessions too.
 */
export const ACTIVE_SESSION_STATES: ReadonlySet<string> = new Set([
  'starting', 'working', 'postprocessing', 'waitingrepository', 'waitingslot',
  'waitingtape', 'pausing', 'resuming',
]);

/**
 * What Veeam is running right now, read once per cycle.
 *
 * ▶️ Running now, 📈 Performance and the Summary all count from this one read.
 * They used to read it twice with two ideas of "Working" — one page and no
 * state check for the running count, every page and the state check for 📈 —
 * so the two could disagree about the same estate at the same moment.
 */
export interface WorkingSessions {
  /** Newest first, including sessions no job owns — Malware Detection, say. */
  sessions: VeeamSession[];
  /** The newest Working session of each job, by job id. */
  byJob: ReadonlyMap<string, VeeamSession>;
  /** Why they could not be read, when they could not; then both are empty. */
  unavailable?: string;
}

export const workingOf = (sessions: VeeamSession[]): WorkingSessions => {
  const active = sessions.filter((session) =>
    ACTIVE_SESSION_STATES.has((session.state ?? '').toLowerCase()),
  );
  const byJob = new Map<string, VeeamSession>();
  for (const session of active) {
    if (session.jobId && !byJob.has(session.jobId)) byJob.set(session.jobId, session);
  }
  return { sessions: active, byJob };
};

/**
 * The Working sessions of a cycle that could not read them.
 *
 * Empty is the safe direction: a running count falls back to the job status
 * alone and never invents a run. 📈 says why it has nothing to show.
 */
export const workingUnavailable = (reason: string): WorkingSessions => ({
  sessions: [],
  byJob: new Map(),
  unavailable: reason,
});

/** The names behind the ids a job configuration points at. */
export interface InventoryNames {
  repositories: ReadonlyMap<string, string>;
  proxies: ReadonlyMap<string, string>;
}

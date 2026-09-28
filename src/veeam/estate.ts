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
 * The same item with its result lower-cased, for anything shaped like a
 * session. Veeam writes `Failed`, `failed` or `FAILED` depending on the build.
 */
export const withResultLowered = <T extends { result?: { result?: string } }>(item: T): T =>
  item.result?.result === undefined
    ? item
    : { ...item, result: { ...item.result, result: item.result.result.toLowerCase() } };

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

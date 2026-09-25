import { DeliveryOutcome } from '../telegram/telegram.service';
import { MonitorAnswer } from '../estate/answer';

export type { MonitorAnswer } from '../estate/answer';

export interface MonitorHealth {
  lastCheckAt: string | null;
  reachable: boolean | null;
  authenticated: boolean | null;
  lastError: string | null;
  trackedJobs: number;
  /** Events that reached at least one chat since start. */
  delivered: number;
  /** Events that were attempted and reached nobody — the number to alarm on. */
  undelivered: number;
  /** Outcome of the most recent event, for answering "where did my alert go?". */
  lastOutcome: DeliveryOutcome | null;
}

/**
 * What the rest of the service may ask of the monitor.
 *
 * The bot's ear and the HTTP surface need five things from it: its health, a
 * pass on demand, the summary, and a job card by name or by id. They used to
 * take the whole monitor for that — a class with most of the service behind
 * it, so a test of one command had to build a Veeam, an evidence scan and a
 * delivery pipeline or hand-write a stub and hope it matched.
 *
 * The seam is real: `MonitorService` is one adapter, and the idle monitor the
 * tests give a world with no Veeam is the other.
 */
export interface Monitor {
  readonly status: MonitorHealth;
  /** One monitoring pass; `busy` when a pass was already running. */
  check(): Promise<'ran' | 'busy'>;
  /** The Summary, as an Answer. */
  summary(): Promise<MonitorAnswer>;
  /** A Job card for a half-remembered name, or the choices when several match. */
  describeJob(query: string): Promise<MonitorAnswer>;
  /** A Job card for a job a Button addressed by id. */
  describeJobById(id: string): Promise<MonitorAnswer>;
}

/** Nest's handle for `Monitor`: an interface leaves nothing at runtime to inject by. */
export const MONITOR = Symbol('Monitor');

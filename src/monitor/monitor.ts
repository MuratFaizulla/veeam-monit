import { DeliveryOutcome } from '../telegram/telegram.service';

/** The Selected server's side of the monitor, with what it delivered overall. */
export interface MonitorHealth {
  lastCheckAt: string | null;
  reachable: boolean | null;
  authenticated: boolean | null;
  lastError: string | null;
  trackedJobs: number;
  /** Events that reached at least one chat since start, from every server. */
  delivered: number;
  /** Events that were attempted and reached nobody — the number to alarm on. */
  undelivered: number;
  /** Outcome of the most recent event, for answering "where did my alert go?". */
  lastOutcome: DeliveryOutcome | null;
}

/** One Veeam server as the monitor last found it. */
export interface ServerStatus {
  key: string;
  name: string;
  /** Whether this is the Selected server: the one the live slots and commands show. */
  selected: boolean;
  /** Null until the server has been asked once. */
  reachable: boolean | null;
  authenticated: boolean | null;
  /** Its IP address, once a connection has resolved it. */
  address?: string;
  /** From the last cycle that read its job list; absent until one has. */
  jobs?: { total: number; failed: number; warning: number };
  lastError: string | null;
}

/** What selecting a server came to. */
export type Selection = 'selected' | 'already' | 'unknown';

/**
 * What the rest of the service may ask of the monitor: the cycle.
 *
 * The bot's ear and the HTTP surface need four things from it: its health,
 * the servers and which one is selected, selecting another, and a pass on
 * demand. They used to take the whole monitor for that — a class with most of
 * the service behind it, so a test of one command had to build a Veeam, an
 * evidence scan and a delivery pipeline or hand-write a stub and hope it
 * matched.
 *
 * What a command asks about the estate — the Summary, a Job card, the job
 * menu, /points, the reports — is not the cycle's, and is asked of
 * `EstateAnswers` (src/estate/estate-answers.ts). It used to be nine members
 * here, each the same pass-through to a server's estate, and every new
 * command added one.
 *
 * The seam is real: `MonitorService` is one adapter, and the idle monitor the
 * tests give a world with no Veeam is the other.
 */
export interface Monitor {
  /** The Selected server's health. */
  readonly status: MonitorHealth;
  /** Every configured server, in the order they are listed. */
  servers(): ServerStatus[];
  /**
   * Makes `key` the Selected server. The live slots are redrawn for it at once
   * rather than at the next tick; alerts keep coming from every server.
   */
  select(key: string): Selection;
  /** One monitoring pass; `busy` when a pass was already running. */
  check(): Promise<'ran' | 'busy'>;
}

/** Nest's handle for `Monitor`: an interface leaves nothing at runtime to inject by. */
export const MONITOR = Symbol('Monitor');

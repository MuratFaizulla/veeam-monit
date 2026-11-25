import { Logger } from '@nestjs/common';
import { ACTIVE_SESSION_STATES, instantOf } from '../veeam/estate';
import { CONFIG_BACKUP_SESSION, MachineResult, VeeamEstateReader } from '../veeam/estate-reader.service';
import { sessionText } from '../veeam/session-text';
import { VeeamSession, VeeamTaskProgress } from '../veeam/types';

const DAY = 86_400_000;

/** How far back the first read looks for each job's newest session: a month, which a monthly job still reaches. */
const FIRST_READ_MS = 32 * DAY;

/**
 * How far before the previous read a later one reaches back, as the Session
 * history's does: a session running then is read again, and ends.
 */
const OVERLAP_MS = 2 * DAY;

/**
 * Sessions whose machines are read at a time. The first read after a start
 * finds one for every job, two hundred on a busy server; they are read a
 * batch a pass rather than all before the alerts of the pass go out.
 */
export const DETAILS_AT_A_TIME = 25;

/** Times a session's machines are asked for before the session goes without them. */
const DETAIL_TRIES = 3;

/** One session of a job: an attempt, as Veeam lists it. */
export interface SessionFacts {
  id: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; absent while it runs. */
  endedAt?: number;
  /** Lower-cased, once it has ended. */
  result?: string;
  /** What Veeam said of it, in one line worth reading: the machine and the reason, no account names. */
  message?: string;
  /** 0–100 while it runs. */
  progressPercent?: number;
}

/** What a session's machines did, read once it has ended. */
export interface SessionDetails {
  /** Each machine, how it ended and why, without its progress. */
  machines: Omit<MachineResult, 'progress'>[];
  /** Bytes, summed over its machines. Absent on a server whose REST API keeps no task sessions (1.1). */
  read?: number;
  transferred?: number;
  processed?: number;
  /** The stage that held most of its machines back: Source, Proxy, Network or Target. */
  bottleneck?: string;
}

/** A job's newest ended session and the one running now. */
export interface JobSessions {
  last?: SessionFacts & { details?: SessionDetails };
  running?: SessionFacts;
}

/**
 * Each job's newest session that has ended, with what its machines did, and the
 * one it is running now: what a chart of the job shows, for every server.
 *
 * Not the Session history, which keeps every session Veeam has for the
 * Evidence of the one server shown and reads it whole on start and daily —
 * nine thousand sessions on the busiest server. This keeps one session a job.
 * The first read reaches back a month; after it, a read reaches back two days
 * before the previous one, or to the oldest session still running when that is
 * further, one page. A session's machines are read once, when it is the job's
 * newest ended one.
 *
 * One per server.
 */
export class LastSessions {
  private readonly logger: Logger;
  private readonly byJob = new Map<string, JobSessions>();
  private readonly tries = new Map<string, number>();
  /** When the last read began, epoch ms; absent before the first. */
  private readAt?: number;

  constructor(
    private readonly reader: VeeamEstateReader,
    private readonly timezone: string,
    server = '',
  ) {
    this.logger = new Logger(`${LastSessions.name}${server ? ` ${server}` : ''}`);
  }

  /** By job id. */
  get jobs(): ReadonlyMap<string, JobSessions> {
    return this.byJob;
  }

  /** Whether an ended session's machines are still to be read. */
  get pending(): boolean {
    return this.waiting().length > 0;
  }

  /**
   * Reads the sessions begun since the last read and keeps each job's newest.
   * Throws when Veeam does not answer, and keeps what it had: the next read
   * reaches back from the last one that worked.
   */
  async refresh(now: number): Promise<void> {
    const since = this.since(now);
    const sessions = await this.reader.sessionsCreatedAfter(new Date(since));
    this.readAt = now;
    this.keep(sessions);
  }

  /** Reads the machines of up to `DETAILS_AT_A_TIME` ended sessions, the newest first. */
  async readDetails(): Promise<void> {
    for (const [, sessions] of this.waiting().slice(0, DETAILS_AT_A_TIME)) {
      const last = sessions.last!;
      try {
        last.details = detailsOf(await this.reader.machineResults(last.id));
      } catch (error) {
        const tries = (this.tries.get(last.id) ?? 0) + 1;
        this.tries.set(last.id, tries);
        if (tries >= DETAIL_TRIES) last.details = { machines: [] };
        this.logger.warn(`Machines of session ${last.id} not read (${tries} of ${DETAIL_TRIES}): ${(error as Error).message}`);
      }
    }
  }

  private since(now: number): number {
    if (this.readAt === undefined) return now - FIRST_READ_MS;
    const running = [...this.byJob.values()].flatMap(({ running }) => (running ? [running.startedAt] : []));
    return Math.min(this.readAt - OVERLAP_MS, ...running);
  }

  /**
   * Every job's newest ended session, if newer than the one kept, and the one
   * running now. What runs is said by this read alone: it reaches back to the
   * oldest session that ran at the last one, so a session it no longer lists as
   * running has ended.
   */
  private keep(sessions: VeeamSession[]): void {
    for (const each of this.byJob.values()) delete each.running;
    for (const session of sessions) {
      const facts = this.factsOf(session);
      if (!facts || !session.jobId) continue;
      const job = this.byJob.get(session.jobId) ?? {};
      if (facts.endedAt === undefined) {
        if (!job.running || facts.startedAt > job.running.startedAt) job.running = facts;
      } else if (!job.last || facts.startedAt > job.last.startedAt) {
        job.last = facts;
      } else if (job.last.id === facts.id) {
        job.last = { ...facts, ...(job.last.details ? { details: job.last.details } : {}) };
      }
      this.byJob.set(session.jobId, job);
    }
  }

  /** A job's session, or nothing for one no job owns, the configuration backup's, or one without its times. */
  private factsOf(session: VeeamSession): SessionFacts | undefined {
    if (!session.id || !session.jobId || session.sessionType === CONFIG_BACKUP_SESSION) return undefined;
    const startedAt = instantOf(session.creationTime, this.timezone);
    if (startedAt === undefined) return undefined;
    const active = ACTIVE_SESSION_STATES.has((session.state ?? '').toLowerCase());
    const endedAt = active ? undefined : instantOf(session.endTime, this.timezone);
    if (!active && endedAt === undefined) return undefined;
    const message = sessionText(session.result?.message);
    const result = session.result?.result;
    return {
      id: session.id,
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(endedAt !== undefined && result ? { result } : {}),
      ...(message && message.toLowerCase() !== result ? { message } : {}),
      ...(active && typeof session.progressPercent === 'number' ? { progressPercent: session.progressPercent } : {}),
    };
  }

  /** The jobs whose newest ended session's machines are not read yet, the newest session first. */
  private waiting(): [string, JobSessions][] {
    return [...this.byJob.entries()]
      .filter(([, { last }]) => last && !last.details)
      .sort(([, a], [, b]) => b.last!.startedAt - a.last!.startedAt);
  }
}

/** What a session's machines did, from how each of them ended. */
export const detailsOf = (results: MachineResult[]): SessionDetails => {
  const progress = results.flatMap(({ progress }) => (progress ? [progress] : []));
  const total = (key: 'readSize' | 'transferredSize' | 'processedSize'): number | undefined =>
    progress.some((each) => typeof each[key] === 'number') ? progress.reduce((sum, each) => sum + (each[key] ?? 0), 0) : undefined;
  const read = total('readSize');
  const transferred = total('transferredSize');
  const processed = total('processedSize');
  const bottleneck = commonest(progress);
  return {
    machines: results.map(({ name, result, reason, algorithm }) => ({ name, result, ...(reason ? { reason } : {}), ...(algorithm ? { algorithm } : {}) })),
    ...(read !== undefined ? { read } : {}),
    ...(transferred !== undefined ? { transferred } : {}),
    ...(processed !== undefined ? { processed } : {}),
    ...(bottleneck ? { bottleneck } : {}),
  };
};

/** The bottleneck most machines name; Veeam's "NotDefined" and "None" name none. */
const commonest = (progress: VeeamTaskProgress[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const { bottleneck } of progress) {
    if (!bottleneck || /^(notdefined|none)$/i.test(bottleneck)) continue;
    counts.set(bottleneck, (counts.get(bottleneck) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

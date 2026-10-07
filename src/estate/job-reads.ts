import { Logger } from '@nestjs/common';
import { Job } from '../veeam/estate';
import { MachineResult, VeeamEstateReader } from '../veeam/estate-reader.service';
import { blameOf, sessionText } from '../veeam/session-text';
import { VeeamJob } from '../veeam/types';

/**
 * Sessions read for one job — by its card and by its alert, which counts the
 * attempt from the same read.
 *
 * Sessions are attempts and the card lists Runs: five of them at Veeam's
 * default four attempts is twenty sessions. Six used to be read, which was
 * one night and half of the one before it. Thirty leaves room for a job that
 * retries more, and for the Run the limit cuts short, which the card leaves out.
 */
export const RECENT_SESSIONS = 30;

/**
 * One session of a job — one attempt, not one run.
 *
 * Veeam retries a failed job by starting another session; which sessions are
 * one run is decided in runs.ts.
 */
export interface JobSession {
  /** The session id, which is how its per-object detail is reached. */
  id?: string;
  startedAt?: string;
  /** Absent while the session is still going. */
  endedAt?: string;
  /** Lower-cased, as the estate reader hands every session result out. */
  result?: string;
  /** Veeam's message as it is worth showing — see `sessionText`; never as Veeam wrote it. */
  message?: string;
  /** The machine the message says went wrong, and why, when it says both. */
  blames?: { machine: string; reason: string };
  /** 0-100, only while running and only once Veeam reports any. */
  percent?: number;
}

/** One machine of an attempt, and how it ended. */
export interface FailedObject {
  name: string;
  /** Lower-cased. */
  result?: string;
  message?: string;
  /** Lower-cased: `full`, `increment`, where Veeam said. */
  algorithm?: string;
}

/**
 * What a Job alert and a Job card ask Veeam about one job when it comes up:
 * its newest attempts, its own configuration, and how the machines of one
 * attempt ended and why.
 *
 * The alert used to ask them of the whole module behind the Job card — three
 * methods made public for it, beside the card's answers — and its tests had to
 * stand up a server and write Veeam's paths, session by session, to say what
 * a night of retries looked like. Two adapters sit behind this seam: Veeam's,
 * below, and the one the alert tests hand in, which answers what the test says
 * happened.
 */
export interface JobReads {
  /** The job's newest attempts, newest first. Best effort: none when Veeam would not say. */
  sessionsOf(job: Job): Promise<JobSession[]>;
  /**
   * The job's own configuration — schedule and retry policy, repository,
   * proxies, machines. Best effort: undefined when it could not be read.
   */
  configurationOf(job: Job): Promise<VeeamJob | undefined>;
  /**
   * How each machine of one attempt ended, and why the ones that went wrong
   * did. Best effort: empty when Veeam could not say — and empty too for a run
   * that never reached a machine at all, which is itself the answer.
   */
  machinesOf(attempt: JobSession): Promise<FailedObject[]>;
}

/** The job reads, asked of one Veeam server. */
export class VeeamJobReads implements JobReads {
  private readonly logger = new Logger(VeeamJobReads.name);

  constructor(private readonly reader: Pick<VeeamEstateReader, 'recentSessions' | 'jobConfiguration' | 'machineResults'>) {}

  async sessionsOf(job: Job): Promise<JobSession[]> {
    try {
      return (await this.reader.recentSessions(job.id, RECENT_SESSIONS)).map((session) => ({
        id: session.id,
        startedAt: session.creationTime,
        endedAt: session.endTime,
        result: session.result?.result,
        // Read once, here, so that nothing downstream can show the message
        // as Veeam wrote it — which is what a card's run list once did.
        message: sessionText(session.result?.message),
        blames: blameOf(session.result?.message),
        percent: session.progressPercent,
      }));
    } catch (error) {
      this.logger.debug(`No session history for job ${job.id}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Read by id rather than taken from the estate scan's copy: that copy keeps
   * only the schedules and retention of every job, and holding every job's
   * full storage settings in memory to answer a question nobody may ask is the
   * wrong trade.
   */
  async configurationOf(job: Job): Promise<VeeamJob | undefined> {
    try {
      return await this.reader.jobConfiguration(job.id);
    } catch (error) {
      this.logger.debug(`No configuration for job ${job.id}: ${(error as Error).message}`);
      return undefined;
    }
  }

  async machinesOf(attempt: JobSession): Promise<FailedObject[]> {
    if (!attempt.id) return [];
    let machines: MachineResult[];
    try {
      machines = await this.reader.machineResults(attempt.id);
    } catch (error) {
      this.logger.debug(`No per-object detail for session ${attempt.id}: ${(error as Error).message}`);
      return [];
    }
    // The task's own message is sometimes only the step it stopped at —
    // "Getting VM info from vSphere" — while the session's says, of the same
    // machine, "Error: Cannot get service content. / Soap fault. Temporary
    // failure in name resolution". An error named for a machine wins.
    const { blames } = attempt;
    return machines.map(({ name, result, reason, algorithm }) => ({
      name,
      result,
      message: blames?.machine === name ? blames.reason : reason,
      ...(algorithm ? { algorithm } : {}),
    }));
  }
}

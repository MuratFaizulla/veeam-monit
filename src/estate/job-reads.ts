import { Logger } from '@nestjs/common';
import { plural } from '../telegram/time';
import { VeeamApiError } from '../veeam/api.error';
import { instantOf, Job } from '../veeam/estate';
import { loggedResults, MachineResult, VeeamEstateReader } from '../veeam/estate-reader.service';
import { blameOf, sessionText } from '../veeam/session-text';
import { VeeamJob, VeeamLogRecord, VeeamSession, VeeamTaskSession } from '../veeam/types';
import { bottleneckOf, byLongest, Stage } from './run-speed';
import { settled } from './settled';

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
 * Machines whose own logs are read when a card asks how fast a run went, the
 * longest first. Billing_Prod, among the largest, has 23.
 */
const MACHINE_LOGS = 30;

/*
 * A job's history, as the Job report reads it: how much is asked for — and
 * how fast, six requests at a time, which is `./settled`'s. They used to be
 * the report's own, and the card's speed had its own pace and its own reading
 * of a server without task sessions: six requests at a time against five,
 * and a 404 that was "no machines" to one and an empty place to the other.
 */

/** The job's newest sessions asked for: a month of a daily job with every retry, and then some. */
const HISTORY_SESSIONS = 500;
/** Sessions whose machines are read, a request each: an hourly job's month would be seven hundred. */
const TASK_SESSIONS = 60;
/** The newest finished sessions whose log says what held them back. */
const LOG_SESSIONS = 6;
/** Logs of the machines that did not end in a success, a request each: a failing month of a big job has hundreds. */
const TASK_LOGS = 150;

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

/** What Veeam wrote while running one attempt: what the Job card's ⚡ reads its speed from. */
export interface AttemptRecord {
  /** Titles of the session's own log, a line each. */
  log: string[];
  /** Its machines; none on a server with no task sessions (REST API 1.1), whose log still says the rest. */
  tasks: VeeamTaskSession[];
  /** Titles of the logs of its longest machines, by task id: those Veeam gave. */
  machineLogs: Map<string, string[]>;
}

/** One attempt of a job's history, with its machines when they were read. */
export interface HistoryAttempt {
  session: VeeamSession;
  /**
   * Its machines. On a server with no task sessions (REST API 1.1), what the
   * session's log says of each — how it ended and why, with no times or
   * sizes. Absent for the attempts past the newest `TASK_SESSIONS`, which are
   * not asked about, and when Veeam would not say.
   */
  tasks?: VeeamTaskSession[];
  /** Its machines were asked for and Veeam would not say: they are not known, which is not none. */
  unread?: true;
}

/** One job's history over a period: what its Job report is made from. */
export interface JobHistory {
  /** The job's own configuration; undefined when it could not be read. */
  configured?: VeeamJob;
  /** The attempts begun in the period, newest first. */
  attempts: HistoryAttempt[];
  /** By task id, the log of each machine that did not end in a success: the only place that says why. */
  taskLogs: Record<string, VeeamLogRecord[]>;
  /** The stage Veeam blamed in each of the newest finished attempts that named one. */
  bottlenecks: Stage[];
  /** What could not be read, a line each, in the report's words: what, how much, and why. */
  missing: string[];
}

/**
 * What a Job alert, a Job card and the Job report ask Veeam about one job:
 * its newest attempts, its own configuration, how the machines of one
 * attempt ended and why, and its history over a period.
 *
 * The alert used to ask them of the whole module behind the Job card — three
 * methods made public for it, beside the card's answers — and its tests had to
 * stand up a server and write Veeam's paths, session by session, to say what
 * a night of retries looked like. The Job report read its month past this
 * seam, with limits and a pace of its own, and took a machine Veeam would not
 * list for one never saved. Two adapters sit behind it: Veeam's, below, and
 * the one the tests hand in, which answers what the test says happened.
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
  /**
   * What Veeam wrote while running one attempt: its log, its machines, and
   * the logs of the longest of them. Best effort: undefined when Veeam would
   * not give the log or the machines; a machine's log it would not give is
   * left out.
   */
  recordOf(attempt: JobSession): Promise<AttemptRecord | undefined>;
  /**
   * The job's attempts begun since `since` (epoch ms), their machines and the
   * logs that say why, its configuration, and what held its newest runs back.
   * Throws when the attempts cannot be read: they are the history. Anything
   * after them that could not be read is said in `missing`, and the rest kept.
   */
  historyOf(job: Job, since: number): Promise<JobHistory>;
}

/** The job reads, asked of one Veeam server whose clock is in `timezone`. */
export class VeeamJobReads implements JobReads {
  private readonly logger = new Logger(VeeamJobReads.name);

  constructor(
    private readonly reader: Pick<
      VeeamEstateReader,
      'recentSessions' | 'jobConfiguration' | 'machineResults' | 'taskSessions' | 'sessionLog' | 'taskLog'
    >,
    private readonly timezone: string,
  ) {}

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

  async recordOf(attempt: JobSession): Promise<AttemptRecord | undefined> {
    if (!attempt.id) return undefined;
    const sessionId = attempt.id;
    try {
      const [log, tasks] = await Promise.all([this.reader.sessionLog(sessionId), this.tasksOf(sessionId)]);
      const longest = tasks
        .filter((task): task is VeeamTaskSession & { id: string } => Boolean(task.id))
        .sort(byLongest(this.timezone))
        .slice(0, MACHINE_LOGS);
      const logs = await settled(longest, (task) => this.reader.taskLog(task.id));
      const machineLogs = new Map<string, string[]>();
      longest.forEach((task, index) => {
        const read = logs[index];
        if (read.status === 'fulfilled') machineLogs.set(task.id, titlesOf(read.value));
        else this.logger.debug(`No log for task ${task.id}: ${(read.reason as Error).message}`);
      });
      return { log: titlesOf(log), tasks, machineLogs };
    } catch (error) {
      this.logger.debug(`No record of session ${sessionId}: ${(error as Error).message}`);
      return undefined;
    }
  }

  async historyOf(job: Job, since: number): Promise<JobHistory> {
    const missing: string[] = [];
    const [configured, sessions] = await Promise.all([
      this.reader.jobConfiguration(job.id).catch((error: Error) => {
        missing.push(`настройки: ${error.message}`);
        return undefined;
      }),
      this.reader.recentSessions(job.id, HISTORY_SESSIONS),
    ]);
    const inPeriod = sessions.filter(
      (session): session is VeeamSession & { id: string } => Boolean(session.id) && (instantOf(session.creationTime, this.timezone) ?? -Infinity) >= since,
    );

    const asked = inPeriod.slice(0, TASK_SESSIONS);
    const machines = await settled(asked, (session) => this.machinesIn(session.id));
    missing.push(...missed('машины', ofSessions, machines));
    const attempts = inPeriod.map((session, index): HistoryAttempt => {
      const read = machines[index];
      if (!read) return { session };
      return read.status === 'fulfilled' ? { session, tasks: read.value.tasks } : { session, unread: true };
    });

    // A machine's own outcome says only the step it failed at, "Getting VM info from vSphere"; its log says why.
    const unsaved = attempts
      .flatMap((attempt) => attempt.tasks ?? [])
      .filter((task): task is VeeamTaskSession & { id: string } => Boolean(task.id) && task.result?.result !== 'success')
      .slice(0, TASK_LOGS);
    const taskLogs = await settled(unsaved, (task) => this.reader.taskLog(task.id));
    missing.push(...missed('журналы', ofMachines, taskLogs));

    // A session read for its machines on a server without task sessions was read whole: its log is not asked twice.
    const logged = new Map(asked.flatMap((session, index) => {
      const read = machines[index];
      return read.status === 'fulfilled' && read.value.log ? [[session.id, read.value.log] as const] : [];
    }));
    const finished = inPeriod.filter((session) => session.endTime).slice(0, LOG_SESSIONS);
    const logs = await settled(finished, async (session) => logged.get(session.id) ?? (await this.reader.sessionLog(session.id)));
    missing.push(...missed('журналы', ofSessions, logs));

    return {
      configured,
      attempts,
      taskLogs: Object.fromEntries(unsaved.flatMap((task, index) => {
        const read = taskLogs[index];
        return read.status === 'fulfilled' ? [[task.id, read.value]] : [];
      })),
      bottlenecks: logs.flatMap((read) => (read.status === 'fulfilled' ? bottleneckOf(titlesOf(read.value)) ?? [] : [])),
      missing,
    };
  }

  /** A session's tasks; none on a server with no task sessions (REST API 1.1). */
  private async tasksOf(sessionId: string): Promise<VeeamTaskSession[]> {
    try {
      return await this.reader.taskSessions(sessionId);
    } catch (error) {
      if (noTaskSessions(error)) return [];
      throw error;
    }
  }

  /**
   * A session's machines: its tasks, or on a server with no task sessions
   * (REST API 1.1) what its log says of each — with the log, which says what
   * held the session back too.
   */
  private async machinesIn(sessionId: string): Promise<{ tasks: VeeamTaskSession[]; log?: VeeamLogRecord[] }> {
    try {
      return { tasks: await this.reader.taskSessions(sessionId) };
    } catch (error) {
      if (!noTaskSessions(error)) throw error;
    }
    const log = await this.reader.sessionLog(sessionId);
    return { tasks: loggedResults(log).map(asTask), log };
  }
}

/** Veeam's answer to a session's tasks on a server whose REST API predates them (1.1). */
const noTaskSessions = (error: unknown): boolean => error instanceof VeeamApiError && error.upstreamStatus === 404;

/** A machine's outcome from a session's log, as the task Veeam would have listed: no id, no times, no sizes. */
const asTask = ({ name, result, reason }: MachineResult): VeeamTaskSession => ({ name, result: { result, ...(reason ? { message: reason } : {}) } });

/** A log's lines, one line each: Veeam breaks its errors over several. */
const titlesOf = (records: VeeamLogRecord[]): string[] =>
  records.map((record) => (record.title ?? '').replace(/\s+/g, ' ').trim());

/** What of a read Veeam would not give, as the report says it: how many of how many, and the first reason. */
const missed = (what: string, word: (count: number) => string, reads: Array<PromiseSettledResult<unknown>>): string[] => {
  const failed = reads.filter((read): read is PromiseRejectedResult => read.status === 'rejected');
  return failed.length ? [`${what} ${failed.length} ${word(failed.length)} из ${reads.length}: ${(failed[0].reason as Error).message}`] : [];
};

/** After a number, in «машины 3 сессий из 60». */
const ofSessions = (count: number) => plural(count, 'сессии', 'сессий', 'сессий');
const ofMachines = (count: number) => plural(count, 'машины', 'машин', 'машин');

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Job, WorkingSessions } from '../veeam/estate';
import { VeeamServer } from '../veeam/servers';
import { VeeamSession } from '../veeam/types';
import { Evidence } from '../estate/backup-evidence.service';
import { Standings, standingsOf } from '../estate/job-standing';
import { isDisabled, isRunningNow } from '../estate/job-state';
import { RepositoryCapacity } from '../estate/repository-capacity';
import { ScheduledRun, todayRuns } from '../estate/schedule-planner';
import {
  Clock,
  headed,
  LiveHealth,
  LiveRunning,
  LiveSchedule,
  renderHealth,
  renderRunning,
  renderSchedule,
} from './format';
import { OrphansSnapshot, renderOrphans } from './orphans';
import {
  PerformanceJob,
  PerformanceSnapshot,
  aggregatePerformance,
  renderPerformance,
} from './performance';
import { ProtectionSnapshot, assessProtection, renderProtection } from './protection';
import { renderRepositories } from './repositories';
import { JobDepth, RestorePointsSnapshot, renderRestorePoints } from './restore-points';
import { LiveSlot } from './slots';

/**
 * What a slot says when Veeam answered nothing this cycle. The evidence module
 * owns the other reasons; this one is about the job list, which it never sees.
 */
const NOT_ANSWERED = 'Veeam не ответил на этот цикл.';

/** What one monitor cycle found, as the live slots need to hear it. */
export interface LiveCycle {
  /**
   * The server the slots show: named on top of every slot when there are
   * several, and read for the task detail 📈 needs.
   */
  server: Pick<VeeamServer, 'name' | 'reader'>;
  /** Undefined when Veeam did not answer the job list this cycle. */
  jobs?: Job[];
  /**
   * What Veeam is running, read once this cycle and shared by ▶️ and 📈 — and
   * by the Summary, when one goes out. Absent when nobody could sign in.
   */
  working?: WorkingSessions;
  repositories?: RepositoryCapacity[];
  /** Whether the monitor account signed in this cycle; false when it could not, or was never configured. */
  authenticated: boolean;
  /** This cycle's Evidence, already refreshed by the monitor before anything read it. */
  evidence: Evidence;
  /** The monitor's own view of itself, which only the monitor has. */
  health: LiveHealth;
}

/** One slot's content for this cycle, in the order the slots are published. */
export interface LivePage {
  slot: LiveSlot;
  content: string | string[];
}

/**
 * What every live slot says after one cycle.
 *
 * Turning the estate into what the slots show was eight private methods in the
 * monitor, reachable only through a whole cycle with a fake Veeam and a fake
 * Telegram behind it. The ▶️ slot and the summary disagreeing about how many
 * jobs were running lived there, where no test could ask the question
 * directly. Here a test hands in a cycle and reads the text the room would see.
 *
 * Publishing is not part of it: the monitor sends what this returns, so the
 * answer can be checked without a chat.
 */
@Injectable()
export class LiveSnapshotsService {
  private readonly logger = new Logger(LiveSnapshotsService.name);
  private readonly config: AppConfig['telegram'];
  /** Whether a slot names its server: only when there is more than one to tell apart. */
  private readonly named: boolean;

  constructor(config: ConfigService) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.named = config.getOrThrow<AppConfig['veeam']>('veeam').servers.length > 1;
  }

  async pages(cycle: LiveCycle, clock: Clock = this.clock()): Promise<LivePage[]> {
    const { jobs, repositories, evidence } = cycle;
    // Worked out once and read by both slots below, so they cannot disagree
    // about which jobs are in scope or how many were left out.
    const standings =
      jobs && evidence.status === 'ready' ? standingsOf(jobs, evidence) : undefined;

    const pages: LivePage[] = [
      { slot: 'health', content: renderHealth(cycle.health, clock) },
      { slot: 'running', content: renderRunning(this.runningState(cycle), clock) },
      { slot: 'schedule', content: renderSchedule(this.scheduleState(jobs, evidence, clock), clock) },
      { slot: 'performance', content: renderPerformance(await this.performanceState(cycle), clock) },
      { slot: 'repositories', content: renderRepositories(repositories, clock) },
      {
        slot: 'protection',
        content: renderProtection(this.protectionState(jobs, standings, evidence), clock),
      },
      { slot: 'restorePoints', content: renderRestorePoints(this.depthState(standings, evidence), clock) },
    ];

    // Off by request until the chains have been gone through by hand; the slot
    // and its renderer stay, so turning it back on is one setting.
    if (this.config.liveOrphans) {
      pages.push({ slot: 'orphans', content: renderOrphans(this.orphansState(jobs, evidence), clock) });
    }
    if (!this.named) return pages;
    const name = cycle.server.name;
    return pages.map(({ slot, content }) => ({
      slot,
      content: Array.isArray(content) ? content.map((page) => headed(name, page)) : headed(name, content),
    }));
  }

  /** Now, in the timezone the operator reads in. */
  private clock(): Clock {
    return { now: new Date(), timezone: this.config.timezone };
  }

  private runningState(cycle: LiveCycle): LiveRunning {
    const { jobs, authenticated } = cycle;
    if (!jobs || !authenticated) {
      // Saying "nothing is running" when we simply could not ask would be a
      // lie, and this message is the one an operator trusts at a glance.
      return {
        jobs: [],
        totalJobs: cycle.health.trackedJobs,
        unavailable: !cycle.health.reachable
          ? 'Сервер Veeam не отвечает, поэтому список заданий не обновляется.'
          : 'Служебная учётная запись Veeam не авторизована, поэтому список заданий не обновляется.',
      };
    }

    // Both sources, united by isRunningNow — sessions with no job of ours
    // behind them, Malware Detection among them, are not jobs and never enter
    // the list, because it is the jobs that are walked and not the sessions.
    const sessions = cycle.working?.byJob ?? new Map();

    return {
      jobs: jobs
        .filter((job) => isRunningNow(job, sessions))
        .map((job) => {
          const session = sessions.get(job.id);
          return {
            name: job.name,
            type: job.type,
            percent: session?.progressPercent,
            startedAt: session?.creationTime ?? job.lastRun,
            disabled: isDisabled(job),
          };
        })
        // The renderer prints them in the order it is given, and an operator
        // rereads this message every few minutes: a stable order is what makes
        // "is my job still there" answerable at a glance.
        .sort((a, b) => a.name.localeCompare(b.name)),
      totalJobs: jobs.length,
      next: upcomingRuns(jobs)[0] ?? null,
    };
  }

  private scheduleState(
    jobs: Job[] | undefined,
    evidence: Evidence,
    clock: Clock,
  ): LiveSchedule {
    if (!jobs) {
      return {
        upcoming: [],
        unavailable: 'Расписание не удалось прочитать: Veeam не ответил на этот цикл.',
      };
    }
    return {
      upcoming: evidence.status === 'ready'
        ? todayRuns(jobs, evidence.schedulesByJob, clock.now, clock.timezone)
        : upcomingRuns(jobs),
      next: upcomingRuns(jobs)[0] ?? null,
    };
  }

  /** Builds the Performance live slot from this cycle's Working sessions and their tasks. */
  private async performanceState(cycle: LiveCycle): Promise<PerformanceSnapshot> {
    if (!cycle.authenticated) {
      return {
        jobs: [],
        activeCount: 0,
        statisticsAvailable: false,
        unavailable: 'Служебная учётная запись Veeam не авторизована.',
      };
    }

    if (cycle.working?.unavailable) {
      return {
        jobs: [],
        activeCount: 0,
        statisticsAvailable: false,
        unavailable: cycle.working.unavailable,
      };
    }
    const sessions = cycle.working?.sessions ?? [];

    if (!sessions.length) return { jobs: [], activeCount: 0, statisticsAvailable: true };

    // A session of one of our jobs goes by the Job's name, as it does in every
    // other message; a session with no job behind it — Malware Detection —
    // has only its own. Veeam names a session after the job as it was called
    // when the session began, or not at all.
    const nameOf = new Map((cycle.jobs ?? []).map((job) => [job.id, job.name]));
    const named = (job: PerformanceJob, session: VeeamSession): PerformanceJob => {
      const name = session.jobId ? nameOf.get(session.jobId) : undefined;
      return name ? { ...job, name } : job;
    };

    const jobs: PerformanceJob[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sessions.length) {
        const session = sessions[next++];
        if (!session.id) continue;
        try {
          const tasks = await cycle.server.reader.taskSessions(session.id);
          jobs.push(named(aggregatePerformance(session, tasks), session));
        } catch (error) {
          // One inaccessible session must not hide all other performance data.
          this.logger.warn(`Performance task sessions ${session.id} skipped: ${(error as Error).message}`);
          jobs.push(named(aggregatePerformance(session, []), session));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, sessions.length) }, () => worker()));

    const statisticsAvailable = jobs.some((job) =>
      [job.rateBps, job.processedSize, job.readSize, job.transferredSize].some(
        (value) => value !== undefined,
      ),
    );
    this.logger.debug(
      `Performance refreshed: active=${sessions.length} detailed=${jobs.filter((job) => job.rateBps !== undefined).length}`,
    );
    return { jobs, activeCount: sessions.length, statisticsAvailable };
  }

  /**
   * Builds the Protection slot.
   *
   * The scan reads every restore point in the estate, which costs ~20 requests
   * and a good few seconds, so it runs on its own slow cadence rather than
   * every minute. What it caches is the raw evidence, not the verdict: the
   * verdict is recomputed each cycle against the current clock, so the ages
   * shown stay right between scans.
   */
  private protectionState(
    jobs: Job[] | undefined,
    standings: Standings | undefined,
    evidence: Evidence,
  ): ProtectionSnapshot {
    const thresholds = {
      staleDays: this.config.protectionStaleDays,
      overdueFactor: this.config.protectionOverdueFactor,
      minStreak: this.config.protectionFailureStreak,
    };

    if (!standings) {
      return {
        risks: [],
        totalJobs: jobs?.length ?? 0,
        protectedJobs: 0,
        excludedDisabled: 0,
        excludedUnscheduled: 0,
        ...thresholds,
        unavailable: evidence.status === 'pending' ? evidence.reason : NOT_ANSWERED,
      };
    }

    return assessProtection({ standings, now: Date.now(), ...thresholds });
  }

  /**
   * Where each job stands against its own schedule, from the same scan
   * 🛡 Protection uses.
   *
   * Jobs with no restore point at all are counted but not listed: they have
   * nothing to date, and Protection already names them.
   */
  private depthState(
    standings: Standings | undefined,
    evidence: Evidence,
  ): RestorePointsSnapshot {
    if (!standings || evidence.status === 'pending') {
      return {
        jobs: [],
        without: 0,
        excludedDisabled: 0,
        excludedUnscheduled: 0,
        failedPoints: 0,
        orphanBackups: 0,
        orphanPoints: 0,
        crossLink: this.config.liveOrphans,
        unavailable: evidence.status === 'pending' ? evidence.reason : NOT_ANSWERED,
      };
    }

    const listed: JobDepth[] = [];
    let without = 0;
    // Which jobs are in scope, and how many were left out, is decided once and
    // shared with 🛡 Protection; the two messages state the same numbers because
    // they are the same numbers.
    for (const job of standings.judged) {
      if (!job.depth) {
        without += 1;
        continue;
      }
      listed.push({ name: job.name, ...job.depth, intervalDays: job.cadenceDays });
    }

    const newest = listed.reduce<{ name: string; at: number } | undefined>(
      (best, job) =>
        job.newest !== undefined && (!best || job.newest > best.at)
          ? { name: job.name, at: job.newest }
          : best,
      undefined,
    );

    return {
      jobs: listed,
      without,
      excludedDisabled: standings.excludedDisabled,
      excludedUnscheduled: standings.excludedUnscheduled,
      failedPoints: evidence.failedPoints,
      orphanBackups: evidence.orphanChains.length,
      orphanPoints: orphanPoints(evidence.orphanChains),
      // Only mentioned while there is a 🧹 topic to send the reader to. A
      // pointer to a topic that does not exist is worse than no pointer.
      crossLink: this.config.liveOrphans,
      newest,
    };
  }

  /** Backup chains left behind by jobs that no longer exist. */
  private orphansState(jobs: Job[] | undefined, evidence: Evidence): OrphansSnapshot {
    if (!jobs || evidence.status === 'pending') {
      return {
        backups: [],
        points: 0,
        totalPoints: 0,
        unavailable: evidence.status === 'pending' ? evidence.reason : NOT_ANSWERED,
      };
    }
    return {
      backups: evidence.orphanChains,
      points: orphanPoints(evidence.orphanChains),
      totalPoints: evidence.totalPoints,
    };
  }
}

const orphanPoints = (chains: { points: number }[]): number =>
  chains.reduce((sum, chain) => sum + chain.points, 0);

/**
 * Every scheduled run still in the future, soonest first. The formatter
 * decides which of them fall on today, because "today" depends on the
 * display timezone rather than on the server's.
 */
const upcomingRuns = (jobs: Job[]): ScheduledRun[] => {
  const now = Date.now();
  const runs: Array<ScheduledRun & { ms: number }> = [];

  for (const job of jobs) {
    if (!job.nextRun) continue;
    const ms = Date.parse(job.nextRun);
    if (!Number.isFinite(ms) || ms <= now) continue;
    runs.push({ name: job.name, at: job.nextRun, ms });
  }

  return runs
    .sort((a, b) => a.ms - b.ms)
    .map(({ name, at }) => ({ name, at }));
};

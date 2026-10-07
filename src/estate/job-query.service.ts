import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Clock } from '../telegram/time';
import { escapeHtml } from '../telegram/format';
import { Job } from '../veeam/estate';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamInventoryService } from '../veeam/inventory.service';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { VeeamApiError } from '../veeam/api.error';
import { VeeamLogRecord, VeeamTaskSession } from '../veeam/types';
import { Answer } from './answer';
import { byLongest, MACHINE_LOGS, RunSpeed, speedOf } from './run-speed';
import { retryWindowOf, runsOf } from './runs';
import { BackupEvidenceService } from './backup-evidence.service';
import { addressable, summarise } from './digest';
import { isBadResult, isDisabled } from './job-state';
import { JobCard, machinesOf, matchJob, renderChoices, renderJobCard, settingsOf } from './job-card';
import { FailedObject, JobReads, JobSession, RECENT_SESSIONS } from './job-reads';
import { RetainedRun } from './evidence';
import { assessProtection, excuseFor, standingOf, standingsOf, thresholdsOf, verdictOf } from './job-standing';
import { pointsOf } from './point-facts';
import { PointsCard, renderPointsCard } from './points-card';
import { PointSizes, sizesOf } from './points-sizes';

/** Machine logs asked for at once when a card reads a run's speed. */
const LOGS_AT_ONCE = 5;

/** A log's lines, one line each: Veeam breaks its errors over several. */
const titlesOf = (records: VeeamLogRecord[]): string[] =>
  records.map((record) => (record.title ?? '').replace(/\s+/g, ' ').trim());

/**
 * Reads one job on demand without changing the background monitor's health.
 *
 * One per Veeam server, built by `ServerEstates`: it answers about the jobs of
 * the server whose reader and Evidence it was handed.
 */
export class JobQueryService {
  private readonly logger = new Logger(JobQueryService.name);
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly reader: VeeamEstateReader,
    private readonly monitorAuth: VeeamMonitorAuthService,
    private readonly evidence: BackupEvidenceService,
    private readonly inventory: VeeamInventoryService,
    private readonly reads: JobReads,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  /**
   * One job, named approximately.
   *
   * Reads the job list and, for the job it settles on, that job's recent
   * sessions; the restore-point figures come from the estate scan that already
   * happened, never from a new one, so asking about a job costs two requests
   * rather than the half-minute the scan takes.
   */
  async describeJob(query: string): Promise<Answer> {
    if (!query.trim()) {
      const read = await this.jobsNow();
      return {
        text: [
          '🔎 <b>Укажите задание</b>',
          '',
          'Например: <code>/job OPS_Exchange</code>',
          'Имя можно писать частями и в любом регистре: <code>/job kingston db</code>',
          '',
          'Или выберите из тех, что сейчас не в порядке:',
        ].join('\n'),
        // Asking for a card without saying which job is most often "show me
        // the one that is broken", so that list is offered instead of a scold.
        // Only the failing list is read here, never the running count, so the
        // sessions are not worth a request to answer "which job did you mean".
        jobs: read.ok ? addressable(summarise(read.jobs, new Set())) : undefined,
      };
    }

    const read = await this.jobsNow();
    if (!read.ok) return { text: read.message };

    const match = matchJob(read.jobs, query);
    if (match.found === 'none') {
      return {
        text: [
          `🔎 <b>Задание «${escapeHtml(query)}» не найдено</b>`,
          '',
          `Просмотрено ${read.jobs.length}. Достаточно любой части имени — проверьте, не опечатка ли.`,
        ].join('\n'),
      };
    }
    if (match.found === 'many') {
      return {
        text: renderChoices(match.jobs, query),
        jobs: match.jobs.map(({ id, name }) => ({ id, name })),
      };
    }
    return this.cardAnswer(match.job);
  }

  /**
   * The same card, addressed by id rather than by name.
   *
   * What a button presses. A name would not fit in Telegram's 64 bytes of
   * callback data, and re-running the search would mean a button could open a
   * different job than the one it was labelled with, if the estate changed
   * between the message and the press.
   */
  async describeJobById(id: string): Promise<Answer> {
    const read = await this.jobsNow();
    if (!read.ok) return { text: read.message };
    const job = read.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return {
        text: '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.',
      };
    }
    return this.cardAnswer(job);
  }

  private async cardAnswer(job: Job): Promise<Answer> {
    return {
      text: renderJobCard(await this.cardFor(job), this.clock()),
      jobId: job.id,
    };
  }

  /**
   * One job's restore points, named approximately — /job's search, answered
   * from the Evidence rather than from the job's sessions.
   *
   * Asked without a name, it offers the jobs whose points are behind their
   * rhythm, past a scheduled Full or too new to judge, which is what "show me
   * the points" most often means.
   */
  async describePoints(query: string): Promise<Answer> {
    const read = await this.jobsNow();
    if (!read.ok) return { text: read.message };

    if (!query.trim()) {
      const needing = this.needingAttention(read.jobs);
      return {
        text: [
          '🔎 <b>Укажите задание</b>',
          '',
          'Например: <code>/points OPS_Exchange</code>',
          'Имя можно писать частями и в любом регистре: <code>/points kingston db</code>',
          '',
          needing.length > 0
            ? 'Или выберите из тех, которым нужно внимание:'
            : 'Сейчас все задания в порядке.',
        ].join('\n'),
        jobs: needing.map(({ id, name }) => ({ id, name })),
        about: 'points',
      };
    }

    const match = matchJob(read.jobs, query);
    if (match.found === 'none') {
      return {
        text: [
          `🔎 <b>Задание «${escapeHtml(query)}» не найдено</b>`,
          '',
          `Просмотрено ${read.jobs.length}. Достаточно любой части имени — проверьте, не опечатка ли.`,
        ].join('\n'),
      };
    }
    if (match.found === 'many') {
      return {
        text: renderChoices(match.jobs, query),
        jobs: match.jobs.map(({ id, name }) => ({ id, name })),
        about: 'points',
      };
    }
    return this.pointsAnswer(match.job);
  }

  /** The same, addressed by id: what a /points Button presses. */
  async describePointsById(id: string): Promise<Answer> {
    const read = await this.jobsNow();
    if (!read.ok) return { text: read.message };
    const job = read.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return {
        text: '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.',
      };
    }
    return this.pointsAnswer(job);
  }

  private async pointsAnswer(job: Job): Promise<Answer> {
    const evidence = this.evidence.evidence;
    let card: PointsCard;
    if (evidence.status === 'ready') {
      const standing = standingOf(job, evidence);
      const excused = excuseFor(job, evidence) ?? undefined;
      const points = pointsOf(standing);
      card = {
        name: job.name,
        excused,
        // By the verdict 🛡 lists the job by, so the two cannot disagree about it.
        verdict: excused ? undefined : verdictOf(standing, this.clock(), thresholdsOf(this.config)),
        points,
        sizes: points ? await this.sizesOf(evidence.backupsByJob.get(job.id) ?? [], points.retained ?? []) : undefined,
        elsewhere: standing.byRuns,
      };
    } else {
      card = { name: job.name, unavailable: evidence.reason };
    }
    return { text: renderPointsCard(card, this.clock()), jobId: job.id, about: 'points' };
  }

  /**
   * What a job's points take up, from its backups' files: a request per
   * backup, asked only when somebody asks about the job, never by the scan.
   * Never throws: a card without sizes is still the answer.
   */
  private async sizesOf(backups: readonly string[], runs: RetainedRun[]): Promise<PointSizes | undefined> {
    if (backups.length === 0) return undefined;
    try {
      const files = await Promise.all(backups.map((backup) => this.reader.backupFiles(backup)));
      return sizesOf(files.flat(), runs);
    } catch (error) {
      this.logger.warn(`Backup files could not be read: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** The jobs 🛡 lists, in its order: the worst first. */
  private needingAttention(jobs: Job[]): Array<Pick<Job, 'id' | 'name'>> {
    const evidence = this.evidence.evidence;
    if (evidence.status !== 'ready') return [];
    const clock = this.clock();
    const { risks } = assessProtection({
      standings: standingsOf(jobs, evidence),
      now: clock.now.getTime(),
      timezone: clock.timezone,
      ...thresholdsOf(this.config),
    });
    return risks.map(({ id, name }) => ({ id, name }));
  }


  /**
   * The job list, right now, for a question rather than for a cycle.
   *
   * Deliberately does not touch `health`: a cycle reports what the monitor
   * knows, and a command asking a question of its own must not overwrite that
   * with its own luck.
   */
  async jobsNow(): Promise<{ ok: true; jobs: Job[] } | { ok: false; message: string }> {
    if (!this.monitorAuth.configured) {
      return { ok: false, message: '⚠️ Служебная учётная запись Veeam не настроена.' };
    }
    try {
      return { ok: true, jobs: await this.reader.jobStates() };
    } catch (error) {
      return {
        ok: false,
        message: `⚠️ <b>Veeam не ответил</b>\n\n${escapeHtml((error as Error).message)}`,
      };
    }
  }

  /** Everything known about one job, from the five places that know it. */
  private async cardFor(job: Job): Promise<JobCard> {
    const evidence = this.evidence.evidence;
    const scanned = evidence.status === 'ready' ? evidence : undefined;

    // In parallel: the three reads are independent, and a card that took three
    // round trips in sequence is a card nobody waits for.
    const [sessions, configured, names] = await Promise.all([
      this.reads.sessionsOf(job),
      this.reads.configurationOf(job),
      this.inventory.names(),
    ]);

    const { machines, excluded } = machinesOf(configured);
    const retryWindowMs = retryWindowOf(configured?.schedule);
    // The newest finished run's first attempt: a retry goes back only for the
    // machines that failed, so it says nothing about the speed of the rest.
    const attempt = runsOf(sessions.filter((session) => session.endedAt), retryWindowMs)[0]?.attempts.at(-1);
    const [failedObjects, speed] = await Promise.all([
      // Only while the job is actually broken: a recovered job's failures are
      // already visible in its run list, and this costs another request.
      isBadResult(job.result) ? this.failedObjects(sessions) : [],
      this.speedOf(attempt, job),
    ]);
    return {
      settings: settingsOf(configured, names),
      machines,
      excluded,
      failedObjects,
      speed,
      sessions,
      sessionsCut: sessions.length >= RECENT_SESSIONS,
      retryWindowMs,
      name: job.name,
      type: job.type,
      status: job.status,
      disabled: isDisabled(job),
      lastResult: job.result,
      lastRun: job.lastRun,
      nextRun: job.nextRun,
      objects: job.objectsCount,
      failures: scanned?.streakByJob.get(job.id),
      depth: scanned?.depthByJob.get(job.id),
      cadenceDays: scanned ? scanned.cadenceByJob.get(job.id) ?? null : undefined,
      pointsUnavailable: evidence.status === 'ready' ? undefined : evidence.reason,
      pointsElsewhere: scanned?.provenByRuns.has(job.id),
    };
  }

  /**
   * How fast one attempt went and what held it back, from what Veeam wrote
   * while running it: the session's log and tasks, then the logs of its
   * longest machines. Best effort: a card without it is still the answer.
   */
  private async speedOf(attempt: JobSession | undefined, job: Job): Promise<RunSpeed | undefined> {
    if (!attempt?.id) return undefined;
    const sessionId = attempt.id;
    try {
      const [log, tasks] = await Promise.all([this.reader.sessionLog(sessionId), this.tasksOf(sessionId)]);
      const longest = tasks
        .filter((task): task is VeeamTaskSession & { id: string } => Boolean(task.id))
        .sort(byLongest)
        .slice(0, MACHINE_LOGS);
      const machineLogs = new Map<string, string[]>();
      // A few at a time: thirty requests at once is a burst Veeam has no need of.
      for (let from = 0; from < longest.length; from += LOGS_AT_ONCE) {
        await Promise.all(
          longest.slice(from, from + LOGS_AT_ONCE).map(async (task) => {
            try {
              machineLogs.set(task.id, titlesOf(await this.reader.taskLog(task.id)));
            } catch (error) {
              this.logger.debug(`No log for task ${task.id}: ${(error as Error).message}`);
            }
          }),
        );
      }
      return speedOf({
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        log: titlesOf(log),
        tasks,
        machineLogs,
        cloud: /clouddirector/i.test(job.type ?? ''),
      });
    } catch (error) {
      this.logger.debug(`No speed for session ${sessionId}: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** A session's tasks; none on a server whose REST API predates them (1.1), whose log still says the rest. */
  private async tasksOf(sessionId: string): Promise<VeeamTaskSession[]> {
    try {
      return await this.reader.taskSessions(sessionId);
    } catch (error) {
      if (error instanceof VeeamApiError && error.upstreamStatus === 404) return [];
      throw error;
    }
  }

  /** Which objects of the newest bad session went wrong, and why. */
  private async failedObjects(sessions: JobSession[]): Promise<FailedObject[]> {
    const bad = sessions.find((session) => isBadResult(session.result ?? ''));
    if (!bad) return [];
    return (await this.reads.machinesOf(bad)).filter((object) => isBadResult(object.result ?? ''));
  }

  private clock(): Clock {
    return { now: new Date(), timezone: this.config.timezone };
  }
}

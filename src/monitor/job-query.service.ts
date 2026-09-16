import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { LiveClock } from '../live/format';
import { escapeHtml } from '../telegram/format';
import { VeeamHttpService } from '../veeam/http.service';
import { VeeamInventoryService } from '../veeam/inventory.service';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { allPages, authorized } from '../veeam/pages';
import { VeeamCollection, VeeamJob, VeeamJobState, VeeamSession, VeeamTaskSession } from '../veeam/types';
import { MonitorAnswer } from './answer';
import { BackupEvidenceService } from './backup-evidence.service';
import { addressable, summarise } from './digest';
import { isBadResult, isDisabled, resultOf } from './job-state';
import { FailedObject, JobCard, JobRun, machinesOf, matchJob, renderChoices, renderJobCard, settingsOf } from './job-card';

const JOB_STATES = '/api/v1/jobs/states';
const JOBS = '/api/v1/jobs';
const SESSIONS = '/api/v1/sessions';
const CARD_SESSIONS = 6;

/** Reads one job on demand without changing the background monitor's health. */
@Injectable()
export class JobQueryService {
  private readonly logger = new Logger(JobQueryService.name);
  private readonly config: AppConfig['telegram'];

  constructor(
    config: ConfigService,
    private readonly veeam: VeeamHttpService,
    private readonly monitorAuth: VeeamMonitorAuthService,
    private readonly evidence: BackupEvidenceService,
    private readonly inventory: VeeamInventoryService,
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
  async describeJob(query: string): Promise<MonitorAnswer> {
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
        jobs: match.jobs
          .filter((job): job is VeeamJobState & { id: string } => Boolean(job.id))
          .map((job) => ({ id: job.id, name: job.name ?? job.id })),
      };
    }
    return this.cardAnswer(match.job, read.accessToken);
  }

  /**
   * The same card, addressed by id rather than by name.
   *
   * What a button presses. A name would not fit in Telegram's 64 bytes of
   * callback data, and re-running the search would mean a button could open a
   * different job than the one it was labelled with, if the estate changed
   * between the message and the press.
   */
  async describeJobById(id: string): Promise<MonitorAnswer> {
    const read = await this.jobsNow();
    if (!read.ok) return { text: read.message };
    const job = read.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      return {
        text: '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.',
      };
    }
    return this.cardAnswer(job, read.accessToken);
  }

  private async cardAnswer(job: VeeamJobState, accessToken: string): Promise<MonitorAnswer> {
    return {
      text: renderJobCard(await this.cardFor(job, accessToken), this.clock()),
      jobId: job.id,
    };
  }


  /**
   * The job list, right now, for a question rather than for a cycle.
   *
   * Deliberately does not touch `health`: a cycle reports what the monitor
   * knows, and a command asking a question of its own must not overwrite that
   * with its own luck.
   */
  async jobsNow(): Promise<
    { ok: true; jobs: VeeamJobState[]; accessToken: string } | { ok: false; message: string }
  > {
    if (!this.monitorAuth.configured) {
      return { ok: false, message: '⚠️ Служебная учётная запись Veeam не настроена.' };
    }
    try {
      const accessToken = await this.monitorAuth.getAccessToken();
      const response = await authorized<VeeamCollection<VeeamJobState>>(this.reader(accessToken), {
        method: 'GET',
        path: JOB_STATES,
      });
      return { ok: true, jobs: response.data ?? [], accessToken };
    } catch (error) {
      return {
        ok: false,
        message: `⚠️ <b>Veeam не ответил</b>\n\n${escapeHtml((error as Error).message)}`,
      };
    }
  }

  /** Everything known about one job, from the five places that know it. */
  private async cardFor(job: VeeamJobState, accessToken: string): Promise<JobCard> {
    const evidence = this.evidence.evidence;
    const scanned = evidence.status === 'ready' ? evidence : undefined;
    const id = job.id;

    // In parallel: the three reads are independent, and a card that took three
    // round trips in sequence is a card nobody waits for.
    const [runs, configured, names] = await Promise.all([
      this.recentRuns(job, accessToken),
      this.jobConfig(job, accessToken),
      this.inventory.names(this.reader(accessToken)),
    ]);

    const { machines, excluded } = machinesOf(configured);
    return {
      settings: settingsOf(configured, names),
      machines,
      excluded,
      // Only while the job is actually broken: a recovered job's failures are
      // already visible in its run list, and this costs another request.
      failedObjects: isBadResult(resultOf(job))
        ? await this.failedObjects(runs, accessToken)
        : [],
      runs,
      name: job.name ?? id ?? 'без имени',
      type: job.type,
      status: job.status,
      disabled: isDisabled(job),
      lastResult: resultOf(job),
      lastRun: job.lastRun,
      nextRun: job.nextRun,
      objects: job.objectsCount,
      failures: scanned && id ? scanned.streakByJob.get(id) : undefined,
      depth: scanned && id ? scanned.depthByJob.get(id) : undefined,
      cadenceDays: scanned && id ? scanned.cadenceByJob.get(id) ?? null : undefined,
      pointsUnavailable: evidence.status === 'ready' ? undefined : evidence.reason,
    };
  }

  /** Newest sessions of one job. Best effort: a card without them still helps. */
  private async recentRuns(job: VeeamJobState, accessToken: string): Promise<JobRun[]> {
    if (!job.id) return [];
    try {
      const response = await authorized<VeeamCollection<VeeamSession>>(this.reader(accessToken), {
        method: 'GET',
        path: SESSIONS,
        params: {
          skip: 0,
          limit: CARD_SESSIONS,
          orderColumn: 'CreationTime',
          orderAsc: false,
          jobIdFilter: job.id,
        },
      });
      return (response.data ?? []).map((session) => ({
        id: session.id,
        startedAt: session.creationTime,
        endedAt: session.endTime,
        result: session.result?.result,
        message: session.result?.message?.trim() || undefined,
        percent: session.progressPercent,
      }));
    } catch (error) {
      this.logger.debug(`No session history for job ${job.id}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * The job's own configuration — schedule, repository, proxies, machines.
   *
   * Read by id rather than taken from the estate scan's copy: that copy keeps
   * only the schedules of all 112 jobs, and holding every job's full storage
   * settings in memory to answer a question nobody may ask is the wrong trade.
   */
  private async jobConfig(
    job: VeeamJobState,
    accessToken: string,
  ): Promise<VeeamJob | undefined> {
    if (!job.id) return undefined;
    try {
      return await authorized<VeeamJob>(this.reader(accessToken), {
        method: 'GET',
        path: `${JOBS}/${encodeURIComponent(job.id)}`,
      });
    } catch (error) {
      this.logger.debug(`No configuration for job ${job.id}: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Which objects of the newest bad run failed, and why.
   *
   * An empty answer is not a failure of this method: a run that could not
   * reach the machine at all — "Virtual Machine … is unavailable" — never
   * starts a task for it, and then the session message is the whole story.
   */
  private async failedObjects(runs: JobRun[], accessToken: string): Promise<FailedObject[]> {
    const bad = runs.find((run) => isBadResult((run.result ?? '').toLowerCase()));
    if (!bad?.id) return [];
    try {
      const tasks = await allPages<VeeamTaskSession>(
        this.reader(accessToken),
        `/api/v1/sessions/${encodeURIComponent(bad.id)}/taskSessions`,
      );
      return tasks
        .filter((task) => isBadResult((task.result?.result ?? '').toLowerCase()))
        .map((task) => ({
          name: task.name ?? 'без имени',
          result: task.result?.result,
          message: task.result?.message?.trim() || undefined,
        }));
    } catch (error) {
      this.logger.debug(`No task detail for session ${bad.id}: ${(error as Error).message}`);
      return [];
    }
  }

  private clock(): LiveClock {
    return { now: new Date(), timezone: this.config.timezone };
  }

  private reader(accessToken: string) {
    return { veeam: this.veeam, auth: this.monitorAuth, accessToken };
  }
}

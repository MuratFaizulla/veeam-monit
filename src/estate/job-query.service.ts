import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Clock } from '../telegram/time';
import { escapeHtml } from '../telegram/format';
import { Job } from '../veeam/estate';
import { machineLine, MachineResult, VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamInventoryService } from '../veeam/inventory.service';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { VeeamJob } from '../veeam/types';
import { Answer } from './answer';
import { retryWindowOf } from './runs';
import { BackupEvidenceService } from './backup-evidence.service';
import { addressable, summarise } from './digest';
import { isBadResult, isDisabled } from './job-state';
import { FailedObject, JobCard, JobSession, machinesOf, matchJob, renderChoices, renderJobCard, settingsOf } from './job-card';

/**
 * Sessions read for one job — by its card and by its alert, which counts the
 * attempt from the same read.
 *
 * Sessions are attempts and the card lists Runs: five of them at Veeam's
 * default four attempts is twenty sessions. Six used to be read, which was
 * one night and half of the one before it. Thirty leaves room for a job that
 * retries more, and for the Run the limit cuts short, which the card leaves out.
 */
const RECENT_SESSIONS = 30;

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
      this.recentSessions(job),
      this.configurationOf(job),
      this.inventory.names(),
    ]);

    const { machines, excluded } = machinesOf(configured);
    return {
      settings: settingsOf(configured, names),
      machines,
      excluded,
      // Only while the job is actually broken: a recovered job's failures are
      // already visible in its run list, and this costs another request.
      failedObjects: isBadResult(job.result) ? await this.failedObjects(sessions) : [],
      sessions,
      sessionsCut: sessions.length >= RECENT_SESSIONS,
      retryWindowMs: retryWindowOf(configured?.schedule),
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
   * Newest sessions of one job. Best effort: a card without them still helps.
   *
   * Public because an alert needs the same thing a card does — the reason the
   * run failed, and enough history around it to say which attempt this is.
   * Reading it twice would be two requests to answer one question.
   */
  async recentSessions(job: Job): Promise<JobSession[]> {
    try {
      return (await this.reader.recentSessions(job.id, RECENT_SESSIONS)).map((session) => ({
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
   *
   * Public because an alert sent before any scan has finished needs the retry
   * policy from here too. Best effort: undefined when it could not be read.
   */
  async configurationOf(job: Job): Promise<VeeamJob | undefined> {
    try {
      return await this.reader.jobConfiguration(job.id);
    } catch (error) {
      this.logger.debug(`No configuration for job ${job.id}: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * How each object of one session ended, and why the ones that went wrong did.
   * Best effort: empty when Veeam could not say.
   *
   * An empty answer is not a failure of this method: a run that could not
   * reach the machine at all — "Virtual Machine … is unavailable" — never
   * starts a task for it, and then the session message is the whole story.
   *
   * Public because an alert asks the same question a card does.
   */
  async objectsOf(session: JobSession): Promise<FailedObject[]> {
    if (!session.id) return [];
    let machines: MachineResult[];
    try {
      machines = await this.reader.machineResults(session.id);
    } catch (error) {
      this.logger.debug(`No per-object detail for session ${session.id}: ${(error as Error).message}`);
      return [];
    }
    // The task's own message is sometimes only the step it stopped at —
    // "Getting VM info from vSphere" — while the session's says, of the same
    // machine, "Error: Cannot get service content. / Soap fault. Temporary
    // failure in name resolution". An error named for a machine wins.
    const said = machineLine(session.message ?? '');
    return machines.map(({ name, result, reason }) => ({
      name,
      result,
      message: said.machine === name && said.reason ? said.reason : reason,
    }));
  }

  /** Which objects of the newest bad session went wrong, and why. */
  private async failedObjects(sessions: JobSession[]): Promise<FailedObject[]> {
    const bad = sessions.find((session) => isBadResult(session.result ?? ''));
    if (!bad) return [];
    return (await this.objectsOf(bad)).filter((object) => isBadResult(object.result ?? ''));
  }

  private clock(): Clock {
    return { now: new Date(), timezone: this.config.timezone };
  }
}

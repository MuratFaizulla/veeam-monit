import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Clock } from '../telegram/time';
import { escapeHtml } from '../telegram/format';
import { Job } from '../veeam/estate';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamInventoryService } from '../veeam/inventory.service';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { Answer } from './answer';
import { RunSpeed, speedOf } from './run-speed';
import { retryWindowOf, runsOf } from './runs';
import { BackupEvidenceService } from './backup-evidence.service';
import { addressable, summarise } from './digest';
import { isBadResult, isDisabled } from './job-state';
import { JobChoice, jobChoicesOf, PointsChoice, pointsChoicesOf } from './job-choices';
import { JobCard, machinesOf, matchJob, renderChoices, renderJobCard, settingsOf } from './job-card';
import { FailedObject, JobReads, JobSession, RECENT_SESSIONS } from './job-reads';
import { assessProtection, standingsOf, thresholdsOf } from './job-standing';

/** What a job's Button says when the job it addresses is no longer there. */
const GONE = '🔎 <b>Это задание больше не найдено</b>\n\nВозможно, его удалили или переименовали.';

/**
 * Reads one job on demand without changing the background monitor's health.
 *
 * One per Veeam server, built by `ServerEstates`: it answers about the jobs of
 * the server whose reader and Evidence it was handed.
 */
export class JobQueryService {
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
    const found = await this.jobById(id);
    return 'job' in found ? this.cardAnswer(found.job) : found.answer;
  }

  private async cardAnswer(job: Job): Promise<Answer> {
    return {
      text: renderJobCard(await this.cardFor(job), this.clock()),
      jobId: job.id,
    };
  }

  /**
   * The job somebody asks the points of, named approximately — /job's search
   * — or what is said instead. Asked without a name, it offers the jobs 🛡
   * lists, in 🛡's order, which is what "show me the points" most often
   * means; a name several jobs share offers each of them, never a guess.
   */
  async pointsOf(query: string): Promise<{ job: Job } | { answer: Answer }> {
    const read = await this.jobsNow();
    if (!read.ok) return { answer: { text: read.message } };

    if (!query.trim()) {
      const needing = this.needingAttention(read.jobs);
      return {
        answer: {
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
        },
      };
    }

    const match = matchJob(read.jobs, query);
    if (match.found === 'none') {
      return {
        answer: {
          text: [
            `🔎 <b>Задание «${escapeHtml(query)}» не найдено</b>`,
            '',
            `Просмотрено ${read.jobs.length}. Достаточно любой части имени — проверьте, не опечатка ли.`,
          ].join('\n'),
        },
      };
    }
    if (match.found === 'many') {
      return {
        answer: {
          text: renderChoices(match.jobs, query),
          jobs: match.jobs.map(({ id, name }) => ({ id, name })),
          about: 'points',
        },
      };
    }
    return { job: match.job };
  }

  /** The job a Button addressed by id, or what is said when it is gone. */
  async jobById(id: string): Promise<{ job: Job } | { answer: Answer }> {
    const read = await this.jobsNow();
    if (!read.ok) return { answer: { text: read.message } };
    const job = read.jobs.find((candidate) => candidate.id === id);
    return job ? { job } : { answer: { text: GONE } };
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
   * Every job by 🛡's verdict, for the points menu: one request, the job
   * list, judged by the Evidence already read — or, while there is none,
   * every job by name and why.
   */
  async pointsChoices(): Promise<{ ok: true; jobs: PointsChoice[]; pending?: string } | { ok: false; message: string }> {
    const read = await this.jobsNow();
    if (!read.ok) return read;
    const evidence = this.evidence.evidence;
    const jobs = pointsChoicesOf(read.jobs, evidence, this.clock(), thresholdsOf(this.config));
    return evidence.status === 'ready' ? { ok: true, jobs } : { ok: true, jobs, pending: evidence.reason };
  }

  /** Every job, for the job menu: one request, the job list. */
  async choices(): Promise<{ ok: true; jobs: JobChoice[] } | { ok: false; message: string }> {
    const read = await this.jobsNow();
    return read.ok ? { ok: true, jobs: jobChoicesOf(read.jobs) } : read;
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
   * while running it, which the Job reads read. Best effort: a card without
   * it is still the answer.
   */
  private async speedOf(attempt: JobSession | undefined, job: Job): Promise<RunSpeed | undefined> {
    if (!attempt) return undefined;
    const record = await this.reads.recordOf(attempt);
    return record
      ? speedOf({
          ...record,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          cloud: /clouddirector/i.test(job.type ?? ''),
          timezone: this.config.timezone,
        })
      : undefined;
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

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpService } from '../veeam/http.service';
import { allPages, authorized } from '../veeam/pages';
import { VeeamCollection, VeeamJobState, VeeamRepositoryState } from '../veeam/types';
import { DeliveryOutcome, DeliveryReport, TelegramService } from '../telegram/telegram.service';
import { TelegramLiveService } from '../live/live.service';
import { LiveSnapshotsService } from '../live/snapshots.service';
import { TelegramStateStore } from '../telegram/state.store';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { NotificationEvent, NotificationSeverity } from '../telegram/types';
import { capacities, RepositoryCapacity } from './repository-capacity';
import { BackupEvidenceService } from './backup-evidence.service';
import { addressable, digestEvent, summarise } from './digest';
import { isBadResult, rememberedResult, resultOf } from './job-state';
import { attemptOf, retriesAllowed, retryWindowOf } from './retries';
import { JobRun } from './job-card';
import { renderEvent } from '../telegram/format';
import { MonitorAnswer } from './answer';
import { JobQueryService } from './job-query.service';

const HOUR = 3_600_000;
const REPOSITORIES = '/api/v1/backupInfrastructure/repositories/states';
const JOB_STATES = '/api/v1/jobs/states';

export type { MonitorAnswer } from './answer';

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
 * Polls Veeam and turns what changed into notification events.
 *
 * Three independent signals are checked, because they fail independently and
 * an operator needs to tell them apart: the API answering at all, the monitor
 * service account being able to log in, and the jobs themselves. The previous
 * version folded the second into the first, so an expired monitor password
 * looked exactly like a healthy server with no failing jobs.
 */
@Injectable()
export class MonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorService.name);
  private readonly config: AppConfig['telegram'];
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastReachable?: boolean;
  private lastAuthenticated?: boolean;
  /** Veeam's own clock from the last successful reachability probe. */
  private lastServerTime?: string;
  private health: MonitorHealth = {
    lastCheckAt: null,
    reachable: null,
    authenticated: null,
    lastError: null,
    trackedJobs: 0,
    delivered: 0,
    undelivered: 0,
    lastOutcome: null,
  };

  constructor(
    config: ConfigService,
    private readonly veeam: VeeamHttpService,
    private readonly telegram: TelegramService,
    private readonly monitorAuth: VeeamMonitorAuthService,
    private readonly store: TelegramStateStore,
    private readonly live: TelegramLiveService,
    private readonly evidence: BackupEvidenceService,
    private readonly jobQuery: JobQueryService,
    private readonly snapshots: LiveSnapshotsService,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
  }

  onModuleInit(): void {
    if (!this.telegram.enabled || this.config.monitorIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.check(), this.config.monitorIntervalMs);
    this.timer.unref();
    void this.check();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get status(): MonitorHealth {
    return { ...this.health, trackedJobs: this.store.trackedJobs() };
  }

  /**
   * One monitoring pass. Never throws: a bad cycle must not kill the timer.
   *
   * Returns whether this call was the pass. A cycle already in flight is
   * declined, and a caller that asked for a pass on purpose — the timer does
   * not care, but POST /check does — has no other way to tell that the health
   * it is about to read belongs to somebody else's cycle.
   */
  async check(): Promise<'ran' | 'busy'> {
    if (this.running) {
      // A slow Veeam answer must not let two passes interleave and report the
      // same transition twice.
      this.logger.debug('Previous Veeam check is still running, skipping this tick');
      return 'busy';
    }
    this.running = true;
    try {
      const reachable = await this.checkReachability();
      const token = reachable ? await this.checkAuthentication() : null;
      let jobs: VeeamJobState[] | undefined;
      let repositories: RepositoryCapacity[] | undefined;
      if (token) {
        // Each step is isolated: one hiccup on /jobs/states used to abort the
        // rest of the cycle, taking the repository check and the digest with it.
        jobs = await this.step('jobs', () => this.checkJobs(token));
        repositories = await this.step('repositories', () => this.checkRepositories(token));
        await this.step('digest', () => this.maybeSendDigest(token));
      }
      this.health.lastCheckAt = new Date().toISOString();
      // Last, so it reports what this cycle actually found — including the
      // cycles where Veeam answered nothing at all.
      await this.step('live', () => this.publishLive(jobs, repositories, token));
      return 'ran';
    } finally {
      this.running = false;
    }
  }

  /**
   * Where every job stands, as a message somebody can be handed.
   *
   * The same counting as the daily digest, pulled instead of pushed. It is
   * rendered here rather than emitted as an event on purpose: an event goes
   * through the router to the topic its severity implies, and a clean summary
   * asked for in General would land in the recoveries topic, where nobody who
   * asked for it is looking. An answer belongs where the question was.
   */
  async summary(): Promise<MonitorAnswer> {
    const read = await this.jobQuery.jobsNow();
    if (!read.ok) return { text: read.message };
    const summary = summarise(read.jobs, await this.jobQuery.workingJobs(read.accessToken));
    return {
      // The very same event the daily message sends, rendered instead of
      // routed. Two renderings of one set of figures began to differ within a
      // day of existing; there is now nothing that can differ.
      text: renderEvent(digestEvent(summary)),
      // The jobs that are not well are exactly the ones somebody reading this
      // is about to ask about, so the summary offers them rather than making
      // them be typed back in.
      jobs: addressable(summary),
    };
  }

  async describeJob(query: string): Promise<MonitorAnswer> {
    return this.jobQuery.describeJob(query);
  }

  async describeJobById(id: string): Promise<MonitorAnswer> {
    return this.jobQuery.describeJobById(id);
  }

  /** What `allPages` needs from this module to read a Veeam collection. */
  private reader(accessToken: string) {
    return { veeam: this.veeam, auth: this.monitorAuth, accessToken };
  }

  private async step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      this.health.lastError = (error as Error).message;
      this.logger.error(`Veeam monitor step "${name}" failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async checkReachability(): Promise<boolean> {
    const { reachable, serverTime, error } = await this.veeam.reachability();
    const detail = (reachable ? serverTime : error) ?? '';
    if (reachable) this.lastServerTime = serverTime;
    else this.health.lastError = detail;
    this.health.reachable = reachable;

    // Starting up is not an event. It used to be announced every time, which
    // put six "монитор запущен" messages in the chat over one afternoon of
    // restarts; the live health message answers the same question, once.
    if (this.lastReachable !== undefined && this.lastReachable !== reachable) {
      await this.emit({
        kind: 'infrastructure',
        severity: reachable ? 'success' : 'critical',
        title: reachable ? 'Veeam: связь восстановлена' : 'Veeam: сервер недоступен',
        fields: [
          ['Сервер', this.veeam.baseUrl],
          [reachable ? 'Время сервера' : 'Ошибка', detail],
        ],
      });
    }
    this.lastReachable = reachable;
    return reachable;
  }

  /**
   * Returns an access token, or null when the monitor account cannot log in.
   *
   * A broken service account is reported once per cooldown instead of every
   * tick, and the recovery is announced so nobody has to check the log.
   */
  private async checkAuthentication(): Promise<string | null> {
    if (!this.monitorAuth.configured) {
      this.health.authenticated = null;
      await this.emit({
        kind: 'infrastructure',
        severity: 'warning',
        title: 'Мониторинг заданий выключен',
        body: 'VEEAM_MONITOR_USERNAME / VEEAM_MONITOR_PASSWORD не заданы, поэтому состояние заданий не проверяется.',
        dedupeKey: 'veeam:auth:unconfigured',
        cooldownMs: 24 * HOUR,
      });
      return null;
    }

    try {
      const token = await this.monitorAuth.getAccessToken();
      this.health.authenticated = true;
      if (this.lastAuthenticated === false) {
        this.store.clearCooldown('veeam:auth:failed');
        await this.emit({
          kind: 'infrastructure',
          severity: 'success',
          title: 'Veeam: служебная учётная запись снова работает',
          fields: [['Учётная запись', this.monitorAuth.username]],
        });
      }
      this.lastAuthenticated = true;
      return token;
    } catch (error) {
      this.health.authenticated = false;
      this.health.lastError = (error as Error).message;
      this.lastAuthenticated = false;
      await this.emit({
        kind: 'infrastructure',
        severity: 'critical',
        title: 'Veeam: служебная учётная запись не авторизуется',
        fields: [
          ['Учётная запись', this.monitorAuth.username],
          ['Сервер', this.veeam.baseUrl],
        ],
        body: `${(error as Error).message}\n\nПока вход не восстановлен, изменения статусов заданий не отслеживаются.`,
        dedupeKey: 'veeam:auth:failed',
        cooldownMs: this.config.authAlertCooldownMs,
      });
      return null;
    }
  }

  /** Returns the states it just read, so the live message reuses that fetch. */
  private async checkJobs(accessToken: string): Promise<VeeamJobState[]> {
    const response = await authorized<VeeamCollection<VeeamJobState>>(this.reader(accessToken), {
      method: 'GET',
      path: JOB_STATES,
    });
    const jobs = response.data ?? [];

    // An empty store means this installation has never been observed. Seeding
    // silently avoids announcing history as if it just happened; every later
    // start compares against the persisted results instead.
    const seeding = !this.store.hasJobResults();

    for (const job of jobs) {
      if (!job.id) continue;
      const result = resultOf(job);
      const previous = this.store.jobResult(job.id);
      const severity = seeding || previous === result ? null : this.severityOf(result, previous);

      if (severity) {
        const report = await this.emit(
          await this.jobEvent(job, result, previous, severity, accessToken),
        );
        // Advancing the remembered result is the record of "this transition has
        // been dealt with". A delivery that reached nobody has not dealt with
        // anything, so the transition stays pending and is retried next tick.
        if (report.outcome === 'failed') continue;
      }
      // Never `none` over something known: that is what lost every recovery
      // and re-announced every retry. See rememberedResult.
      this.store.recordJobResult(job.id, rememberedResult(result, previous));
    }

    this.store.forgetJobsExcept(new Set(jobs.map((job) => job.id)));

    if (seeding) {
      this.logger.log(`Veeam monitor seeded with ${jobs.length} job states, alerts start next cycle`);
    }

    return jobs;
  }

  /* ---------------------------------------------------------------- *
   * Live status
   * ---------------------------------------------------------------- */

  /**
   * Refreshes every live slot. They are state rather than events, so they are
   * edited in place and never queue up behind the alert pipeline.
   *
   * What each slot says is decided by the snapshots module; the monitor adds
   * the one input only it has — its own health — and sends the result.
   */
  private async publishLive(
    jobs: VeeamJobState[] | undefined,
    repositories: RepositoryCapacity[] | undefined,
    accessToken: string | null,
  ): Promise<void> {
    const pages = await this.snapshots.pages({
      jobs,
      repositories,
      accessToken,
      health: {
        reachable: this.health.reachable === true,
        authenticated: this.health.authenticated,
        serverUrl: this.veeam.baseUrl,
        serverTime: this.lastServerTime,
        error: this.health.lastError,
        trackedJobs: this.store.trackedJobs(),
        intervalMs: this.config.monitorIntervalMs,
      },
    });
    for (const { slot, content } of pages) await this.live.publish(slot, content);
  }


  /** Null means the transition is not worth a message (e.g. into "running"). */
  private severityOf(result: string, previous: string | undefined): NotificationSeverity | null {
    if (result === 'failed') return 'critical';
    if (result === 'warning') return 'warning';
    // Success is only interesting as a recovery: reporting every scheduled
    // success would bury the failures it is supposed to make visible.
    if (result === 'success' && previous && isBadResult(previous)) return 'success';
    return null;
  }

  private async jobEvent(
    job: VeeamJobState,
    result: string,
    previous: string | undefined,
    severity: NotificationSeverity,
    accessToken: string,
  ): Promise<NotificationEvent> {
    const name = job.name ?? job.id ?? 'неизвестное задание';
    const title =
      severity === 'success'
        ? `${name}: задание восстановлено`
        : `${name}: ${result === 'failed' ? 'ОШИБКА' : 'предупреждение'}`;

    // One read, two answers: the reason the run failed, and which attempt of
    // the run this is. They come from the same sessions, and fetching them
    // twice would be two requests to say one thing.
    const runs = severity === 'success' ? [] : await this.jobQuery.recentRuns(job, accessToken);

    return {
      kind: 'job',
      severity,
      subject: name,
      title,
      fields: [
        ['Результат', result.toUpperCase()],
        ['Было', previous ? previous.toUpperCase() : '—'],
        ['Попытка', this.attemptLabel(job, runs)],
        ['Тип', job.type],
        ['Статус', job.status],
        ['Последний запуск', job.lastRun],
        ['Следующий запуск', job.nextRun],
        ['Объектов', job.objectsCount],
      ],
      body: severity === 'success' ? undefined : runs[0]?.message,
      // One message per job per transition; the cooldown only guards against a
      // job flapping between two results within the window.
      dedupeKey: `job:${job.id}:${result}`,
      cooldownMs: this.config.jobAlertCooldownMs,
    };
  }

  /**
   * "2 из 3", or nothing when this is a first attempt with no retries behind it.
   *
   * Three alerts a night with identical text were three attempts at one run,
   * and nothing in the message said so. The retry policy comes from the estate
   * scan, which already reads every job configuration — a policy that changed
   * in the last twenty minutes is not worth a request per alert.
   */
  private attemptLabel(job: VeeamJobState, runs: JobRun[]): string | undefined {
    const evidence = this.evidence.evidence;
    const schedule =
      evidence.status === 'ready' && job.id ? evidence.schedulesByJob.get(job.id) : undefined;
    const attempt = attemptOf(runs, retryWindowOf(schedule));
    const allowed = retriesAllowed(schedule);
    if (attempt === 1 && !allowed) return undefined;
    return allowed ? `${attempt} из ${allowed}` : String(attempt);
  }

  private async checkRepositories(accessToken: string): Promise<RepositoryCapacity[]> {
    let repositories: RepositoryCapacity[];
    try {
      repositories = capacities(
        await allPages<VeeamRepositoryState>(this.reader(accessToken), REPOSITORIES),
      );
    } catch (error) {
      this.logger.warn(`Repository capacity check skipped: ${(error as Error).message}`);
      throw error;
    }

    if (this.config.repositoryFreePercent <= 0) return repositories;
    for (const repository of repositories) {
      // A repository whose free space Veeam did not report is left alone. It
      // used to be treated as zero free, which raised a critical alert about a
      // repository nobody could say anything about.
      const { freePercent, freeGB, capacityGB } = repository;
      if (freePercent === undefined) continue;
      const key = `repo:${repository.key}`;
      if (freePercent >= this.config.repositoryFreePercent) {
        this.store.clearCooldown(key);
        continue;
      }
      await this.emit({
        kind: 'repository',
        severity: freePercent < this.config.repositoryFreePercent / 2 ? 'critical' : 'warning',
        subject: repository.subject,
        title: `Репозиторий ${repository.name}: мало свободного места`,
        fields: [
          ['Свободно', `${(freeGB ?? 0).toFixed(1)} ГБ (${freePercent.toFixed(1)}%)`],
          ['Ёмкость', `${(capacityGB ?? 0).toFixed(1)} ГБ`],
          ['Порог', `${this.config.repositoryFreePercent}%`],
          ['Сервер', repository.hostName],
          ['Путь', repository.path],
        ],
        dedupeKey: key,
        cooldownMs: this.config.repositoryAlertCooldownMs,
      });
    }
    return repositories;
  }

  /** Once-a-day roll-up, so a quiet channel still proves the monitor is alive. */
  private async maybeSendDigest(accessToken: string): Promise<void> {
    const hour = this.config.digestHour;
    if (hour < 0 || new Date().getHours() !== hour) return;
    if (this.store.isSuppressed('digest')) return;

    const response = await authorized<VeeamCollection<VeeamJobState>>(this.reader(accessToken), {
      method: 'GET',
      path: JOB_STATES,
    });
    const summary = summarise(response.data ?? [], await this.jobQuery.workingJobs(accessToken));
    const report = await this.emit(digestEvent(summary));

    // Arming before the fetch, as this used to, lost the whole digest for 23
    // hours whenever that request threw.
    if (report.outcome === 'delivered') this.store.armCooldown('digest', 23 * HOUR);
  }

  private async emit(event: NotificationEvent): Promise<DeliveryReport> {
    const report = await this.telegram.notify(event);
    this.health.lastOutcome = report.outcome;
    if (report.outcome === 'delivered') this.health.delivered += 1;
    if (report.outcome === 'failed') this.health.undelivered += 1;

    const line = `Event "${event.title}" -> ${report.outcome} topic=${report.topic ?? 'General'} (${report.reason}) sent=${report.sent} failed=${report.failed}`;
    if (report.outcome === 'failed') this.logger.error(line);
    else this.logger.debug(line);
    return report;
  }
}

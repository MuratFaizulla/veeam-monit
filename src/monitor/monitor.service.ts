import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpService } from '../veeam/http.service';
import { allPages, authorized } from '../veeam/pages';
import { VeeamCollection, VeeamJobState, VeeamRepositoryState } from '../veeam/types';
import { DeliveryReport, TelegramService } from '../telegram/telegram.service';
import { TelegramLiveService } from '../live/live.service';
import { LiveSnapshotsService } from '../live/snapshots.service';
import { TelegramStateStore } from '../telegram/state.store';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { NotificationEvent, NotificationSeverity } from '../telegram/types';
import { capacities, RepositoryCapacity } from './repository-capacity';
import { BackupEvidenceService, Evidence } from './backup-evidence.service';
import { addressable, digestDue, digestEvent, summarise } from './digest';
import { repositoryAlarms } from './repository-alarms';
import { jobTransitions } from './transitions';
import { attemptOf, retriesAllowed, retryWindowOf } from './runs';
import { JobSession } from './job-card';
import { renderEvent } from '../telegram/format';
import { MonitorAnswer } from './answer';
import { Monitor, MonitorHealth } from './monitor';
import { JobQueryService } from './job-query.service';

const HOUR = 3_600_000;
const REPOSITORIES = '/api/v1/backupInfrastructure/repositories/states';
const JOB_STATES = '/api/v1/jobs/states';

export type { MonitorAnswer, MonitorHealth } from './monitor';

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
export class MonitorService implements Monitor, OnModuleInit, OnModuleDestroy {
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
    return { ...this.health, trackedJobs: this.store.jobResults.count() };
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
      // Each step is isolated: one hiccup on /jobs/states used to abort the
      // rest of the cycle, taking the repository check and the digest with it.
      if (token) jobs = await this.step('jobs', () => this.readJobs(token));

      // Once, before anything reads it — the alerts as much as the live slots.
      // It used to be refreshed by the live step, which runs last, so the
      // alerts read the previous cycle's evidence: after one cycle Veeam did
      // not answer, that was "pending", and the first alert after the outage —
      // the likeliest alert of all — lost the job's retry policy and said
      // "Попытка: 2" instead of "2 из 4".
      await this.evidence.refresh(token, jobs);
      const evidence = this.evidence.evidence;

      if (token) {
        const read = jobs;
        if (read) await this.step('alerts', () => this.checkJobs(read, evidence, token));
        repositories = await this.step('repositories', () => this.checkRepositories(token));
        if (read) await this.step('digest', () => this.maybeSendDigest(read, token));
      }
      this.health.lastCheckAt = new Date().toISOString();
      // Last, so it reports what this cycle actually found — including the
      // cycles where Veeam answered nothing at all.
      await this.step('live', () => this.publishLive(jobs, repositories, token, evidence));
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
        this.store.cooldowns.clear('veeam:auth:failed');
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

  /** Read once per cycle; the alerts, the evidence and the live slots share it. */
  private async readJobs(accessToken: string): Promise<VeeamJobState[]> {
    const response = await authorized<VeeamCollection<VeeamJobState>>(this.reader(accessToken), {
      method: 'GET',
      path: JOB_STATES,
    });
    return response.data ?? [];
  }

  /** Announces what changed since the results the monitor remembers. */
  private async checkJobs(
    jobs: VeeamJobState[],
    evidence: Evidence,
    accessToken: string,
  ): Promise<void> {
    // An empty store means this installation has never been observed.
    const seeding = !this.store.jobResults.seeded();
    const transitions = jobTransitions(jobs, (id) => this.store.jobResults.of(id), seeding);

    for (const { job, result, previous, severity, remember } of transitions) {
      if (severity) {
        const report = await this.emit(
          await this.jobEvent(job, result, previous, severity, evidence, accessToken),
        );
        // Advancing the remembered result is the record of "this transition has
        // been dealt with". A delivery that reached nobody has not dealt with
        // anything, so the transition stays pending and is retried next tick.
        if (report.outcome === 'failed') continue;
      }
      this.store.jobResults.record(job.id, remember);
    }

    this.store.jobResults.keepOnly(new Set(jobs.map((job) => job.id)));

    if (seeding) {
      this.logger.log(`Veeam monitor seeded with ${jobs.length} job states, alerts start next cycle`);
    }
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
    evidence: Evidence,
  ): Promise<void> {
    const pages = await this.snapshots.pages({
      jobs,
      repositories,
      accessToken,
      evidence,
      health: {
        reachable: this.health.reachable === true,
        authenticated: this.health.authenticated,
        serverUrl: this.veeam.baseUrl,
        serverTime: this.lastServerTime,
        error: this.health.lastError,
        trackedJobs: this.store.jobResults.count(),
        intervalMs: this.config.monitorIntervalMs,
      },
    });
    for (const { slot, content } of pages) await this.live.publish(slot, content);
  }


  private async jobEvent(
    job: VeeamJobState,
    result: string,
    previous: string | undefined,
    severity: NotificationSeverity,
    evidence: Evidence,
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
        ['Попытка', this.attemptLabel(job, runs, evidence)],
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
  private attemptLabel(
    job: VeeamJobState,
    runs: JobSession[],
    evidence: Evidence,
  ): string | undefined {
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

    const { events, cleared } = repositoryAlarms(repositories, {
      thresholdPercent: this.config.repositoryFreePercent,
      cooldownMs: this.config.repositoryAlertCooldownMs,
    });
    for (const key of cleared) this.store.cooldowns.clear(key);
    for (const event of events) await this.emit(event);
    return repositories;
  }

  /** Once-a-day roll-up, so a quiet channel still proves the monitor is alive. */
  private async maybeSendDigest(jobs: VeeamJobState[], accessToken: string): Promise<void> {
    if (!digestDue(new Date(), this.config.digestHour, this.config.timezone)) return;
    if (this.store.cooldowns.isSuppressed('digest')) return;

    // The job list this cycle already read. It used to be read a second time
    // here, on the one cycle a day that most wanted to be quick.
    const summary = summarise(jobs, await this.jobQuery.workingJobs(accessToken));
    const report = await this.emit(digestEvent(summary));

    // Arming before the fetch, as this used to, lost the whole digest for 23
    // hours whenever that request threw.
    if (report.outcome === 'delivered') this.store.cooldowns.arm('digest', 23 * HOUR);
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

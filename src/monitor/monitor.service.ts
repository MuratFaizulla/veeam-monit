import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpService } from '../veeam/http.service';
import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { Job, WorkingSessions, workingUnavailable } from '../veeam/estate';
import { VeeamSchedule } from '../veeam/types';
import { DeliveryReport, TelegramService } from '../telegram/telegram.service';
import { TelegramLiveService } from '../live/live.service';
import { LiveCycle, LiveSnapshotsService } from '../live/snapshots.service';
import { TelegramStateStore } from '../telegram/state.store';
import { VeeamMonitorAuthService } from '../veeam/monitor-auth.service';
import { NotificationEvent, NotificationSeverity } from '../telegram/types';
import { capacities, RepositoryCapacity } from '../estate/repository-capacity';
import { BackupEvidenceService, Evidence } from '../estate/backup-evidence.service';
import { addressable, digestDue, digestEvent, summarise } from '../estate/digest';
import { repositoryAlarms } from './repository-alarms';
import { jobTransitions, Transition } from './transitions';
import { attemptOf, retriesAllowed, retryWindowOf } from '../estate/runs';
import { JobSession } from '../estate/job-card';
import { renderEvent } from '../telegram/format';
import { MonitorAnswer } from '../estate/answer';
import { Monitor, MonitorHealth } from './monitor';
import { JobQueryService } from '../estate/job-query.service';

const HOUR = 3_600_000;

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
    private readonly reader: VeeamEstateReader,
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
      const authenticated = reachable && (await this.checkAuthentication());
      // Each step is isolated: one hiccup on /jobs/states used to abort the
      // rest of the cycle, taking the repository check and the digest with it.
      const jobs = authenticated ? await this.step('jobs', () => this.reader.jobStates()) : undefined;
      // Once, beside the job list it is united with, and shared by everything
      // that counts running jobs: ▶️, 📈 and the daily Summary.
      const working = authenticated ? await this.working() : undefined;
      let repositories: RepositoryCapacity[] | undefined;

      // Once, before anything reads it — the alerts as much as the live slots.
      // It used to be refreshed by the live step, which runs last, so the
      // alerts read the previous cycle's evidence: after one cycle Veeam did
      // not answer, that was "pending", and the first alert after the outage —
      // the likeliest alert of all — lost the job's retry policy and said
      // "Попытка: 2" instead of "2 из 4".
      await this.evidence.refresh(authenticated, jobs);
      const evidence = this.evidence.evidence;

      if (authenticated) {
        if (jobs) await this.step('alerts', () => this.checkJobs(jobs, evidence));
        repositories = await this.step('repositories', () => this.checkRepositories());
        if (jobs && working) await this.step('digest', () => this.maybeSendDigest(jobs, working));
      }
      this.health.lastCheckAt = new Date().toISOString();
      // Last, so it reports what this cycle actually found — including the
      // cycles where Veeam answered nothing at all.
      await this.step('live', () =>
        this.publishLive({ jobs, working, repositories, authenticated, evidence }),
      );
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
    const summary = summarise(read.jobs, (await this.working()).byJob);
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

  /**
   * What Veeam is running right now. Never throws.
   *
   * A failed read is an empty one with the reason, which is the safe direction:
   * a running count falls back to the job status alone and never invents a run,
   * and 📈 says why it has nothing to show.
   */
  private async working(): Promise<WorkingSessions> {
    try {
      return await this.reader.workingSessions();
    } catch (error) {
      this.logger.warn(`Working sessions unavailable: ${(error as Error).message}`);
      return workingUnavailable((error as Error).message);
    }
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
   * Whether the monitor account can sign in. The token itself stays with the
   * auth service; the estate reader asks it for one on every request.
   *
   * A broken service account is reported once per cooldown instead of every
   * tick, and the recovery is announced so nobody has to check the log.
   */
  private async checkAuthentication(): Promise<boolean> {
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
      return false;
    }

    try {
      await this.monitorAuth.getAccessToken();
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
      return true;
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
      return false;
    }
  }

  /** Announces what changed since the results the monitor remembers. */
  private async checkJobs(jobs: Job[], evidence: Evidence): Promise<void> {
    // An empty store means this installation has never been observed.
    const seeding = !this.store.jobResults.seeded();
    const transitions = jobTransitions(jobs, (id) => this.store.jobResults.of(id), seeding);

    for (const transition of transitions) {
      const { job, severity, remember } = transition;
      if (severity) {
        const report = await this.emit(await this.jobEvent({ ...transition, severity }, evidence));
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
  private async publishLive(cycle: Omit<LiveCycle, 'health'>): Promise<void> {
    const pages = await this.snapshots.pages({
      ...cycle,
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
    transition: Transition & { severity: NotificationSeverity },
    evidence: Evidence,
  ): Promise<NotificationEvent> {
    const { job, result, previous, severity } = transition;
    const { name } = job;
    const title =
      severity === 'success'
        ? `${name}: задание восстановлено`
        : `${name}: ${result === 'failed' ? 'ОШИБКА' : 'предупреждение'}`;

    // One read, two answers: the reason the run failed, and which attempt of
    // the run this is. They come from the same sessions, and fetching them
    // twice would be two requests to say one thing.
    const sessions = severity === 'success' ? [] : await this.jobQuery.recentSessions(job);
    const schedule = severity === 'success' ? undefined : await this.retryPolicyOf(job, evidence);

    return {
      kind: 'job',
      severity,
      subject: name,
      title,
      fields: [
        ['Результат', result.toUpperCase()],
        ['Было', previous ? previous.toUpperCase() : '—'],
        ['Попытка', this.attemptLabel(sessions, schedule)],
        ['Тип', job.type],
        ['Статус', job.status],
        ['Последний запуск', job.lastRun],
        ['Следующий запуск', job.nextRun],
        ['Объектов', job.objectsCount],
      ],
      body: severity === 'success' ? undefined : sessions[0]?.message,
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
    sessions: JobSession[],
    schedule: VeeamSchedule | undefined,
  ): string | undefined {
    const attempt = attemptOf(sessions, retryWindowOf(schedule));
    const allowed = retriesAllowed(schedule);
    if (attempt === 1 && !allowed) return undefined;
    return allowed ? `${attempt} из ${allowed}` : String(attempt);
  }

  /**
   * The job's schedule, retry policy included: from the Evidence when a scan
   * has finished, otherwise from the job's own configuration.
   *
   * The scan already reads every job configuration, so it is the free answer.
   * But after a restart the Evidence is pending until the first scan finishes,
   * and a scan can fail outright; the alert used to lose "из 4" for as long as
   * that lasted. One request per alert is cheap next to that. Best effort: an
   * alert without the policy is still an alert.
   */
  private async retryPolicyOf(job: Job, evidence: Evidence): Promise<VeeamSchedule | undefined> {
    if (evidence.status === 'ready') return evidence.schedulesByJob.get(job.id);
    try {
      return (await this.reader.jobConfiguration(job.id)).schedule;
    } catch (error) {
      this.logger.debug(`No configuration for job ${job.id}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async checkRepositories(): Promise<RepositoryCapacity[]> {
    let repositories: RepositoryCapacity[];
    try {
      repositories = capacities(await this.reader.repositoryStates());
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
  private async maybeSendDigest(jobs: Job[], working: WorkingSessions): Promise<void> {
    if (!digestDue(new Date(), this.config.digestHour, this.config.timezone)) return;
    if (this.store.cooldowns.isSuppressed('digest')) return;

    // The job list and the Working sessions this cycle already read. The list
    // used to be read a second time here, on the one cycle a day that most
    // wanted to be quick, and the sessions a third time.
    const summary = summarise(jobs, working.byJob);
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

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpService } from '../veeam/veeam-http.service';
import { VeeamApiError } from '../veeam/veeam-api.error';
import {
  VeeamCollection,
  VeeamJobState,
  VeeamRepositoryState,
  VeeamSession,
  VeeamTaskSession,
} from '../veeam/veeam.types';
import { DeliveryOutcome, DeliveryReport, TelegramService } from './telegram.service';
import { TelegramLiveService } from './telegram-live.service';
import {
  LiveClock,
  LiveRunning,
  LiveSchedule,
  ScheduledRun,
  renderHealth,
  renderRunning,
  renderSchedule,
} from './telegram-live.format';
import { TelegramStateStore } from './telegram-state.store';
import { VeeamMonitorAuthService } from './veeam-monitor-auth.service';
import { NotificationEvent, NotificationSeverity } from './telegram.types';
import {
  ACTIVE_SESSION_STATES,
  PerformanceJob,
  PerformanceSnapshot,
  aggregatePerformance,
  renderPerformance,
} from './telegram-performance';

const HOUR = 3_600_000;
const REPOSITORIES = '/api/v1/backupInfrastructure/repositories/states';
const SESSIONS = '/api/v1/sessions';

/** Veeam results that mean "this run went wrong", lower-cased. */
const BAD_RESULTS = new Set(['failed', 'warning']);

/**
 * Job statuses that count as "running right now", lower-cased. `Idle` is
 * deliberately absent: a continuously running job sits in it between transfers,
 * and listing those as active would make the live message permanently wrong.
 */
const RUNNING_STATUSES = new Set([
  'working',
  'running',
  'starting',
  'stopping',
  'pausing',
  'resuming',
  'postprocessing',
]);

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
export class TelegramMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramMonitorService.name);
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

  /** One monitoring pass. Never throws: a bad cycle must not kill the timer. */
  async check(): Promise<void> {
    if (this.running) {
      // A slow Veeam answer must not let two passes interleave and report the
      // same transition twice.
      this.logger.debug('Previous Veeam check is still running, skipping this tick');
      return;
    }
    this.running = true;
    try {
      const reachable = await this.checkReachability();
      const token = reachable ? await this.checkAuthentication() : null;
      let jobs: VeeamJobState[] | undefined;
      if (token) {
        // Each step is isolated: one hiccup on /jobs/states used to abort the
        // rest of the cycle, taking the repository check and the digest with it.
        jobs = await this.step('jobs', () => this.checkJobs(token));
        await this.step('repositories', () => this.checkRepositories(token));
        await this.step('digest', () => this.maybeSendDigest(token));
      }
      this.health.lastCheckAt = new Date().toISOString();
      // Last, so it reports what this cycle actually found — including the
      // cycles where Veeam answered nothing at all.
      await this.step('live', () => this.publishLive(jobs, token));
    } finally {
      this.running = false;
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
    let reachable = false;
    let detail = '';
    try {
      const result = await this.veeam.request<{ serverTime?: string }>({
        method: 'GET',
        path: '/api/v1/serverTime',
      });
      reachable = true;
      detail = result.serverTime ?? '';
      this.lastServerTime = result.serverTime;
    } catch (error) {
      detail = (error as Error).message;
      this.health.lastError = detail;
    }
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
    const response = await this.veeam.request<VeeamCollection<VeeamJobState>>({
      method: 'GET',
      path: '/api/v1/jobs/states',
      accessToken,
    });
    const jobs = response.data ?? [];

    // An empty store means this installation has never been observed. Seeding
    // silently avoids announcing history as if it just happened; every later
    // start compares against the persisted results instead.
    const seeding = !this.store.hasJobResults();

    for (const job of jobs) {
      if (!job.id) continue;
      const result = job.lastResult?.toLowerCase() || 'none';
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
      this.store.recordJobResult(job.id, result);
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
   * Refreshes the two always-current messages: is the monitor working, and
   * what is running right now. Both are state rather than events, so they are
   * edited in place and never queue up behind the alert pipeline.
   */
  private async publishLive(
    jobs: VeeamJobState[] | undefined,
    accessToken: string | null,
  ): Promise<void> {
    const clock: LiveClock = { now: new Date(), timezone: this.config.timezone };

    await this.live.publish(
      'health',
      renderHealth(
        {
          reachable: this.health.reachable === true,
          authenticated: this.health.authenticated,
          serverUrl: this.veeam.baseUrl,
          serverTime: this.lastServerTime,
          error: this.health.lastError,
          trackedJobs: this.store.trackedJobs(),
          intervalMs: this.config.monitorIntervalMs,
        },
        clock,
      ),
    );

    await this.live.publish(
      'running',
      renderRunning(await this.runningState(jobs, accessToken), clock),
    );

    await this.live.publish('schedule', renderSchedule(this.scheduleState(jobs), clock));

    await this.live.publish(
      'performance',
      renderPerformance(await this.performanceState(accessToken), clock),
    );
  }

  /** Builds the Performance live slot from active sessions and their tasks. */
  private async performanceState(accessToken: string | null): Promise<PerformanceSnapshot> {
    if (!accessToken) {
      return {
        jobs: [],
        activeCount: 0,
        statisticsAvailable: false,
        unavailable: 'Служебная учётная запись Veeam не авторизована.',
      };
    }

    let sessions: VeeamSession[];
    try {
      sessions = (await this.allPages<VeeamSession>(SESSIONS, accessToken, {
        stateFilter: 'Working',
        orderColumn: 'CreationTime',
        orderAsc: false,
      })).filter((session) => ACTIVE_SESSION_STATES.has((session.state ?? '').toLowerCase()));
    } catch (error) {
      this.logger.error(`Performance sessions unavailable: ${(error as Error).message}`);
      return {
        jobs: [],
        activeCount: 0,
        statisticsAvailable: false,
        unavailable: (error as Error).message,
      };
    }

    if (!sessions.length) return { jobs: [], activeCount: 0, statisticsAvailable: true };

    const jobs: PerformanceJob[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sessions.length) {
        const session = sessions[next++];
        if (!session.id) continue;
        try {
          const tasks = await this.allPages<VeeamTaskSession>(
            `/api/v1/sessions/${encodeURIComponent(session.id)}/taskSessions`,
            accessToken,
          );
          jobs.push(aggregatePerformance(session, tasks));
        } catch (error) {
          // One inaccessible session must not hide all other performance data.
          this.logger.warn(`Performance task sessions ${session.id} skipped: ${(error as Error).message}`);
          jobs.push(aggregatePerformance(session, []));
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

  /** Reads every page; Veeam may cap the requested limit below our value. */
  private async allPages<T>(
    path: string,
    accessToken: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let token = accessToken;
    let skip = 0;
    const limit = 100;
    for (;;) {
      let page: VeeamCollection<T>;
      try {
        page = await this.veeam.request<VeeamCollection<T>>({
          method: 'GET', path, accessToken: token, params: { ...params, skip, limit },
        });
      } catch (error) {
        if (!(error instanceof VeeamApiError) || !error.isUnauthorized) throw error;
        this.monitorAuth.invalidateAccessToken();
        token = await this.monitorAuth.getAccessToken();
        page = await this.veeam.request<VeeamCollection<T>>({
          method: 'GET', path, accessToken: token, params: { ...params, skip, limit },
        });
      }
      const data = page.data ?? [];
      items.push(...data);
      const total = page.pagination?.total;
      if (
        typeof total === 'number'
          ? items.length >= total
          : data.length < (page.pagination?.limit ?? limit)
      ) break;
      if (!data.length) break;
      skip += data.length;
    }
    return items;
  }

  private scheduleState(jobs: VeeamJobState[] | undefined): LiveSchedule {
    if (!jobs) {
      return {
        upcoming: [],
        unavailable: 'Расписание не удалось прочитать: Veeam не ответил на этот цикл.',
      };
    }
    return { upcoming: this.upcomingRuns(jobs) };
  }

  private async runningState(
    jobs: VeeamJobState[] | undefined,
    accessToken: string | null,
  ): Promise<LiveRunning> {
    if (!jobs || !accessToken) {
      // Saying "nothing is running" when we simply could not ask would be a
      // lie, and this message is the one an operator trusts at a glance.
      return {
        jobs: [],
        totalJobs: this.store.trackedJobs(),
        unavailable:
          this.health.reachable === false
            ? 'Сервер Veeam не отвечает, поэтому список заданий не обновляется.'
            : 'Служебная учётная запись Veeam не авторизована, поэтому список заданий не обновляется.',
      };
    }

    const active = jobs.filter((job) => RUNNING_STATUSES.has((job.status ?? '').toLowerCase()));
    // The percentage lives on the session, not the job state, so that call is
    // made only when something is actually running.
    const sessions = active.length ? await this.runningSessions(accessToken) : new Map();

    return {
      jobs: active.map((job) => {
        const session = job.id ? sessions.get(job.id) : undefined;
        return {
          name: job.name ?? job.id ?? 'без имени',
          type: job.type,
          percent: session?.progressPercent,
          startedAt: session?.creationTime ?? job.lastRun,
        };
      }),
      totalJobs: jobs.length,
      next: this.upcomingRuns(jobs)[0] ?? null,
    };
  }

  /** Newest working session per job. Best effort: progress is a nicety. */
  private async runningSessions(accessToken: string): Promise<Map<string, VeeamSession>> {
    const byJob = new Map<string, VeeamSession>();
    try {
      const response = await this.veeam.request<VeeamCollection<VeeamSession>>({
        method: 'GET',
        path: SESSIONS,
        accessToken,
        params: {
          skip: 0,
          limit: 100,
          orderColumn: 'CreationTime',
          orderAsc: false,
          stateFilter: 'Working',
        },
      });
      for (const session of response.data ?? []) {
        if (session.jobId && !byJob.has(session.jobId)) byJob.set(session.jobId, session);
      }
    } catch (error) {
      this.logger.debug(`No running session detail: ${(error as Error).message}`);
    }
    return byJob;
  }

  /**
   * Every scheduled run still in the future, soonest first. The formatter
   * decides which of them fall on today, because "today" depends on the
   * display timezone rather than on the server's.
   */
  private upcomingRuns(jobs: VeeamJobState[]): ScheduledRun[] {
    const now = Date.now();
    const runs: Array<ScheduledRun & { ms: number }> = [];

    for (const job of jobs) {
      if (!job.nextRun) continue;
      const ms = Date.parse(job.nextRun);
      if (!Number.isFinite(ms) || ms <= now) continue;
      runs.push({ name: job.name ?? job.id ?? 'без имени', at: job.nextRun, ms });
    }

    return runs
      .sort((a, b) => a.ms - b.ms)
      .map(({ name, at }) => ({ name, at }));
  }

  /** Null means the transition is not worth a message (e.g. into "running"). */
  private severityOf(result: string, previous: string | undefined): NotificationSeverity | null {
    if (result === 'failed') return 'critical';
    if (result === 'warning') return 'warning';
    // Success is only interesting as a recovery: reporting every scheduled
    // success would bury the failures it is supposed to make visible.
    if (result === 'success' && previous && BAD_RESULTS.has(previous)) return 'success';
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

    return {
      kind: 'job',
      severity,
      subject: name,
      title,
      fields: [
        ['Результат', result.toUpperCase()],
        ['Было', previous ? previous.toUpperCase() : '—'],
        ['Тип', job.type],
        ['Статус', job.status],
        ['Последний запуск', job.lastRun],
        ['Следующий запуск', job.nextRun],
        ['Объектов', job.objectsCount],
      ],
      body: severity === 'success' ? undefined : await this.lastSessionMessage(job, accessToken),
      // One message per job per transition; the cooldown only guards against a
      // job flapping between two results within the window.
      dedupeKey: `job:${job.id}:${result}`,
      cooldownMs: this.config.jobAlertCooldownMs,
    };
  }

  /**
   * The job state carries no reason for a failure, so the newest session for
   * that job is fetched for its message. Best effort: an alert without the
   * detail is far better than no alert.
   */
  private async lastSessionMessage(
    job: VeeamJobState,
    accessToken: string,
  ): Promise<string | undefined> {
    if (!job.id) return undefined;
    try {
      const response = await this.veeam.request<VeeamCollection<VeeamSession>>({
        method: 'GET',
        path: SESSIONS,
        accessToken,
        params: {
          skip: 0,
          limit: 1,
          orderColumn: 'CreationTime',
          orderAsc: false,
          jobIdFilter: job.id,
        },
      });
      return response.data?.[0]?.result?.message?.trim() || undefined;
    } catch (error) {
      this.logger.debug(`No session detail for job ${job.id}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async checkRepositories(accessToken: string): Promise<void> {
    if (this.config.repositoryFreePercent <= 0) return;
    let repositories: VeeamRepositoryState[];
    try {
      const response = await this.veeam.request<VeeamCollection<VeeamRepositoryState>>({
        method: 'GET',
        path: REPOSITORIES,
        accessToken,
      });
      repositories = response.data ?? [];
    } catch (error) {
      this.logger.warn(`Repository capacity check skipped: ${(error as Error).message}`);
      return;
    }

    for (const repository of repositories) {
      const capacity = repository.capacityGB ?? 0;
      const free = repository.freeGB ?? 0;
      if (capacity <= 0) continue;
      const freePercent = (free / capacity) * 100;
      const key = `repo:${repository.id ?? repository.name}`;
      if (freePercent >= this.config.repositoryFreePercent) {
        this.store.clearCooldown(key);
        continue;
      }
      await this.emit({
        kind: 'repository',
        severity: freePercent < this.config.repositoryFreePercent / 2 ? 'critical' : 'warning',
        subject: repository.name,
        title: `Репозиторий ${repository.name ?? repository.id}: мало свободного места`,
        fields: [
          ['Свободно', `${free.toFixed(1)} ГБ (${freePercent.toFixed(1)}%)`],
          ['Ёмкость', `${capacity.toFixed(1)} ГБ`],
          ['Порог', `${this.config.repositoryFreePercent}%`],
          ['Сервер', repository.hostName],
          ['Путь', repository.path],
        ],
        dedupeKey: key,
        cooldownMs: this.config.repositoryAlertCooldownMs,
      });
    }
  }

  /** Once-a-day roll-up, so a quiet channel still proves the monitor is alive. */
  private async maybeSendDigest(accessToken: string): Promise<void> {
    const hour = this.config.digestHour;
    if (hour < 0 || new Date().getHours() !== hour) return;
    if (this.store.isSuppressed('digest')) return;

    const response = await this.veeam.request<VeeamCollection<VeeamJobState>>({
      method: 'GET',
      path: '/api/v1/jobs/states',
      accessToken,
    });
    const jobs = response.data ?? [];
    const by = (result: string): VeeamJobState[] =>
      jobs.filter((job) => (job.lastResult?.toLowerCase() ?? '') === result);
    const failed = by('failed');
    const warning = by('warning');

    const report = await this.emit({
      kind: 'digest',
      severity: failed.length ? 'critical' : warning.length ? 'warning' : 'success',
      title: 'Veeam: сводка за сутки',
      fields: [
        ['Всего заданий', jobs.length],
        ['Успешно', by('success').length],
        ['С предупреждением', warning.length],
        ['С ошибкой', failed.length],
        ['Выполняются', jobs.filter((job) => job.status?.toLowerCase() === 'working').length],
      ],
      body: [...failed, ...warning]
        .map((job) => `${job.lastResult?.toUpperCase()} — ${job.name ?? job.id}`)
        .join('\n')
        .slice(0, 3000) || undefined,
    });

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

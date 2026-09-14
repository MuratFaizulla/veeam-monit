import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { VeeamHttpService } from '../veeam/veeam-http.service';
import {
  VeeamCollection,
  VeeamJobState,
  VeeamRepositoryState,
  VeeamSession,
} from '../veeam/veeam.types';
import { TelegramService } from './telegram.service';
import { TelegramStateStore } from './telegram-state.store';
import { VeeamMonitorAuthService } from './veeam-monitor-auth.service';
import { NotificationEvent, NotificationSeverity } from './telegram.types';

const HOUR = 3_600_000;
const REPOSITORIES = '/api/v1/backupInfrastructure/repositories/states';

/** Veeam results that mean "this run went wrong", lower-cased. */
const BAD_RESULTS = new Set(['failed', 'warning']);

export interface MonitorHealth {
  lastCheckAt: string | null;
  reachable: boolean | null;
  authenticated: boolean | null;
  lastError: string | null;
  trackedJobs: number;
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
  private health: MonitorHealth = {
    lastCheckAt: null,
    reachable: null,
    authenticated: null,
    lastError: null,
    trackedJobs: 0,
  };

  constructor(
    config: ConfigService,
    private readonly veeam: VeeamHttpService,
    private readonly telegram: TelegramService,
    private readonly monitorAuth: VeeamMonitorAuthService,
    private readonly store: TelegramStateStore,
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
    return { ...this.health, trackedJobs: Object.keys(this.store.data.jobResults).length };
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
      if (token) {
        await this.checkJobs(token);
        await this.checkRepositories(token);
        await this.maybeSendDigest(token);
      }
      this.health.lastCheckAt = new Date().toISOString();
    } catch (error) {
      this.health.lastError = (error as Error).message;
      this.logger.error(`Veeam monitor cycle failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
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
    } catch (error) {
      detail = (error as Error).message;
      this.health.lastError = detail;
    }
    this.health.reachable = reachable;

    if (this.lastReachable === undefined) {
      await this.emit({
        kind: 'infrastructure',
        severity: reachable ? 'info' : 'critical',
        title: `Veeam Monitor запущен — сервер ${reachable ? 'доступен' : 'НЕДОСТУПЕН'}`,
        fields: [
          ['Сервер', this.veeam.baseUrl],
          [reachable ? 'Время сервера' : 'Ошибка', detail],
          ['Интервал проверки', `${Math.round(this.config.monitorIntervalMs / 1000)} с`],
        ],
      });
    } else if (this.lastReachable !== reachable) {
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

  private async checkJobs(accessToken: string): Promise<void> {
    const response = await this.veeam.request<VeeamCollection<VeeamJobState>>({
      method: 'GET',
      path: '/api/v1/jobs/states',
      accessToken,
    });
    const jobs = response.data ?? [];

    // An empty store means this installation has never been observed. Seeding
    // silently avoids announcing history as if it just happened; every later
    // start compares against the persisted results instead.
    const seeding = Object.keys(this.store.data.jobResults).length === 0;

    for (const job of jobs) {
      if (!job.id) continue;
      const result = job.lastResult?.toLowerCase() || 'none';
      const previous = this.store.data.jobResults[job.id];
      this.store.data.jobResults[job.id] = result;

      if (seeding || previous === result) continue;
      const severity = this.severityOf(result, previous);
      if (!severity) continue;
      await this.emit(await this.jobEvent(job, result, previous, severity, accessToken));
    }

    // Jobs deleted in Veeam must not keep a slot in the state file forever.
    const live = new Set(jobs.map((job) => job.id));
    for (const id of Object.keys(this.store.data.jobResults)) {
      if (!live.has(id)) delete this.store.data.jobResults[id];
    }
    this.store.save();

    if (seeding) {
      this.logger.log(`Veeam monitor seeded with ${jobs.length} job states, alerts start next cycle`);
    }
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
        path: '/api/v1/sessions',
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
    if (!this.store.allow('digest', 23 * HOUR)) return;

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

    await this.emit({
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
  }

  private async emit(event: NotificationEvent): Promise<void> {
    const report = await this.telegram.notify(event);
    this.logger.debug(
      `Event "${event.title}" -> topic=${report.topic ?? 'General'} (${report.reason}) sent=${report.sent} failed=${report.failed} skipped=${report.skipped}`,
    );
  }
}

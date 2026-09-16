import { join } from 'path';
import type { LiveSlot } from '../telegram/live-slots';
import {
  NOTIFICATION_SEVERITIES,
  type NotificationKind,
  type NotificationSeverity,
} from '../telegram/telegram.types';

/** How an event is mapped onto a forum topic when no rule in the routes file matches. */
export type TelegramRoutingMode = 'job' | 'severity' | 'kind' | 'single';

export interface AppConfig {
  port: number;
  /**
   * Whether the OpenAPI page is served at /api/docs. On by default: it carries
   * no secrets — only the names of the headers the guards expect — and a
   * monitor nobody can drive by hand is a monitor nobody checks.
   */
  docs: boolean;
  veeam: {
    baseUrl: string;
    apiVersion: string;
    insecureTls: boolean;
    timeoutMs: number;
  };
  telegram: {
    botToken: string;
    webhookUrl: string;
    webhookSecret: string;
    adminKey: string;
    chatIds: string[];
    monitorIntervalMs: number;
    veeamUsername: string;
    veeamPassword: string;
    /** JSON file holding chats, forum topics, job results and cooldowns. */
    stateFile: string;
    /** Optional JSON file with explicit routing rules. */
    routesFile: string;
    routingMode: TelegramRoutingMode;
    /** Shared destination for critical and warning events in single mode. */
    alertsTopic: string;
    /** Prefixed to the job name when a per-job topic is created. */
    jobTopicPrefix: string;
    severityTopics: Record<NotificationSeverity, string>;
    kindTopics: Record<NotificationKind, string>;
    /** Severities that are delivered at all. */
    severities: NotificationSeverity[];
    /** Whether the bot may create missing forum topics itself. */
    createTopics: boolean;
    /** Minimum gap between two messages to the same chat. */
    sendIntervalMs: number;
    queueLimit: number;
    jobAlertCooldownMs: number;
    authAlertCooldownMs: number;
    repositoryAlertCooldownMs: number;
    /** Free-space percentage below which a repository is reported. 0 disables. */
    repositoryFreePercent: number;
    /** Local hour for the daily digest, or -1 to disable it. */
    digestHour: number;
    /** Whether the always-current status messages are maintained at all. */
    live: boolean;
    /**
     * Whether the 🧹 Orphaned backups slot is published. Off by default: the
     * estate's chains have to be gone through by hand before the list means
     * anything, and until then it is 245 rows nobody is acting on.
     */
    liveOrphans: boolean;
    /**
     * Topics that hold one always-current message instead of a stream of them.
     * These are state, not events: they are edited in place, never appended to.
     */
    liveTopics: Record<LiveSlot, string>;
    /**
     * How often the restore-point scan runs. It reads every restore point, so
     * it is far heavier than a monitor tick — and far less urgent, since the
     * age of a backup changes on the scale of hours.
     */
    protectionIntervalMs: number;
    /** Floor before a missing restore point is reported, in days. */
    protectionStaleDays: number;
    /** How many of its own intervals a job may miss before it is overdue. */
    protectionOverdueFactor: number;
    /** Consecutive failed runs that make a job worth reporting on their own. */
    protectionFailureStreak: number;
    /** Existing forum thread for the Performance live message. 0 auto-creates by name. */
    performanceTopicId: number;
    repositoriesTopicId: number;
    /** Rewrite an unchanged live message at least this often, as a heartbeat. */
    liveRefreshMs: number;
    /** IANA zone used to render times for humans. Empty means the server's own. */
    timezone: string;
  };
}

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const text = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === '' ? fallback : value.trim();

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const ROUTING_MODES: TelegramRoutingMode[] = ['job', 'severity', 'kind', 'single'];

/**
 * Defaults to `single`: a fixed set of topics, with failures in Alerts.
 *
 * `job` was the default until a per-job topic had been created for every job
 * that ever changed result, and the topic list stopped being readable. The
 * live status topics are unaffected by the mode — they are state, not events,
 * and never pass through the router.
 */
const routingMode = (value: string | undefined): TelegramRoutingMode => {
  const mode = (value ?? '').trim().toLowerCase() as TelegramRoutingMode;
  return ROUTING_MODES.includes(mode) ? mode : 'single';
};

const severities = (value: string | undefined): NotificationSeverity[] => {
  const requested = list(value?.toLowerCase()) as NotificationSeverity[];
  const valid = requested.filter((item) => NOTIFICATION_SEVERITIES.includes(item));
  return valid.length ? valid : [...NOTIFICATION_SEVERITIES];
};

export const configuration = (): AppConfig => ({
  port: int(process.env.PORT, 3000),
  docs: bool(process.env.API_DOCS, true),
  veeam: {
    // Trailing slashes would produce "//api/v1/..." paths, so strip them once here.
    baseUrl: (process.env.VEEAM_BASE_URL ?? 'https://localhost:9419').replace(/\/+$/, ''),
    apiVersion: process.env.VEEAM_API_VERSION ?? '1.2-rev1',
    insecureTls: bool(process.env.VEEAM_INSECURE_TLS, true),
    timeoutMs: int(process.env.VEEAM_TIMEOUT_MS, 30000),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    webhookUrl: (process.env.TELEGRAM_WEBHOOK_URL ?? '').replace(/\/+$/, ''),
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    adminKey: process.env.TELEGRAM_ADMIN_KEY ?? '',
    chatIds: list(process.env.TELEGRAM_CHAT_IDS),
    monitorIntervalMs: int(process.env.TELEGRAM_MONITOR_INTERVAL_MS, 60000),
    veeamUsername: process.env.VEEAM_MONITOR_USERNAME ?? '',
    veeamPassword: process.env.VEEAM_MONITOR_PASSWORD ?? '',
    stateFile: text(process.env.TELEGRAM_STATE_FILE, join(process.cwd(), 'data', 'telegram-state.json')),
    routesFile: text(process.env.TELEGRAM_ROUTES_FILE, ''),
    routingMode: routingMode(process.env.TELEGRAM_ROUTING_MODE),
    alertsTopic: text(process.env.TELEGRAM_TOPIC_ALERTS, '🚨 Alerts'),
    jobTopicPrefix: process.env.TELEGRAM_JOB_TOPIC_PREFIX ?? '',
    severityTopics: {
      critical: text(process.env.TELEGRAM_TOPIC_CRITICAL, '🔴 Errors'),
      warning: text(process.env.TELEGRAM_TOPIC_WARNING, '🟡 Warnings'),
      success: text(process.env.TELEGRAM_TOPIC_SUCCESS, '🟢 Recovered'),
      info: text(process.env.TELEGRAM_TOPIC_INFO, 'ℹ️ Events'),
    },
    kindTopics: {
      job: text(process.env.TELEGRAM_TOPIC_JOBS, '📦 Jobs'),
      infrastructure: text(process.env.TELEGRAM_TOPIC_INFRASTRUCTURE, '🖥 Infrastructure'),
      repository: text(process.env.TELEGRAM_TOPIC_REPOSITORY, '💾 Repositories'),
      security: text(process.env.TELEGRAM_TOPIC_SECURITY, '🛡 Security'),
      digest: text(process.env.TELEGRAM_TOPIC_DIGEST, '📊 Daily digest'),
      manual: text(process.env.TELEGRAM_TOPIC_MANUAL, '📣 Announcements'),
    },
    severities: severities(process.env.TELEGRAM_SEVERITIES),
    createTopics: bool(process.env.TELEGRAM_CREATE_TOPICS, true),
    sendIntervalMs: int(process.env.TELEGRAM_SEND_INTERVAL_MS, 1500),
    queueLimit: int(process.env.TELEGRAM_QUEUE_LIMIT, 200),
    jobAlertCooldownMs: int(process.env.TELEGRAM_JOB_COOLDOWN_MIN, 15) * 60_000,
    authAlertCooldownMs: int(process.env.TELEGRAM_AUTH_COOLDOWN_MIN, 60) * 60_000,
    repositoryAlertCooldownMs: int(process.env.TELEGRAM_REPOSITORY_COOLDOWN_MIN, 720) * 60_000,
    repositoryFreePercent: int(process.env.TELEGRAM_REPOSITORY_FREE_PERCENT, 10),
    digestHour: int(process.env.TELEGRAM_DIGEST_HOUR, -1),
    live: bool(process.env.TELEGRAM_LIVE, true),
    liveOrphans: bool(process.env.TELEGRAM_LIVE_ORPHANS, false),
    liveTopics: {
      health: text(process.env.TELEGRAM_TOPIC_HEALTH, '🩺 Monitor health'),
      running: text(process.env.TELEGRAM_TOPIC_RUNNING, '▶️ Running now'),
      schedule: text(process.env.TELEGRAM_TOPIC_SCHEDULE, '📅 Upcoming runs'),
      performance: text(process.env.TELEGRAM_TOPIC_PERFORMANCE, '📈 Performance'),
      repositories: text(process.env.TELEGRAM_TOPIC_REPOSITORIES_LIVE, '💾 Repositories'),
      protection: text(process.env.TELEGRAM_TOPIC_PROTECTION, '🛡 Protection'),
      restorePoints: text(process.env.TELEGRAM_TOPIC_RESTORE_POINTS, '🗂 Restore points'),
      orphans: text(process.env.TELEGRAM_TOPIC_ORPHANS, '🧹 Orphaned backups'),
    },
    performanceTopicId: int(process.env.TELEGRAM_PERFORMANCE_TOPIC_ID, 0),
    repositoriesTopicId: int(process.env.TELEGRAM_REPOSITORIES_TOPIC_ID, 0),
    protectionIntervalMs: int(process.env.TELEGRAM_PROTECTION_INTERVAL_MIN, 30) * 60_000,
    protectionStaleDays: int(process.env.TELEGRAM_PROTECTION_STALE_DAYS, 3),
    protectionOverdueFactor: Number(process.env.TELEGRAM_PROTECTION_OVERDUE_FACTOR) || 2.5,
    protectionFailureStreak: int(process.env.TELEGRAM_PROTECTION_FAILURE_STREAK, 3),
    liveRefreshMs: int(process.env.TELEGRAM_LIVE_REFRESH_MIN, 5) * 60_000,
    timezone: text(process.env.TELEGRAM_TIMEZONE, ''),
  },
});

import { join } from 'path';
import type { NotificationKind, NotificationSeverity } from '../telegram/telegram.types';

/** How an event is mapped onto a forum topic when no rule in the routes file matches. */
export type TelegramRoutingMode = 'job' | 'severity' | 'kind' | 'single';

export interface AppConfig {
  port: number;
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
     * Topics that hold one always-current message instead of a stream of them.
     * These are state, not events: they are edited in place, never appended to.
     */
    liveTopics: { health: string; running: string; schedule: string; performance: string };
    /** Existing forum thread for the Performance live message. 0 auto-creates by name. */
    performanceTopicId: number;
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
const SEVERITIES: NotificationSeverity[] = ['critical', 'warning', 'success', 'info'];

/**
 * Defaults to : a fixed set of topics, with alerts in General.
 *
 *  was the default until a per-job topic had been created for every job
 * that ever changed result, and the topic list stopped being readable. The
 * live status topics are unaffected by the mode — they are state, not events.
 */
/**
 * Defaults to `single`: a fixed set of topics, with alerts in General.
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
  const valid = requested.filter((item) => SEVERITIES.includes(item));
  return valid.length ? valid : SEVERITIES;
};

export const configuration = (): AppConfig => ({
  port: int(process.env.PORT, 3000),
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
    liveTopics: {
      health: text(process.env.TELEGRAM_TOPIC_HEALTH, '🩺 Monitor health'),
      running: text(process.env.TELEGRAM_TOPIC_RUNNING, '▶️ Running now'),
      schedule: text(process.env.TELEGRAM_TOPIC_SCHEDULE, '📅 Today'),
      performance: text(process.env.TELEGRAM_TOPIC_PERFORMANCE, '📈 Performance'),
    },
    performanceTopicId: int(process.env.TELEGRAM_PERFORMANCE_TOPIC_ID, 0),
    liveRefreshMs: int(process.env.TELEGRAM_LIVE_REFRESH_MIN, 5) * 60_000,
    timezone: text(process.env.TELEGRAM_TIMEZONE, ''),
  },
});

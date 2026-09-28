import { join } from 'path';
import type { LiveSlot } from '../live/slots';
import {
  NOTIFICATION_SEVERITIES,
  type NotificationKind,
  type NotificationSeverity,
} from '../telegram/types';
import { type Environment, httpUrl, readSettings } from './settings';

/**
 * How an event is mapped onto a forum topic when no rule in the routes file
 * matches. The list is the definition; the type and the check both read it.
 */
const ROUTING_MODES = ['single', 'job', 'severity', 'kind'] as const;

export type TelegramRoutingMode = (typeof ROUTING_MODES)[number];

export interface AppConfig {
  port: number;
  /**
   * Whether the OpenAPI page is served at /api/docs. Off by default: even
   * without values, an API catalogue is useful reconnaissance on a service
   * that may be exposed for Telegram webhooks. Operators can enable it when
   * they need the interactive API catalogue.
   */
  docs: boolean;
  veeam: {
    /**
     * Every Veeam server watched, in the order people see them listed. Never
     * empty. The first is the one shown until somebody selects another.
     */
    servers: VeeamEndpoint[];
    /** Shared by every server: they run one version, behind one account. */
    apiVersion: string;
    insecureTls: boolean;
    timeoutMs: number;
    /**
     * The dedicated service account the background monitor signs in with.
     * Both empty, or both set: startup refuses one without the other.
     */
    username: string;
    password: string;
  };
  telegram: {
    botToken: string;
    webhookUrl: string;
    webhookSecret: string;
    adminKey: string;
    chatIds: string[];
    monitorIntervalMs: number;
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

/** One Veeam server, as configured. */
export interface VeeamEndpoint {
  /**
   * Short, ASCII and unique: what a Button and the state file address the
   * server by. Derived from the name, so renaming a server forgets what was
   * remembered about it — the job results it is compared against, and so one
   * quiet cycle while it is learned again.
   */
  key: string;
  /** What people call it: in alerts, the server menu and the live slots. */
  name: string;
  baseUrl: string;
  /**
   * Whether the TLS handshake offers what an old server insists on — SHA-1
   * signatures among them — and modern OpenSSL no longer offers by default.
   * Such a server resets the connection instead of saying why. Off unless
   * VEEAM_LEGACY_TLS names the server; the fix that lasts is on the server.
   */
  legacyTls: boolean;
}

const MINUTE = 60_000;

const DEFAULT_VEEAM_URL = 'https://localhost:9419';

/**
 * A Button carries the key and a job's 36-character id in Telegram's 64 bytes
 * of callback data, with room to spare for the prefix.
 */
const KEY_LENGTH = 16;
/** Long enough for "veeam01main-baas", short enough for a row of buttons. */
const NAME_LENGTH = 32;

/** The server's name when none is given: the first label of its host name. */
const hostLabel = (baseUrl: string): string => new URL(baseUrl).hostname.split('.')[0] || baseUrl;

const keyOf = (name: string, index: number): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KEY_LENGTH)
    .replace(/-+$/, '') || `server${index + 1}`;

/** The one server of an installation configured by `VEEAM_BASE_URL`. */
const endpointAt = (baseUrl: string): VeeamEndpoint => {
  const name = hostLabel(baseUrl);
  return { key: keyOf(name, 0), name, baseUrl, legacyTls: false };
};

/** Whether `named` — a name or a key, in any case — is this server. */
const isNamed = (endpoint: VeeamEndpoint, named: string): boolean =>
  named.toLowerCase() === endpoint.name.toLowerCase() || named.toLowerCase() === endpoint.key;

/**
 * `VEEAM_SERVERS`: comma-separated entries, each `name=url` or a bare URL
 * named after its host. Every problem is reported through `refuse`, and the
 * entries that were fine are still returned, so reading carries on.
 */
const endpointsOf = (listed: string, refuse: (message: string) => void): VeeamEndpoint[] => {
  const endpoints: VeeamEndpoint[] = [];
  listed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const equals = entry.indexOf('=');
      // A URL may hold "=" itself, but never before its "://".
      const named = equals > 0 && !entry.slice(0, equals).includes('://');
      const baseUrl = httpUrl(named ? entry.slice(equals + 1).trim() : entry);
      // The entry is not repeated: a URL can carry credentials.
      if (baseUrl === undefined) return refuse(`VEEAM_SERVERS entry ${index + 1} must be a valid HTTP(S) URL`);
      const name = named ? entry.slice(0, equals).trim() : hostLabel(baseUrl);
      if (!name || name.length > NAME_LENGTH) {
        return refuse(`VEEAM_SERVERS entry ${index + 1} needs a name of 1 to ${NAME_LENGTH} characters`);
      }
      endpoints.push({ key: keyOf(name, index), name, baseUrl, legacyTls: false });
    });

  const seen = new Map<string, VeeamEndpoint>();
  for (const endpoint of endpoints) {
    const twin = seen.get(endpoint.key);
    if (twin) {
      refuse(`VEEAM_SERVERS names "${twin.name}" and "${endpoint.name}" are too alike to tell apart`);
    }
    seen.set(endpoint.key, endpoint);
  }
  if (new Set(endpoints.map((endpoint) => endpoint.baseUrl.toLowerCase())).size < endpoints.length) {
    refuse('VEEAM_SERVERS lists one URL twice');
  }
  return endpoints;
};

const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Every setting the service has, each declared once: the variable, what kind
 * of value it holds, its bounds and its default. The value a setting yields
 * and the error it raises come from that one line (see settings.ts), so
 * startup cannot accept what the service would read differently.
 *
 * Throws, naming every variable that is wrong, instead of returning a config
 * with a guess in it.
 */
export const readConfig = (env: Environment): AppConfig =>
  readSettings(env, (read) => {
    const username = read.text('VEEAM_MONITOR_USERNAME', '');
    // Verbatim: a password is the one value whose surrounding spaces may be meant.
    const password = read.verbatim('VEEAM_MONITOR_PASSWORD');
    read.require(
      Boolean(username) === Boolean(password),
      'VEEAM_MONITOR_USERNAME and VEEAM_MONITOR_PASSWORD must be set together',
    );

    // Two ways to name the servers: the list, or the one URL every
    // installation had before there was a list. Both at once would leave a
    // reader of the file guessing which one the service believed.
    const listed = read.text('VEEAM_SERVERS', '');
    const single = read.url('VEEAM_BASE_URL', '');
    read.require(
      !(listed && single),
      'VEEAM_SERVERS and VEEAM_BASE_URL both name the Veeam servers: set one of them',
    );
    const refuse = (message: string) => read.require(false, message);
    const listedServers = listed ? endpointsOf(listed, refuse) : [];
    const configured = listedServers.length ? listedServers : [endpointAt(single || DEFAULT_VEEAM_URL)];
    const legacyTls = read.list('VEEAM_LEGACY_TLS', /^[^=]+$/, 'server names');
    for (const named of legacyTls) {
      read.require(
        configured.some((endpoint) => isNamed(endpoint, named)),
        `VEEAM_LEGACY_TLS names "${named}", which is not one of the Veeam servers`,
      );
    }
    const servers = configured.map((endpoint) => ({
      ...endpoint,
      legacyTls: legacyTls.some((named) => isNamed(endpoint, named)),
    }));

    const webhookUrl = read.url('TELEGRAM_WEBHOOK_URL', '', { httpsOnly: true });
    const webhookSecret = read.text('TELEGRAM_WEBHOOK_SECRET', '');
    read.require(
      !webhookUrl || Boolean(webhookSecret),
      'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_WEBHOOK_URL is set',
    );

    return {
      port: read.integer('PORT', 3000, { min: 1, max: 65535 }),
      docs: read.flag('API_DOCS', false),
      veeam: {
        servers,
        apiVersion: read.text('VEEAM_API_VERSION', '1.2-rev1'),
        insecureTls: read.flag('VEEAM_INSECURE_TLS', false),
        timeoutMs: read.integer('VEEAM_TIMEOUT_MS', 30000, { min: 1 }),
        username,
        password,
      },
      telegram: {
        botToken: read.text('TELEGRAM_BOT_TOKEN', ''),
        webhookUrl,
        webhookSecret,
        adminKey: read.text('TELEGRAM_ADMIN_KEY', ''),
        chatIds: read.list('TELEGRAM_CHAT_IDS', /^-?\d+$/, 'numeric chat IDs'),
        monitorIntervalMs: read.integer('TELEGRAM_MONITOR_INTERVAL_MS', 60000, { min: 0 }),
        stateFile: read.text('TELEGRAM_STATE_FILE', join(process.cwd(), 'data', 'telegram-state.json')),
        routesFile: read.text('TELEGRAM_ROUTES_FILE', ''),
        // `single`: a fixed set of topics, with failures in Alerts. `job` was the
        // default until a per-job topic had been created for every job that ever
        // changed result, and the topic list stopped being readable. The live
        // status topics are unaffected by the mode — they are state, not events,
        // and never pass through the router.
        routingMode: read.oneOf('TELEGRAM_ROUTING_MODE', ROUTING_MODES, 'single'),
        alertsTopic: read.text('TELEGRAM_TOPIC_ALERTS', '🚨 Alerts'),
        // Verbatim: "Veeam / " ends in a space on purpose.
        jobTopicPrefix: read.verbatim('TELEGRAM_JOB_TOPIC_PREFIX'),
        severityTopics: {
          critical: read.text('TELEGRAM_TOPIC_CRITICAL', '🔴 Errors'),
          warning: read.text('TELEGRAM_TOPIC_WARNING', '🟡 Warnings'),
          success: read.text('TELEGRAM_TOPIC_SUCCESS', '🟢 Recovered'),
          info: read.text('TELEGRAM_TOPIC_INFO', 'ℹ️ Events'),
        },
        kindTopics: {
          job: read.text('TELEGRAM_TOPIC_JOBS', '📦 Jobs'),
          infrastructure: read.text('TELEGRAM_TOPIC_INFRASTRUCTURE', '🖥 Infrastructure'),
          repository: read.text('TELEGRAM_TOPIC_REPOSITORY', '💾 Repositories'),
          security: read.text('TELEGRAM_TOPIC_SECURITY', '🛡 Security'),
          digest: read.text('TELEGRAM_TOPIC_DIGEST', '📊 Daily digest'),
          manual: read.text('TELEGRAM_TOPIC_MANUAL', '📣 Announcements'),
        },
        severities: read.someOf('TELEGRAM_SEVERITIES', NOTIFICATION_SEVERITIES),
        createTopics: read.flag('TELEGRAM_CREATE_TOPICS', true),
        sendIntervalMs: read.integer('TELEGRAM_SEND_INTERVAL_MS', 1500, { min: 0 }),
        queueLimit: read.integer('TELEGRAM_QUEUE_LIMIT', 200, { min: 1 }),
        jobAlertCooldownMs: read.integer('TELEGRAM_JOB_COOLDOWN_MIN', 15, { min: 0 }) * MINUTE,
        authAlertCooldownMs: read.integer('TELEGRAM_AUTH_COOLDOWN_MIN', 60, { min: 0 }) * MINUTE,
        repositoryAlertCooldownMs: read.integer('TELEGRAM_REPOSITORY_COOLDOWN_MIN', 720, { min: 0 }) * MINUTE,
        repositoryFreePercent: read.integer('TELEGRAM_REPOSITORY_FREE_PERCENT', 10, { min: 0, max: 100 }),
        digestHour: read.integer('TELEGRAM_DIGEST_HOUR', -1, { min: -1, max: 23 }),
        live: read.flag('TELEGRAM_LIVE', true),
        liveOrphans: read.flag('TELEGRAM_LIVE_ORPHANS', false),
        liveTopics: {
          health: read.text('TELEGRAM_TOPIC_HEALTH', '🩺 Monitor health'),
          running: read.text('TELEGRAM_TOPIC_RUNNING', '▶️ Running now'),
          schedule: read.text('TELEGRAM_TOPIC_SCHEDULE', '📅 Upcoming runs'),
          performance: read.text('TELEGRAM_TOPIC_PERFORMANCE', '📈 Performance'),
          repositories: read.text('TELEGRAM_TOPIC_REPOSITORIES_LIVE', '💾 Repositories'),
          protection: read.text('TELEGRAM_TOPIC_PROTECTION', '🛡 Protection'),
          restorePoints: read.text('TELEGRAM_TOPIC_RESTORE_POINTS', '🗂 Restore points'),
          orphans: read.text('TELEGRAM_TOPIC_ORPHANS', '🧹 Orphaned backups'),
        },
        performanceTopicId: read.integer('TELEGRAM_PERFORMANCE_TOPIC_ID', 0, { min: 0 }),
        repositoriesTopicId: read.integer('TELEGRAM_REPOSITORIES_TOPIC_ID', 0, { min: 0 }),
        protectionIntervalMs: read.integer('TELEGRAM_PROTECTION_INTERVAL_MIN', 60, { min: 1 }) * MINUTE,
        protectionStaleDays: read.integer('TELEGRAM_PROTECTION_STALE_DAYS', 3, { min: 0 }),
        protectionOverdueFactor: read.positive('TELEGRAM_PROTECTION_OVERDUE_FACTOR', 2.5),
        protectionFailureStreak: read.integer('TELEGRAM_PROTECTION_FAILURE_STREAK', 3, { min: 1 }),
        liveRefreshMs: read.integer('TELEGRAM_LIVE_REFRESH_MIN', 5, { min: 1 }) * MINUTE,
        timezone: read.text('TELEGRAM_TIMEZONE', '', { valid: isTimeZone, must: 'be a valid IANA time zone' }),
      },
    };
  });

/** The `load` factory of ConfigModule: what the service runs on. */
export const configuration = (): AppConfig => readConfig(process.env);

/**
 * The `validate` hook of ConfigModule, run before anything is built, so a bad
 * setting stops startup rather than the monitor. It is the same reading as
 * `configuration`; the environment is handed back unchanged, because whatever
 * this returns is looked up by ConfigService before the loaded config is.
 */
export const validateEnvironment = (env: Environment): Environment => {
  readConfig(env);
  return env;
};

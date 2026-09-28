const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Every setting is declared once, in src/config/configuration.ts. Startup's
// check and the values the service runs on come out of that one declaration,
// so each test here asks both of them: the two used to be separate parsers of
// the same environment, and they disagreed.
//
// Explicit env objects only — nothing here reads process.env or anybody's .env.
const { readConfig, validateEnvironment } = require('../dist/config/configuration');

/** Startup accepts it, and this is what the service is then given. */
const accepted = (env) => {
  assert.doesNotThrow(() => validateEnvironment(env));
  return readConfig(env);
};

/** Startup refuses it, saying `because`, and the service cannot be given it either. */
const refused = (env, because) => {
  assert.throws(() => validateEnvironment(env), because);
  assert.throws(() => readConfig(env), because);
};

test('a routing mode written in capitals is accepted and read in lower case', () => {
  assert.equal(accepted({ TELEGRAM_ROUTING_MODE: 'Single' }).telegram.routingMode, 'single');
  assert.equal(accepted({ TELEGRAM_ROUTING_MODE: ' KIND ' }).telegram.routingMode, 'kind');
});

test('a severity list with a trailing comma, spaces or capitals is accepted as meant', () => {
  assert.deepEqual(accepted({ TELEGRAM_SEVERITIES: 'critical,' }).telegram.severities, ['critical']);
  assert.deepEqual(
    accepted({ TELEGRAM_SEVERITIES: ' Critical , WARNING,,' }).telegram.severities,
    ['critical', 'warning'],
  );
  // Nothing listed is not "deliver nothing": it is the default, everything.
  assert.deepEqual(
    accepted({ TELEGRAM_SEVERITIES: ' , ' }).telegram.severities,
    ['critical', 'warning', 'success', 'info'],
  );
});

test('an integer is digits and nothing else, for every integer setting', () => {
  // Startup used to check with Number() and the service to read with
  // parseInt(), so `1e3` passed as a thousand and was run as one, and `0x10`
  // passed as sixteen and was run as zero.
  for (const written of ['1e3', '12abc', '0x10', '1.0', '1 000']) {
    refused({ TELEGRAM_QUEUE_LIMIT: written }, /TELEGRAM_QUEUE_LIMIT/);
    refused({ PORT: written }, /PORT/);
  }
  assert.equal(accepted({ TELEGRAM_QUEUE_LIMIT: ' 1000 ' }).telegram.queueLimit, 1000);
  assert.equal(accepted({ TELEGRAM_DIGEST_HOUR: '-1' }).telegram.digestHour, -1);
});

test('a routing mode or severity nobody knows is refused, not quietly replaced', () => {
  // The parser used to fall back to `single` on anything it did not know, so
  // the only thing standing between a typo and the wrong topics was startup.
  refused({ TELEGRAM_ROUTING_MODE: 'per-job' }, /TELEGRAM_ROUTING_MODE must be single, job, severity or kind/);
  refused({ TELEGRAM_SEVERITIES: 'critical,fatal' }, /TELEGRAM_SEVERITIES.*"fatal"/);
});

test('invalid operator settings fail before the monitor starts', () => {
  refused({ PORT: '3000x' }, /PORT/);
  refused({ PORT: '0' }, /PORT/);
  refused({ PORT: '65536' }, /PORT/);
  refused({ VEEAM_TIMEOUT_MS: '0' }, /VEEAM_TIMEOUT_MS/);
  refused({ TELEGRAM_MONITOR_INTERVAL_MS: '-1' }, /TELEGRAM_MONITOR_INTERVAL_MS/);
  refused({ TELEGRAM_SEND_INTERVAL_MS: '-1' }, /TELEGRAM_SEND_INTERVAL_MS/);
  refused({ TELEGRAM_QUEUE_LIMIT: '0' }, /TELEGRAM_QUEUE_LIMIT/);
  refused({ TELEGRAM_JOB_COOLDOWN_MIN: '-1' }, /TELEGRAM_JOB_COOLDOWN_MIN/);
  refused({ TELEGRAM_AUTH_COOLDOWN_MIN: '-1' }, /TELEGRAM_AUTH_COOLDOWN_MIN/);
  refused({ TELEGRAM_REPOSITORY_COOLDOWN_MIN: '-1' }, /TELEGRAM_REPOSITORY_COOLDOWN_MIN/);
  refused({ TELEGRAM_REPOSITORY_FREE_PERCENT: '101' }, /TELEGRAM_REPOSITORY_FREE_PERCENT/);
  refused({ TELEGRAM_DIGEST_HOUR: '24' }, /TELEGRAM_DIGEST_HOUR/);
  refused({ TELEGRAM_DIGEST_HOUR: '-2' }, /TELEGRAM_DIGEST_HOUR/);
  refused({ TELEGRAM_PROTECTION_INTERVAL_MIN: '0' }, /TELEGRAM_PROTECTION_INTERVAL_MIN/);
  refused({ TELEGRAM_PROTECTION_STALE_DAYS: '-1' }, /TELEGRAM_PROTECTION_STALE_DAYS/);
  refused({ TELEGRAM_PROTECTION_FAILURE_STREAK: '0' }, /TELEGRAM_PROTECTION_FAILURE_STREAK/);
  refused({ TELEGRAM_LIVE_REFRESH_MIN: '0' }, /TELEGRAM_LIVE_REFRESH_MIN/);
  refused({ TELEGRAM_PERFORMANCE_TOPIC_ID: '-1' }, /TELEGRAM_PERFORMANCE_TOPIC_ID/);
  refused({ TELEGRAM_REPOSITORIES_TOPIC_ID: '-1' }, /TELEGRAM_REPOSITORIES_TOPIC_ID/);

  for (const key of ['API_DOCS', 'VEEAM_INSECURE_TLS', 'TELEGRAM_CREATE_TOPICS', 'TELEGRAM_LIVE', 'TELEGRAM_LIVE_ORPHANS']) {
    refused({ [key]: 'maybe' }, new RegExp(`${key} must be true or false`));
  }

  refused({ VEEAM_MONITOR_USERNAME: 'svc' }, /VEEAM_MONITOR_PASSWORD/);
  refused({ VEEAM_MONITOR_PASSWORD: 'p' }, /VEEAM_MONITOR_USERNAME/);
  refused({ VEEAM_MONITOR_USERNAME: 'svc', VEEAM_MONITOR_PASSWORD: '   ' }, /VEEAM_MONITOR_PASSWORD/);

  for (const factor of ['0', '-1', 'abc', 'Infinity']) {
    refused({ TELEGRAM_PROTECTION_OVERDUE_FACTOR: factor }, /TELEGRAM_PROTECTION_OVERDUE_FACTOR/);
  }

  refused({ VEEAM_BASE_URL: 'not-a-url' }, /VEEAM_BASE_URL/);
  refused({ VEEAM_BASE_URL: 'ftp://veeam:9419' }, /VEEAM_BASE_URL/);
  refused({ TELEGRAM_WEBHOOK_URL: 'http://example.com', TELEGRAM_WEBHOOK_SECRET: 's' }, /TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL/);
  refused({ TELEGRAM_WEBHOOK_URL: 'https://example.com' }, /TELEGRAM_WEBHOOK_SECRET/);
  refused({ TELEGRAM_CHAT_IDS: '-100123,general' }, /TELEGRAM_CHAT_IDS/);
  refused({ TELEGRAM_TIMEZONE: 'No/Such_Zone' }, /TELEGRAM_TIMEZONE/);

  accepted({
    PORT: '3000',
    TELEGRAM_MONITOR_INTERVAL_MS: '0',
    TELEGRAM_DIGEST_HOUR: '-1',
    TELEGRAM_WEBHOOK_URL: 'https://example.com',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    TELEGRAM_TIMEZONE: 'Asia/Qyzylorda',
  });
});

test('every wrong setting is named at once, not one per restart', () => {
  let message = '';
  try {
    validateEnvironment({ PORT: 'x', TELEGRAM_LIVE: 'maybe', TELEGRAM_ROUTING_MODE: 'per-job' });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /PORT/);
  assert.match(message, /TELEGRAM_LIVE/);
  assert.match(message, /TELEGRAM_ROUTING_MODE/);
});

test('harmless variants are read as meant', () => {
  const config = accepted({
    API_DOCS: 'Off',
    TELEGRAM_LIVE_ORPHANS: ' YES ',
    TELEGRAM_CHAT_IDS: '-100123, -100456,',
    VEEAM_BASE_URL: ' https://veeam.example:9419/ ',
    TELEGRAM_PROTECTION_OVERDUE_FACTOR: '1.5',
  });
  assert.equal(config.docs, false);
  assert.equal(config.telegram.liveOrphans, true);
  assert.deepEqual(config.telegram.chatIds, ['-100123', '-100456']);
  assert.deepEqual(config.veeam.servers, [
    { key: 'veeam', name: 'veeam', baseUrl: 'https://veeam.example:9419', legacyTls: false },
  ]);
  assert.equal(config.telegram.protectionOverdueFactor, 1.5);
});

test('a variable left empty means its default, whatever its kind', () => {
  // An .env line with nothing after "=" arrives as "", and used to be read as
  // an empty base URL or API version by some settings and as unset by others.
  const config = accepted({
    VEEAM_BASE_URL: '',
    VEEAM_API_VERSION: ' ',
    TELEGRAM_QUEUE_LIMIT: '',
    TELEGRAM_LIVE: '',
    TELEGRAM_ROUTING_MODE: '',
    TELEGRAM_PROTECTION_OVERDUE_FACTOR: '',
  });
  assert.equal(config.veeam.servers[0].baseUrl, 'https://localhost:9419');
  assert.equal(config.veeam.apiVersion, '1.2-rev1');
  assert.equal(config.telegram.queueLimit, 200);
  assert.equal(config.telegram.live, true);
  assert.equal(config.telegram.routingMode, 'single');
  assert.equal(config.telegram.protectionOverdueFactor, 2.5);
});

test('several Veeam servers are listed once, each named or named after its host', () => {
  const config = accepted({
    VEEAM_SERVERS: ' https://veeam01main.example.com:9419/ , BAAS = https://veeam02baas.example.com:9419 ,',
  });
  assert.deepEqual(config.veeam.servers, [
    { key: 'veeam01main', name: 'veeam01main', baseUrl: 'https://veeam01main.example.com:9419', legacyTls: false },
    { key: 'baas', name: 'BAAS', baseUrl: 'https://veeam02baas.example.com:9419', legacyTls: false },
  ]);

  // A key is what a Button carries beside a job id in 64 bytes, so it is ASCII
  // and short whatever the name is; a name with nothing ASCII in it gets one by
  // its place in the list.
  const named = accepted({ VEEAM_SERVERS: 'Астана=https://a.example:9419,Very long name of a server=https://b.example:9419' });
  assert.deepEqual(named.veeam.servers.map((server) => server.key), ['server1', 'very-long-name-o']);
});

test('old TLS is offered only to the servers named for it', () => {
  const config = accepted({
    VEEAM_SERVERS: 'https://veeam01main.example.com:9419,BAAS=https://veeam02baas.example.com:9419',
    VEEAM_LEGACY_TLS: 'baas',
  });
  assert.deepEqual(config.veeam.servers.map((server) => [server.name, server.legacyTls]), [
    ['veeam01main', false],
    ['BAAS', true],
  ]);
  // A name that matches nothing would be a server left refusing the handshake,
  // with nothing to say the setting did not apply.
  refused({ VEEAM_SERVERS: 'https://a.example:9419', VEEAM_LEGACY_TLS: 'b' }, /VEEAM_LEGACY_TLS names "b"/);
});

test('the server list refuses what it could not tell apart or reach', () => {
  refused(
    { VEEAM_SERVERS: 'https://a.example:9419', VEEAM_BASE_URL: 'https://b.example:9419' },
    /VEEAM_SERVERS and VEEAM_BASE_URL/,
  );
  refused({ VEEAM_SERVERS: 'one=not-a-url' }, /VEEAM_SERVERS entry 1 must be a valid HTTP/);
  refused({ VEEAM_SERVERS: 'VBR 1=https://a.example:9419,vbr-1=https://b.example:9419' }, /too alike/);
  refused({ VEEAM_SERVERS: 'https://a.example:9419,other=https://a.example:9419' }, /one URL twice/);
  refused({ VEEAM_SERVERS: `${'x'.repeat(33)}=https://a.example:9419` }, /entry 1 needs a name/);
});

test('the monitor account is Veeam settings, not Telegram ones', () => {
  const config = accepted({ VEEAM_MONITOR_USERNAME: ' svc@example.com ', VEEAM_MONITOR_PASSWORD: ' p a ss ' });
  assert.equal(config.veeam.username, 'svc@example.com');
  // Kept exactly as written: the one value whose surrounding spaces may be meant.
  assert.equal(config.veeam.password, ' p a ss ');
  // Every Telegram service is handed the telegram block; none of them needs this.
  assert.equal(JSON.stringify(config.telegram).includes('p a ss'), false);
});

test('with nothing set, every setting has the default it has always had', () => {
  assert.deepEqual(accepted({}), {
    port: 3000,
    docs: false,
    veeam: {
      servers: [{ key: 'localhost', name: 'localhost', baseUrl: 'https://localhost:9419', legacyTls: false }],
      apiVersion: '1.2-rev1',
      insecureTls: false,
      timeoutMs: 30000,
      username: '',
      password: '',
    },
    telegram: {
      botToken: '',
      webhookUrl: '',
      webhookSecret: '',
      adminKey: '',
      chatIds: [],
      monitorIntervalMs: 60000,
      stateFile: path.join(process.cwd(), 'data', 'telegram-state.json'),
      routesFile: '',
      routingMode: 'single',
      alertsTopic: '🚨 Alerts',
      jobTopicPrefix: '',
      severityTopics: { critical: '🔴 Errors', warning: '🟡 Warnings', success: '🟢 Recovered', info: 'ℹ️ Events' },
      kindTopics: {
        job: '📦 Jobs',
        infrastructure: '🖥 Infrastructure',
        repository: '💾 Repositories',
        security: '🛡 Security',
        digest: '📊 Daily digest',
        manual: '📣 Announcements',
      },
      severities: ['critical', 'warning', 'success', 'info'],
      createTopics: true,
      sendIntervalMs: 1500,
      queueLimit: 200,
      jobAlertCooldownMs: 15 * 60_000,
      authAlertCooldownMs: 60 * 60_000,
      repositoryAlertCooldownMs: 720 * 60_000,
      repositoryFreePercent: 10,
      digestHour: -1,
      live: true,
      liveOrphans: false,
      liveTopics: {
        health: '🩺 Monitor health',
        running: '▶️ Running now',
        schedule: '📅 Upcoming runs',
        performance: '📈 Performance',
        repositories: '💾 Repositories',
        protection: '🛡 Protection',
        restorePoints: '🗂 Restore points',
        orphans: '🧹 Orphaned backups',
      },
      performanceTopicId: 0,
      repositoriesTopicId: 0,
      protectionIntervalMs: 60 * 60_000,
      protectionStaleDays: 3,
      protectionOverdueFactor: 2.5,
      protectionFailureStreak: 3,
      liveRefreshMs: 5 * 60_000,
      timezone: '',
    },
  });
});

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
require('reflect-metadata');

const { configuration, readConfig } = require('../dist/config/configuration');
const { TelegramStateStore } = require('../dist/telegram/state.store');
const { TelegramTransportService } = require('../dist/telegram/transport.service');
const { TelegramTopicsService } = require('../dist/telegram/topics.service');
const { TelegramRoutingService } = require('../dist/telegram/routing.service');
const { TelegramService } = require('../dist/telegram/telegram.service');
const { TelegramUpdatesService } = require('../dist/updates/updates.service');
const { TelegramCommandsService } = require('../dist/updates/commands.service');
const { TelegramChatAccess } = require('../dist/updates/chat-access');
const { announcement, probe } = require('../dist/updates/manual-event');
const {
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
} = require('../dist/telegram/types');
const { MonitorService } = require('../dist/monitor/monitor.service');
const { JobQueryService } = require('../dist/estate/job-query.service');
const { LiveSnapshotsService } = require('../dist/live/snapshots.service');
const { TelegramLiveService } = require('../dist/live/live.service');
const { BackupEvidenceService } = require('../dist/estate/backup-evidence.service');
const { VeeamHttpService } = require('../dist/veeam/http.service');
const { VeeamInventoryService } = require('../dist/veeam/inventory.service');
const { VeeamEstateReader } = require('../dist/veeam/estate-reader.service');
const { workingOf } = require('../dist/veeam/estate');
const { capacities, capacityOf } = require('../dist/estate/repository-capacity');

const CHAT = '-1001234567890';
/** The key of the one server a world has: named after its host, https://localhost:9419. */
const SERVER = 'localhost';

/**
 * The service's real config, read from `settings` alone and never from
 * process.env, so nobody's shell leaks into a test. A setting that is
 * undefined is left out.
 *
 * UPPER_CASE keys are environment variables and go through the same checks as
 * at startup. camelCase keys are not: they set a field of the telegram block
 * after reading, for the few tests that need a value no operator is allowed to
 * configure — a heartbeat or a scan on every call, say.
 */
function appConfig(settings = {}) {
  const env = {};
  const fields = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    if (/^[A-Z0-9_]+$/.test(key)) env[key] = String(value);
    else fields[key] = value;
  }
  const config = readConfig(env);
  Object.assign(config.telegram, fields);
  return config;
}

const telegramConfig = (settings) => appConfig(settings).telegram;

/** ConfigService as the services use it: one block per key, and an unknown key throws. */
function configService(config) {
  return {
    getOrThrow: (key) => {
      if (!(key in config)) throw new TypeError(`Configuration key "${key}" does not exist`);
      return config[key];
    },
  };
}

/** Records every Bot API call and answers with plausible Telegram payloads. */
function fakeBotApi(handlers = {}) {
  const calls = [];
  let thread = 100;
  let message = 1000;
  const fn = async (method, payload) => {
    calls.push({ method, payload });
    const handler = handlers[method];
    if (handler) {
      const answer = await handler(payload, calls);
      if (answer !== undefined) return answer;
    }
    if (method === 'createForumTopic') {
      return { ok: true, result: { message_thread_id: (thread += 1), name: payload.name } };
    }
    if (method === 'sendMessage') return { ok: true, result: { message_id: (message += 1) } };
    return { ok: true, result: true };
  };
  return {
    fn,
    calls,
    of: (method) => calls.filter((call) => call.method === method).map((call) => call.payload),
    sent: () => calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload),
    reset: () => calls.splice(0, calls.length),
  };
}

function world(env = {}, handlers = {}, stateFile) {
  const file =
    stateFile ?? path.join(os.tmpdir(), `veeam-telegram-${Math.random().toString(36).slice(2)}.json`);
  const app = appConfig({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_IDS: CHAT,
    TELEGRAM_STATE_FILE: file,
    TELEGRAM_SEND_INTERVAL_MS: '0',
    TELEGRAM_REPOSITORY_FREE_PERCENT: '0',
    TELEGRAM_ROUTES_FILE: undefined,
    // Most tests below exercise per-job topics, so they ask for that mode; the
    // shipped default is 'single' and has its own test.
    TELEGRAM_ROUTING_MODE: 'job',
    TELEGRAM_DIGEST_HOUR: undefined,
    // The live status messages have their own tests; leaving them on would add
    // two sends to every cycle and drown the assertions below.
    TELEGRAM_LIVE: 'false',
    ...env,
  });
  const telegram = app.telegram;
  const config = configService(app);
  const store = new TelegramStateStore(file, telegram.chatIds, app.veeam.servers[0].key);
  const api = fakeBotApi(handlers);
  const transport = new TelegramTransportService(config, api.fn);
  const topics = new TelegramTopicsService(config, transport, store);
  const routing = new TelegramRoutingService(config);
  const service = new TelegramService(config, transport, topics, routing, store);
  // The second adapter of the Monitor seam (src/monitor/monitor.ts), for tests
  // with no Veeam: it says it ran and reports nothing. monitorWorld swaps in
  // the real one below.
  const { commands, updates } = ear({ config, transport, topics, store }, idleMonitor());
  const live = new TelegramLiveService(config, transport, topics, store);
  // Configured chats only learn they are forums from getChat or an update.
  store.mergeChat({ id: Number(CHAT), type: 'supergroup', is_forum: true });
  return {
    file, app, config, store, api, transport, topics, routing, service, commands, updates, live, telegram,
  };
}

/**
 * Intake and the commands it hands Updates to, asking `monitor`. Tests reach
 * both through `updates.handleUpdate`, as Telegram does; `commands` is there
 * for a test of interpretation with no intake at all.
 */
function ear(w, monitor) {
  const commands = new TelegramCommandsService(w.config, w.transport, w.topics, w.store, monitor);
  const access = new TelegramChatAccess(w.config, w.transport);
  const updates = new TelegramUpdatesService(w.config, w.transport, w.topics, w.store, commands, access);
  return { commands, updates };
}

/** A Monitor with nothing behind it. Kept in step with MonitorService by a test. */
function idleMonitor() {
  return {
    servers: () => [{
      key: SERVER, name: SERVER, selected: true, reachable: null, authenticated: null, lastError: null,
    }],
    select: (key) => (key === SERVER ? 'already' : 'unknown'),
    check: async () => 'ran',
    summary: async () => ({ text: 'сводка' }),
    describeJob: async (query) => ({ text: `карточка ${query}` }),
    describeJobById: async (id, server) => ({ text: `карточка ${id}`, jobId: id, server }),
    status: {
      lastCheckAt: null, reachable: null, authenticated: null, lastError: null,
      trackedJobs: 0, delivered: 0, undelivered: 0, lastOutcome: null,
    },
  };
}

function veeamFake(routes, baseUrl = 'https://veeam.test:9419') {
  return {
    baseUrl,
    request: async (req) => {
      const handler = routes[req.path];
      assert.ok(handler, `unexpected Veeam path ${req.path}`);
      return typeof handler === 'function' ? handler(req) : handler;
    },
    // Borrowed rather than re-written: the reachability probe is exactly the
    // knowledge that used to exist in two copies, and a third one living in the
    // test fake would be no better than the two we removed. It only needs
    // `request`, which this fake provides.
    reachability: VeeamHttpService.prototype.reachability,
  };
}

/**
 * The monitor account as every service but the auth service's own tests sees
 * it: configured, signed in as `tok`, and willing to fetch another token when
 * Veeam refuses one. It was written out by hand eleven times.
 */
function monitorAccount(over = {}) {
  return {
    configured: true,
    username: 'svc@example.com',
    getAccessToken: async () => 'tok',
    invalidateAccessToken: () => {},
    rejectToken: () => true,
    ...over,
  };
}

/** The Evidence of a world, reading `veeam` as `auth`. */
function evidenceOf(w, veeam, auth = monitorAccount()) {
  return new BackupEvidenceService(w.config, new VeeamEstateReader(veeam, auth));
}

/**
 * A monitor wired to a world. The argument list was written out at twelve call
 * sites and every new dependency had to be added to all of them; the twelfth
 * time it was added, eleven tests stopped compiling at once.
 */
function monitorOf(w, veeam, auth = monitorAccount(), evidence) {
  return monitorOfServers(w, [serverOf(w, veeam, auth, evidence)]);
}

/**
 * One server of a world, as `ServerEstates` wires one: `veeam` is its
 * transport and `auth` its token. Its key and name are the world's first
 * configured server's unless `endpoint` says otherwise.
 */
function serverOf(w, veeam, auth = monitorAccount(), evidence, endpoint = w.app.veeam.servers[0]) {
  const reader = new VeeamEstateReader(veeam, auth);
  const scan = evidence ?? new BackupEvidenceService(w.config, reader);
  const inventory = new VeeamInventoryService(reader);
  return {
    key: endpoint.key, name: endpoint.name, baseUrl: veeam.baseUrl,
    http: veeam, auth, reader, inventory, evidence: scan,
    jobs: new JobQueryService(w.config, reader, auth, scan, inventory),
  };
}

/** A monitor watching several servers, the first of them selected until one is chosen. */
function monitorOfServers(w, servers) {
  return new MonitorService(
    w.config, { all: servers }, w.service, w.store, w.live, new LiveSnapshotsService(w.config),
  );
}

function monitorWorld(env, jobStates, extraRoutes = {}, handlers = {}) {
  const w = world(env, handlers);
  let states = jobStates;
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: '2026-09-14T11:00:00+05:00' },
    '/api/v1/jobs/states': () => ({ data: states }),
    '/api/v1/sessions': { data: [{ result: { message: 'Agent failed to process method' } }] },
    '/api/v1/jobs': { data: [] },
    '/api/v1/backups': { data: [] },
    '/api/v1/restorePoints': { data: [] },
    ...extraRoutes,
  });
  const auth = monitorAccount();
  const evidence = evidenceOf(w, veeam, auth);
  const monitor = monitorOf(w, veeam, auth, evidence);
  // The real monitor, so /check in these tests drives a real cycle.
  const { commands, updates } = ear(w, monitor);
  return { ...w, commands, updates, monitor, auth, veeam, evidence, setJobs: (next) => (states = next) };
}

const job = (id, name, lastResult) => ({ id, name, lastResult, type: 'Backup', status: 'Stopped' });

/**
 * OPS_Exchange, exactly as Veeam reports it.
 *
 * The run that opened on 21 August failed, was retried, and the retry that
 * started on 23 August succeeded — writing the point at 01:31 while carrying
 * the *first* attempt's session id. The run on 14 September errored out after
 * 6.8 GB of 22.4 and left a point behind anyway.
 */
const exchange = (env = {}) =>
  monitorWorld({ TELEGRAM_LIVE: 'true', ...env }, [job('1', 'OPS_Exchange', 'Failed')], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': { data: [{ id: 'b1', jobId: '1', name: 'OPS_Exchange' }] },
    '/api/v1/restorePoints': {
      data: [
        { id: 'p2', backupId: 'b1', sessionId: 'sep14', name: 'MTA', creationTime: '2026-09-14T00:19:03+05:00' },
        { id: 'p1', backupId: 'b1', sessionId: 'aug21', name: 'MTA', creationTime: '2026-08-23T01:31:12+05:00' },
      ],
    },
    '/api/v1/sessions': {
      data: [
        { id: 'sep14', jobId: '1', sessionType: 'BackupJob', creationTime: '2026-09-14T00:15:24+05:00',
          endTime: '2026-09-14T00:47:54+05:00', result: { result: 'Failed' } },
        { id: 'aug23', jobId: '1', sessionType: 'BackupJob', creationTime: '2026-08-23T01:22:00+05:00',
          endTime: '2026-08-26T17:26:50+05:00', result: { result: 'Success' } },
        { id: 'aug21', jobId: '1', sessionType: 'BackupJob', creationTime: '2026-08-21T23:04:03+05:00',
          endTime: '2026-08-23T01:20:41+05:00', result: { result: 'Failed' } },
      ],
    },
    // The one machine of the job is the one that failed that night.
    '/api/v1/sessions/sep14/taskSessions': { data: [{ name: 'MTA', result: { result: 'Failed' } }] },
  });

/**
 * A throwaway self-signed certificate of the kind Veeam ships with: the name on
 * it is not the host's. Made by openssl at test time, so no private key is ever
 * committed; undefined where openssl is not installed.
 */
function selfSigned(name = 'Veeam Backup Server Certificate') {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam-tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', `/CN=${name}`,
    ], { stdio: 'ignore' });
  } catch {
    return undefined;
  }
  return { certFile, key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
}

module.exports = {
  selfSigned,
  CHAT, SERVER, appConfig, telegramConfig, configService, fakeBotApi, world, ear, veeamFake, idleMonitor, monitorWorld, job, exchange,
  monitorAccount, evidenceOf, workingOf, VeeamEstateReader,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramCommandsService, TelegramChatAccess,
  TelegramLiveService, MonitorService, BackupEvidenceService, VeeamHttpService, VeeamInventoryService, LiveSnapshotsService, monitorOf, monitorOfServers, serverOf,
  announcement, probe, capacities, capacityOf,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
};

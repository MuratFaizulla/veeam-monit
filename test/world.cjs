const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
require('reflect-metadata');

const { configuration } = require('../dist/config/configuration');
const { TelegramStateStore } = require('../dist/telegram/state.store');
const { TelegramTransportService } = require('../dist/telegram/transport.service');
const { TelegramTopicsService } = require('../dist/telegram/topics.service');
const { TelegramRoutingService } = require('../dist/telegram/routing.service');
const { TelegramService } = require('../dist/telegram/telegram.service');
const { TelegramUpdatesService } = require('../dist/telegram/updates.service');
const { announcement, probe } = require('../dist/telegram/manual-event');
const {
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
} = require('../dist/telegram/types');
const { MonitorService } = require('../dist/monitor/monitor.service');
const { TelegramLiveService } = require('../dist/live/live.service');
const { BackupEvidenceService } = require('../dist/monitor/backup-evidence.service');
const { VeeamHttpService } = require('../dist/veeam/http.service');
const { capacities, capacityOf } = require('../dist/monitor/repository-capacity');

const CHAT = '-1001234567890';

/** Builds a real telegram config block from env overrides, then restores env. */
function telegramConfig(overrides) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return configuration().telegram;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  const telegram = telegramConfig({
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
  const config = { getOrThrow: () => telegram };
  const store = new TelegramStateStore(file, telegram.chatIds);
  const api = fakeBotApi(handlers);
  const transport = new TelegramTransportService(config, api.fn);
  const topics = new TelegramTopicsService(config, transport, store);
  const routing = new TelegramRoutingService(config);
  const service = new TelegramService(config, transport, topics, routing, store);
  const updates = new TelegramUpdatesService(config, transport, topics, store);
  const live = new TelegramLiveService(config, transport, topics, store);
  // Configured chats only learn they are forums from getChat or an update.
  store.mergeChat({ id: Number(CHAT), type: 'supergroup', is_forum: true });
  return { file, config, store, api, transport, topics, routing, service, updates, live, telegram };
}

function veeamFake(routes) {
  return {
    baseUrl: 'https://veeam.test:9419',
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
  const auth = {
    configured: true,
    username: 'svc@example.com',
    getAccessToken: async () => 'tok',
    invalidateAccessToken: () => {},
  };
  const evidence = new BackupEvidenceService(w.config, veeam, auth);
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live, evidence,
  );
  return { ...w, monitor, auth, veeam, evidence, setJobs: (next) => (states = next) };
}

const job = (id, name, lastResult) => ({ id, name, lastResult, type: 'Backup', status: 'Stopped' });

/**
 * TTC_Exchange, exactly as Veeam reports it.
 *
 * The run that opened on 21 August failed, was retried, and the retry that
 * started on 23 August succeeded — writing the point at 01:31 while carrying
 * the *first* attempt's session id. The run on 14 September errored out after
 * 6.8 GB of 22.4 and left a point behind anyway.
 */
const exchange = (env = {}) =>
  monitorWorld({ TELEGRAM_LIVE: 'true', ...env }, [job('1', 'TTC_Exchange', 'Failed')], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': { data: [{ id: 'b1', jobId: '1', name: 'TTC_Exchange' }] },
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
  });

module.exports = {
  CHAT, telegramConfig, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService,
  announcement, probe, capacities, capacityOf,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
};

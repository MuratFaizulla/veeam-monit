const { test } = require('node:test');
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

/* ------------------------------------------------------------------ *
 * Events a human asks for
 * ------------------------------------------------------------------ */

test('an announcement with no text is refused, with the reason', () => {
  assert.deepEqual(announcement('   '), { ok: false, message: 'text is required' });
  assert.deepEqual(announcement(undefined), { ok: false, message: 'text is required' });
  assert.deepEqual(announcement('  Плановые работы  '), {
    ok: true,
    event: { kind: 'manual', severity: 'info', title: 'Плановые работы' },
  });
});

test('a probe for an unknown kind names the kinds that exist', () => {
  const refused = probe({ kind: 'backup' });
  assert.equal(refused.ok, false);
  // The list has to come from the same place the type does, or the message
  // starts describing an older set of kinds than the router accepts.
  assert.equal(refused.message, `kind must be one of ${NOTIFICATION_KINDS.join(', ')}`);
  assert.equal(probe({ severity: 'fatal' }).message, `severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}`);
});

test('a probe with nothing filled in is still a routable job event', () => {
  const built = probe({});
  assert.equal(built.ok, true);
  assert.equal(built.event.kind, 'job');
  assert.equal(built.event.severity, 'info');
  assert.ok(built.event.title.length > 0);
});

test('a probe goes through the real routing path, topic creation included', async () => {
  const w = world();
  const built = probe({ kind: 'job', severity: 'critical', subject: 'SQL Daily' });

  const report = await w.service.notify(built.event);

  assert.equal(report.outcome, 'delivered');
  assert.deepEqual(w.api.of('createForumTopic').map((p) => p.name), ['SQL Daily']);
});

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

test('a forum chat receives every job in its own topic instead of General', async () => {
  const w = world();

  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'SQL Daily: ОШИБКА' });
  await w.service.notify({ kind: 'job', severity: 'warning', subject: 'VM Weekly', title: 'VM Weekly: предупреждение' });

  assert.deepEqual(w.api.of('createForumTopic').map((p) => p.name), ['SQL Daily', 'VM Weekly']);
  const sent = w.api.sent();
  assert.equal(sent.length, 2);
  // The bug this fixes: without message_thread_id everything lands in General.
  assert.ok(sent.every((payload) => typeof payload.message_thread_id === 'number'));
  assert.notEqual(sent[0].message_thread_id, sent[1].message_thread_id);
  assert.equal(sent[0].parse_mode, 'HTML');
});

test('a topic is created once and reused for later events of the same job', async () => {
  const w = world();
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'first' });
  await w.service.notify({ kind: 'job', severity: 'success', subject: 'SQL Daily', title: 'second' });

  assert.equal(w.api.of('createForumTopic').length, 1);
  const sent = w.api.sent();
  assert.equal(sent[0].message_thread_id, sent[1].message_thread_id);
});

test('infrastructure and repository events use their own topics, not a job topic', async () => {
  const w = world();
  await w.service.notify({ kind: 'infrastructure', severity: 'critical', title: 'сервер недоступен' });
  await w.service.notify({ kind: 'repository', severity: 'warning', subject: 'Repo01', title: 'мало места' });

  assert.deepEqual(
    w.api.of('createForumTopic').map((p) => p.name),
    [w.telegram.kindTopics.infrastructure, w.telegram.kindTopics.repository],
  );
});

test('severity mode groups every kind into one topic per severity', async () => {
  const w = world({ TELEGRAM_ROUTING_MODE: 'severity' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'B', title: 'b' });
  await w.service.notify({ kind: 'infrastructure', severity: 'warning', title: 'c' });

  assert.deepEqual(
    w.api.of('createForumTopic').map((p) => p.name),
    [w.telegram.severityTopics.critical, w.telegram.severityTopics.warning],
  );
  const sent = w.api.sent();
  assert.equal(sent[0].message_thread_id, sent[1].message_thread_id);
  assert.notEqual(sent[1].message_thread_id, sent[2].message_thread_id);
});

test('single mode sends failures to Alerts and keeps non-alerts in General', async () => {
  const w = world({ TELEGRAM_ROUTING_MODE: 'single' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  await w.service.notify({ kind: 'job', severity: 'success', subject: 'A', title: 'recovered' });

  assert.deepEqual(w.api.of('createForumTopic').map((topic) => topic.name), ['🚨 Alerts']);
  assert.equal(w.api.sent()[0].message_thread_id, 101);
  assert.equal(w.api.sent()[1].message_thread_id, undefined);
});

test('a non-forum chat never gets a thread id', async () => {
  const w = world();
  w.store.mergeChat({ id: Number(CHAT), type: 'group', is_forum: false });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });

  assert.equal(w.api.of('createForumTopic').length, 0);
  assert.equal(w.api.sent()[0].message_thread_id, undefined);
});

test('routes file overrides the strategy and can drop events', async () => {
  const routes = path.join(os.tmpdir(), `routes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(
    routes,
    JSON.stringify({
      // First match wins, so the mute rule has to come before the DBA rule.
      routes: [
        { match: { severity: 'success' }, drop: true },
        { match: { kind: 'job', subject: '^sql-' }, topic: 'DBA' },
      ],
    }),
  );
  const w = world({ TELEGRAM_ROUTES_FILE: routes });

  const dba = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL-01', title: 'a' });
  const dropped = await w.service.notify({ kind: 'job', severity: 'success', subject: 'SQL-01', title: 'b' });
  const other = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'FS-01', title: 'c' });

  assert.equal(dba.topic, 'DBA');
  assert.equal(dropped.skipped, true);
  assert.equal(other.topic, 'FS-01');
  assert.deepEqual(w.api.of('createForumTopic').map((p) => p.name), ['DBA', 'FS-01']);
  fs.rmSync(routes, { force: true });
});

test('an unreadable routes file falls back to the strategy instead of failing', async () => {
  const w = world({ TELEGRAM_ROUTES_FILE: path.join(os.tmpdir(), 'does-not-exist.json') });
  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  assert.equal(report.sent, 1);
  assert.equal(report.topic, 'A');
});

test('severity filter suppresses the kinds an installation does not want', async () => {
  const w = world({ TELEGRAM_SEVERITIES: 'critical,warning' });
  const report = await w.service.notify({ kind: 'job', severity: 'success', subject: 'A', title: 'a' });
  assert.equal(report.skipped, true);
  assert.equal(w.api.sent().length, 0);
});

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

test('a deleted topic is forgotten, re-created and the message still arrives', async () => {
  let deleted = true;
  const w = world({}, {
    sendMessage: (payload) => {
      if (deleted && payload.message_thread_id === 55) {
        return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };
      }
      return undefined;
    },
  });
  w.store.rememberTopic(CHAT, 'SQL Daily', 55);

  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'a' });

  assert.equal(report.sent, 1);
  assert.equal(w.api.of('createForumTopic').length, 1);
  assert.equal(w.store.threadId(CHAT, 'SQL Daily'), 101, 'the stale thread id was replaced');
  deleted = false;
});

test('a 429 is retried after exactly the delay Telegram asked for', async () => {
  let limited = true;
  const w = world({}, {
    sendMessage: () => {
      if (!limited) return undefined;
      limited = false;
      return { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } };
    },
  });

  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  assert.equal(report.sent, 1);
  assert.equal(w.api.sent().length, 2);
});

test('a chat the bot was removed from is unregistered instead of retried forever', async () => {
  const w = world({}, {
    sendMessage: () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked' }),
  });

  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  assert.equal(report.failed, 1);
  assert.deepEqual(w.store.chats(), []);
});

test('job names are HTML-escaped so Telegram cannot reject or mis-render them', async () => {
  const w = world();
  await w.service.notify({
    kind: 'job',
    severity: 'critical',
    subject: 'A & B',
    title: '<b>A & B</b>: ОШИБКА',
    body: 'error <script>alert(1)</script>',
  });

  const text = w.api.sent()[0].text;
  assert.match(text, /&lt;b&gt;A &amp; B&lt;\/b&gt;/);
  assert.doesNotMatch(text, /<script>/);
});

test('messages are cut to Telegram’s 4096-character limit', async () => {
  const w = world();
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a', body: 'x\n'.repeat(4000) });
  assert.ok(w.api.sent()[0].text.length <= 4096);
});

/* ------------------------------------------------------------------ *
 * Update handling
 * ------------------------------------------------------------------ */

test('a chat named in configuration is registered before any update arrives', async () => {
  const file = path.join(os.tmpdir(), `veeam-seed-${Math.random().toString(36).slice(2)}.json`);
  const telegram = telegramConfig({ TELEGRAM_CHAT_IDS: CHAT, TELEGRAM_STATE_FILE: file });
  // The registry is asked on its own, with no service constructed at all: the
  // seeding must not depend on which provider Nest happens to build first.
  const store = new TelegramStateStore(file, telegram.chatIds);

  assert.deepEqual(
    store.chats().map(([id]) => id),
    [CHAT],
  );
  fs.rmSync(file, { force: true });
});

test('the reported mode follows the transport, not a flag somebody set', async () => {
  const w = world();
  // No webhook URL and the polling loop was never started, so neither transport
  // is up. Reporting "webhook" here is what used to hide a failed start.
  assert.equal(w.updates.mode, 'starting');
  assert.equal(w.updates.webhookConfigured, false);

  const file = path.join(os.tmpdir(), `veeam-off-${Math.random().toString(36).slice(2)}.json`);
  const off = telegramConfig({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_STATE_FILE: file });
  const store = new TelegramStateStore(file);
  const config = { getOrThrow: () => off };
  const transport = new TelegramTransportService(config);
  const topics = new TelegramTopicsService(config, transport, store);
  assert.equal(new TelegramUpdatesService(config, transport, topics, store).mode, 'disabled');
  fs.rmSync(file, { force: true });
});

test('status counts every chat and every topic the bot knows', async () => {
  const w = world();
  w.topics.remember(CHAT, '🔴 Errors', 11);
  w.topics.remember(CHAT, '🟡 Warnings', 12);

  assert.deepEqual(w.service.reach, {
    enabled: true,
    chats: 1,
    topics: 2,
    queue: { pending: 0, dropped: 0 },
  });
});

test('a topic created by a human in the group is learned from the update', async () => {
  const w = world();
  await w.updates.handleUpdate({
    update_id: 1,
    message: {
      message_id: 5,
      message_thread_id: 77,
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
      forum_topic_created: { name: 'Ручной топик' },
    },
  });

  assert.equal(w.topics.list(CHAT)['Ручной топик'], 77);
});

test('/start answers inside the topic it was asked in', async () => {
  const w = world();
  await w.updates.handleUpdate({
    update_id: 2,
    message: {
      message_id: 6,
      message_thread_id: 42,
      is_topic_message: true,
      text: '/start@MuratVeeamMonitor2026Bot',
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  });

  const sent = w.api.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 42);
  assert.match(sent[0].text, /Chat ID/);
});

/* ------------------------------------------------------------------ *
 * Monitor
 * ------------------------------------------------------------------ */

test('an unreachable server is an answer, not an exception', async () => {
  const veeam = {
    request: async () => {
      throw new Error('connect ETIMEDOUT 10.0.0.1:9419');
    },
    reachability: VeeamHttpService.prototype.reachability,
  };

  // The health probe and the monitor ask the same question and must not be able
  // to answer it differently.
  assert.deepEqual(await veeam.reachability(), {
    reachable: false,
    error: 'connect ETIMEDOUT 10.0.0.1:9419',
  });
  veeam.request = async () => ({ serverTime: '2026-09-14T11:00:00+05:00' });
  assert.deepEqual(await veeam.reachability(), {
    reachable: true,
    serverTime: '2026-09-14T11:00:00+05:00',
  });
});

test('a pass asked for while one is already running is declined, and says so', async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')], {
    '/api/v1/serverTime': async () => {
      await held;
      return { serverTime: '2026-09-14T11:00:00+05:00' };
    },
  });

  const first = w.monitor.check();
  // Whoever asked second must be able to tell that the health they are about to
  // read belongs to the cycle already in flight, not to their own request.
  assert.equal(await w.monitor.check(), 'busy');
  release();
  assert.equal(await first, 'ran');
  assert.equal(await w.monitor.check(), 'ran');
});

test('the first cycle seeds job results silently and the next one reports changes', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success'), job('2', 'FS Daily', 'Success')]);

  await w.monitor.check();
  assert.deepEqual(w.api.sent(), [], 'starting up is not an event, so the first cycle is silent');

  w.api.reset();
  w.setJobs([job('1', 'SQL Daily', 'Failed'), job('2', 'FS Daily', 'Success')]);
  await w.monitor.check();

  const sent = w.api.sent();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /SQL Daily/);
  assert.match(sent[0].text, /FAILED/);
  assert.match(sent[0].text, /Agent failed to process method/);
  assert.equal(w.api.of('createForumTopic').at(-1).name, 'SQL Daily');
});

test('a job that stays failed is not reported again, and its recovery is', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  w.setJobs([job('1', 'SQL Daily', 'Failed')]);
  await w.monitor.check();
  w.api.reset();

  await w.monitor.check();
  assert.equal(w.api.sent().length, 0, 'unchanged failure must stay quiet');

  w.setJobs([job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  const sent = w.api.sent();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /восстановлено/);
});

test('a run in progress is not an event', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  w.api.reset();
  w.setJobs([{ id: '1', name: 'SQL Daily', lastResult: 'None', status: 'Working' }]);
  await w.monitor.check();
  assert.equal(w.api.sent().length, 0);
});

test('job state survives a restart, so a failure is announced once', async () => {
  const first = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await first.monitor.check();
  first.setJobs([job('1', 'SQL Daily', 'Failed')]);
  await first.monitor.check();
  first.store.flush();

  const w = world({}, {}, first.file);
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': { data: [job('1', 'SQL Daily', 'Failed')] },
    '/api/v1/sessions': { data: [] },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );
  await monitor.check();

  // Nothing at all: the persisted result stops a duplicate alert, and the
  // persisted topic id stops a second "SQL Daily" topic being created.
  assert.equal(w.api.of('createForumTopic').length, 0);
  assert.deepEqual(w.api.sent(), []);
  fs.rmSync(first.file, { force: true });
});

test('a monitor account that cannot log in is reported, once, and its recovery too', async () => {
  const w = world({ TELEGRAM_AUTH_COOLDOWN_MIN: '60' });
  let broken = true;
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': { data: [] },
  });
  const auth = {
    configured: true,
    username: 'svc@example.com',
    getAccessToken: async () => {
      if (broken) throw new Error('Veeam API 401: Authentication failed');
      return 'tok';
    },
  };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();
  const alerts = w.api.sent().filter((payload) => /не авторизуется/.test(payload.text));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Authentication failed/);
  assert.equal(monitor.status.authenticated, false);

  w.api.reset();
  await monitor.check();
  assert.equal(w.api.sent().length, 0, 'the same broken login must not alert every minute');

  broken = false;
  w.api.reset();
  await monitor.check();
  assert.match(w.api.sent()[0].text, /снова работает/);
  assert.equal(monitor.status.authenticated, true);
});

test('losing and regaining the Veeam API is reported as a transition', async () => {
  const w = world();
  let up = true;
  const veeam = veeamFake({
    '/api/v1/serverTime': () => {
      if (!up) throw new Error('connect ECONNREFUSED');
      return { serverTime: 'now' };
    },
    '/api/v1/jobs/states': { data: [] },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();
  w.api.reset();
  up = false;
  await monitor.check();
  assert.match(w.api.sent()[0].text, /сервер недоступен/);

  w.api.reset();
  up = true;
  await monitor.check();
  assert.match(w.api.sent()[0].text, /связь восстановлена/);
});

test('a repository below the free-space threshold is reported once per cooldown', async () => {
  const w = world({ TELEGRAM_REPOSITORY_FREE_PERCENT: '10', TELEGRAM_REPOSITORY_COOLDOWN_MIN: '720' });
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': { data: [] },
    '/api/v1/backupInfrastructure/repositories/states': {
      data: [
        { id: 'r1', name: 'Repo01', capacityGB: 1000, freeGB: 40 },
        { id: 'r2', name: 'Repo02', capacityGB: 1000, freeGB: 400 },
      ],
    },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();
  const alerts = w.api.sent().filter((payload) => /Repo0/.test(payload.text));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Repo01/);
  assert.match(alerts[0].text, /4\.0%/);

  w.api.reset();
  await monitor.check();
  assert.equal(w.api.sent().filter((payload) => /Repo0/.test(payload.text)).length, 0);
});

test('a repository that does not report free space raises nothing', async () => {
  const w = world({ TELEGRAM_REPOSITORY_FREE_PERCENT: '10' });
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': { data: [] },
    '/api/v1/backupInfrastructure/repositories/states': {
      // Capacity known, free space absent. Read as "zero free" this used to be
      // a critical alert about a repository nobody could say anything about.
      data: [{ id: 'r1', name: 'Repo01', capacityGB: 1000, usedSpaceGB: 120 }],
    },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();
  assert.deepEqual(w.api.sent().filter((payload) => /Repo0/.test(payload.text)), []);
});

test('what a repository has in use is capacity minus free, not what Veeam calls used', () => {
  // usedSpaceGB may count logical or deduplicated data and can exceed capacity,
  // so it is only ever the fallback.
  const physical = capacityOf({ id: 'r1', name: 'R', capacityGB: 1000, freeGB: 250, usedSpaceGB: 4000 });
  assert.equal(physical.usedGB, 750);
  assert.equal(physical.usedPercent, 75);
  assert.equal(physical.freePercent, 25);

  const fallback = capacityOf({ id: 'r2', name: 'R', capacityGB: 1000, usedSpaceGB: 400 });
  assert.equal(fallback.usedPercent, 40);
  // The bar may rest on the fallback; the alarm may not.
  assert.equal(fallback.freePercent, undefined);

  const unknowable = capacityOf({ id: 'r3', name: 'R' });
  assert.equal(unknowable.usedPercent, undefined);
  assert.equal(unknowable.freePercent, undefined);
});

test('repositories are listed by name with the default ones last', () => {
  const ordered = capacities([
    { id: 'a', name: 'Default Backup Repository' },
    { id: 'b', name: 'Repo10' },
    { id: 'c', name: 'Repo2' },
    { id: 'd' },
  ]).map((repository) => repository.name);

  assert.deepEqual(ordered, ['d', 'Repo2', 'Repo10', 'Default Backup Repository']);
});

/* ------------------------------------------------------------------ *
 * Delivery accounting: nothing is marked as reported until it is sent
 * ------------------------------------------------------------------ */

/** Telegram rejects the message outright; not a rate limit, not a dead chat. */
const rejectSend = (isBroken) => ({
  sendMessage: () =>
    isBroken() ? { ok: false, error_code: 400, description: 'Bad Request: nope' } : undefined,
});

test('a delivery that reached nobody does not burn the cooldown', async () => {
  let broken = true;
  const w = world({}, rejectSend(() => broken));
  const event = () => ({
    kind: 'job',
    severity: 'critical',
    subject: 'SQL Daily',
    title: 'SQL Daily: ОШИБКА',
    dedupeKey: 'job:1:failed',
    cooldownMs: 60_000,
  });

  const first = await w.service.notify(event());
  assert.equal(first.outcome, 'failed');
  assert.equal(w.store.snapshot().cooldowns['job:1:failed'], undefined, 'окно не должно быть взведено');

  broken = false;
  const second = await w.service.notify(event());
  assert.equal(second.outcome, 'delivered', 'повтор проходит, а не глушится кулдауном');

  const third = await w.service.notify(event());
  assert.equal(third.outcome, 'cooldown', 'после успешной доставки окно взведено');
});

test('the delivery report names why an event was not sent', async () => {
  const w = world({ TELEGRAM_SEVERITIES: 'critical' });
  const base = { kind: 'job', subject: 'A', title: 'a' };

  assert.equal((await w.service.notify({ ...base, severity: 'warning' })).outcome, 'severity-filtered');
  assert.equal((await w.service.notify({ ...base, severity: 'critical' })).outcome, 'delivered');

  const keyed = { ...base, severity: 'critical', dedupeKey: 'k', cooldownMs: 60_000 };
  assert.equal((await w.service.notify(keyed)).outcome, 'delivered');
  assert.equal((await w.service.notify(keyed)).outcome, 'cooldown');

  w.store.dropChat(CHAT);
  assert.equal((await w.service.notify({ ...base, severity: 'critical' })).outcome, 'no-chats');
});

test('a transition whose delivery failed is retried on the next cycle', async () => {
  let broken = true;
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')], {}, rejectSend(() => broken));

  await w.monitor.check();
  assert.equal(w.store.jobResult('1'), 'success', 'первый цикл засеял состояние');

  w.setJobs([job('1', 'SQL Daily', 'Failed')]);
  await w.monitor.check();
  assert.equal(
    w.store.jobResult('1'),
    'success',
    'провалившаяся отправка не отмечает переход как обработанный',
  );
  assert.equal(w.monitor.status.undelivered > 0, true);

  broken = false;
  w.api.reset();
  await w.monitor.check();

  const sent = w.api.sent();
  assert.equal(sent.length, 1, 'переход сообщается на следующем цикле');
  assert.match(sent[0].text, /SQL Daily/);
  assert.match(sent[0].text, /FAILED/);
  assert.equal(w.store.jobResult('1'), 'failed');
  assert.equal(w.monitor.status.lastOutcome, 'delivered');
});

test('a failing job step does not abort the repository check', async () => {
  const w = world({ TELEGRAM_REPOSITORY_FREE_PERCENT: '10' });
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': () => {
      throw new Error('Veeam 500 Internal Server Error');
    },
    '/api/v1/backupInfrastructure/repositories/states': {
      data: [{ id: 'r1', name: 'Repo01', capacityGB: 1000, freeGB: 40 }],
    },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();

  assert.ok(
    w.api.sent().some((payload) => /Repo01/.test(payload.text)),
    'репозитории проверены, несмотря на упавший шаг заданий',
  );
  assert.match(monitor.status.lastError, /Veeam 500/);
  assert.ok(monitor.status.lastCheckAt, 'цикл дошёл до конца');
});

test('the digest cooldown is armed only once the digest was delivered', async () => {
  let broken = true;
  const hour = new Date().getHours();
  const w = world({ TELEGRAM_DIGEST_HOUR: String(hour) }, rejectSend(() => broken));
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': { data: [job('1', 'SQL Daily', 'Failed')] },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();
  assert.equal(w.store.snapshot().cooldowns['digest'], undefined, 'неудачная сводка не глушит сутки');

  broken = false;
  w.api.reset();
  await monitor.check();

  assert.ok(
    w.api.sent().some((payload) => /сводка за сутки/.test(payload.text)),
    'сводка отправлена на следующем цикле',
  );
  assert.ok(w.store.snapshot().cooldowns['digest'] > Date.now(), 'теперь окно взведено');
});

test('every state write persists without the caller managing save()', async () => {
  const file = path.join(os.tmpdir(), `veeam-telegram-${Math.random().toString(36).slice(2)}.json`);
  const w = world({}, {}, file);

  w.store.rememberTopic(CHAT, 'SQL Daily', 77);
  w.store.recordJobResult('job-1', 'failed');
  w.store.armCooldown('k', 60_000);
  w.store.flush();

  // A second store over the same file sees everything, and no caller in the
  // three modules above ever had to remember a save.
  const reopened = new TelegramStateStore(file);
  assert.equal(reopened.threadId(CHAT, 'SQL Daily'), 77);
  assert.equal(reopened.jobResult('job-1'), 'failed');
  assert.equal(reopened.isSuppressed('k'), true);
  assert.deepEqual(
    reopened.chats().map(([id]) => id),
    [CHAT],
    'чат, засеянный из конфигурации, тоже сохранён',
  );

  reopened.forgetJobsExcept(new Set(['other']));
  reopened.flush();
  assert.equal(new TelegramStateStore(file).jobResult('job-1'), undefined);
  fs.rmSync(file, { force: true });
});

/* ------------------------------------------------------------------ *
 * Live status messages
 * ------------------------------------------------------------------ */

const LIVE = { TELEGRAM_LIVE: 'true' };
const running = (name, extra = {}) => ({
  ...job('1', name, 'Success'),
  status: 'Working',
  ...extra,
});

test('the live status is one message per topic, edited in place on later cycles', async () => {
  const w = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);

  await w.monitor.check();
  const opening = w.api.sent();
  assert.equal(opening.length, 7, 'one message per live slot');
  assert.ok(opening.some((m) => /всё работает/.test(m.text)));
  assert.ok(opening.some((m) => /не выполняется ни одно задание/.test(m.text)));
  assert.deepEqual(
    w.api.of('createForumTopic').map((t) => t.name),
    [
      '🩺 Monitor health',
      '▶️ Running now',
      '📅 Upcoming runs',
      '📈 Performance',
      '💾 Repositories',
      '🛡 Protection',
      '🗂 Restore points',
    ],
  );

  w.api.reset();
  w.setJobs([running('SQL Daily')]);
  await w.monitor.check();

  assert.deepEqual(w.api.sent(), [], 'a restart-free change never posts a second message');
  const edits = w.api.of('editMessageText');
  assert.equal(edits.length, 1, 'only the message whose content actually changed');
  assert.match(edits[0].text, /Сейчас выполняется: 1 задание/);
});

test('an unchanged live message is left alone instead of rewritten every cycle', async () => {
  const w = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();

  w.api.reset();
  await w.monitor.check();
  await w.monitor.check();

  assert.deepEqual(w.api.sent(), []);
  assert.deepEqual(w.api.of('editMessageText'), []);
});

test('a running job is shown with its progress, elapsed time and next run', async () => {
  const startedAt = new Date(Date.now() - 22 * 60_000).toISOString();
  const nextRun = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const w = monitorWorld(LIVE, [running('SQL Daily', { nextRun })], {
    '/api/v1/sessions': { data: [{ jobId: '1', state: 'Working', progressPercent: 62, creationTime: startedAt }] },
  });

  await w.monitor.check();

  const text = w.api.sent().find((m) => /Сейчас выполня[ею]тся/.test(m.text)).text;
  assert.match(text, /<b>SQL Daily<\/b> — 62%/);
  assert.match(text, /▰▰▰▰▰▰▱▱▱▱/);
  assert.match(text, /идёт 22 мин/);
  // While something is running, the next run belongs to the schedule slot only.
  assert.ok(!/Ближайший запуск/.test(text));
  const schedule = w.api.sent().find((m) => /Upcoming runs|Сегодня|расписан/.test(m.text)).text;
  assert.match(schedule, /SQL Daily/);
});

test('a live message Telegram no longer has is deleted and replaced, not duplicated', async () => {
  let gone = false;
  const w = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')], {}, {
    editMessageText: () =>
      gone
        ? { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }
        : undefined,
  });
  await w.monitor.check();

  w.api.reset();
  gone = true;
  w.setJobs([running('SQL Daily')]);
  await w.monitor.check();

  assert.equal(w.api.of('deleteMessage').length, 1, 'the stale message is removed');
  assert.equal(w.api.sent().length, 1, 'exactly one replacement');
  assert.match(w.api.sent()[0].text, /Сейчас выполня[ею]тся/);
  assert.equal(w.api.of('createForumTopic').length, 0, 'the topic itself is still known');
});

test('pinning and heartbeat rewrites come from the slot declaration', async () => {
  const { LIVE_SLOTS } = require('../dist/live/slots');
  const w = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();

  const pinned = w.api.of('pinChatMessage').map((p) => p.message_id);
  const sentIds = w.api.calls
    .filter((c) => c.method === 'sendMessage')
    .map((c, i) => ({ i, id: 1001 + i }));
  assert.equal(
    pinned.length,
    Object.values(LIVE_SLOTS).filter((s) => s.pinned).length,
    'exactly the slots declared pinned are pinned',
  );
  assert.ok(sentIds.length > pinned.length, 'and the rest are not');

  // A pinned slot is never rewritten just to move its timestamp: that is churn
  // the whole room sees. The declaration is what says so.
  for (const [name, spec] of Object.entries(LIVE_SLOTS)) {
    assert.equal(spec.pinned, !spec.heartbeat, `${name}: pinned and heartbeat are opposites`);
  }
});

test('a slot too long for one message owns a second, and drops it when it shrinks', async () => {
  const w = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();

  w.api.reset();
  await w.live.publish('restorePoints', ['страница один', 'страница два']);
  assert.equal(w.api.sent().length, 1, 'the continuation is a message of its own');
  assert.equal(w.api.of('editMessageText').length, 1, 'the first page keeps its message');

  w.api.reset();
  await w.live.publish('restorePoints', ['страница один, иначе', 'страница два, иначе']);
  assert.equal(w.api.sent().length, 0, 'both pages are edited in place');
  assert.equal(w.api.of('editMessageText').length, 2);

  w.api.reset();
  await w.live.publish('restorePoints', ['теперь всё помещается']);
  assert.equal(w.api.of('deleteMessage').length, 1, 'the page nothing fills is removed');
  assert.equal(w.api.sent().length, 0);
});

test('the live message survives a restart instead of starting a second one', async () => {
  const first = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);
  await first.monitor.check();
  first.store.flush();
  assert.equal(first.api.sent().length, 7);

  const w = world(LIVE, {}, first.file);
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: '2026-09-14T11:00:00+05:00' },
    '/api/v1/jobs/states': { data: [job('1', 'SQL Daily', 'Success')] },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );
  await monitor.check();

  assert.deepEqual(w.api.sent(), [], 'the persisted message id is reused');
  assert.equal(w.api.of('createForumTopic').length, 0);
  fs.rmSync(first.file, { force: true });
});

test('an unreachable Veeam is reported as unknown, not as "nothing is running"', async () => {
  const w = world(LIVE);
  const veeam = veeamFake({
    '/api/v1/serverTime': () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();

  const texts = w.api.sent().map((m) => m.text);
  assert.ok(texts.some((t) => /🔴 <b>Veeam — сервер недоступен/.test(t)));
  assert.ok(texts.some((t) => /Данные о заданиях недоступны/.test(t)));
  assert.ok(!texts.some((t) => /не выполняется ни одно задание/.test(t)));
});

test('counts are written in Russian, with the right form for 1, 2 and 5', async () => {
  const { plural, duration } = require('../dist/live/format');
  const jobs = (n) => `${n} ${plural(n, 'задание', 'задания', 'заданий')}`;
  assert.equal(jobs(1), '1 задание');
  assert.equal(jobs(2), '2 задания');
  assert.equal(jobs(5), '5 заданий');
  assert.equal(jobs(11), '11 заданий');
  assert.equal(jobs(21), '21 задание');
  assert.equal(duration(45_000), '45 с');
  assert.equal(duration(22 * 60_000), '22 мин');
  assert.equal(duration(3 * 3_600_000 + 33 * 60_000), '3 ч 33 мин');
  assert.equal(duration(50 * 3_600_000), '2 д 2 ч');
});

test('a moving server clock alone does not rewrite the health message', async () => {
  let minute = 0;
  const w = world(LIVE);
  const veeam = veeamFake({
    '/api/v1/serverTime': () => ({
      serverTime: new Date(Date.UTC(2026, 8, 14, 11, minute++, 0)).toISOString(),
    }),
    '/api/v1/jobs/states': { data: [] },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();
  assert.equal(w.api.sent().length, 7);

  w.api.reset();
  await monitor.check();
  assert.deepEqual(w.api.of('editMessageText'), [], 'nothing an operator cares about changed');
  assert.deepEqual(w.api.sent(), []);
});

test('by default every failure goes to the shared Alerts topic', async () => {
  const saved = process.env.TELEGRAM_ROUTING_MODE;
  delete process.env.TELEGRAM_ROUTING_MODE;
  try {
    assert.equal(configuration().telegram.routingMode, 'single');
  } finally {
    if (saved !== undefined) process.env.TELEGRAM_ROUTING_MODE = saved;
  }

  const w = monitorWorld({ TELEGRAM_ROUTING_MODE: 'single' }, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  w.setJobs([job('1', 'SQL Daily', 'Failed')]);
  w.api.reset();
  await w.monitor.check();

  const alert = w.api.sent().find((m) => /SQL Daily/.test(m.text));
  assert.notEqual(alert.message_thread_id, undefined, 'shared Alerts topic, not General');
  assert.deepEqual(w.api.of('createForumTopic').map((topic) => topic.name), ['🚨 Alerts']);
});

test('the schedule slot lists only what is still due today', async () => {
  const { renderSchedule } = require('../dist/live/format');
  const now = new Date('2026-09-14T12:00:00Z');
  const clock = { now, timezone: 'UTC' };
  const at = (iso) => new Date(iso).toISOString();

  const today = renderSchedule(
    {
      upcoming: [
        { name: 'TTC_vCloud_vcd02', at: at('2026-09-14T13:13:00Z') },
        { name: 'SQL Daily Backup', at: at('2026-09-14T20:00:00Z') },
        { name: 'FS Weekly', at: at('2026-09-15T03:00:00Z') },
      ],
    },
    clock,
  );
  assert.match(today, /Сегодня осталось 2 запуска/);
  assert.match(today, /13:13.*TTC_vCloud_vcd02/);
  assert.ok(!/FS Weekly/.test(today));

  const empty = renderSchedule(
    { upcoming: [], next: { name: 'FS Monthly', at: at('2026-09-23T03:00:00Z') } },
    clock,
  );
  assert.match(empty, /На сегодня запусков больше нет/);
  assert.match(empty, /Следующий:.*FS Monthly — 23\.09 в 03:00/);

  const none = renderSchedule({ upcoming: [] }, clock);
  assert.match(none, /по расписанию ничего не запланировано/);
});

test('the planner keeps only today and excludes manual or disabled jobs', () => {
  const { todayRuns } = require('../dist/monitor/schedule-planner');
  const now = new Date('2026-09-15T10:00:00Z');
  const jobs = [
    { id: 'daily', name: 'Daily', nextRun: '2026-09-15T17:00:00Z' },
    { id: 'weekly', name: 'Tue Thu', nextRun: '2026-09-15T18:00:00Z' },
    { id: 'monthly', name: 'Monthly', nextRun: '2026-09-19T17:00:00Z' },
    { id: 'manual', name: 'Manual', nextRun: '2026-09-15T19:00:00Z' },
    { id: 'disabled', name: 'Disabled', status: 'Disabled', nextRun: '2026-09-15T20:00:00Z' },
  ];
  const schedules = new Map([
    ['daily', { runAutomatically: true, daily: { isEnabled: true, dailyKind: 'Everyday', days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] } }],
    ['weekly', { runAutomatically: true, daily: { isEnabled: true, dailyKind: 'SelectedDays', days: ['tuesday', 'thursday'] } }],
    ['monthly', { runAutomatically: true, monthly: { isEnabled: true } }],
    ['manual', { runAutomatically: false, daily: { isEnabled: true, days: ['tuesday'] } }],
    ['disabled', { runAutomatically: true, daily: { isEnabled: true, days: ['tuesday'] } }],
  ]);

  const runs = todayRuns(jobs, schedules, now, 'Asia/Qyzylorda');
  assert.equal(runs.filter((run) => run.name === 'Daily').length, 1);
  assert.equal(runs.filter((run) => run.name === 'Tue Thu').length, 1);
  assert.equal(runs.filter((run) => run.name === 'Monthly').length, 0);
  assert.ok(!runs.some((run) => run.name === 'Manual'));
  assert.ok(!runs.some((run) => run.name === 'Disabled'));
  assert.equal(runs.find((run) => run.name === 'Daily').cadence, 'ежедневно');
});

test('a cycle Veeam did not answer leaves the schedule honest about it', async () => {
  const w = world(LIVE);
  const veeam = veeamFake({
    '/api/v1/serverTime': () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {} };
  const monitor = new MonitorService(
    w.config, veeam, w.service, auth, w.store, w.live,
    new BackupEvidenceService(w.config, veeam, auth),
  );

  await monitor.check();

  const texts = w.api.sent().map((m) => m.text);
  assert.ok(texts.some((t) => /Расписание недоступно/.test(t)));
  assert.ok(!texts.some((t) => /На сегодня запусков больше нет/.test(t)));
});

test('a long list fills the message to Telegram’s limit instead of an invented cap', async () => {
  const { renderSchedule, renderRunning } = require('../dist/live/format');
  const now = new Date('2026-09-14T00:00:00Z');
  const clock = { now, timezone: 'UTC' };
  const runs = (n) =>
    Array.from({ length: n }, (_, i) => ({
      name: `TTC_JOB_${String(i).padStart(3, '0')}`,
      at: new Date(now.getTime() + (i + 1) * 60_000).toISOString(),
    }));

  // 42 entries used to be cut to 30 for no reason; they fit with room to spare.
  const short = renderSchedule({ upcoming: runs(42) }, clock);
  assert.match(short, /Сегодня осталось 42 запуска/);
  assert.ok(!/…и ещё/.test(short), 'nothing needs hiding at this size');
  assert.equal((short.match(/TTC_JOB_/g) ?? []).length, 42);

  // A day where everything is scheduled does not overflow and says what it hid.
  const long = renderSchedule({ upcoming: runs(400) }, clock);
  assert.ok(long.length <= 4096);
  const hidden = /…и ещё (\d+) запуск/.exec(long);
  assert.ok(hidden, 'the remainder is counted, not silently dropped');
  assert.equal((long.match(/TTC_JOB_/g) ?? []).length + Number(hidden[1]), 400);

  const many = renderRunning(
    {
      jobs: runs(300).map((r) => ({ name: r.name, type: 'Backup', percent: 50, startedAt: r.at })),
      totalJobs: 300,
    },
    clock,
  );
  assert.ok(many.length <= 4096, `message is ${many.length} characters`);
  assert.match(many, /…и ещё \d+ задани/);
});

/* ------------------------------------------------------------------ *
 * Protection: what is actually recoverable
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** Restore points every `everyDays`, the newest `ageDays` old. */
const points = (now, ageDays, everyDays, count = 8) =>
  Array.from({ length: count }, (_, i) => now - (ageDays + i * everyDays) * DAY_MS);

/**
 * Builds an evidence of the shape a scan produces, from the shorthand these
 * tests use. Jobs carry `disabled` / `unscheduled` flags; the real predicate
 * reads a Veeam status and the evidence's unscheduled set, so they are put
 * back into that shape and the real module decides.
 */
const standings = (jobs, pointsByJob, streakByJob, now) => {
  const { standingsOf } = require('../dist/monitor/job-standing');
  const { cadenceOf } = require('../dist/monitor/backup-evidence.service');
  const newestFirst = new Map(
    [...pointsByJob].map(([id, stamps]) => [id, [...stamps].sort((a, b) => b - a)]),
  );
  return standingsOf(
    jobs.map((j) => ({
      id: j.id,
      name: j.name,
      type: j.type,
      lastRun: j.lastRun,
      status: j.disabled ? 'Disabled' : 'Stopped',
    })),
    {
      status: 'ready',
      scannedAt: now,
      runsByJob: newestFirst,
      cadenceByJob: new Map([...newestFirst].map(([id, runs]) => [id, cadenceOf(runs)])),
      unscheduled: new Set(jobs.filter((j) => j.unscheduled).map((j) => j.id)),
      streakByJob,
      depthByJob: new Map(),
      orphanChains: [],
      totalPoints: 0,
      failedPoints: 0,
    },
  );
};

const assess = (overrides) => {
  const { assessProtection } = require('../dist/live/protection');
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const { jobs = [], pointsByJob = new Map(), streakByJob = new Map(), ...thresholds } = overrides;
  return assessProtection({
    standings: standings(jobs, pointsByJob, streakByJob, now),
    now,
    staleDays: 3,
    overdueFactor: 2.5,
    minStreak: 3,
    ...thresholds,
  });
};

test('a job succeeding on paper but producing nothing for months is reported', async () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const snapshot = assess({
    jobs: [{ id: '1', name: 'CLT_AIFC_archive', type: 'Backup', lastRun: '2026-06-19T11:57:52Z' }],
    pointsByJob: new Map([['1', points(now, 87, 1)]]),
  });

  assert.equal(snapshot.risks.length, 1, 'lastResult=Success hides this from every other alert');
  assert.equal(snapshot.risks[0].severity, 'critical');
  assert.equal(Math.floor(snapshot.risks[0].ageDays), 87);
});

test('a job with no restore point at all is critical, and says when it last ran', async () => {
  const snapshot = assess({
    jobs: [{ id: '1', name: 'TTC_Konaev_EM_DB', lastRun: '2026-08-12T10:01:00Z' }],
  });

  assert.equal(snapshot.risks.length, 1);
  assert.equal(snapshot.risks[0].ageDays, null);
  assert.equal(snapshot.risks[0].severity, 'critical');

  const { renderProtection } = require('../dist/live/protection');
  const text = renderProtection(snapshot, { now: new Date(Date.UTC(2026, 8, 14, 12)), timezone: 'UTC' });
  assert.match(text, /точек восстановления нет/);
  assert.match(text, /последний запуск 12\.08/);
});

test('a weekly job is judged against its own rhythm, not against a flat threshold', async () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);

  // Five days old, but this job only ever produces a point every five days.
  const onSchedule = assess({
    jobs: [{ id: '1', name: 'TTC_ASUEDT_REMS_REMS03' }],
    pointsByJob: new Map([['1', points(now, 5, 5)]]),
  });
  assert.deepEqual(onSchedule.risks, [], 'a flat 3-day rule would cry wolf here');
  assert.equal(onSchedule.protectedJobs, 1);

  // The same job, now three of its own intervals late.
  const late = assess({
    jobs: [{ id: '1', name: 'TTC_ASUEDT_REMS_REMS03' }],
    pointsByJob: new Map([['1', points(now, 16, 5)]]),
  });
  assert.equal(late.risks.length, 1);
  assert.equal(Math.round(late.risks[0].intervalDays), 5);
});

test('a daily job that missed a single run is not reported', async () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const snapshot = assess({
    jobs: [{ id: '1', name: 'SQL Daily Backup' }],
    pointsByJob: new Map([['1', points(now, 2, 1)]]),
  });
  assert.deepEqual(snapshot.risks, [], 'the floor protects hourly and daily jobs from noise');
});

test('repeated failures are reported even while the restore point is still fresh', async () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const snapshot = assess({
    jobs: [{ id: '1', name: 'TTC_SMAX_SAM' }],
    pointsByJob: new Map([['1', points(now, 0.2, 1)]]),
    streakByJob: new Map([['1', 5]]),
  });

  assert.equal(snapshot.risks.length, 1);
  assert.equal(snapshot.risks[0].severity, 'warning', 'the data is still recoverable');
  assert.equal(snapshot.risks[0].failures, 5);
  assert.equal(snapshot.protectedJobs, 1, 'a failed attempt does not erase the fresh point');

  const { renderProtection } = require('../dist/live/protection');
  const text = renderProtection(snapshot, { now: new Date(now), timezone: 'UTC' });
  assert.match(text, /5 неудачных запусков подряд/);
});

test('one or two failures are not a streak', async () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const snapshot = assess({
    jobs: [{ id: '1', name: 'SQL Daily Backup' }],
    pointsByJob: new Map([['1', points(now, 0.2, 1)]]),
    streakByJob: new Map([['1', 2]]),
  });
  assert.deepEqual(snapshot.risks, []);
});

test('the worst offenders come first, and an all-clear says so', async () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const snapshot = assess({
    jobs: [
      { id: '1', name: 'mild' },
      { id: '2', name: 'worst' },
      { id: '3', name: 'none-at-all' },
    ],
    pointsByJob: new Map([
      ['1', points(now, 4, 1)],
      ['2', points(now, 40, 1)],
    ]),
  });
  assert.deepEqual(snapshot.risks.map((r) => r.name), ['none-at-all', 'worst', 'mild']);

  const { renderProtection } = require('../dist/live/protection');
  const clear = renderProtection(
    assess({ jobs: [{ id: '1', name: 'ok' }], pointsByJob: new Map([['1', points(now, 0.5, 1)]]) }),
    { now: new Date(now), timezone: 'UTC' },
  );
  assert.match(clear, /🟢 <b>Все задания защищены<\/b>/);
});

test('an unread scan admits it instead of claiming everything is protected', async () => {
  const { renderProtection } = require('../dist/live/protection');
  const text = renderProtection(
    { risks: [], totalJobs: 112, protectedJobs: 0, staleDays: 3, overdueFactor: 2.5, minStreak: 3,
      unavailable: 'Точки восстановления ещё не прочитаны.' },
    { now: new Date(), timezone: 'UTC' },
  );
  assert.match(text, /Защищённость не проверена/);
  assert.ok(!/Все задания защищены/.test(text));
});

test('a disabled job is not owed a restore point', async () => {
  const snapshot = assess({
    jobs: [
      { id: '1', name: 'TTC_MGMT_VEEAM_OLD', disabled: true },
      { id: '2', name: 'CLT_live' },
    ],
    pointsByJob: new Map([['2', points(Date.UTC(2026, 8, 14, 12), 0.5, 1)]]),
  });

  assert.deepEqual(snapshot.risks, []);
  assert.equal(snapshot.excludedDisabled, 1);
  assert.equal(snapshot.totalJobs, 1, 'the disabled job is not part of the denominator either');
});

test('a job that only runs by hand is not owed one either', async () => {
  const snapshot = assess({
    jobs: [{ id: '1', name: 'CLT_AIFC_archive', unscheduled: true }],
  });

  assert.deepEqual(snapshot.risks, [], 'no schedule means no expectation');
  assert.equal(snapshot.excludedUnscheduled, 1);
  assert.equal(snapshot.totalJobs, 0);

  const { renderProtection } = require('../dist/live/protection');
  const text = renderProtection(snapshot, { now: new Date(), timezone: 'UTC' });
  assert.match(text, /Не учитываются:.*1 без расписания/, 'what is outside the check is stated');
});

test('a job whose schedule could not be read is still judged', async () => {
  // TTC_Billing_DB_file is absent from /api/v1/jobs; an unknown schedule must
  // not become a silent exemption.
  const snapshot = assess({
    jobs: [{ id: '1', name: 'TTC_Billing_DB_file', unscheduled: undefined }],
  });

  assert.equal(snapshot.risks.length, 1);
  assert.equal(snapshot.excludedUnscheduled, 0);
});

/* ------------------------------------------------------------------ *
 * Restore point depth
 * ------------------------------------------------------------------ */

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 15, 12);

const depthPages = (over) => {
  const { renderRestorePoints } = require('../dist/live/restore-points');
  return renderRestorePoints(
    {
      jobs: [],
      without: 0,
      excludedDisabled: 0,
      excludedUnscheduled: 0,
      orphanBackups: 0,
      orphanPoints: 0,
      crossLink: false,
      ...over,
    },
    { now: new Date(NOW), timezone: 'UTC' },
  );
};

/** The whole topic as one string, for assertions that do not care about pages. */
const depth = (over) => depthPages(over).join('\n');

test('a row says the name, the point count and exactly when the newest was taken', async () => {
  const text = depth({
    jobs: [
      {
        name: 'TTC_Call_Center',
        runs: 7,
        points: 7,
        machines: 1,
        intervalDays: 1,
        oldest: NOW - 7 * DAY,
        newest: Date.UTC(2026, 5, 17, 21, 32, 9),
      },
    ],
  });

  // Spelled out, because this is the line somebody reads before opening Veeam.
  assert.match(text, /^🔴 TTC_Call_Center — 7 точек · пропущено \d+ запусков · 17 июня 2026 г\. в 21:32:09$/mu);
});

test('the same staleness means opposite things at different cadences', async () => {
  // Both went three days without a point. The nightly job has missed two
  // backups; the weekly one is not due yet.
  const text = depth({
    jobs: [
      { name: 'CLT_weekly', runs: 9, points: 9, machines: 1, intervalDays: 7,
        oldest: NOW - 63 * DAY, newest: NOW - 3 * DAY },
      { name: 'CLT_nightly', runs: 30, points: 30, machines: 1, intervalDays: 1,
        oldest: NOW - 33 * DAY, newest: NOW - 3 * DAY },
    ],
  });

  const lines = text.split('\n');
  const nightly = lines.findIndex((l) => l.includes('CLT_nightly'));
  const weekly = lines.findIndex((l) => l.includes('CLT_weekly'));
  assert.ok(nightly < weekly, 'the one behind its own schedule comes first');
  assert.match(lines[nightly], /^🔴 CLT_nightly — 30 точек · пропущено 2 запуска/u);
  assert.match(lines[weekly], /^🟢 CLT_weekly — 9 точек · /u);
  assert.ok(!/CLT_weekly.*пропущен/u.test(lines[weekly]), 'nothing is claimed about a job that is on time');
  assert.match(text, /Отстают от расписания:<\/b> 1/);
});

test('a job whose cadence cannot be learned claims nothing about missed runs', async () => {
  const text = depth({
    jobs: [
      { name: 'CLT_KMG_PETROCHEM', runs: 1, points: 1, machines: 1, intervalDays: null,
        newest: NOW - 40 * DAY },
    ],
  });

  assert.match(text, /^⚪ CLT_KMG_PETROCHEM — 1 точка · /mu);
  assert.ok(!/пропущен/u.test(text), 'two points are not enough to know a rhythm');
  assert.match(text, /Только одна точка:<\/b> 1 задание/);
});

test('jobs that are not supposed to run are left out, and said to be left out', async () => {
  const text = depth({
    jobs: [{ name: 'has-some', runs: 5, points: 5, machines: 1, intervalDays: 1, newest: NOW }],
    without: 7,
    excludedUnscheduled: 31,
    excludedDisabled: 4,
  });

  assert.match(text, /Заданий:<\/b> 1 \(\+7 без точек\)/);
  assert.match(text, /Не учитываются:<\/b> 31 без расписания, 4 выключено/);
});

const estate = (size) =>
  Array.from({ length: size }, (_, i) => ({
    name: `TTC_JOB_${String(i).padStart(3, '0')}`,
    runs: 10,
    points: 10,
    machines: 1,
    intervalDays: 1,
    // Job 000 is three days behind, the rest are current.
    newest: NOW - (size - i) * 0.01 * DAY - (i === 0 ? 3 * DAY : 0),
  }));

test('a list too long for one message continues into a second', async () => {
  const pages = depthPages({ jobs: estate(90) });

  assert.equal(pages.length, 2, 'ninety spelled-out rows do not fit in one message');
  for (const page of pages) {
    assert.ok(page.length <= 4096, `page is ${page.length} characters`);
  }
  assert.match(pages[1], /^🗂 <b>Точки восстановления — продолжение<\/b>/);
  // The totals belong to the list, not to a page: repeated under the first
  // message they would be read as that page's own count.
  assert.ok(!/Заданий:/.test(pages[0]));
  assert.match(pages[1], /Заданий:<\/b> 90/);
  assert.equal(
    pages.join('\n').match(/TTC_JOB_/g).length,
    90,
    'every job appears exactly once across the pages',
  );
});

test('the pages fill up, keeping the ones that are behind', async () => {
  const pages = depthPages({ jobs: estate(400) });
  const text = pages.join('\n');

  const hidden = /…и ещё (\d+) задани\S* по графику/.exec(text);
  assert.ok(hidden, 'the ones on schedule are the ones worth dropping');
  assert.equal(text.match(/TTC_JOB_/g).length + Number(hidden[1]), 400);
  assert.match(pages[0], /TTC_JOB_000/, 'the one that is behind is always shown');
});

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

test('a point left behind by a failed run is not counted as a backup', async () => {
  const w = exchange();
  await w.monitor.check();

  const topic = w.api.sent().find((m) => /Точки восстановления/.test(m.text));
  assert.ok(topic, 'the topic was published');
  assert.ok(!/14 сентября/u.test(topic.text), 'a run that errored out is not a backup');
  assert.match(topic.text, /Не в счёт:<\/b> 1 точка от прогонов с ошибкой/u);
});

test('a point finished by a successful retry counts, whatever id it carries', async () => {
  const w = exchange();
  await w.monitor.check();

  const topic = w.api.sent().find((m) => /Точки восстановления/.test(m.text));
  // Written nine minutes into the retry that succeeded, so it is a backup —
  // even though the session id on it belongs to the attempt that failed.
  assert.match(topic.text, /TTC_Exchange — 1 точка · 23 августа 2026 г\. в 01:31:12/u);
});

/* ------------------------------------------------------------------ *
 * The evidence itself
 *
 * Session attribution used to be assertable only by driving a whole cycle and
 * grepping a rendered Russian message for a date format owned by a third
 * module. These ask the evidence directly.
 * ------------------------------------------------------------------ */

test('the evidence attributes each point to the run that was on the clock', async () => {
  const w = exchange();
  await w.evidence.refresh('tok', [job('1', 'TTC_Exchange', 'Failed')]);
  const evidence = w.evidence.evidence;

  assert.equal(evidence.status, 'ready');
  assert.equal(evidence.failedPoints, 1, 'the run that errored out left one point');
  assert.equal(evidence.totalPoints, 2);
  const depth = evidence.depthByJob.get('1');
  assert.equal(depth.runs, 1, 'only the point a successful run wrote is retained');
  assert.equal(depth.newest, Date.parse('2026-08-23T01:31:12+05:00'));
});

test('evidence nothing has read yet says why, instead of an empty estate', async () => {
  const w = exchange();

  assert.deepEqual(w.evidence.evidence, {
    status: 'pending',
    reason: 'Точки восстановления ещё не прочитаны.',
  });

  // A cycle Veeam did not answer must not be reported as "no restore points".
  await w.evidence.refresh(null, undefined);
  assert.equal(w.evidence.evidence.status, 'pending');
  assert.match(w.evidence.evidence.reason, /не ответил/);
});

test('a scan that throws leaves the previous evidence standing', async () => {
  // Cadence zero, so the second refresh really re-scans rather than being
  // waved through by the gate — otherwise this would pass without ever
  // reaching the failure it is about.
  const w = exchange({ TELEGRAM_PROTECTION_INTERVAL_MIN: '0' });
  const jobs = [job('1', 'TTC_Exchange', 'Failed')];
  await w.evidence.refresh('tok', jobs);
  const first = w.evidence.evidence;
  assert.equal(first.status, 'ready');

  let attempted = false;
  w.veeam.request = async () => {
    attempted = true;
    throw new Error('Veeam fell over mid-scan');
  };
  await w.evidence.refresh('tok', jobs);

  assert.ok(attempted, 'the scan was re-run');
  assert.equal(w.evidence.evidence.status, 'ready', 'stale evidence beats no evidence');
  assert.equal(w.evidence.evidence.scannedAt, first.scannedAt);
});

test('the 🧹 pointer is a decision the renderer is given, not a zero it infers', async () => {
  const estate = {
    jobs: [{ name: 'CLT_live', runs: 5, points: 5, machines: 1, intervalDays: 1, newest: NOW }],
    orphanBackups: 245,
    orphanPoints: 5037,
  };

  const linked = depth({ ...estate, crossLink: true });
  assert.match(linked, /Сверх того, без заданий:<\/b> 5037 точек в 245 цепочках — см\. 🧹/);

  // The chains are just as real; there is simply nowhere to send anyone.
  const unlinked = depth({ ...estate, crossLink: false });
  assert.ok(!/🧹/u.test(unlinked));
  assert.ok(!/без заданий/u.test(unlinked));
});

test('with the 🧹 topic off, nothing points the reader at it', async () => {
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [job('1', 'CLT_live', 'Success')], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': {
      data: [
        { id: 'b1', jobId: '1', name: 'CLT_live' },
        // A chain whose job is gone: real, counted, but with nowhere to send
        // anyone while the topic that lists them does not exist.
        { id: 'b2', jobId: 'deleted-job', name: 'TTC_OFD_vms' },
      ],
    },
    '/api/v1/restorePoints': {
      data: [
        { id: 'p1', backupId: 'b1', sessionId: 's1', name: 'vm', creationTime: '2026-09-14T01:00:00+05:00' },
        { id: 'p2', backupId: 'b2', sessionId: 's0', name: 'vm', creationTime: '2026-04-04T01:00:00+05:00' },
      ],
    },
  });

  await w.monitor.check();
  const topic = w.api.sent().find((m) => /Точки восстановления/.test(m.text));
  assert.ok(!/🧹/u.test(topic.text), 'a pointer to a deleted topic is worse than no pointer');
  assert.ok(!/без заданий/u.test(topic.text));
  assert.ok(!w.api.sent().some((m) => /Бэкапы без заданий/.test(m.text)), 'and the slot is not published');
});

test('an unread scan says so rather than showing an empty estate', async () => {
  const text = depth({ unavailable: 'Точки восстановления ещё не прочитаны.' });
  assert.match(text, /не прочитаны/);
  assert.ok(!/Сначала те/.test(text));
});

/* ------------------------------------------------------------------ *
 * What a job is owed
 * ------------------------------------------------------------------ */

test('both slots are told the same thing about which jobs are in scope', async () => {
  // The invariant that used to be two copies of a predicate and a comment
  // asking the next reader to keep the counts in the same order.
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [
    { id: '1', name: 'CLT_running', type: 'Backup', status: 'Stopped' },
    { id: '2', name: 'TTC_OLD', type: 'Backup', status: 'Disabled' },
    { id: '3', name: 'CLT_by_hand', type: 'Backup', status: 'Stopped' },
  ], {
    '/api/v1/jobs': {
      data: [
        { id: '1', schedule: { runAutomatically: true } },
        { id: '2', schedule: { runAutomatically: true } },
        { id: '3', schedule: { runAutomatically: false } },
      ],
    },
  });

  await w.monitor.check();
  const sent = w.api.sent();
  const protection = sent.find((m) => /Защищ|Требуют внимания|защищены/.test(m.text));
  const depth = sent.find((m) => /Точки восстановления|Точек восстановления/.test(m.text));

  for (const message of [protection, depth]) {
    assert.match(message.text, /Не учитываются:<\/b> 1 без расписания, 1 выключено/);
  }
});

test('a job is only excused on positive evidence, never on a gap', async () => {
  const { standingsOf } = require('../dist/monitor/job-standing');
  const blank = {
    status: 'ready', scannedAt: 0, runsByJob: new Map(), cadenceByJob: new Map(),
    unscheduled: new Set(['known-manual']), streakByJob: new Map(), depthByJob: new Map(),
    orphanChains: [], totalPoints: 0, failedPoints: 0,
  };

  const result = standingsOf(
    [
      { id: 'known-manual', name: 'by hand', status: 'Stopped' },
      { id: 'off', name: 'switched off', status: 'Disabled' },
      // Its configuration was never read, so nothing says it is excused.
      { id: 'unknown', name: 'schedule unreadable', status: 'Stopped' },
    ],
    blank,
  );

  assert.deepEqual(result.judged.map((j) => j.id), ['unknown']);
  assert.equal(result.excludedUnscheduled, 1);
  assert.equal(result.excludedDisabled, 1);
});

/* ------------------------------------------------------------------ *
 * Reading a whole collection
 *
 * This existed only as a private method reachable through a monitor cycle, and
 * no fake ever returned a pagination envelope — so the offset stepping written
 * to keep a nine-thousand-session read from stalling the cycle had never once
 * executed in a test.
 * ------------------------------------------------------------------ */

/** A Veeam that holds `total` rows and answers honest pages of `size`. */
const collection = (total, size, quirks = {}) => {
  const asked = [];
  const rows = Array.from({ length: total }, (_, i) => ({ id: `row-${i}` }));
  return {
    asked,
    reader: {
      auth: { invalidateAccessToken: () => {}, getAccessToken: async () => 'fresh' },
      accessToken: 'tok',
      veeam: {
        request: async ({ params }) => {
          asked.push({ skip: params.skip, limit: params.limit });
          const limit = quirks.cap ? Math.min(params.limit, quirks.cap) : params.limit;
          return {
            data: rows.slice(params.skip, params.skip + limit),
            pagination: quirks.silent ? undefined : { total, skip: params.skip, limit },
          };
        },
      },
    },
  };
};

test('a collection is read whole, in one page when it fits', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(40, 500);

  const rows = await allPages(c.reader, '/api/v1/backups', {}, 500);

  assert.equal(rows.length, 40);
  assert.equal(c.asked.length, 1, 'a short first page is the whole collection');
});

test('a collection longer than one page is read by offset, not by walking', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(1200, 500);

  const rows = await allPages(c.reader, '/api/v1/restorePoints', {}, 500);

  assert.equal(rows.length, 1200);
  assert.deepEqual(rows[0], { id: 'row-0' });
  assert.deepEqual(rows[1199], { id: 'row-1199' });
  assert.deepEqual(c.asked.map((a) => a.skip), [0, 500, 1000]);
});

test('the step follows the limit Veeam actually gave, not the one asked for', async () => {
  const { allPages } = require('../dist/veeam/pages');
  // Asked for 500, capped at 200: stepping by 500 would skip two thirds.
  const c = collection(700, 500, { cap: 200 });

  const rows = await allPages(c.reader, '/api/v1/sessions', {}, 500);

  assert.equal(rows.length, 700, 'no row is missed');
  assert.deepEqual(new Set(rows.map((r) => r.id)).size, 700, 'and none is read twice');
});

test('a server that reports no total is walked until a page comes back short', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(250, 100, { silent: true });

  const rows = await allPages(c.reader, '/api/v1/jobs', {}, 100);

  assert.equal(rows.length, 250);
  assert.deepEqual(c.asked.map((a) => a.skip), [0, 100, 200]);
});

test('a token that expires mid-read is refreshed and the page re-fetched', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const { VeeamApiError } = require('../dist/veeam/api.error');
  let invalidated = false;
  let first = true;
  const reader = {
    auth: {
      invalidateAccessToken: () => (invalidated = true),
      getAccessToken: async () => 'fresh',
    },
    accessToken: 'stale',
    veeam: {
      request: async ({ accessToken }) => {
        if (first) {
          first = false;
          throw new VeeamApiError('Veeam rejected the token', 401);
        }
        return { data: [{ id: accessToken }], pagination: { total: 1, skip: 0, limit: 500 } };
      },
    },
  };

  const rows = await allPages(reader, '/api/v1/backups', {}, 500);

  assert.ok(invalidated, 'the expired token is dropped');
  assert.deepEqual(rows, [{ id: 'fresh' }], 'the page is re-fetched with the new one');
});

/* ------------------------------------------------------------------ *
 * Orphaned backup chains
 * ------------------------------------------------------------------ */

const orphans = (over) => {
  const { renderOrphans } = require('../dist/live/orphans');
  return renderOrphans(
    { backups: [], points: 0, totalPoints: 0, ...over },
    { now: new Date(Date.UTC(2026, 8, 15, 12)), timezone: 'UTC' },
  );
};

test('chains left behind by deleted jobs are listed biggest first, with their share', async () => {
  const text = orphans({
    backups: [
      { name: 'CLT_small', points: 12, newest: Date.UTC(2026, 8, 10) },
      { name: 'TTC_OFD_vms', points: 347, newest: Date.UTC(2026, 3, 4) },
    ],
    points: 359,
    totalPoints: 1000,
  });

  const lines = text.split('\n');
  const big = lines.findIndex((l) => /TTC_OFD_vms/.test(l));
  const small = lines.findIndex((l) => /CLT_small/.test(l));
  assert.ok(big < small, 'the chain holding the most is where deleting pays');
  assert.match(lines[big], /^🔴 347 · TTC_OFD_vms · 04\.04/, 'stale by months');
  assert.match(lines[small], /^🟢 12 · CLT_small/, 'recent enough to still be wanted');
  assert.match(text, /Точек в них:<\/b> 359 из 1000 \(36%\)/);
});

test('orphaned chains are reported as facts, not as rubbish to delete', async () => {
  const text = orphans({
    backups: [{ name: 'TTC_gone', points: 5, newest: Date.UTC(2026, 0, 1) }],
    points: 5,
    totalPoints: 10,
  });
  // A chain kept deliberately after a job was retired looks identical to one
  // nobody remembers, so the message must not tell anyone to delete it.
  assert.match(text, /только вручную/);
  assert.ok(!/мусор/i.test(text));
});

test('an estate with no leftover chains says so', async () => {
  assert.match(orphans({}), /🟢 <b>Бэкапов без заданий нет<\/b>/);
});

test('the orphan list counts the points it could not show, not just the chains', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    name: `CHAIN_${String(i).padStart(3, '0')}_${'x'.repeat(20)}`,
    points: 300 - i,
    newest: Date.UTC(2026, 8, 1),
  }));
  const text = orphans({
    backups: many,
    points: many.reduce((s, b) => s + b.points, 0),
    totalPoints: 99999,
  });

  assert.ok(text.length <= 4096, `message is ${text.length} characters`);
  const rest = /…и ещё (\d+) цепоч\S+ на (\d+) точ\S+/.exec(text);
  assert.ok(rest, 'the hidden remainder is quantified in points, not just chains');
  const shown = (text.match(/CHAIN_/g) ?? []).length;
  assert.equal(shown + Number(rest[1]), 300);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
require('reflect-metadata');

const { configuration } = require('../dist/config/configuration');
const { TelegramStateStore } = require('../dist/telegram/telegram-state.store');
const { TelegramTransportService } = require('../dist/telegram/telegram-transport.service');
const { TelegramTopicsService } = require('../dist/telegram/telegram-topics.service');
const { TelegramRoutingService } = require('../dist/telegram/telegram-routing.service');
const { TelegramService } = require('../dist/telegram/telegram.service');
const { TelegramMonitorService } = require('../dist/telegram/telegram-monitor.service');
const { TelegramLiveService } = require('../dist/telegram/telegram-live.service');

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
  const store = new TelegramStateStore(file);
  const api = fakeBotApi(handlers);
  const transport = new TelegramTransportService(config, api.fn);
  const topics = new TelegramTopicsService(config, transport, store);
  const routing = new TelegramRoutingService(config);
  const service = new TelegramService(config, transport, topics, routing, store);
  const live = new TelegramLiveService(config, transport, topics, store);
  // Configured chats only learn they are forums from getChat or an update.
  store.mergeChat({ id: Number(CHAT), type: 'supergroup', is_forum: true });
  return { file, config, store, api, transport, topics, routing, service, live, telegram };
}

function veeamFake(routes) {
  return {
    baseUrl: 'https://veeam.test:9419',
    request: async (req) => {
      const handler = routes[req.path];
      assert.ok(handler, `unexpected Veeam path ${req.path}`);
      return typeof handler === 'function' ? handler(req) : handler;
    },
  };
}

function monitorWorld(env, jobStates, extraRoutes = {}, handlers = {}) {
  const w = world(env, handlers);
  let states = jobStates;
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: '2026-09-14T11:00:00+05:00' },
    '/api/v1/jobs/states': () => ({ data: states }),
    '/api/v1/sessions': { data: [{ result: { message: 'Agent failed to process method' } }] },
    '/api/v1/backups': { data: [] },
    '/api/v1/restorePoints': { data: [] },
    ...extraRoutes,
  });
  const auth = { configured: true, username: 'svc@example.com', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);
  return { ...w, monitor, auth, setJobs: (next) => (states = next) };
}

const job = (id, name, lastResult) => ({ id, name, lastResult, type: 'Backup', status: 'Stopped' });

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

test('single mode restores the old behaviour of posting everything to General', async () => {
  const w = world({ TELEGRAM_ROUTING_MODE: 'single' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });

  assert.equal(w.api.of('createForumTopic').length, 0);
  assert.equal(w.api.sent()[0].message_thread_id, undefined);
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

test('a topic created by a human in the group is learned from the update', async () => {
  const w = world();
  await w.service.handleUpdate({
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
  await w.service.handleUpdate({
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);
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
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

  await monitor.check();
  const alerts = w.api.sent().filter((payload) => /Repo0/.test(payload.text));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Repo01/);
  assert.match(alerts[0].text, /4\.0%/);

  w.api.reset();
  await monitor.check();
  assert.equal(w.api.sent().filter((payload) => /Repo0/.test(payload.text)).length, 0);
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

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
  assert.equal(opening.length, 6, 'health, running, schedule, performance, repositories, protection');
  assert.ok(opening.some((m) => /всё работает/.test(m.text)));
  assert.ok(opening.some((m) => /не выполняется ни одно задание/.test(m.text)));
  assert.deepEqual(
    w.api.of('createForumTopic').map((t) => t.name),
    ['🩺 Monitor health', '▶️ Running now', '📅 Today', '📈 Performance', '💾 Repositories', '🛡 Protection'],
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
  const schedule = w.api.sent().find((m) => /Today|Сегодня|расписан/.test(m.text)).text;
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

test('the live message survives a restart instead of starting a second one', async () => {
  const first = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);
  await first.monitor.check();
  first.store.flush();
  assert.equal(first.api.sent().length, 6);

  const w = world(LIVE, {}, first.file);
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: '2026-09-14T11:00:00+05:00' },
    '/api/v1/jobs/states': { data: [job('1', 'SQL Daily', 'Success')] },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

  await monitor.check();

  const texts = w.api.sent().map((m) => m.text);
  assert.ok(texts.some((t) => /🔴 <b>Veeam — сервер недоступен/.test(t)));
  assert.ok(texts.some((t) => /Данные о заданиях недоступны/.test(t)));
  assert.ok(!texts.some((t) => /не выполняется ни одно задание/.test(t)));
});

test('counts are written in Russian, with the right form for 1, 2 and 5', async () => {
  const { plural, duration } = require('../dist/telegram/telegram-live.format');
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

  await monitor.check();
  assert.equal(w.api.sent().length, 6);

  w.api.reset();
  await monitor.check();
  assert.deepEqual(w.api.of('editMessageText'), [], 'nothing an operator cares about changed');
  assert.deepEqual(w.api.sent(), []);
});

test('by default every alert goes to General instead of growing a topic per job', async () => {
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
  assert.equal(alert.message_thread_id, undefined, 'General, not a per-job thread');
  assert.equal(w.api.of('createForumTopic').length, 0);
});

test('the schedule slot lists what is still due today, and says so when nothing is', async () => {
  const { renderSchedule } = require('../dist/telegram/telegram-live.format');
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
  assert.ok(!/FS Weekly/.test(today), 'tomorrow is not today');

  const empty = renderSchedule(
    { upcoming: [{ name: 'FS Weekly', at: at('2026-09-15T03:00:00Z') }] },
    clock,
  );
  assert.match(empty, /На сегодня запусков больше нет/);
  assert.match(empty, /Следующий:.*FS Weekly — завтра в 03:00/);

  const none = renderSchedule({ upcoming: [] }, clock);
  assert.match(none, /по расписанию ничего не запланировано/);
});

test('a cycle Veeam did not answer leaves the schedule honest about it', async () => {
  const w = world(LIVE);
  const veeam = veeamFake({
    '/api/v1/serverTime': () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok' };
  const monitor = new TelegramMonitorService(w.config, veeam, w.service, auth, w.store, w.live);

  await monitor.check();

  const texts = w.api.sent().map((m) => m.text);
  assert.ok(texts.some((t) => /Расписание недоступно/.test(t)));
  assert.ok(!texts.some((t) => /На сегодня запусков больше нет/.test(t)));
});

test('a long list fills the message to Telegram’s limit instead of an invented cap', async () => {
  const { renderSchedule, renderRunning } = require('../dist/telegram/telegram-live.format');
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
  assert.ok(long.length <= 4096, `message is ${long.length} characters`);
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

const assess = (overrides) => {
  const { assessProtection } = require('../dist/telegram/telegram-protection');
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  return assessProtection({
    jobs: [],
    pointsByJob: new Map(),
    streakByJob: new Map(),
    now,
    staleDays: 3,
    overdueFactor: 2.5,
    minStreak: 3,
    ...overrides,
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

  const { renderProtection } = require('../dist/telegram/telegram-protection');
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

  const { renderProtection } = require('../dist/telegram/telegram-protection');
  const text = renderProtection(snapshot, { now: new Date(now), timezone: 'UTC' });
  assert.match(text, /5 неуспехов подряд/);
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

  const { renderProtection } = require('../dist/telegram/telegram-protection');
  const clear = renderProtection(
    assess({ jobs: [{ id: '1', name: 'ok' }], pointsByJob: new Map([['1', points(now, 0.5, 1)]]) }),
    { now: new Date(now), timezone: 'UTC' },
  );
  assert.match(clear, /🟢 <b>Все задания защищены<\/b>/);
});

test('an unread scan admits it instead of claiming everything is protected', async () => {
  const { renderProtection } = require('../dist/telegram/telegram-protection');
  const text = renderProtection(
    { risks: [], totalJobs: 112, protectedJobs: 0, staleDays: 3, overdueFactor: 2.5, minStreak: 3,
      unavailable: 'Точки восстановления ещё не прочитаны.' },
    { now: new Date(), timezone: 'UTC' },
  );
  assert.match(text, /Защищённость не проверена/);
  assert.ok(!/Все задания защищены/.test(text));
});

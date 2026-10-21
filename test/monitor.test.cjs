const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// One harness for every test file. Everything it pulls out of dist/ is
// re-exported, so each file opens with the same line and takes what it needs.
const {
  CHAT, SERVER, telegramConfig, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService, monitorOf, monitorAccount,
  announcement, probe, capacities, capacityOf, jobReadsOf, serverOf, kingstonNight,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Monitor: the cycle
 *
 * What a command asks about the estate — a Job card, /points, the Summary —
 * is asked of the estate's answers, with no cycle behind them
 * (estate.test.cjs); what it offers next and /clear are the commands'
 * (commands.test.cjs). What is here needs a pass.
 * ------------------------------------------------------------------ */

test('an unreachable server is an answer, not an exception', async () => {
  const veeam = {
    request: async () => {
      throw new Error('connect ETIMEDOUT 192.0.2.1:9419');
    },
    reachability: VeeamHttpService.prototype.reachability,
  };

  // The health probe and the monitor ask the same question and must not be able
  // to answer it differently.
  assert.deepEqual(await veeam.reachability(), {
    reachable: false,
    error: 'connect ETIMEDOUT 192.0.2.1:9419',
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
  assert.match(sent[0].text, /SQL Daily — failed<\/b>/);
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
  assert.match(sent[0].text, /SQL Daily — succeeded/);
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);
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
  const auth = monitorAccount({
    getAccessToken: async () => {
      if (broken) throw new Error('Veeam API 401: Authentication failed');
      return 'tok';
    },
  });
  const monitor = monitorOf(w, veeam, auth);

  await monitor.check();
  const alerts = w.api.sent().filter((payload) => /cannot sign in/.test(payload.text));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Authentication failed/);
  assert.equal(monitor.status.authenticated, false);

  w.api.reset();
  await monitor.check();
  assert.equal(w.api.sent().length, 0, 'the same broken login must not alert every minute');

  broken = false;
  w.api.reset();
  await monitor.check();
  assert.match(w.api.sent()[0].text, /signs in again/);
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

  await monitor.check();
  w.api.reset();
  up = false;
  await monitor.check();
  assert.match(w.api.sent()[0].text, /Veeam is unreachable/);

  w.api.reset();
  up = true;
  await monitor.check();
  assert.match(w.api.sent()[0].text, /Veeam is reachable again/);
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

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
 * The evidence itself
 *
 * Asked directly rather than through a rendered Russian message. What one
 * reading establishes — which run wrote a point — is asked of the reading
 * itself, with no Veeam behind it (runs.test.cjs).
 * ------------------------------------------------------------------ */

test('evidence nothing has read yet says why, instead of an empty estate', async () => {
  const w = exchange();

  assert.deepEqual(w.evidence.evidence, {
    status: 'pending',
    reason: 'Точки восстановления ещё не прочитаны.',
  });

  // A cycle Veeam did not answer must not be reported as "no restore points".
  await w.evidence.refresh(false, undefined);
  assert.equal(w.evidence.evidence.status, 'pending');
  assert.match(w.evidence.evidence.reason, /не ответил/);
});

test('a scan that throws leaves the previous evidence standing', async () => {
  // Cadence zero, so the second refresh really re-scans rather than being
  // waved through by the gate — otherwise this would pass without ever
  // reaching the failure it is about. No operator may set zero, so it is set
  // on the config itself rather than through TELEGRAM_PROTECTION_INTERVAL_MIN.
  const w = exchange({ protectionIntervalMs: 0 });
  const jobs = [job('1', 'OPS_Exchange', 'Failed')];
  await w.evidence.refresh(true, jobs);
  const first = w.evidence.evidence;
  assert.equal(first.status, 'ready');

  let attempted = false;
  w.veeam.request = async () => {
    attempted = true;
    throw new Error('Veeam fell over mid-scan');
  };
  await w.evidence.refresh(true, jobs);

  assert.ok(attempted, 'the scan was re-run');
  assert.equal(w.evidence.evidence.status, 'ready', 'stale evidence beats no evidence');
  assert.equal(w.evidence.evidence.scannedAt, first.scannedAt);
});

test('with the 🧹 topic off, nothing points the reader at it', async () => {
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [job('1', 'CUST_live', 'Success')], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': {
      data: [
        { id: 'b1', jobId: '1', name: 'CUST_live' },
        // A chain whose job is gone: real, counted, but with nowhere to send
        // anyone while the topic that lists them does not exist.
        { id: 'b2', jobId: 'deleted-job', name: 'OPS_OFD_vms' },
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
  const topic = w.api.sent().find((m) => /требу(?:ет|ют) внимания|защищен/.test(m.text));
  assert.ok(!/🧹/u.test(topic.text), 'a pointer to a deleted topic is worse than no pointer');
  assert.ok(!/без заданий/u.test(topic.text));
  assert.ok(!w.api.sent().some((m) => /Бэкапы без заданий/.test(m.text)), 'and the slot is not published');
});

/* ------------------------------------------------------------------ *
 * What a job is owed
 * ------------------------------------------------------------------ */

test('the jobs left out of the check are said, once', async () => {
  // It used to be two copies of a predicate in two topics, and a comment
  // asking the next reader to keep the counts in the same order.
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [
    { id: '1', name: 'CUST_running', type: 'Backup', status: 'Stopped' },
    { id: '2', name: 'OPS_OLD', type: 'Backup', status: 'Disabled' },
    { id: '3', name: 'CUST_by_hand', type: 'Backup', status: 'Stopped' },
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
  const protection = sent.find((m) => /требу(?:ет|ют) внимания|защищен/.test(m.text));

  assert.match(protection.text, /<i>Не проверяются: 1 без расписания, 1 выключено<\/i>/);
  assert.ok(!sent.some((m) => /Точки восстановления/.test(m.text)), 'and there is no second topic to say it again');
});

test('a job is only excused on positive evidence, never on a gap', async () => {
  const { standingsOf } = require('../dist/estate/job-standing');
  const blank = {
    status: 'ready', scannedAt: 0, runsByJob: new Map(), cadenceByJob: new Map(),
    unscheduled: new Set(['known-manual']), provenByRuns: new Set(), streakByJob: new Map(), depthByJob: new Map(), retentionByJob: new Map(), fullsByJob: new Map(), backupsByJob: new Map(),
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
 * Driving the monitor from the group
 * ------------------------------------------------------------------ */

const said = (w, text) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  message: {
    message_id: 1,
    message_thread_id: 1,
    is_topic_message: true,
    text,
    chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
  },
});

test('/check runs a pass now and answers with what the monitor knows', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  w.api.reset();

  await said(w, '/check');

  const reply = w.api.sent().at(-1);
  assert.equal(reply.message_thread_id, undefined, 'answered in General');
  assert.match(reply.text, /Цикл проверки выполнен/);
  assert.match(reply.text, /Veeam отвечает:<\/b> 🟢 да/);
  assert.match(reply.text, /Заданий под наблюдением:<\/b> 1/);
});

test('/check asked twice in a row does not poll Veeam twice', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await said(w, '/check');
  const after = w.api.sent().length;

  await said(w, '/check');

  const reply = w.api.sent().at(-1);
  assert.match(reply.text, /уже была только что/);
  // Still answered — silence would read as a broken bot — but nothing was run.
  assert.equal(w.api.sent().length, after + 1);
});

test('/status carries the same health as /check, without running anything', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  w.api.reset();

  await said(w, '/status');

  const reply = w.api.sent().at(-1);
  assert.match(reply.text, /Учётная запись:<\/b> 🟢 да/);
  // The way to the rest is a button now, not a line telling somebody to type.
  const buttons = reply.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(buttons, ['📊 Сводка', '🔄 Проверить', '🤖 Команды']);
});

test('the summary and the running list cannot disagree about the count', async () => {
  const running = { id: '9', name: 'Started by hand', status: 'Disabled', lastResult: 'Success' };
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [running, job('1', 'SQL Daily', 'Success')], {
    '/api/v1/sessions': { data: [{ id: 's1', jobId: '9', state: 'Working', creationTime: '2026-09-16T10:00:00+05:00' }] },
  });

  await w.monitor.check();
  const live = w.api.sent().find((m) => /Сейчас выполня/.test(m.text));
  w.api.reset();
  await said(w, '/digest');

  assert.match(live.text, /Started by hand/, '▶️ видит запуск');
  assert.match(w.api.sent().at(-1).text, /Выполняются:<\/b> 1/, 'и сводка считает его же');
});

/* ------------------------------------------------------------------ *
 * Retries: one broken run, not three
 * ------------------------------------------------------------------ */

test('"none" never erases what was known about a job', () => {
  const { rememberedResult } = require('../dist/estate/job-state');

  // Veeam says "none" while a job is running. Recording it over a real result
  // is what lost every recovery and re-announced every retry.
  assert.equal(rememberedResult('none', 'failed'), 'failed');
  assert.equal(rememberedResult('none', 'success'), 'success');
  assert.equal(rememberedResult('failed', 'success'), 'failed');
  // Nothing known yet: "none" is the honest answer and is recorded.
  assert.equal(rememberedResult('none', undefined), 'none');
});

test('a run that fails, retries and finally succeeds is one alert and one recovery', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  w.api.reset();

  // It fails.
  w.setJobs([job('1', 'SQL Daily', 'Failed')]);
  await w.monitor.check();
  assert.equal(w.api.sent().length, 1, 'об отказе сообщено один раз');

  // Veeam retries: while the retry runs, the job reports no result at all.
  w.api.reset();
  w.setJobs([{ id: '1', name: 'SQL Daily', lastResult: 'None', status: 'Working' }]);
  await w.monitor.check();
  assert.deepEqual(w.api.sent(), [], 'запущенный повтор — не событие');

  // The retry fails too. This is the same broken run, and used to be announced
  // again because the remembered result had been overwritten with "none".
  w.setJobs([job('1', 'SQL Daily', 'Failed')]);
  await w.monitor.check();
  assert.deepEqual(w.api.sent(), [], 'тот же отказ не сообщается второй раз');

  // The next retry works. This is the message that never arrived at all.
  w.setJobs([job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  const sent = w.api.sent();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /SQL Daily — succeeded/);
});

test('an attempt is counted from the sessions behind it', () => {
  const { attemptOf, retryWindowOf, retriesAllowed } = require('../dist/estate/runs');
  const run = (started, ended, result) => ({ startedAt: started, endedAt: ended, result });
  // Newest first, ten minutes apart — Veeam retrying one run.
  const retried = [
    run('2026-09-17T03:54:49+05:00', '2026-09-17T03:55:08+05:00', 'Failed'),
    run('2026-09-17T03:02:45+05:00', '2026-09-17T03:44:00+05:00', 'Failed'),
    run('2026-09-16T23:46:16+05:00', '2026-09-17T02:52:00+05:00', 'Failed'),
  ];
  const window = retryWindowOf({ retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } });

  assert.equal(attemptOf(retried, window), 3);
  assert.equal(retriesAllowed({ retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } }), 4);

  // A run a day later is a different run, however it ended.
  const separate = [run('2026-09-18T03:00:00+05:00', '2026-09-18T03:20:00+05:00', 'Failed'), ...retried];
  assert.equal(attemptOf(separate, window), 1);
  assert.equal(retriesAllowed({ retry: { isEnabled: false } }), undefined, 'без повторов нечего считать');
});

test('the alert says which attempt it is', async () => {
  let sessions = [{ id: 's0', jobId: '1', result: { result: 'Success', message: 'ok' } }];
  const w = monitorWorld({}, [job('1', 'CORE_DBS03', 'Success')], {
    '/api/v1/jobs': { data: [{
      id: '1',
      schedule: { runAutomatically: true, retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } },
    }] },
    '/api/v1/sessions': () => ({ data: sessions }),
  });
  await w.monitor.check();
  w.api.reset();

  // Second attempt of one run: three identical messages a night were three of
  // these, and nothing in them said so.
  sessions = [
    { id: 's2', jobId: '1', creationTime: '2026-09-17T03:02:45+05:00', endTime: '2026-09-17T03:44:00+05:00',
      result: { result: 'Failed', message: 'Processing CORE-DACA03' } },
    { id: 's1', jobId: '1', creationTime: '2026-09-16T23:46:16+05:00', endTime: '2026-09-17T02:52:00+05:00',
      result: { result: 'Failed', message: 'Processing CORE-CORE01' } },
  ];
  w.setJobs([job('1', 'CORE_DBS03', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().at(-1);
  assert.match(alert.text, /CORE_DBS03 \(retry 1\) — failed<\/b>/, 'the second attempt is its first retry');
  assert.match(alert.text, /Processing CORE-DACA03/, 'и причина именно этой попытки');
});

/* ------------------------------------------------------------------ *
 * Job alerts: a failed run is followed until Veeam stops retrying it
 *
 * OPS_ERP_APP_DB1 on 30 September: four attempts from 03:12 to 05:37, all
 * failed. The one alert said "Попытка: 1 из 4", because a failure is announced
 * when the result changes, and the three retries changed nothing. Nobody was
 * told the run had ended with no point, nor which machine failed and why.
 *
 * Asked of the Job alerts module directly: a cycle's jobs and the Evidence go
 * in, the alerts it sends come out. Each of these used to take up to eight
 * whole monitor cycles through a fake Telegram, and a test that needed the
 * wait for a retry to run out had to reach into the state file to fake it.
 * ------------------------------------------------------------------ */

const { JobAlerts } = require('../dist/monitor/job-alerts');
const { JobMemory } = require('../dist/telegram/job-memory');
const { jobOf } = require('../dist/veeam/estate');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (ms) => new Date(ms).toISOString();
const VDDK =
  'Processing APPDB1-T3Q4 Error: Failed to open VDDK disk [[SITE1_SSD_DATA09] APPDB1-T3Q4/APPDB1-T3Q4_1.vmdk] ( is read-only mode - [true] )\r\n' +
  'Logon attempt with parameters [VC/ESX: [192.0.2.194];Port: 443;Login: [svc@example.com];VMX Spec: [moref=vm-31466]]\r\n' +
  'Failed to open disk for read.\r\n' +
  "Failed to upload disk 'vddkConnSpec>'\r\n" +
  'Agent failed to process method {DataTransfer.SyncDisk}.';
/** VDDK as the Job reads hand it on: the reason, without the connection parameters and the agent's call stack. */
const VDDK_REASON =
  'Failed to open VDDK disk [[SITE1_SSD_DATA09] APPDB1-T3Q4/APPDB1-T3Q4_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.';
const RETRY_FOUR = { runAutomatically: true, retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } };

/** What an alert says under its title, as it is sent. */
const textOf = (event) => event.lines.join('\n');

/**
 * APP_DB1's Job alerts, driven attempt by attempt. `attempt(n)` puts the n-th
 * attempt's session in front and has Veeam report the job accordingly;
 * `check()` is one cycle. The clock is the test's own, moved by `later`.
 */
const retriedNight = ({ schedule = RETRY_FOUR, status = 'Inactive' } = {}) => {
  let now = Date.now();
  // The first attempt started an hour ago and has just ended; each retry
  // starts after the one before it ended, seconds apart, which is all the rule
  // folding them needs.
  const starts = [now - 60 * MINUTE, now - 50_000, now - 8_000, now - 5_000];
  const ends = [now - 1 * MINUTE, now - 10_000, now - 6_000, now - 1_000];
  let sessions = [];
  let state = { lastResult: 'Success', status, lastRun: at(now - DAY) };
  let delivers = true;
  const sent = [];

  const reads = jobReadsOf({
    sessions: () => sessions,
    machines: Object.fromEntries([1, 2, 3, 4].map((n) => [`a${n}`, [{ name: 'APPDB1-T3Q4', result: 'failed', message: VDDK_REASON }]])),
  });
  const memory = new JobMemory({ results: {}, retrying: {} }, () => {});
  const send = async (event) => {
    if (!delivers) return { outcome: 'failed' };
    sent.push(event);
    return { outcome: 'delivered' };
  };
  const alerts = new JobAlerts({ name: 'veeam01main', reads }, memory, send, { timezone: 'UTC', cooldownMs: 0, now: () => now });
  const evidence = { status: 'ready', schedulesByJob: new Map([['1', schedule]]) };
  const session = (n, result, ended = ends[n - 1]) => ({
    id: `a${n}`, startedAt: at(starts[n - 1]),
    // A session still going has no result yet.
    endedAt: ended === null ? undefined : at(ended), result: ended === null ? 'none' : result.toLowerCase(), message: 'Processing APPDB1-T3Q4',
  });

  return {
    sent,
    memory,
    ends,
    /** Reads of this job's sessions so far. */
    get reads() {
      return reads.asked;
    },
    /** Whether Telegram takes what is sent. */
    set delivers(value) {
      delivers = value;
    },
    check: () =>
      alerts.check([jobOf({ id: '1', name: 'OPS_ERP_APP_DB1', type: 'Backup', objectsCount: 1, ...state })], evidence),
    /**
     * The n-th attempt ended with `result`; `ended: null` means it is still
     * running. `reported` is the job's result as Veeam's job list gives it,
     * when it is not the one that follows from that.
     */
    attempt(n, result = 'Failed', { ended, reported } = {}) {
      sessions = [session(n, result, ended), ...sessions.filter((s) => s.id !== `a${n}`)];
      const running = ended === null;
      state = { lastResult: reported ?? (running ? 'None' : result), status: running ? 'Working' : status, lastRun: at(starts[n - 1]) };
    },
    later(ms) {
      now += ms;
    },
  };
};

test('the first failure says Veeam will try again, and which machine failed and why', async () => {
  const night = retriedNight();
  await night.check();

  night.attempt(1);
  await night.check();

  assert.equal(night.sent.length, 1);
  const [alert] = night.sent;
  const retryAt = new Date(night.ends[0] + 10 * MINUTE);
  const hhmm = `${String(retryAt.getUTCHours()).padStart(2, '0')}:${String(retryAt.getUTCMinutes()).padStart(2, '0')}`;
  assert.equal(alert.title, 'OPS_ERP_APP_DB1 — failed');
  assert.match(textOf(alert), new RegExp(`\n\n🔁 Veeam will retry ≈ .*${hhmm} \\(retry 1\\)\\.`));
  assert.ok(alert.lines.includes(`❌ <b>APPDB1-T3Q4</b> — ${VDDK_REASON}`), 'the machine, and why');
  // Not running is what every job an alert is about is doing.
  assert.match(alert.lines[0], /^<i>VM backup · started .* · ran 59 min<\/i>$/);
  assert.equal(night.memory.retryingOf('1').attempt, 1, 'запуск запомнен до конца повторов');
});

test('the retries in between say nothing, and the last one says the run is over', async () => {
  const night = retriedNight();
  await night.check();
  night.attempt(1);
  await night.check();
  night.sent.length = 0;

  night.attempt(2, 'Failed', { ended: null });
  await night.check();
  night.attempt(2);
  await night.check();
  night.attempt(3);
  await night.check();
  assert.deepEqual(night.sent, [], 'повторы, у которых есть ещё попытки, — не событие');
  assert.equal(night.memory.retryingOf('1').attempt, 3);

  night.attempt(4);
  await night.check();
  const [last] = night.sent;
  assert.equal(last.title, 'OPS_ERP_APP_DB1 (retry 3) — failed, no more retries');
  assert.match(textOf(last), /\n\n⛔ No more retries\.$/);
  assert.match(textOf(last), /❌ <b>APPDB1-T3Q4<\/b> — Failed to open VDDK disk/);
  assert.equal(night.memory.retryingOf('1'), undefined);

  await night.check();
  assert.equal(night.sent.length, 1, 'и сказано один раз');
});

test('following a run reads nothing until Veeam starts another attempt', async () => {
  const night = retriedNight();
  await night.check();
  night.attempt(1);
  await night.check();
  const before = night.reads;

  // The ten minutes' wait, a cycle a minute.
  for (let i = 0; i < 3; i += 1) {
    night.later(MINUTE);
    await night.check();
  }
  night.attempt(2, 'Failed', { ended: null });
  await night.check();

  assert.equal(night.reads, before, 'ни ожидание, ни идущая попытка не стоят запроса');
  night.attempt(2);
  await night.check();
  assert.equal(night.reads, before + 1, 'закончившаяся попытка — один');
});

test('a failure first read while Veeam is already retrying says so, and the run is followed', async () => {
  const night = retriedNight();
  await night.check();

  // The first attempt failed while the bot was not looking, and the second is
  // running as it looks: the job list still says failed. Read as ending in
  // an attempt with no result, the run used to be called over.
  night.attempt(1);
  night.attempt(2, 'Failed', { ended: null, reported: 'Failed' });
  await night.check();

  const [alert] = night.sent;
  assert.equal(alert.title, 'OPS_ERP_APP_DB1 — failed');
  assert.match(textOf(alert), /\n\n🔁 Retry 1 is running now\.$/);
  assert.match(textOf(alert), /❌ <b>APPDB1-T3Q4<\/b> — Failed to open VDDK disk/, 'причина — из попытки, что упала');
  assert.equal(night.memory.retryingOf('1').attempt, 2);

  // It fails, and so do the two after it: the last word comes, once.
  for (const n of [2, 3]) {
    night.attempt(n);
    await night.check();
  }
  assert.equal(night.sent.length, 1);
  night.attempt(4);
  await night.check();
  assert.equal(night.sent.at(-1).title, 'OPS_ERP_APP_DB1 (retry 3) — failed, no more retries');
  assert.equal(night.sent.length, 2);
});

test('a job only a hand can start is promised no retry, and not waited on', async () => {
  // Veeam retries only the runs it starts itself. Both of these ran because
  // somebody started them, whatever their retry settings say.
  const byHand = retriedNight({ schedule: { ...RETRY_FOUR, runAutomatically: false } });
  const switchedOff = retriedNight({ status: 'Disabled' });

  for (const night of [byHand, switchedOff]) {
    await night.check();
    night.attempt(1);
    await night.check();
    night.later(DAY);
    await night.check();

    assert.equal(night.sent.length, 1, 'одно сообщение, без «повторов больше не будет» полчаса спустя');
    assert.equal(night.sent[0].title, 'OPS_ERP_APP_DB1 — failed');
    assert.doesNotMatch(textOf(night.sent[0]), /retr/i, 'повтора не обещано');
    assert.equal(night.memory.retryingOf('1'), undefined);
  }
  assert.match(switchedOff.sent[0].lines[0], / · disabled in Veeam<\/i>$/);
  assert.doesNotMatch(byHand.sent[0].lines[0], /disabled/);
});

test('a run Veeam stopped retrying early is called over once the wait has passed', async () => {
  const night = retriedNight();
  await night.check();
  night.attempt(1);
  await night.check();
  night.sent.length = 0;

  // Inside the ten-minute wait, nothing is late yet.
  night.later(9 * MINUTE);
  await night.check();
  assert.deepEqual(night.sent, []);

  // Forty minutes on and no second attempt: past the wait and the allowance
  // for a slow start.
  night.later(31 * MINUTE);
  await night.check();
  const [last] = night.sent;
  assert.equal(last.title, 'OPS_ERP_APP_DB1 — failed, no more retries');
  assert.match(textOf(last), /\n\n⛔ No more retries\.$/);
});

test('a retry that works is a recovery that says which attempt did it', async () => {
  const night = retriedNight();
  await night.check();
  night.attempt(1);
  await night.check();
  night.sent.length = 0;

  night.attempt(2, 'Success');
  await night.check();

  const [recovered] = night.sent;
  assert.equal(recovered.title, 'OPS_ERP_APP_DB1 (retry 1) — succeeded');
  // The attempt that worked, and nothing about machines or what comes next.
  assert.equal(recovered.lines.length, 1);
  assert.match(recovered.lines[0], /^<i>VM backup · started .* · ran 40 s<\/i>$/);
  assert.equal(night.memory.retryingOf('1'), undefined);
});

test('an alert that reached nobody is not remembered, and is sent again next cycle', async () => {
  const night = retriedNight();
  await night.check();

  night.attempt(1);
  night.delivers = false;
  await night.check();
  assert.equal(night.memory.resultOf('1'), 'success', 'отказ всё ещё новость');
  assert.equal(night.memory.retryingOf('1'), undefined);

  night.delivers = true;
  await night.check();
  assert.equal(night.sent.length, 1);
  assert.equal(night.memory.resultOf('1'), 'failed');
  assert.equal(night.memory.retryingOf('1').attempt, 1);

  // The last word too: undelivered, the run stays followed.
  for (const n of [2, 3]) {
    night.attempt(n);
    await night.check();
  }
  night.attempt(4);
  night.delivers = false;
  await night.check();
  assert.equal(night.memory.retryingOf('1').attempt, 3, 'не доставлено — не забыто');
  night.delivers = true;
  await night.check();
  assert.equal(night.sent.at(-1).title, 'OPS_ERP_APP_DB1 (retry 3) — failed, no more retries');
  assert.equal(night.memory.retryingOf('1'), undefined);
});

test('the monitor hands every server\'s jobs to its Job alerts, and the run followed is kept in the state file', async () => {
  const now = Date.now();
  let sessions = [];
  const emm = (lastResult, lastRun) => ({
    id: '1', name: 'OPS_ERP_APP_DB1', type: 'Backup', status: 'Inactive', lastResult, lastRun, objectsCount: 1,
  });
  const failed = (id, start, end) => ({
    id, jobId: '1', sessionType: 'BackupJob', creationTime: at(start), endTime: at(end),
    result: { result: 'Failed', message: 'Processing APPDB1-T3Q4' },
  });
  const w = monitorWorld({ TELEGRAM_TIMEZONE: 'UTC' }, [emm('Success', at(now - DAY))], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: RETRY_FOUR }] },
    '/api/v1/sessions': () => ({ data: sessions }),
  });
  await w.monitor.check();

  sessions = [failed('a1', now - 60 * MINUTE, now - MINUTE)];
  w.setJobs([emm('Failed', at(now - 60 * MINUTE))]);
  await w.monitor.check();
  assert.match(w.api.sent().at(-1).text, /\n\n🔁 Veeam will retry ≈ .* \(retry 1\)\./);
  assert.equal(w.store.snapshot().retrying[SERVER]['1'].attempt, 1, 'в файле состояния');

  sessions = [
    failed('a4', now - 5_000, now - 1_000),
    failed('a3', now - 8_000, now - 6_000),
    failed('a2', now - 50_000, now - 10_000),
    ...sessions,
  ];
  w.setJobs([emm('Failed', at(now - 5_000))]);
  await w.monitor.check();
  assert.match(w.api.sent().at(-1).text, /OPS_ERP_APP_DB1 \(retry 3\) — failed, no more retries/);
  assert.equal(w.store.snapshot().retrying[SERVER]['1'], undefined);
});

/* ------------------------------------------------------------------ *
 * A session's message is shown as it is worth showing, everywhere
 *
 * OPS_Kingston_vCenters' night (world.cjs), asked of the alert and the Job
 * reads here, and of the Job card in estate.test.cjs.
 * ------------------------------------------------------------------ */

test('an alert with no machine to list gives the session\'s reason, without the connection parameters', async () => {
  const w = monitorWorld({}, [job('1', 'OPS_Kingston_vCenters', 'Success')], {
    '/api/v1/sessions': { data: [kingstonNight('n2', 29)] },
  });
  await w.monitor.check();

  w.setJobs([job('1', 'OPS_Kingston_vCenters', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().at(-1).text;
  assert.match(alert, /\n\ncomp01vc01 — Cannot get service content\. \/ Soap fault\. Temporary failure in name resolution(\n|$)/);
  assert.doesNotMatch(alert, /Logon attempt|svc@example\.com/);
});

test('the Job reads hand on a machine\'s reason, the session\'s for the machine it blames, and never the connection parameters', async () => {
  const { reads } = serverOf(world(), veeamFake({
    '/api/v1/sessions': { data: [kingstonNight('n2', 29)] },
    '/api/v1/sessions/n2/taskSessions': { data: [
      // Its own task says only the step it stopped at.
      { name: 'comp01vc01', result: { result: 'Failed', message: 'Getting VM info from vSphere' } },
      { name: 'mgmt01vc01', result: { result: 'Failed', message: 'Processing mgmt01vc01 Error: Disk full' } },
      { name: 'ok01', result: { result: 'Success', message: 'Success' } },
      { name: 'APPDB1-T3Q4', result: { result: 'Failed', message: VDDK } },
    ] },
  }));

  const [session] = await reads.sessionsOf({ id: '1', name: 'OPS_Kingston_vCenters', result: 'failed' });

  assert.equal(session.message, 'comp01vc01 — Cannot get service content. / Soap fault. Temporary failure in name resolution');
  assert.deepEqual(await reads.machinesOf(session), [
    { name: 'comp01vc01', result: 'failed', message: 'Cannot get service content. / Soap fault. Temporary failure in name resolution' },
    { name: 'mgmt01vc01', result: 'failed', message: 'Disk full' },
    { name: 'ok01', result: 'success', message: 'Success' },
    { name: 'APPDB1-T3Q4', result: 'failed', message: VDDK_REASON },
  ]);
});

test('an alert lists at most five machines of a kind and counts the rest', () => {
  const { machineLines } = require('../dist/monitor/job-alerts');
  const objects = [
    ...Array.from({ length: 7 }, (_, i) => ({ name: `vm${i}`, result: 'failed', message: 'x'.repeat(400) })),
    { name: 'ok', result: 'success' },
    { name: 'slow', result: 'warning', message: 'Removing VM snapshot' },
  ];

  const lines = machineLines(objects, 'Processing vm0');

  assert.equal(lines.filter((line) => line.startsWith('❌ <b>vm')).length, 5);
  assert.deepEqual(lines.slice(5), ['… and 2 more failed', '⚠️ <b>slow</b> — Removing VM snapshot', '✅ 1 other machine — no errors']);
  assert.ok(lines.every((line) => line.length < 340), 'длинная причина обрезана');
  // Nothing named: the session's own message is the whole story.
  assert.deepEqual(machineLines([{ name: 'ok', result: 'success' }], 'Virtual Machine X is unavailable'), ['Virtual Machine X is unavailable']);
  assert.deepEqual(machineLines([{ name: 'a&b', result: 'failed', message: '<none>' }]), ['❌ <b>a&amp;b</b> — &lt;none&gt;']);
});

test('an alert names a Full and a retry the way Veeam\'s console names the session', async () => {
  const night = retriedNight();
  await night.check();
  night.attempt(1);
  await night.check();
  assert.equal(night.sent[0].title, 'OPS_ERP_APP_DB1 — failed', 'a first attempt at an increment says neither');

  const reads = jobReadsOf({
    sessions: [{ id: 'f1', startedAt: at(Date.now() - 50 * MINUTE), endedAt: at(Date.now() - MINUTE), result: 'failed' }],
    machines: { f1: [
      { name: 'new01', algorithm: 'increment', result: 'success' },
      { name: 'db01', algorithm: 'full', result: 'failed', message: 'Disk full' },
      { name: 'db02', algorithm: 'full', result: 'success' },
    ] },
  });
  const sent = [];
  const alerts = new JobAlerts({ name: 'veeam01main', reads }, new JobMemory({ results: { 1: 'success' }, retrying: {} }, () => {}), async (event) => {
    sent.push(event);
    return { outcome: 'delivered' };
  }, { timezone: 'UTC', cooldownMs: 0 });
  await alerts.check([jobOf({ id: '1', name: 'OPS_Files', type: 'Backup', status: 'Inactive', lastResult: 'Failed' })], { status: 'ready', schedulesByJob: new Map([['1', RETRY_FOUR]]) });
  // Two machines of three took a Full: the run was one.
  assert.equal(sent[0].title, 'OPS_Files (Full) — failed');
});

test('a job alert says when the job ran and runs next as people write it, in the operator\'s zone', async () => {
  // As Veeam reports them, and as they reached the chat until now:
  // "2026-09-30T01:21:14.7+05:00".
  const esb = (lastResult, lastRun, nextRun) => ({
    id: '1', name: 'OPS_ERP_ESB_DB', type: 'Backup', status: 'Stopped',
    lastResult, lastRun, nextRun, objectsCount: 2,
  });
  const w = monitorWorld({ TELEGRAM_TIMEZONE: 'Asia/Qyzylorda' }, [
    esb('Success', '2026-09-15T01:21:00+05:00', '2026-09-16T01:21:00+05:00'),
  ]);
  await w.monitor.check();

  w.setJobs([esb('Failed', '2026-09-16T01:21:14.7+05:00', '2026-09-17T01:21:00+05:00')]);
  await w.monitor.check();
  const failed = w.api.sent().at(-1).text;
  assert.match(failed, /started on 16\.09 at 01:21/);
  assert.match(failed, /⏭ Next scheduled run: on 17\.09 at 01:21\./);
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(failed), `no ISO string is left: ${failed}`);

  // The recovery is written the same way; in UTC it would read 20:21 the day before.
  w.setJobs([esb('Success', '2026-09-17T01:21:00+05:00', '2026-09-18T01:21:00+05:00')]);
  await w.monitor.check();
  const recovered = w.api.sent().at(-1).text;
  assert.match(recovered, /— succeeded/);
  assert.match(recovered, /started on 17\.09 at 01:21/);
});

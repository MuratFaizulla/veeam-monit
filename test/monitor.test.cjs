const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// One harness for every test file. Everything it pulls out of dist/ is
// re-exported, so each file opens with the same line and takes what it needs.
const {
  CHAT, telegramConfig, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService,
  announcement, probe, capacities, capacityOf,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Monitor
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {}, rejectToken: () => true };
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {}, rejectToken: () => true };
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {}, rejectToken: () => true };
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
  const auth = { configured: true, username: 'svc', getAccessToken: async () => 'tok', invalidateAccessToken: () => {}, rejectToken: () => true };
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
 * The evidence itself
 *
 * Session attribution used to be assertable only by driving a whole cycle and
 * grepping a rendered Russian message for a date format owned by a third
 * module. These ask the evidence directly.
 * ------------------------------------------------------------------ */

test('the evidence attributes each point to the run that was on the clock', async () => {
  const w = exchange();
  await w.evidence.refresh('tok', [job('1', 'OPS_Exchange', 'Failed')]);
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
  const jobs = [job('1', 'OPS_Exchange', 'Failed')];
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
  const topic = w.api.sent().find((m) => /Точки восстановления/.test(m.text));
  assert.ok(!/🧹/u.test(topic.text), 'a pointer to a deleted topic is worse than no pointer');
  assert.ok(!/без заданий/u.test(topic.text));
  assert.ok(!w.api.sent().some((m) => /Бэкапы без заданий/.test(m.text)), 'and the slot is not published');
});

/* ------------------------------------------------------------------ *
 * What a job is owed
 * ------------------------------------------------------------------ */

test('both slots are told the same thing about which jobs are in scope', async () => {
  // The invariant that used to be two copies of a predicate and a comment
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

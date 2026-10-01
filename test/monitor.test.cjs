const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// One harness for every test file. Everything it pulls out of dist/ is
// re-exported, so each file opens with the same line and takes what it needs.
const {
  CHAT, SERVER, telegramConfig, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService, monitorOf, monitorAccount,
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
  assert.match(sent[0].text, /Результат:<\/b> ошибка/);
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

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
  const jobs = [job('1', 'TTC_Exchange', 'Failed')];
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
  const { standingsOf } = require('../dist/estate/job-standing');
  const blank = {
    status: 'ready', scannedAt: 0, runsByJob: new Map(), cadenceByJob: new Map(),
    unscheduled: new Set(['known-manual']), provenByRuns: new Set(), streakByJob: new Map(), depthByJob: new Map(), retentionByJob: new Map(),
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

test('an approximate name finds the job somebody meant', () => {
  const { matchJob } = require('../dist/estate/job-card');
  const jobs = [
    { id: '1', name: 'TTC_Veeam_DB_Konaev' },
    { id: '2', name: 'TTC_Konaev_EM_DB' },
    { id: '3', name: 'TTC_Exchange' },
  ];

  assert.deepEqual(matchJob(jobs, 'ttc_exchange'), { found: 'one', job: jobs[2] });
  // The words in the other order, separated by underscores nobody types.
  assert.deepEqual(matchJob(jobs, 'konaev em'), { found: 'one', job: jobs[1] });
  assert.deepEqual(matchJob(jobs, 'нет такого'), { found: 'none' });
});

test('a name that fits several jobs is listed, never guessed at', () => {
  const { matchJob } = require('../dist/estate/job-card');
  const jobs = [{ id: '1', name: 'TTC_Veeam_DB_Konaev' }, { id: '2', name: 'TTC_Konaev_EM_DB' }];

  // Answering confidently about the wrong job is worse than answering with a
  // list: the asker would have no way of noticing.
  const match = matchJob(jobs, 'konaev');

  assert.equal(match.found, 'many');
  // The jobs, not their names: a button has to address what it opens.
  assert.deepEqual(match.jobs.map((j) => j.name), ['TTC_Konaev_EM_DB', 'TTC_Veeam_DB_Konaev']);
  assert.deepEqual(match.jobs.map((j) => j.id), ['2', '1']);
});

test('/job answers about one job, which no live topic can', async () => {
  const w = exchange();
  await w.monitor.check();
  w.api.reset();

  await said(w, '/job exchange');

  const reply = w.api.sent().at(-1);
  assert.equal(reply.message_thread_id, undefined, 'answered in General');
  assert.match(reply.text, /TTC_Exchange/);
  assert.match(reply.text, /Последний результат:<\/b> ошибка/);
  assert.match(reply.text, /<i>бэкап ВМ/, 'the kind of job in words, not Veeam\'s "Backup"');
  assert.match(reply.text, /Точки восстановления/);
  assert.match(reply.text, /Последние запуски/);
});

test('/job without a name says how to use it instead of failing', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);

  await said(w, '/job');

  assert.match(w.api.sent().at(-1).text, /Укажите задание/);
});

test('/digest counts every job and names the ones that went wrong', async () => {
  const w = monitorWorld({}, [
    job('1', 'SQL Daily', 'Failed'),
    job('2', 'Files', 'Success'),
    job('3', 'Exchange', 'Warning'),
  ]);

  await said(w, '/digest');

  const reply = w.api.sent().at(-1);
  assert.match(reply.text, /Всего заданий:<\/b> 3/);
  assert.match(reply.text, /Успешно:<\/b> 1/);
  // The same rendering the daily message uses: a plain list in a <pre> block,
  // marked with the icons every other message uses for the two results.
  assert.match(reply.text, /🔴 SQL Daily/);
  assert.match(reply.text, /🟡 Exchange/);
  assert.doesNotMatch(reply.text, /FAILED|WARNING/);
});

test('a summary asked for in General is answered in General', async () => {
  const w = monitorWorld({ TELEGRAM_ROUTING_MODE: 'single' }, [job('1', 'SQL Daily', 'Success')]);

  await w.updates.handleUpdate({
    update_id: 7,
    message: {
      message_id: 1,
      text: '/digest',
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  });

  // Routed as an event, a clean summary would land in the recoveries topic by
  // its severity — nowhere near whoever asked for it. An answer is not an event.
  const reply = w.api.sent().at(-1);
  assert.equal(reply.message_thread_id, undefined, 'в General, а не в теме по severity');
  assert.equal(w.api.of('createForumTopic').length, 0, 'и без создания темы');
});

test('/help names every command the bot answers', async () => {
  const w = monitorWorld({}, []);

  await said(w, '/help');

  const reply = w.api.sent().at(-1);
  for (const command of ['/status', '/check', '/digest', '/job', '/topics']) {
    assert.ok(reply.text.includes(command), `${command} описан`);
  }
});

/**
 * TTC_ASUEDT_EMM_DB1 as this VBR actually reports it: three days a week at
 * 03:12, four twenty-second retries that all failed on the same unreachable
 * machine, and a fifth run that worked.
 */
const configured = () => monitorWorld({}, [
  {
    id: '1', name: 'TTC_ASUEDT_EMM_DB1', type: 'Backup', status: 'Stopped',
    lastResult: 'Failed', lastRun: '2026-09-16T03:44:58+05:00',
    nextRun: '2026-09-18T03:12:00+05:00', objectsCount: 1,
  },
], {
  '/api/v1/jobs/1': {
    id: '1', name: 'TTC_ASUEDT_EMM_DB1',
    schedule: {
      runAutomatically: true,
      // Veeam lists the days in its own order; the card must not.
      daily: { isEnabled: true, dailyKind: 'SelectedDays', localTime: '03:12',
        days: ['friday', 'monday', 'wednesday'] },
      retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 },
    },
    storage: {
      backupRepositoryId: 'repo-6',
      backupProxies: { autoSelectEnabled: true, proxyIds: [] },
      retentionPolicy: { type: 'Days', quantity: 7 },
      advancedSettings: {
        backupModeType: 'Incremental',
        activeFulls: { isEnabled: true, weekly: { isEnabled: true, days: ['saturday'] } },
      },
    },
    virtualMachines: {
      includes: [{ name: 'EMMDB1-T3Q4', hostName: '192.0.2.194', size: '3,9 TB' }],
      excludes: { vms: [] },
    },
  },
  '/api/v1/backupInfrastructure/repositories': { data: [{ id: 'repo-6', name: 'AST01_FAS8200_7K_BKP06' }] },
  '/api/v1/backupInfrastructure/proxies': { data: [{ id: 'p1', name: '192.0.2.20' }] },
  '/api/v1/sessions': { data: [{
    id: 'sess-bad', jobId: '1',
    creationTime: '2026-09-16T03:44:58+05:00', endTime: '2026-09-16T03:45:17+05:00',
    result: { result: 'Failed', message: 'Virtual Machine EMMDB1-T3Q4 is unavailable and will be skipped from processing' },
  }] },
  '/api/v1/sessions/sess-bad/taskSessions': { data: [{
    name: 'EMMDB1-T3Q4', state: 'Stopped',
    result: { result: 'Failed', message: 'Getting VM info from vSphere' },
  }] },
});

test('/job shows how the job is set up, not just how it ran', async () => {
  const w = configured();

  await said(w, '/job EMM_DB1');

  const reply = w.api.sent().at(-1).text;
  assert.match(reply, /Расписание:<\/b> пн, ср, пт в 03:12/, 'дни в порядке недели');
  assert.match(reply, /Повтор при ошибке:<\/b> 3 раза через 10 мин/);
  assert.match(reply, /Репозиторий:<\/b> AST01_FAS8200_7K_BKP06/, 'имя, а не id');
  assert.match(reply, /Прокси:<\/b> автоматически/);
  assert.match(reply, /Хранение:<\/b> 7 дней/);
  assert.match(reply, /Режим:<\/b> Incremental, активный полный: сб/);
  assert.match(reply, /Машины \(1\)/);
  assert.match(reply, /EMMDB1-T3Q4 — 3,9 TB · 192\.0\.2\.194/);
});

test('/job names the machine that failed, which the job name never does', async () => {
  const w = configured();

  await said(w, '/job EMM_DB1');

  const reply = w.api.sent().at(-1).text;
  assert.match(reply, /Что именно не прошло/);
  // The task says only the step it stopped at; the session says, of the same
  // machine, why. The machine's own error is the one worth reading.
  assert.match(reply, /🔴 EMMDB1-T3Q4 — Virtual Machine EMMDB1-T3Q4 is unavailable and will be skipped/);
  assert.doesNotMatch(reply, /Getting VM info/);
});

test('a job that is not failing is not asked which machine failed', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);

  await said(w, '/job SQL');

  // The per-object read costs a request and answers a question nobody asked:
  // a recovered job's failures are already in its run list.
  assert.doesNotMatch(w.api.sent().at(-1).text, /Что именно не прошло/);
});

test('a schedule is read the way Veeam means it', () => {
  const { describeSchedule, describeRetry } = require('../dist/estate/schedule-planner');

  assert.equal(describeSchedule({ runAutomatically: true, daily: { isEnabled: true, dailyKind: 'Everyday', localTime: '22:00' } }), 'ежедневно в 22:00');
  assert.equal(describeSchedule({ runAutomatically: true, daily: { isEnabled: true, dailyKind: 'WeekDays', localTime: '03:00' } }), 'по рабочим дням в 03:00');
  assert.equal(describeSchedule({ runAutomatically: true, periodically: { isEnabled: true, periodicallyKind: 'Hours', frequency: 4 } }), 'каждые 4 ч');
  assert.equal(describeSchedule({ runAutomatically: true, afterThisJob: { isEnabled: true, jobName: 'TTC_Exchange' } }), 'после «TTC_Exchange»');
  // A filled-in schedule Veeam will never act on would otherwise be described
  // as if it ran three times a week.
  assert.equal(
    describeSchedule({ runAutomatically: false, daily: { isEnabled: true, dailyKind: 'Everyday', localTime: '22:00' } }),
    'только вручную',
  );
  assert.equal(describeRetry({ retry: { isEnabled: false } }), 'выключен');
});

test('a named proxy is told apart from automatic selection', () => {
  const { settingsOf } = require('../dist/estate/job-card');
  const names = {
    repositories: new Map([['r1', 'AST01_BKP06']]),
    proxies: new Map([['p1', '192.0.2.20'], ['p2', '192.0.2.21']]),
  };

  const chosen = settingsOf({ storage: { backupProxies: { autoSelectEnabled: false, proxyIds: ['p1', 'p2'] } } }, names);
  assert.equal(chosen.proxies, '192.0.2.20, 192.0.2.21');

  // An empty proxyIds list means "Veeam picks" only when the flag says so;
  // without reading the flag the two are indistinguishable.
  const auto = settingsOf({ storage: { backupProxies: { autoSelectEnabled: true, proxyIds: [] } } }, names);
  assert.equal(auto.proxies, 'автоматически');
});

test('a monthly Active Full is said, not dropped', () => {
  // TTC_Billing_Prod takes its fulls every third Wednesday; the card said
  // nothing about fulls at all.
  const { settingsOf } = require('../dist/estate/job-card');
  const names = { repositories: new Map(), proxies: new Map() };
  const advancedSettings = {
    backupModeType: 'Incremental',
    activeFulls: {
      isEnabled: true,
      weekly: { isEnabled: false, days: ['saturday'] },
      monthly: { isEnabled: true, dayOfWeek: 'wednesday', dayNumberInMonth: 'Third' },
    },
    synthenticFulls: { isEnabled: false, weekly: { isEnabled: true, days: ['saturday'] } },
  };
  assert.equal(
    settingsOf({ storage: { advancedSettings } }, names).mode,
    'Incremental, активный полный: ежемесячно, 3-я ср',
  );
});

test('the card names the chain being written', () => {
  const { renderJobCard } = require('../dist/estate/job-card');
  const now = Date.UTC(2026, 9, 1, 7);
  const at = (day) => Date.UTC(2026, 8, day, 20);
  const card = renderJobCard(
    {
      name: 'ESBTST', type: 'Backup', disabled: false, lastResult: 'success',
      sessions: [], sessionsCut: false, retryWindowMs: 0, failedObjects: [], machines: [], excluded: 0, cadenceDays: 1,
      depth: { runs: 11, points: 43, machines: 4, oldest: at(19), newest: now,
        chain: { fulls: 2, lastFull: at(26), sinceFull: 4 } },
    },
    { now: new Date(now), timezone: 'UTC' },
  );
  assert.match(card, /Цепочка: Full 26\.09 \+ 4 инкр\./u);
});

test('the reason is said once: at length by object, or briefly by run', async () => {
  const detailed = configured();
  await said(detailed, '/job EMM_DB1');
  // The per-object block is about to say this at length; saying it twice is
  // how the card turned into a wall of the same Veeam paragraph.
  assert.doesNotMatch(detailed.api.sent().at(-1).text, /<b>Причина:<\/b>/);

  // Where a run failed before it reached any object, there is no per-object
  // block and the session message is the whole story.
  const plain = monitorWorld({}, [job('1', 'SQL Daily', 'Failed')]);
  await said(plain, '/job SQL');
  const reply = plain.api.sent().at(-1).text;
  assert.match(reply, /<b>Причина:<\/b> Agent failed to process method/);
  assert.doesNotMatch(reply, /Что именно не прошло/);
});

/* ------------------------------------------------------------------ *
 * The menu and the buttons
 * ------------------------------------------------------------------ */

const pressed = (w, data) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  callback_query: {
    id: 'cb-1',
    data,
    from: { id: 42, first_name: 'Оператор' },
    message: {
      message_id: 9,
      message_thread_id: 1,
      is_topic_message: true,
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  },
});

test('a button and its reader cannot disagree about what it means', () => {
  const { encode, decode } = require('../dist/updates/keyboard');
  const { BOT_COMMANDS } = require('../dist/updates/commands');

  for (const action of [{ kind: 'summary' }, { kind: 'check' }, { kind: 'help' }, { kind: 'status' }]) {
    assert.deepEqual(decode(encode(action)), action, `${action.kind} выживает круг`);
  }
  // The longest key configuration allows, beside a GUID.
  const job = { kind: 'job', id: '1e218e3f-9e08-4e28-ae89-06077422eddf', server: 'veeam01-backup-a' };
  assert.deepEqual(decode(encode(job)), job, 'сервер и GUID помещаются в 64 байта Telegram');
  // A job's Button from before there was a list names no server.
  assert.deepEqual(decode('a:job:1e218e3f-9e08-4e28-ae89-06077422eddf'), {
    kind: 'job', id: '1e218e3f-9e08-4e28-ae89-06077422eddf',
  });

  // A button from a version that had actions this one does not.
  assert.equal(decode('a:whatever'), undefined);
  assert.equal(decode(undefined), undefined);

  // The menu names only commands the bot actually answers.
  assert.deepEqual(
    BOT_COMMANDS.map((c) => c.command).sort(),
    ['check', 'clear', 'digest', 'help', 'job', 'menu', 'servers', 'status', 'topics'],
  );
});

test('the command menu is registered with Telegram at startup', async () => {
  // A webhook world on purpose: long polling would leave a loop running for as
  // long as the test process lives.
  const w = monitorWorld({
    TELEGRAM_WEBHOOK_URL: 'https://veeam.example.com',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-for-tests-0123456789',
  }, []);

  await w.updates.onModuleInit();

  const published = w.api.of('setMyCommands').at(-1);
  assert.ok(published, 'меню отправлено в Bot API');
  assert.ok(published.commands.some((c) => c.command === 'job' && /имени/.test(c.description)));
  // Without this Telegram never delivers a press, and every button is dead.
  assert.ok(w.api.of('setWebhook').at(-1).allowed_updates.includes('callback_query'));
});

test('the summary offers the jobs it just named', async () => {
  const w = monitorWorld({}, [
    job('1', 'SQL Daily', 'Failed'),
    job('2', 'Files', 'Success'),
    job('3', 'Exchange', 'Warning'),
  ]);

  await said(w, '/digest');

  const rows = w.api.sent().at(-1).reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row) => row[0].text), ['SQL Daily', 'Exchange', '🔄 Обновить']);
  // Addressed by id: a name would not fit the 64 bytes, and would open the
  // wrong job if the estate changed between the message and the press. And by
  // server, which may no longer be the one selected when it is pressed.
  assert.equal(rows[0][0].callback_data, `a:job:${SERVER}:1`);
});

test('pressing a job button opens that job, without anybody typing a name', async () => {
  const w = configured();

  // A Button from before there was a list: no server, so the first one.
  await pressed(w, 'a:job:1');

  const sent = w.api.sent().at(-1);
  assert.equal(sent.message_thread_id, undefined, 'ответ в General');
  assert.match(sent.text, /TTC_ASUEDT_EMM_DB1/);
  assert.match(sent.text, /Расписание:<\/b> пн, ср, пт в 03:12/);
  // And the card offers its own refresh, so the loop closes.
  assert.deepEqual(
    sent.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    [`a:job:${SERVER}:1`, 'a:sum'],
  );
});

test('a press is acknowledged before the work, not after', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);

  await pressed(w, 'a:sum');

  // Telegram spins on the presser's screen until this is answered, so it must
  // not wait behind a Veeam read.
  const order = w.api.calls.map((call) => call.method);
  assert.equal(order[0], 'answerCallbackQuery');
  assert.ok(order.includes('sendMessage'));
});

test('a button this version does not know is acknowledged and ignored', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);

  await pressed(w, 'a:from-a-future-version');

  assert.equal(w.api.of('answerCallbackQuery').length, 1, 'спиннер снят');
  assert.deepEqual(w.api.sent(), [], 'и ничего не отвечено наугад');
});

test('a job that disappeared between the message and the press says so', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')]);

  await pressed(w, 'a:job:gone');

  assert.match(w.api.sent().at(-1).text, /больше не найдено/);
});

test('a job switched off in Veeam is counted apart, never as a failure', () => {
  // The summary listed TTC_MGMT_VEEAM_OLD and others as FAILED: the last run
  // of each had failed, before somebody switched it off. Nobody expects a job
  // that is off to run, so its last result is history, not a problem to fix.
  const { summarise, digestEvent } = require('../dist/estate/digest');
  const { jobOf } = require('../dist/veeam/estate');
  const jobs = [
    { id: '1', name: 'SQL Daily', status: 'Stopped', lastResult: 'Failed' },
    { id: '2', name: 'TTC_MGMT_VEEAM_OLD', status: 'Disabled', lastResult: 'Failed' },
    { id: '3', name: 'Old warning', status: 'Disabled', lastResult: 'Warning' },
    { id: '4', name: 'Old success', status: 'Disabled', lastResult: 'Success' },
    { id: '5', name: 'Files', status: 'Stopped', lastResult: 'Success' },
  ].map(jobOf);

  const summary = summarise(jobs, new Set());
  assert.deepEqual(summary.failing.map((failing) => failing.name), ['SQL Daily']);
  assert.deepEqual(
    [summary.total, summary.success, summary.warning, summary.failed, summary.disabled],
    [5, 1, 0, 1, 3],
  );

  const event = digestEvent(summary);
  const field = (label) => event.fields.find(([name]) => name === label)?.[1];
  assert.equal(field('Выключены в Veeam'), 3);
  assert.doesNotMatch(event.body, /TTC_MGMT_VEEAM_OLD|Old warning/);
});

test('a running job Veeam still calls disabled is counted as running', async () => {
  const { summarise } = require('../dist/estate/digest');
  const { jobOf } = require('../dist/veeam/estate');
  const jobs = [
    { id: '1', name: 'Konaev EM', status: 'Disabled', lastResult: 'Success' },
    { id: '2', name: 'Konaev DB', status: 'Disabled', lastResult: 'Success' },
    { id: '3', name: 'Queued', status: 'Working', lastResult: 'Success' },
  ].map(jobOf);

  // Two of these are transferring right now under a session Veeam opened by
  // hand; their own status keeps saying "disabled" the whole time. Counting
  // from the status alone said one job was running while three were.
  assert.equal(summarise(jobs, new Set(['1', '2'])).running, 3);
  assert.equal(summarise(jobs, new Set()).running, 1, 'без сессий — только по статусу');
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
 * Clearing up after itself
 * ------------------------------------------------------------------ */

test('/clear takes back the answers and leaves the record alone', async () => {
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Failed')]);
  // An alert, which is a record of something that happened.
  await w.monitor.check();
  w.setJobs([job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  const alerts = w.api.sent().map((_, i) => 1001 + i);
  // And some chatter.
  await said(w, '/status');
  await said(w, '/help');
  w.api.reset();

  await said(w, '/clear');

  const deleted = w.api.of('deleteMessages').flatMap((call) => call.message_ids);
  assert.equal(deleted.length, 2, 'оба ответа убраны');
  for (const id of alerts) {
    assert.ok(!deleted.includes(id), `оповещение ${id} не тронуто`);
  }
  assert.match(w.api.sent().at(-1).text, /Убрано 2 сообщения/);
});

test('/clear removes only answers in General', async () => {
  const w = monitorWorld({}, []);
  const inThread = (thread, text) => w.updates.handleUpdate({
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      message_thread_id: thread,
      is_topic_message: thread !== undefined,
      text,
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  });

  await inThread(1, '/help');
  w.store.answerLog.remember(CHAT, 9001, 77);
  await inThread(undefined, '/help');
  w.api.reset();

  await inThread(1, '/clear');

  const deleted = w.api.of('deleteMessages').flatMap((call) => call.message_ids);
  assert.equal(deleted.length, 2);
  assert.ok(!deleted.includes(9001));
  assert.equal(w.api.sent().at(-1).message_thread_id, undefined);
});

test('/clear with nothing to remove says so instead of claiming work', async () => {
  const w = monitorWorld({}, []);

  await said(w, '/clear');

  assert.equal(w.api.of('deleteMessages').length, 0);
  assert.match(w.api.sent().at(-1).text, /Нечего убирать/);
});

test('one undeletable message does not cost the whole batch', async () => {
  const w = monitorWorld({}, [], {}, {
    // Telegram fails the call outright when any id in it cannot be deleted.
    deleteMessages: () => { throw new Error('Bad Request: message can\'t be deleted'); },
    deleteMessage: (payload) => {
      if (payload.message_id === 1002) throw new Error('Bad Request: message to delete not found');
      return { ok: true, result: true };
    },
  });
  await said(w, '/status');
  await said(w, '/help');
  await said(w, '/topics');
  w.api.reset();

  await said(w, '/clear');

  // Three answers, one of them already gone by hand: the other two still go.
  assert.match(w.api.sent().at(-1).text, /Убрано 2 сообщения/);
  assert.match(w.api.sent().at(-1).text, /1 не поддал/);
});

test('answers older than Telegram allows are never offered for deletion', () => {
  const { TelegramStateStore } = require('./world.cjs');
  const file = path.join(os.tmpdir(), `veeam-clear-${Math.random().toString(36).slice(2)}.json`);
  const store = new TelegramStateStore(file, []);

  store.answerLog.remember(CHAT, 5001, 55);
  // Reach past the interface deliberately: the alternative is a test that
  // waits two days.
  const state = JSON.parse(JSON.stringify(store.snapshot()));
  assert.equal(state.answers[CHAT].length, 1);
  store.answerLog.forget(CHAT, [5001]);

  assert.deepEqual(store.answerLog.inTopic(CHAT, 55), [], 'забытое не возвращается');
  fs.rmSync(file, { force: true });
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
  assert.match(sent[0].text, /восстановлено/);
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
  const w = monitorWorld({}, [job('1', 'REMS_DBS03', 'Success')], {
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
      result: { result: 'Failed', message: 'Processing REMS-DACA03' } },
    { id: 's1', jobId: '1', creationTime: '2026-09-16T23:46:16+05:00', endTime: '2026-09-17T02:52:00+05:00',
      result: { result: 'Failed', message: 'Processing REMS-REMS01' } },
  ];
  w.setJobs([job('1', 'REMS_DBS03', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().at(-1);
  assert.match(alert.text, /Попытка:<\/b> 2 из 4/);
  assert.match(alert.text, /Processing REMS-DACA03/, 'и причина именно этой попытки');
});

/* ------------------------------------------------------------------ *
 * Job alerts: a failed run is followed until Veeam stops retrying it
 *
 * TTC_ASUEDT_EMM_DB1 on 30 September: four attempts from 03:12 to 05:37, all
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
const { serverOf } = require('./world.cjs');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (ms) => new Date(ms).toISOString();
const VDDK =
  'Processing EMMDB1-T3Q4 Error: Failed to open VDDK disk [[AST01_A400_SSD_DATA09] EMMDB1-T3Q4/EMMDB1-T3Q4_1.vmdk] ( is read-only mode - [true] )\r\n' +
  'Logon attempt with parameters [VC/ESX: [192.0.2.194];Port: 443;Login: [svc@example.com];VMX Spec: [moref=vm-31466]]\r\n' +
  'Failed to open disk for read.\r\n' +
  "Failed to upload disk 'vddkConnSpec>'\r\n" +
  'Agent failed to process method {DataTransfer.SyncDisk}.';
const RETRY_FOUR = { runAutomatically: true, retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } };

/** One field of an alert, as it is sent. */
const fieldOf = (event, label) => event.fields.find(([name]) => name === label)?.[1];

/**
 * EMM_DB1's Job alerts, driven attempt by attempt. `attempt(n)` puts the n-th
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
  let reads = 0;
  let state = { lastResult: 'Success', status, lastRun: at(now - DAY) };
  let delivers = true;
  const sent = [];

  const server = serverOf(world(), veeamFake({
    '/api/v1/sessions': (req) => {
      if (req.params?.jobIdFilter === '1') reads += 1;
      return { data: sessions };
    },
    ...Object.fromEntries([1, 2, 3, 4].map((n) => [`/api/v1/sessions/a${n}/taskSessions`, {
      data: [{ name: 'EMMDB1-T3Q4', result: { result: 'Failed', message: VDDK } }],
    }])),
  }));
  const memory = new JobMemory({ results: {}, retrying: {} }, () => {});
  const send = async (event) => {
    if (!delivers) return { outcome: 'failed' };
    sent.push(event);
    return { outcome: 'delivered' };
  };
  const alerts = new JobAlerts(server, memory, send, { timezone: 'UTC', cooldownMs: 0, now: () => now });
  const evidence = { status: 'ready', schedulesByJob: new Map([['1', schedule]]) };
  const session = (n, result, ended = ends[n - 1]) => ({
    id: `a${n}`, jobId: '1', sessionType: 'BackupJob', creationTime: at(starts[n - 1]),
    // A session still going has no result yet.
    endTime: ended === null ? undefined : at(ended), result: { result: ended === null ? 'None' : result, message: 'Processing EMMDB1-T3Q4' },
  });

  return {
    sent,
    memory,
    ends,
    /** Reads of this job's sessions so far. */
    get reads() {
      return reads;
    },
    /** Whether Telegram takes what is sent. */
    set delivers(value) {
      delivers = value;
    },
    check: () =>
      alerts.check([jobOf({ id: '1', name: 'TTC_ASUEDT_EMM_DB1', type: 'Backup', objectsCount: 1, ...state })], evidence),
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
  assert.equal(alert.title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА');
  assert.match(fieldOf(alert, 'Попытка'), new RegExp(`^1 из 4 · Veeam повторит ≈ .*${hhmm}$`));
  assert.equal(
    alert.body,
    'Не прошли: 1 из 1\n🔴 EMMDB1-T3Q4 — Failed to open VDDK disk [[AST01_A400_SSD_DATA09] EMMDB1-T3Q4/EMMDB1-T3Q4_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.',
    'параметры подключения и трасса агента — не причина',
  );
  // "не выполняется" is what every job an alert is about is doing.
  assert.equal(fieldOf(alert, 'Статус'), undefined);
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
  assert.equal(last.title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА, повторов больше не будет');
  assert.equal(fieldOf(last, 'Попытка'), '4 из 4 · повторов больше не будет');
  assert.match(last.body, /🔴 EMMDB1-T3Q4 — Failed to open VDDK disk/);
  assert.equal(fieldOf(last, 'Было'), undefined, 'что было до этого запуска, сказано в первом сообщении');
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
  assert.equal(alert.title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА');
  assert.equal(fieldOf(alert, 'Попытка'), '2 из 4 · повтор уже идёт');
  assert.match(alert.body, /🔴 EMMDB1-T3Q4 — Failed to open VDDK disk/, 'причина — из попытки, что упала');
  assert.equal(night.memory.retryingOf('1').attempt, 2);

  // It fails, and so do the two after it: the last word comes, once.
  for (const n of [2, 3]) {
    night.attempt(n);
    await night.check();
  }
  assert.equal(night.sent.length, 1);
  night.attempt(4);
  await night.check();
  assert.equal(night.sent.at(-1).title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА, повторов больше не будет');
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
    assert.equal(night.sent[0].title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА');
    assert.equal(fieldOf(night.sent[0], 'Попытка'), undefined, 'повтора не обещано');
    assert.equal(night.memory.retryingOf('1'), undefined);
  }
  assert.equal(fieldOf(switchedOff.sent[0], 'Статус'), 'выключено в Veeam');
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
  assert.equal(last.title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА, повторов больше не будет');
  assert.equal(fieldOf(last, 'Попытка'), '1 из 4 · повторов больше не будет');
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
  assert.equal(recovered.title, 'TTC_ASUEDT_EMM_DB1: задание восстановлено');
  assert.equal(fieldOf(recovered, 'Попытка'), '2 из 4');
  assert.equal(recovered.body, undefined);
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
  assert.equal(night.sent.at(-1).title, 'TTC_ASUEDT_EMM_DB1: ОШИБКА, повторов больше не будет');
  assert.equal(night.memory.retryingOf('1'), undefined);
});

test('the monitor hands every server\'s jobs to its Job alerts, and the run followed is kept in the state file', async () => {
  const now = Date.now();
  let sessions = [];
  const emm = (lastResult, lastRun) => ({
    id: '1', name: 'TTC_ASUEDT_EMM_DB1', type: 'Backup', status: 'Inactive', lastResult, lastRun, objectsCount: 1,
  });
  const failed = (id, start, end) => ({
    id, jobId: '1', sessionType: 'BackupJob', creationTime: at(start), endTime: at(end),
    result: { result: 'Failed', message: 'Processing EMMDB1-T3Q4' },
  });
  const w = monitorWorld({ TELEGRAM_TIMEZONE: 'UTC' }, [emm('Success', at(now - DAY))], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: RETRY_FOUR }] },
    '/api/v1/sessions': () => ({ data: sessions }),
  });
  await w.monitor.check();

  sessions = [failed('a1', now - 60 * MINUTE, now - MINUTE)];
  w.setJobs([emm('Failed', at(now - 60 * MINUTE))]);
  await w.monitor.check();
  assert.match(w.api.sent().at(-1).text, /Попытка:<\/b> 1 из 4 · Veeam повторит/);
  assert.equal(w.store.snapshot().retrying[SERVER]['1'].attempt, 1, 'в файле состояния');

  sessions = [
    failed('a4', now - 5_000, now - 1_000),
    failed('a3', now - 8_000, now - 6_000),
    failed('a2', now - 50_000, now - 10_000),
    ...sessions,
  ];
  w.setJobs([emm('Failed', at(now - 5_000))]);
  await w.monitor.check();
  assert.match(w.api.sent().at(-1).text, /ОШИБКА, повторов больше не будет/);
  assert.equal(w.store.snapshot().retrying[SERVER]['1'], undefined);
});

/* ------------------------------------------------------------------ *
 * A session's message is shown as it is worth showing, everywhere
 * ------------------------------------------------------------------ */

// TTC_Konaev_vCenters, as Veeam wrote it: the reason, the line that says DNS,
// and the connection parameters with the service account in them.
const DNS_RAW =
  'Processing comp01vc01 Error: Cannot get service content.\r\n' +
  'Soap fault. Temporary failure in name resolution\r\n' +
  'Logon attempt with parameters [VC/ESX: [vc01cast];Port: 443;Login: [svc@example.com]]';
const konaevNight = (id, day) => ({
  id, jobId: '1', creationTime: `2026-09-${day}T22:00:00+05:00`, endTime: `2026-09-${day}T22:10:00+05:00`,
  result: { result: 'Failed', message: DNS_RAW },
});

test('a Job card never shows the connection parameters Veeam writes after a reason', async () => {
  // No per-machine detail to read, so both the reason line and the run list
  // come from the sessions' own messages — which the run list showed raw.
  const w = monitorWorld({}, [job('1', 'TTC_Konaev_vCenters', 'Failed')], {
    '/api/v1/sessions': { data: [konaevNight('n2', 29), konaevNight('n1', 27)] },
  });

  await said(w, '/job Konaev');

  const reply = w.api.sent().at(-1).text;
  assert.match(reply, /<b>Причина:<\/b> comp01vc01 — Cannot get service content\. \/ Soap fault\. Temporary failure in name resolution/);
  const runs = reply.slice(reply.indexOf('Последние запуски'));
  assert.equal((runs.match(/comp01vc01 — Cannot get service content/g) ?? []).length, 2, `в списке запусков:\n${runs}`);
  assert.doesNotMatch(reply, /Logon attempt|svc@example\.com/);
});

test('an alert with no machine to list gives the session\'s reason, without the connection parameters', async () => {
  const w = monitorWorld({}, [job('1', 'TTC_Konaev_vCenters', 'Success')], {
    '/api/v1/sessions': { data: [konaevNight('n2', 29)] },
  });
  await w.monitor.check();

  w.setJobs([job('1', 'TTC_Konaev_vCenters', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().at(-1).text;
  assert.match(alert, /<pre>comp01vc01 — Cannot get service content\. \/ Soap fault\. Temporary failure in name resolution<\/pre>/);
  assert.doesNotMatch(alert, /Logon attempt|svc@example\.com/);
});

test('the machine a session blames takes the session\'s reason, and the others keep their own', async () => {
  const server = serverOf(world(), veeamFake({
    '/api/v1/sessions': { data: [konaevNight('n2', 29)] },
    '/api/v1/sessions/n2/taskSessions': { data: [
      // Its own task says only the step it stopped at.
      { name: 'comp01vc01', result: { result: 'Failed', message: 'Getting VM info from vSphere' } },
      { name: 'mgmt01vc01', result: { result: 'Failed', message: 'Processing mgmt01vc01 Error: Disk full' } },
      { name: 'ok01', result: { result: 'Success', message: 'Success' } },
    ] },
  }));

  const [session] = await server.jobs.recentSessions({ id: '1', name: 'TTC_Konaev_vCenters', result: 'failed' });

  assert.deepEqual(await server.jobs.objectsOf(session), [
    { name: 'comp01vc01', result: 'failed', message: 'Cannot get service content. / Soap fault. Temporary failure in name resolution' },
    { name: 'mgmt01vc01', result: 'failed', message: 'Disk full' },
    { name: 'ok01', result: 'success', message: 'Success' },
  ]);
});

test('an alert lists at most five machines of a group and counts the rest', () => {
  const { objectsBody } = require('../dist/monitor/job-alerts');
  const objects = [
    ...Array.from({ length: 7 }, (_, i) => ({ name: `vm${i}`, result: 'failed', message: 'x'.repeat(400) })),
    { name: 'ok', result: 'success' },
    { name: 'slow', result: 'warning', message: 'Removing VM snapshot' },
  ];

  const body = objectsBody(objects, 'Processing vm0');

  assert.match(body, /^Не прошли: 7 из 9\n/);
  assert.equal((body.match(/^🔴 /gm) ?? []).length, 5);
  assert.match(body, /… и ещё 2\n\nС предупреждением: 1 из 9\n🟡 slow — Removing VM snapshot$/);
  assert.ok(body.split('\n').every((line) => line.length < 320), 'длинная причина обрезана');
  // Nothing named: the session's own message is the whole story.
  assert.equal(objectsBody([{ name: 'ok', result: 'success' }], 'Virtual Machine X is unavailable'), 'Virtual Machine X is unavailable');
});

/* ------------------------------------------------------------------ *
 * Live slots outliving Telegram's edit window
 * ------------------------------------------------------------------ */

test('a live message is retired before Telegram stops answering for it', async () => {
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  const first = w.store.liveMessages.of(CHAT, 'health');
  assert.ok(first.createdAt, 'дата отправки запомнена');

  // Two days on. Telegram would refuse both the edit and the deletion, and the
  // slot would be left with a frozen message and a second one beside it.
  w.store.liveMessages.remember(CHAT, 'health', {
    ...first,
    createdAt: Date.now() - 40 * 3_600_000,
  });
  w.api.reset();
  await w.monitor.check();

  assert.deepEqual(
    w.api.of('deleteMessage').map((c) => c.message_id),
    [first.messageId],
    'старое убрано, пока это ещё разрешено',
  );
  const now = w.store.liveMessages.of(CHAT, 'health');
  assert.notEqual(now.messageId, first.messageId, 'слот ведёт уже новое сообщение');
  assert.ok(now.createdAt > Date.now() - 60_000, 'и отсчёт пошёл заново');
});

test('a message of unknown age is retired rather than edited on faith', async () => {
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();
  const first = w.store.liveMessages.of(CHAT, 'health');

  // A ref persisted before createdAt existed: it may be minutes or weeks old,
  // and betting on minutes is how the stuck message appeared.
  const { createdAt, ...ageless } = first;
  w.store.liveMessages.remember(CHAT, 'health', ageless);
  w.api.reset();
  await w.monitor.check();

  assert.equal(w.api.of('deleteMessage').length, 1);
  assert.notEqual(w.store.liveMessages.of(CHAT, 'health').messageId, first.messageId);
});

test('a job alert says when the job ran and runs next as people write it, in the operator\'s zone', async () => {
  // As Veeam reports them, and as they reached the chat until now:
  // "2026-09-30T01:21:14.7+05:00".
  const esb = (lastResult, lastRun, nextRun) => ({
    id: '1', name: 'TTC_ASUEDT_ESB_DB', type: 'Backup', status: 'Stopped',
    lastResult, lastRun, nextRun, objectsCount: 2,
  });
  const w = monitorWorld({ TELEGRAM_TIMEZONE: 'Asia/Qyzylorda' }, [
    esb('Success', '2026-09-15T01:21:00+05:00', '2026-09-16T01:21:00+05:00'),
  ]);
  await w.monitor.check();

  w.setJobs([esb('Failed', '2026-09-16T01:21:14.7+05:00', '2026-09-17T01:21:00+05:00')]);
  await w.monitor.check();
  const failed = w.api.sent().at(-1).text;
  assert.match(failed, /Последний запуск:<\/b> 16\.09 в 01:21/);
  assert.match(failed, /Следующий запуск:<\/b> 17\.09 в 01:21/);
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(failed), `no ISO string is left: ${failed}`);

  // The recovery is written the same way; in UTC it would read 20:21 the day before.
  w.setJobs([esb('Success', '2026-09-17T01:21:00+05:00', '2026-09-18T01:21:00+05:00')]);
  await w.monitor.check();
  const recovered = w.api.sent().at(-1).text;
  assert.match(recovered, /задание восстановлено/);
  assert.match(recovered, /Последний запуск:<\/b> 17\.09 в 01:21/);
  assert.match(recovered, /Следующий запуск:<\/b> 18\.09 в 01:21/);
});

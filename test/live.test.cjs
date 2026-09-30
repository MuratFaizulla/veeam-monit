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
  MonitorService, BackupEvidenceService, VeeamHttpService, monitorOf, monitorAccount,
  announcement, probe, capacities, capacityOf,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
} = require('./world.cjs');

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
  // Block elements, the same ones 💾 Repositories draws with: a Windows client
  // with no glyph for ▰ rendered half the bar as hyphens.
  assert.match(text, /██████░░░░/);
  assert.match(text, /идёт 22 мин/);
  // While something is running, the next run belongs to the schedule slot only.
  assert.ok(!/Ближайший запуск/.test(text));
  const schedule = w.api.sent().find((m) => /Upcoming runs|Сегодня|расписан/.test(m.text)).text;
  assert.match(schedule, /SQL Daily/);
});

test('a run somebody started on a switched-off job is still a run', async () => {
  const startedAt = new Date(Date.now() - 32 * 60_000).toISOString();
  // Exactly what Veeam reports for it: the job is "Disabled" and transferring
  // at the same time. Reading the status alone hid two live runs from this
  // list, and the count above the list agreed with the omission.
  const w = monitorWorld(LIVE, [
    { ...job('1', 'OPS_Kingston_EM_DB', 'Success'), status: 'Disabled' },
    running('OPS_Network_services', { id: '2' }),
  ], {
    '/api/v1/sessions': {
      data: [
        { jobId: '1', state: 'Working', progressPercent: 97, creationTime: startedAt },
        { jobId: '2', state: 'Working', progressPercent: 88, creationTime: startedAt },
      ],
    },
  });

  await w.monitor.check();
  const text = w.api.sent().find((m) => /Сейчас выполня[ею]тся/.test(m.text)).text;

  assert.match(text, /Сейчас выполняются: 2 задания/);
  assert.match(text, /<b>OPS_Kingston_EM_DB<\/b> — 97%/);
  // And it says why it is unusual, because the schedule will not start it again.
  assert.match(text, /выключено в Veeam/);
  assert.ok(!/OPS_Network_services<\/b> — 88%[\s\S]*выключено/.test(text), 'only the disabled one is marked');
});

test('a session that belongs to no job of ours is not listed as a job', async () => {
  const w = monitorWorld(LIVE, [running('SQL Daily')], {
    '/api/v1/sessions': {
      data: [
        { jobId: '1', state: 'Working', progressPercent: 40, creationTime: new Date().toISOString() },
        // Veeam runs this alongside the jobs; it has no job id we know.
        { jobId: 'malware-1', name: 'Malware Detection', state: 'Working', progressPercent: 0 },
      ],
    },
  });

  await w.monitor.check();
  const text = w.api.sent().find((m) => /Сейчас выполня[ею]тся/.test(m.text)).text;

  assert.match(text, /Сейчас выполняется: 1 задание/);
  assert.ok(!/Malware/.test(text));
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

test('a live message Telegram failed to edit for a moment is kept, not replaced', async () => {
  // Every hour or two the ▶️ topic gained a message. An edit that met a 429, a
  // 5xx or a dropped connection was taken for a message that was gone: the
  // delete tried next failed the same way, a second message was posted, and
  // the first — still there, no longer anybody's — stayed. Fifteen in a day.
  const failures = {
    'rate limit': () => ({
      ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 },
    }),
    'bad gateway': () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }),
    'dropped connection': () => { throw new Error('socket hang up'); },
  };
  for (const [name, failure] of Object.entries(failures)) {
    let failing = false;
    const fail = () => (failing ? failure() : undefined);
    const w = world({ TELEGRAM_LIVE: 'true' }, { editMessageText: fail, deleteMessage: fail });
    await w.live.publish('running', '▶️ первый');
    const first = w.store.liveMessages.of(CHAT, 'running').messageId;

    failing = true;
    w.api.reset();
    await w.live.publish('running', '▶️ второй');
    assert.deepEqual(w.api.sent(), [], `${name}: no second message`);
    assert.deepEqual(w.api.of('deleteMessage'), [], `${name}: the first is not deleted`);
    assert.equal(w.store.liveMessages.of(CHAT, 'running').messageId, first, `${name}: the slot keeps it`);

    failing = false;
    w.api.reset();
    await w.live.publish('running', '▶️ второй');
    assert.deepEqual(
      w.api.of('editMessageText').map((edit) => edit.message_id), [first],
      `${name}: the next cycle writes the same message`,
    );
    assert.deepEqual(w.api.sent(), [], `${name}: still one message`);
  }
});

/**
 * A forum whose topics can be deleted the way a person deletes one: the topic
 * goes, and every message in it goes with it.
 */
const deletableForum = () => {
  const threadOf = new Map();
  const deleted = new Set();
  let next = 5000;
  const gone = (what) => ({ ok: false, error_code: 400, description: `Bad Request: message to ${what} not found` });
  const lost = (payload) => deleted.has(threadOf.get(payload.message_id));
  return {
    delete: (thread) => deleted.add(thread),
    handlers: {
      sendMessage: (payload) => {
        if (deleted.has(payload.message_thread_id)) {
          return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };
        }
        threadOf.set((next += 1), payload.message_thread_id);
        return { ok: true, result: { message_id: next } };
      },
      editMessageText: (payload) => (lost(payload) ? gone('edit') : undefined),
      editMessageReplyMarkup: (payload) => (lost(payload) ? gone('edit') : undefined),
      deleteMessage: (payload) => (lost(payload) ? gone('delete') : undefined),
    },
  };
};

test('a live topic somebody deleted comes back by itself, holding its message', async () => {
  const forum = deletableForum();
  const w = monitorWorld(LIVE, [running('SQL Daily')], {}, forum.handlers);
  await w.monitor.check();
  const slots = Object.entries(w.telegram.liveTopics).filter(([slot]) => w.store.liveMessages.of(CHAT, slot));
  const before = Object.fromEntries(slots.map(([slot, name]) => [slot, w.store.threadId(CHAT, name)]));

  // Every one of them, including the ones whose content has not changed and
  // are only looked at again on the heartbeat, a few minutes later.
  for (const thread of Object.values(before)) forum.delete(thread);
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try {
    w.api.reset();
    await w.monitor.check();
  } finally {
    Date.now = realNow;
  }

  for (const [slot, name] of slots) {
    const thread = w.store.threadId(CHAT, name);
    assert.ok(thread && thread !== before[slot], `${name}: the topic is created again`);
    assert.equal(w.store.liveMessages.of(CHAT, slot).threadId, thread, `${name}: the slot remembers the new topic`);
    assert.ok(
      w.api.sent().some((message) => message.message_thread_id === thread),
      `${name}: and its message is in it`,
    );
  }
  assert.equal(w.api.of('createForumTopic').length, slots.length, 'one topic each, not two');
  const runningNow = w.api.sent().find((message) => message.message_thread_id === w.store.threadId(CHAT, '▶️ Running now'));
  assert.match(runningNow.text, /SQL Daily/, 'with what it was showing');
});

test('a live message Telegram will no longer let the bot edit is replaced', async () => {
  let old = false;
  const w = world({ TELEGRAM_LIVE: 'true' }, {
    editMessageText: () =>
      old ? { ok: false, error_code: 400, description: "Bad Request: message can't be edited" } : undefined,
  });
  await w.live.publish('running', '▶️ первый');
  const first = w.store.liveMessages.of(CHAT, 'running').messageId;

  old = true;
  w.api.reset();
  await w.live.publish('running', '▶️ второй');

  assert.equal(w.api.sent().length, 1, 'a message the bot can write to takes over');
  assert.notEqual(w.store.liveMessages.of(CHAT, 'running').messageId, first);
});

test('no live message is pinned, so replacing one leaves no notice behind', async () => {
  // 📈 and 💾 used to pin their message. Every 36 hours the slot posts a fresh
  // one and pinned that too, and each pin left a "Veeam pinned …" line in the
  // topic that outlived the message: "pinned Deleted message", one every day
  // and a half, which the bot cannot remove. The topic holds a single message
  // anyway, so the pin only repeated it.
  const w = monitorWorld(LIVE, [job('1', 'SQL Daily', 'Success')]);
  await w.monitor.check();

  const realNow = Date.now;
  Date.now = () => realNow() + 37 * 3_600_000;
  try {
    await w.monitor.check();
  } finally {
    Date.now = realNow;
  }

  assert.ok(w.api.of('deleteMessage').length > 0, 'the messages were replaced');
  assert.deepEqual(w.api.of('pinChatMessage'), [], 'and nothing was ever pinned');
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

  await monitor.check();

  const texts = w.api.sent().map((m) => m.text);
  assert.ok(texts.some((t) => /🔴 <b>Veeam — сервер недоступен/.test(t)));
  assert.ok(texts.some((t) => /Данные о заданиях недоступны/.test(t)));
  assert.ok(!texts.some((t) => /не выполняется ни одно задание/.test(t)));
});

test('counts are written in Russian, with the right form for 1, 2 and 5', async () => {
  const { plural, duration } = require('../dist/telegram/time');
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
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

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
        { name: 'OPS_vCloud_vcd02', at: at('2026-09-14T13:13:00Z') },
        { name: 'SQL Daily Backup', at: at('2026-09-14T20:00:00Z') },
        { name: 'FS Weekly', at: at('2026-09-15T03:00:00Z') },
      ],
    },
    clock,
  );
  assert.match(today, /Сегодня осталось 2 запуска/);
  assert.match(today, /13:13.*OPS_vCloud_vcd02/);
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
  const { todayRuns } = require('../dist/estate/schedule-planner');
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
  assert.equal(runs.find((run) => run.name === 'Daily').scheduleKind, 'ежедневно');
});

test('a cycle Veeam did not answer leaves the schedule honest about it', async () => {
  const w = world(LIVE);
  const veeam = veeamFake({
    '/api/v1/serverTime': () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

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
      name: `OPS_JOB_${String(i).padStart(3, '0')}`,
      at: new Date(now.getTime() + (i + 1) * 60_000).toISOString(),
    }));

  // 42 entries used to be cut to 30 for no reason; they fit with room to spare.
  const short = renderSchedule({ upcoming: runs(42) }, clock);
  assert.match(short, /Сегодня осталось 42 запуска/);
  assert.ok(!/…и ещё/.test(short), 'nothing needs hiding at this size');
  assert.equal((short.match(/OPS_JOB_/g) ?? []).length, 42);

  // A day where everything is scheduled does not overflow and says what it hid.
  const long = renderSchedule({ upcoming: runs(400) }, clock);
  assert.ok(long.length <= 4096);
  const hidden = /…и ещё (\d+) запуск/.exec(long);
  assert.ok(hidden, 'the remainder is counted, not silently dropped');
  assert.equal((long.match(/OPS_JOB_/g) ?? []).length + Number(hidden[1]), 400);

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
  const { standingsOf } = require('../dist/estate/job-standing');
  const { cadenceOf } = require('../dist/estate/backup-evidence.service');
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
      provenByRuns: new Set(),
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
    jobs: [{ id: '1', name: 'CUST_FINHUB_archive', type: 'Backup', lastRun: '2026-06-19T11:57:52Z' }],
    pointsByJob: new Map([['1', points(now, 87, 1)]]),
  });

  assert.equal(snapshot.risks.length, 1, 'lastResult=Success hides this from every other alert');
  assert.equal(snapshot.risks[0].severity, 'critical');
  assert.equal(Math.floor(snapshot.risks[0].ageDays), 87);
});

test('a job with no restore point at all is critical, and says when it last ran', async () => {
  const snapshot = assess({
    jobs: [{ id: '1', name: 'OPS_Kingston_EM_DB', lastRun: '2026-08-12T10:01:00Z' }],
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
    jobs: [{ id: '1', name: 'OPS_ERP_REMS_REMS03' }],
    pointsByJob: new Map([['1', points(now, 5, 5)]]),
  });
  assert.deepEqual(onSchedule.risks, [], 'a flat 3-day rule would cry wolf here');
  assert.equal(onSchedule.protectedJobs, 1);

  // The same job, now three of its own intervals late.
  const late = assess({
    jobs: [{ id: '1', name: 'OPS_ERP_REMS_REMS03' }],
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
    jobs: [{ id: '1', name: 'OPS_SMAX_SAM' }],
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
      { id: '1', name: 'OPS_MGMT_VEEAM_OLD', disabled: true },
      { id: '2', name: 'CUST_live' },
    ],
    pointsByJob: new Map([['2', points(Date.UTC(2026, 8, 14, 12), 0.5, 1)]]),
  });

  assert.deepEqual(snapshot.risks, []);
  assert.equal(snapshot.excludedDisabled, 1);
  assert.equal(snapshot.totalJobs, 1, 'the disabled job is not part of the denominator either');
});

test('a job that only runs by hand is not owed one either', async () => {
  const snapshot = assess({
    jobs: [{ id: '1', name: 'CUST_FINHUB_archive', unscheduled: true }],
  });

  assert.deepEqual(snapshot.risks, [], 'no schedule means no expectation');
  assert.equal(snapshot.excludedUnscheduled, 1);
  assert.equal(snapshot.totalJobs, 0);

  const { renderProtection } = require('../dist/live/protection');
  const text = renderProtection(snapshot, { now: new Date(), timezone: 'UTC' });
  assert.match(text, /Не учитываются:.*1 без расписания/, 'what is outside the check is stated');
});

test('a job whose schedule could not be read is still judged', async () => {
  // OPS_Billing_DB_file is absent from /api/v1/jobs; an unknown schedule must
  // not become a silent exemption.
  const snapshot = assess({
    jobs: [{ id: '1', name: 'OPS_Billing_DB_file', unscheduled: undefined }],
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
        name: 'OPS_Call_Center',
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
  assert.match(text, /^🔴 OPS_Call_Center — 7 точек · пропущено \d+ запусков · 17 июня 2026 г\. в 21:32:09$/mu);
});

test('the same staleness means opposite things at different cadences', async () => {
  // Both went three days without a point. The nightly job has missed two
  // backups; the weekly one is not due yet.
  const text = depth({
    jobs: [
      { name: 'CUST_weekly', runs: 9, points: 9, machines: 1, intervalDays: 7,
        oldest: NOW - 63 * DAY, newest: NOW - 3 * DAY },
      { name: 'CUST_nightly', runs: 30, points: 30, machines: 1, intervalDays: 1,
        oldest: NOW - 33 * DAY, newest: NOW - 3 * DAY },
    ],
  });

  const lines = text.split('\n');
  const nightly = lines.findIndex((l) => l.includes('CUST_nightly'));
  const weekly = lines.findIndex((l) => l.includes('CUST_weekly'));
  assert.ok(nightly < weekly, 'the one behind its own schedule comes first');
  assert.match(lines[nightly], /^🔴 CUST_nightly — 30 точек · пропущено 2 запуска/u);
  assert.match(lines[weekly], /^🟢 CUST_weekly — 9 точек · /u);
  assert.ok(!/CUST_weekly.*пропущен/u.test(lines[weekly]), 'nothing is claimed about a job that is on time');
  assert.match(text, /Отстают от расписания:<\/b> 1/);
});

test('a job whose cadence cannot be learned claims nothing about missed runs', async () => {
  const text = depth({
    jobs: [
      { name: 'CUST_CHEMPLANT', runs: 1, points: 1, machines: 1, intervalDays: null,
        newest: NOW - 40 * DAY },
    ],
  });

  assert.match(text, /^⚪ CUST_CHEMPLANT — 1 точка · /mu);
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
    name: `OPS_JOB_${String(i).padStart(3, '0')}`,
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
    pages.join('\n').match(/OPS_JOB_/g).length,
    90,
    'every job appears exactly once across the pages',
  );
});

test('the pages fill up, keeping the ones that are behind', async () => {
  const pages = depthPages({ jobs: estate(400) });
  const text = pages.join('\n');

  const hidden = /…и ещё (\d+) задани\S* по графику/.exec(text);
  assert.ok(hidden, 'the ones on schedule are the ones worth dropping');
  assert.equal(text.match(/OPS_JOB_/g).length + Number(hidden[1]), 400);
  assert.match(pages[0], /OPS_JOB_000/, 'the one that is behind is always shown');
});


test('a point left behind by a failed run is not counted as a backup', async () => {
  const w = exchange();
  await w.monitor.check();

  const topic = w.api.sent().find((m) => /Точки восстановления/.test(m.text));
  assert.ok(topic, 'the topic was published');
  assert.ok(!/14 сентября/u.test(topic.text), 'a run that errored out is not a backup');
  assert.match(topic.text, /Не в счёт:<\/b> 1 точка машин, упавших в своём прогоне/u);
});

test('a point finished by a successful retry counts, whatever id it carries', async () => {
  // The zone the time below is written in, named rather than taken from the
  // machine: on one in UTC the same point reads "22 августа … 20:31:12".
  const w = exchange({ TELEGRAM_TIMEZONE: 'Asia/Qyzylorda' });
  await w.monitor.check();

  const topic = w.api.sent().find((m) => /Точки восстановления/.test(m.text));
  // Written nine minutes into the retry that succeeded, so it is a backup —
  // even though the session id on it belongs to the attempt that failed.
  assert.match(topic.text, /OPS_Exchange — 1 точка · 23 августа 2026 г\. в 01:31:12/u);
});

const HOUR_MS = 3_600_000;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

test('a failed run\'s points count for the machines that got through it, not for the one that failed', async () => {
  // OPS_ERP_REMS_DBS03's nights: every run failed on one unreachable
  // machine, and the topics said "точек восстановления нет" of a job with 131
  // points on disk, thirteen machines a night.
  const w = monitorWorld(LIVE, [job('1', 'REMS_DBS03', 'Failed')], {
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': { data: [{ id: 'b1', jobId: '1', name: 'REMS_DBS03' }] },
    '/api/v1/restorePoints': {
      data: ['DACA01', 'DACS01', 'DBS03'].map((name, i) => ({
        id: `p${i}`, backupId: 'b1', sessionId: 'night', name, creationTime: isoAgo(3 * HOUR_MS - i * 60_000),
      })),
    },
    '/api/v1/sessions': {
      data: [{ id: 'night', jobId: '1', sessionType: 'BackupJob', creationTime: isoAgo(3 * HOUR_MS + 60_000),
        endTime: isoAgo(2 * HOUR_MS), result: { result: 'Failed' } }],
    },
    '/api/v1/sessions/night/taskSessions': {
      data: [
        { name: 'DACA01', result: { result: 'Success' } },
        { name: 'DACS01', result: { result: 'Warning' } },
        { name: 'DBS03', result: { result: 'Failed' } },
      ],
    },
  });
  await w.monitor.check();

  const texts = w.api.sent().map((message) => message.text);
  const depth = texts.find((text) => /Точки восстановления/.test(text));
  assert.match(depth, /REMS_DBS03 — 2 точки/u, 'the machines that got through are backed up');
  assert.match(depth, /Не в счёт:<\/b> 1 точка машин, упавших в своём прогоне/u);
  const protection = texts.find((text) => /Все задания защищены|Требуют внимания/.test(text));
  assert.ok(!/точек восстановления нет/.test(protection), protection);
});

test('a replica is judged by the runs that worked, its points being kept on the target', async () => {
  const replica = (id, name, lastResult) => ({ ...job(id, name, lastResult), type: 'VSphereReplica' });
  const run = (id, jobId, ago, result) => ({
    id, jobId, sessionType: 'ReplicaJob', creationTime: isoAgo(ago), endTime: isoAgo(ago - 600_000),
    result: { result },
  });
  const w = monitorWorld(LIVE, [replica('1', 'REPL_OK', 'Success'), replica('2', 'NTP/DOM', 'Failed')], {
    '/api/v1/jobs': { data: [
      { id: '1', schedule: { runAutomatically: true } },
      { id: '2', schedule: { runAutomatically: true } },
    ] },
    '/api/v1/sessions': { data: [
      run('ok3', '1', 2 * HOUR_MS, 'Success'),
      run('ok2', '1', 26 * HOUR_MS, 'Success'),
      run('ok1', '1', 50 * HOUR_MS, 'Success'),
      run('bad3', '2', 3 * HOUR_MS, 'Failed'),
      run('bad2', '2', 27 * HOUR_MS, 'Failed'),
      run('bad1', '2', 51 * HOUR_MS, 'Failed'),
    ] },
  });
  await w.monitor.check();

  const texts = w.api.sent().map((message) => message.text);
  const protection = texts.find((text) => /Требуют внимания/.test(text));
  assert.ok(!/REPL_OK/.test(protection), 'a replica replicating every night is protected');
  assert.match(protection, /NTP\/DOM<\/b> — успешных запусков нет/u, 'what the failing one lacks is a run that worked');
  assert.ok(!/точек восстановления нет/.test(protection), 'never "no points", which every replica would read');
  const depth = texts.find((text) => /Точки восстановления|Точек восстановления нет/.test(text));
  assert.match(depth, /2 задания с точками вне этого списка \(репликации и др\.\)/u);
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
      { name: 'CUST_small', points: 12, newest: Date.UTC(2026, 8, 10) },
      { name: 'OPS_OFD_vms', points: 347, newest: Date.UTC(2026, 3, 4) },
    ],
    points: 359,
    totalPoints: 1000,
  });

  const lines = text.split('\n');
  const big = lines.findIndex((l) => /OPS_OFD_vms/.test(l));
  const small = lines.findIndex((l) => /CUST_small/.test(l));
  assert.ok(big < small, 'the chain holding the most is where deleting pays');
  assert.match(lines[big], /^🔴 347 · OPS_OFD_vms · 04\.04/, 'stale by months');
  assert.match(lines[small], /^🟢 12 · CUST_small/, 'recent enough to still be wanted');
  assert.match(text, /Точек в них:<\/b> 359 из 1000 \(36%\)/);
});

test('orphaned chains are reported as facts, not as rubbish to delete', async () => {
  const text = orphans({
    backups: [{ name: 'OPS_gone', points: 5, newest: Date.UTC(2026, 0, 1) }],
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

test('the 🧹 pointer is a decision the renderer is given, not a zero it infers', async () => {
  const estate = {
    jobs: [{ name: 'CUST_live', runs: 5, points: 5, machines: 1, intervalDays: 1, newest: NOW }],
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

test('an unread scan says so rather than showing an empty estate', async () => {
  const text = depth({ unavailable: 'Точки восстановления ещё не прочитаны.' });
  assert.match(text, /не прочитаны/);
  assert.ok(!/Сначала те/.test(text));
});

/* ------------------------------------------------------------------ *
 * A message somebody deleted by hand
 * ------------------------------------------------------------------ */

test('an unchanged slot notices its message was deleted, on the heartbeat', async () => {
  // 💾 used to skip the heartbeat, which left it with no reason to look at its
  // message again: somebody clearing the chat by hand emptied the topic for
  // good. Every slot now rewrites an unchanged message now and then, and that
  // write is what finds it gone.
  let gone = false;
  const w = world({ TELEGRAM_LIVE: 'true' }, {
    editMessageText: () =>
      gone ? { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' } : undefined,
  });
  const text = '💾 <b>REPOSITORIES</b>\nRepo01 — 40%';
  await w.live.publish('repositories', text);
  const first = w.store.liveMessages.of(CHAT, 'repositories').messageId;

  gone = true;
  w.api.reset();
  await w.live.publish('repositories', text);
  assert.deepEqual(w.api.calls, [], 'unchanged and recent: nothing is asked of Telegram');

  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try {
    await w.live.publish('repositories', text);
  } finally {
    Date.now = realNow;
  }
  assert.equal(w.api.sent().length, 1, 'слот восстановился сам');
  assert.notEqual(w.store.liveMessages.of(CHAT, 'repositories').messageId, first);
});

test('a slot returns to the topic it was in, not to the one now configured', async () => {
  const w = world({ TELEGRAM_LIVE: 'true', liveRefreshMs: 0 }, {
    // The message is gone and the topic has since been renamed by hand, so its
    // configured name resolves to nothing.
    editMessageText: () => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    }),
  });
  w.store.rememberTopic(CHAT, '📅 Upcoming runs', 86);
  await w.live.publish('schedule', '📅 первый');
  const thread = w.store.liveMessages.of(CHAT, 'schedule').threadId;
  assert.equal(thread, 86, 'тема запомнена вместе с сообщением');

  w.store.forgetTopic(CHAT, '📅 Upcoming runs');
  w.api.reset();
  await w.live.publish('schedule', '📅 второй');

  // Without the remembered thread the bot creates a second topic beside the
  // first and leaves the one everybody is looking at empty.
  assert.equal(w.api.of('createForumTopic').length, 0, 'вторая тема не создана');
  assert.equal(w.api.sent().at(-1).message_thread_id, 86);
});

test('every live slot ends on the footer the live module leaves out of the comparison', () => {
  // A slot whose last line is not recognised as the footer hashes its own
  // timestamp, never compares as unchanged, and is rewritten every cycle.
  // Two renderers used to
  // spell the footer themselves; this is what keeps that from coming back.
  const { isFooter } = require('../dist/live/format.js');
  const { renderRepositories } = require('../dist/live/repositories.js');
  const { renderPerformance } = require('../dist/live/performance.js');
  const clock = { now: new Date('2026-09-14T12:00:00Z'), timezone: 'UTC' };
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `j${i}`, name: `Job ${i} ${'x'.repeat(80)}`, rateBps: i * 1024, bottleneck: 'Target',
    processedSize: 1, readSize: 1, transferredSize: 1, progressPercent: 50,
  }));
  const texts = [
    renderRepositories(undefined, clock),
    renderRepositories([], clock),
    renderRepositories(Array.from({ length: 80 }, (_, i) => ({
      name: `Repository ${i} ${'y'.repeat(60)}`, usedPercent: 50, usedGB: 1, capacityGB: 2, freeGB: 1, isOnline: true,
    })), clock),
    renderPerformance({ activeCount: 0, statisticsAvailable: true, jobs: [] }, clock),
    renderPerformance({ activeCount: 60, statisticsAvailable: true, jobs: many }, clock),
  ];
  for (const text of texts) {
    assert.ok(text.length <= 4096, `over the limit: ${text.length}`);
    assert.ok(isFooter(text.split('\n').at(-1)), `last line is not the footer:\n${text.split('\n').at(-1)}`);
  }
});

/* The live slots, asked directly: a cycle in, the text the room would see out. */

const snapshotsOf = (routes, env = {}) => {
  const { world: makeWorld, veeamFake: fakeVeeam, LiveSnapshotsService: Snapshots,
    VeeamEstateReader: Reader } = require('./world.cjs');
  const w = makeWorld({ TELEGRAM_LIVE: 'true', ...env });
  const snapshots = new Snapshots(w.config);
  // The server shown, as the monitor hands it over with every cycle.
  const server = { name: 'veeam', reader: new Reader(fakeVeeam(routes), monitorAccount()) };
  return { pages: (cycle) => snapshots.pages({ server, ...cycle }) };
};

const liveHealth = (over = {}) => ({
  reachable: true, authenticated: true, serverUrl: 'https://veeam.test:9419',
  error: null, trackedJobs: 3, intervalMs: 60_000, ...over,
});

/** The monitor refreshes the evidence before the slots read it; these cycles have none. */
const PENDING = { status: 'pending', reason: 'Точки восстановления ещё не прочитаны.' };

const pageOf = (pages, slot) => pages.find((page) => page.slot === slot)?.content;

test('▶️ counts a job running by status and one running by session as two', async () => {
  // The count the summary and this slot once disagreed on: status alone saw
  // one, sessions alone saw three (one of them Malware Detection, no job of
  // ours), and the truth was two.
  const { workingOf } = require('./world.cjs');
  const snapshots = snapshotsOf({
    '/api/v1/sessions/s2/taskSessions': { data: [] },
    '/api/v1/sessions/s9/taskSessions': { data: [] },
  });
  const working = workingOf([
    { id: 's2', jobId: '2', state: 'Working', progressPercent: 40, creationTime: '2026-09-14T10:00:00Z' },
    { id: 's9', jobId: 'malware', state: 'Working' },
  ]);
  const jobs = [
    { id: '1', name: 'By status', status: 'Working', lastResult: 'Success' },
    { id: '2', name: 'By session', status: 'Stopped', lastResult: 'Success' },
    { id: '3', name: 'Idle', status: 'Stopped', lastResult: 'Success' },
  ];
  const pages = await snapshots.pages({ jobs, working, authenticated: true, evidence: PENDING, health: liveHealth() });
  const running = pageOf(pages, 'running');
  assert.match(running, /выполняются: 2 задания/);
  assert.match(running, /By status/);
  assert.match(running, /By session<\/b> — 40%/);
  assert.doesNotMatch(running, /Idle|malware/);
});

test('a cycle Veeam did not answer says so in every slot instead of "nothing"', async () => {
  const snapshots = snapshotsOf({});
  const pages = await snapshots.pages({
    jobs: undefined, authenticated: false, evidence: PENDING, health: liveHealth({ reachable: false }),
  });
  assert.deepEqual(
    pages.map((page) => page.slot),
    ['health', 'running', 'schedule', 'performance', 'repositories', 'protection', 'restorePoints'],
  );
  assert.match(pageOf(pages, 'health'), /сервер недоступен/);
  assert.match(pageOf(pages, 'running'), /Сервер Veeam не отвечает/);
  assert.doesNotMatch(pageOf(pages, 'running'), /не выполняется ни одно/);
  assert.match(pageOf(pages, 'schedule'), /Расписание недоступно/);
  assert.match(pageOf(pages, 'performance'), /не авторизована/);
});

test('🧹 is only among the pages while it is switched on', async () => {
  const on = await snapshotsOf({}, { TELEGRAM_LIVE_ORPHANS: 'true' })
    .pages({ jobs: undefined, authenticated: false, evidence: PENDING, health: liveHealth() });
  assert.equal(on.at(-1).slot, 'orphans');
});

test('📈 names a job the way every other message does, and a session with no job by itself', async () => {
  const { workingOf } = require('./world.cjs');
  const snapshots = snapshotsOf({
    // Figures, or 📈 lists no names at all.
    '/api/v1/sessions/s1/taskSessions': { data: [{ type: 'Backup', progress: { processingRate: '10 MB/s', processedSize: 1 } }] },
    '/api/v1/sessions/s9/taskSessions': { data: [{ type: 'Backup', progress: { processingRate: '20 MB/s', processedSize: 1 } }] },
  });
  const working = workingOf([
    // Veeam names a session after the job as it was called then, or not at all.
    { id: 's1', jobId: 'job-guid-1', name: 'old name', state: 'Working', creationTime: '2026-09-14T10:00:00Z' },
    { id: 's9', name: 'Malware Detection', state: 'Working', creationTime: '2026-09-14T10:00:00Z' },
  ]);
  const jobs = [{ id: 'job-guid-1', name: 'OPS_MGMT_MS', result: 'success', status: 'Working' }];
  const pages = await snapshots.pages({ jobs, working, authenticated: true, evidence: PENDING, health: liveHealth() });
  const performance = pageOf(pages, 'performance');
  assert.match(performance, /OPS_MGMT_MS/);
  assert.doesNotMatch(performance, /old name/);
  assert.match(performance, /Malware Detection/);
});

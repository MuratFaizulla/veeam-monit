const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CHAT, SERVER, world, ear, veeamFake, serverOf, monitorOfServers, printerOf, monitorAccount } = require('./world.cjs');
const { jobReportOf } = require('../dist/estate/job-report');
const { jobReportPage } = require('../dist/estate/job-report-page');
const { readJob } = require('../dist/estate/job-reports');
const { VeeamEstateReader } = require('../dist/veeam/estate-reader.service');
const { encode, decode } = require('../dist/updates/keyboard');

/* ------------------------------------------------------------------ *
 * The Job report: what it says
 * ------------------------------------------------------------------ */

const TZ = 'Asia/Qyzylorda'; // +05:00, no summer time
const AT = Date.parse('2026-10-14T06:00:00Z'); // 11:00 on Wednesday 14.10, local
const GB = 1024 ** 3;
const MINUTE = 60_000;
const local = (at) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

/** One machine in one attempt. */
const task = (name, result, message = '', minutes = 10) => ({
  name, result: { result, message }, progress: { duration: `00:${String(minutes).padStart(2, '0')}:00`, transferredSize: GB },
});
/** An attempt starting at `start` (ISO, with its offset), `minutes` long. */
const attempt = (id, start, minutes, result, tasks) => ({
  session: { id, creationTime: start, endTime: new Date(Date.parse(start) + minutes * MINUTE).toISOString(), result: { result } },
  tasks,
});

const NSX = "Processing edge-01 Error: The method is disabled by 'vShield_SVM'";
const TIMEOUT = 'Error: Время ожидания операции истекло';

/**
 * OPS_Edge, every day at 04:00: edge-01 is an NSX machine no run can save,
 * db-01 timed out once and its retry saved it, web-01 is fine. Nothing ran on
 * 11.10. A Full on the third Wednesday of the month; the newest is 10.10.
 */
const edgeReading = (over = {}) => ({
  at: AT,
  days: 30,
  server: 'veeam01-backup-a',
  job: { id: 'j1', name: 'OPS_Edge', type: 'Backup', status: 'Stopped', result: 'failed' },
  configured: {
    id: 'j1',
    schedule: { runAutomatically: true, daily: { isEnabled: true, dailyKind: 'Everyday', localTime: '04:00' }, retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } },
    storage: {
      backupRepositoryId: 'r1',
      retentionPolicy: { type: 'Days', quantity: 7 },
      advancedSettings: { activeFulls: { isEnabled: true, monthly: { isEnabled: true, dayOfWeek: 'wednesday', dayNumberInMonth: 'Third' } } },
    },
    virtualMachines: { includes: [
      { type: 'VirtualMachine', name: 'edge-01', size: '1,5 GB' },
      { type: 'VirtualMachine', name: 'db-01', size: '40 GB' },
      { type: 'VirtualMachine', name: 'web-01', size: '20 GB' },
      // A container is not a machine.
      { type: 'Folder', name: 'Production' },
    ] },
  },
  // Newest first, as Veeam lists them.
  attempts: [
    attempt('c2', '2026-10-13T04:42:00+05:00', 4, 'failed', [task('edge-01', 'failed', NSX, 2)]),
    attempt('c1', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('edge-01', 'failed', NSX, 2), task('db-01', 'success'), task('web-01', 'success')]),
    attempt('b2', '2026-10-12T04:40:00+05:00', 4, 'failed', [task('edge-01', 'failed', NSX, 2)]),
    attempt('b1', '2026-10-12T04:00:00+05:00', 28, 'failed', [task('edge-01', 'failed', NSX, 2), task('db-01', 'success'), task('web-01', 'success')]),
    attempt('a2', '2026-10-10T04:45:00+05:00', 8, 'failed', [task('edge-01', 'failed', NSX, 2), task('db-01', 'success')]),
    attempt('a1', '2026-10-10T04:00:00+05:00', 32, 'failed', [task('edge-01', 'failed', NSX, 2), task('db-01', 'failed', TIMEOUT), task('web-01', 'success')]),
  ],
  bottlenecks: ['Target', 'Target', 'Source'],
  repository: { id: 'r1', name: 'NAS01_SHARE_BKP03', type: 'Smb', capacityGB: 100 * 1024, freeGB: 15 * 1024 },
  files: [
    // A backup file's time is the Veeam server's own clock, with no offset: 22:30 on the 12th is the 12th.
    { name: 'OPS_EdgeD2026-10-12T223000.vib', creationTime: '2026-10-12T22:30:00', backupSize: 5 * GB, dataSize: 20 * GB },
    { name: 'OPS_EdgeD2026-10-13T040002.vib', creationTime: '2026-10-13T04:00:02', backupSize: 4 * GB, dataSize: 18 * GB },
    { name: 'OPS_EdgeD2026-10-10T040002.vbk', creationTime: '2026-10-10T04:00:02', backupSize: 100 * GB, dataSize: 400 * GB },
  ],
  points: [
    { name: 'db-01', creationTime: '2026-10-10T04:30:00+05:00' },
    { name: 'db-01', creationTime: '2026-10-13T04:20:00+05:00' },
    { name: 'web-01', creationTime: '2026-10-10T04:10:00+05:00' },
    { name: 'web-01', creationTime: '2026-10-13T04:10:00+05:00' },
  ],
  neighbours: [{ id: 'n1', name: 'OPS_Files' }, { id: 'n2', name: 'OPS_Mail' }],
  neighbourRuns: [
    { jobId: 'n1', start: '2026-10-13T03:50:00+05:00', end: '2026-10-13T05:10:00+05:00' },
    // Done before OPS_Edge started: not a neighbour that night.
    { jobId: 'n2', start: '2026-10-13T01:00:00+05:00', end: '2026-10-13T02:00:00+05:00' },
  ],
  ...over,
});

test('a job is told by its runs, a retry folded into the run it retried, and a scheduled day nothing ran on', () => {
  const report = jobReportOf(edgeReading(), TZ);

  assert.deepEqual(report.runs.map((run) => [local(run.start), run.result, run.pieces.length]), [
    ['10.10, 04:00', 'failed', 2],
    ['12.10, 04:00', 'failed', 2],
    ['13.10, 04:00', 'failed', 2],
  ]);
  assert.deepEqual(report.runs.map((run) => `${run.saved}/${run.machines}`), ['2/3', '2/3', '2/3']);
  assert.deepEqual(report.missed.map(local), ['11.10, 04:00']);
  assert.equal(report.usual, 30);
});

test('a machine no run saves comes first, and one a retry saved says so', () => {
  const report = jobReportOf(edgeReading(), TZ);

  assert.deepEqual(report.machines.map((machine) => machine.name), ['edge-01', 'db-01', 'web-01'], 'the folder is not a machine');
  const [edge, db, web] = report.machines;
  assert.equal(edge.failing, true);
  assert.equal(edge.points, 0);
  assert.equal(edge.error, "The method is disabled by 'vShield_SVM'");
  assert.deepEqual(edge.history, ['failed', 'failed', 'failed']);
  assert.equal(db.error, 'Время ожидания операции истекло');
  assert.equal(db.errorTone, 'healed');
  assert.deepEqual(db.history, ['success', 'success', 'success']);
  assert.equal(db.points, 2);
  assert.equal(web.error, undefined);
  assert.equal(web.minutes, 10);
  assert.deepEqual(report.errors.map((group) => [group.text, group.machines.length, group.runs]), [
    ["The method is disabled by 'vShield_SVM'", 1, 3],
    ['Время ожидания операции истекло', 1, 1],
  ]);
});

test('the report says what is wrong and what to do about it, in the words of what it found', () => {
  const report = jobReportOf(edgeReading(), TZ);

  assert.equal(report.status, 'crit');
  assert.equal(report.verdict, '1 из 3 машин не сохранена ни разу за 30 дней; все 3 запуска закончились ошибкой');
  assert.deepEqual(report.findings.map((finding) => finding.title).slice(2), ['Не было 1 запуска по расписанию', 'На BKP03 свободно 15%']);
  assert.equal(report.steps[0].title, 'Исключить из задания 1 служебную машину NSX');
  assert.deepEqual(report.steps[0].tags, ['edge-01']);
  const full = report.steps.find((step) => /Active Full/.test(step.title));
  assert.equal(full.title, 'Следующий Active Full — 21.10');
  assert.equal(full.severity, 'ok');
});

test('the chain is told a day at a time, newest first, each on the day the Veeam server wrote it', () => {
  const report = jobReportOf(edgeReading(), TZ);
  const day = (utcMidnight) => new Date(utcMidnight).toISOString().slice(0, 10);

  assert.deepEqual(report.chain.map((entry) => [day(entry.day), entry.full]), [
    ['2026-10-13', false],
    ['2026-10-12', false],
    ['2026-10-10', true],
  ]);
  assert.equal(report.disk, 109 * GB);
  assert.equal(report.lastFull.disk, 100 * GB);
  assert.deepEqual(report.depth, { points: 2, oldest: Date.parse('2026-10-10T04:10:00+05:00') });
});

test('who else writes to the repository is whoever was writing while the newest run was', () => {
  const report = jobReportOf(edgeReading(), TZ);

  assert.deepEqual(report.neighbours.rows.map((row) => [row.name, Boolean(row.own)]), [['OPS_Edge', true], ['OPS_Files', false]]);
  assert.equal(report.neighbours.jobs, 1);
  assert.equal(report.neighbours.of, 2);
  assert.equal(local(report.neighbours.origin), '12.10, 12:00', 'the chart starts at the noon before');
  assert.equal(report.bottleneck, 'Target');
});

test('a first attempt a retry makes good every time is a warning, and a Full that will not fit is said', () => {
  const healed = edgeReading({
    configured: { ...edgeReading().configured, virtualMachines: { includes: [] } },
    attempts: [
      attempt('b2', '2026-10-13T04:40:00+05:00', 9, 'success', [task('db-01', 'success')]),
      attempt('b1', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', TIMEOUT), task('web-01', 'success')]),
      attempt('a2', '2026-10-12T04:40:00+05:00', 9, 'success', [task('db-01', 'success')]),
      attempt('a1', '2026-10-12T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', TIMEOUT), task('web-01', 'success')]),
    ],
    repository: { id: 'r1', name: 'NAS01_SHARE_BKP03', type: 'Smb', capacityGB: 1024, freeGB: 200 },
  });
  const report = jobReportOf(healed, TZ);

  assert.equal(report.status, 'warn');
  assert.deepEqual(report.findings.map((finding) => finding.title), [
    'Первая попытка падает в 2 из 2 запусков — спасает повтор',
    'Active Full 21.10 займёт ≈ 100 ГБ — свободно 200 ГБ',
  ]);
  assert.deepEqual(report.steps.map((step) => step.title), [
    'Сдвинуть старт с 04:00 или проверить vCenter',
    'Освободить место на BKP03 до 21.10',
  ]);
});

test('the page has the overview, the machines and the storage, and Veeam\'s names are escaped', () => {
  const html = jobReportPage(jobReportOf(edgeReading({ job: { id: 'j1', name: 'OPS_<b>Edge</b>', type: 'Backup', result: 'failed' } }), TZ), TZ);

  assert.equal(html.match(/<section class="page">/g).length, 3);
  assert.match(html, /Запуски за 30 дней/);
  assert.match(html, /Машины/);
  assert.match(html, /Кто ещё писал в BKP03/);
  assert.match(html, /OPS_&lt;b&gt;Edge&lt;\/b&gt;/);
  assert.doesNotMatch(html, /OPS_<b>Edge/);
  assert.match(html, /url\(data:font\/woff2;base64,/, 'the font is in the page');
  assert.doesNotMatch(html, /https?:\/\//, 'the page fetches nothing');
});

/* ------------------------------------------------------------------ *
 * Reading it
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const recent = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

/** A server with OPS_Edge, its sessions — one of them with machines Veeam cannot list — its backup and a neighbour. */
const edgeServer = (over = {}) => {
  const asked = [];
  const veeam = veeamFake({
    '/api/v1/jobs/states': { data: [{ id: 'j1', name: 'OPS_Edge', type: 'Backup', status: 'Stopped', lastResult: 'Failed' }] },
    '/api/v1/jobs/j1': edgeReading().configured,
    '/api/v1/jobs': { data: [
      { id: 'j1', name: 'OPS_Edge', storage: { backupRepositoryId: 'r1' } },
      { id: 'n1', name: 'OPS_Files', storage: { backupRepositoryId: 'r1' } },
      { id: 'n9', name: 'OPS_Elsewhere', storage: { backupRepositoryId: 'r9' } },
    ] },
    '/api/v1/sessions': (req) => {
      asked.push(req.params);
      if (req.params?.jobIdFilter === 'j1') return { data: [
        { id: 's2', jobId: 'j1', creationTime: recent(24), endTime: recent(23.5), result: { result: 'Failed' } },
        { id: 's1', jobId: 'j1', creationTime: recent(48), endTime: recent(47.5), result: { result: 'Success' } },
        // Before the month: not read.
        { id: 's0', jobId: 'j1', creationTime: recent(24 * 40), endTime: recent(24 * 40 - 1), result: { result: 'Success' } },
      ] };
      return { data: [
        { id: 'x1', jobId: 'n1', creationTime: recent(24.2), endTime: recent(23), result: { result: 'Success' } },
        { id: 'x2', jobId: 'n9', creationTime: recent(24.2), endTime: recent(23), result: { result: 'Success' } },
      ] };
    },
    '/api/v1/sessions/s1/taskSessions': { data: [task('db-01', 'Success')] },
    // A server whose REST API predates task sessions.
    '/api/v1/sessions/s2/taskSessions': () => { throw new Error('HTTP 404'); },
    '/api/v1/sessions/s1/logs': { records: [{ title: 'Primary bottleneck: Target' }] },
    '/api/v1/sessions/s2/logs': { records: [{ title: 'Primary bottleneck: Source' }] },
    '/api/v1/backupInfrastructure/repositories/states': { data: [edgeReading().repository] },
    '/api/v1/backups': { data: [{ id: 'b1', name: 'OPS_Edge', jobId: 'j1' }, { id: 'b2', name: 'OPS_Other', jobId: 'j2' }] },
    '/api/v1/backups/b1/backupFiles': { data: edgeReading().files },
    '/api/v1/restorePoints': { data: [{ name: 'db-01', backupId: 'b1', creationTime: recent(47) }, { name: 'other', backupId: 'b2', creationTime: recent(47) }] },
    ...over,
  });
  return { veeam, asked };
};

test('a job is read for its month: its sessions and their machines, its files and points, and its neighbours', async () => {
  const { veeam } = edgeServer();
  const reading = await readJob('veeam01-backup-a', new VeeamEstateReader(veeam, monitorAccount()), 'j1', NOW);

  assert.equal(reading.error, undefined);
  assert.equal(reading.job.name, 'OPS_Edge');
  assert.deepEqual(reading.attempts.map(({ session, tasks }) => [session.id, tasks?.length]), [['s2', undefined], ['s1', 1]]);
  assert.deepEqual(reading.bottlenecks, ['Source', 'Target']);
  assert.equal(reading.repository.name, 'NAS01_SHARE_BKP03');
  assert.equal(reading.files.length, 3);
  assert.deepEqual(reading.points.map((point) => point.name), ['db-01']);
  assert.deepEqual(reading.neighbours, [{ id: 'n1', name: 'OPS_Files' }]);
  assert.deepEqual(reading.neighbourRuns.map((run) => run.jobId), ['n1']);
});

test('a request after the sessions that fails is said, and the rest is kept; a job that is gone is none', async () => {
  const { veeam } = edgeServer({ '/api/v1/backups': () => { throw new Error('The Veeam server did not respond within 30000 ms'); } });
  const reader = new VeeamEstateReader(veeam, monitorAccount());
  const reading = await readJob('veeam01-backup-a', reader, 'j1', NOW);

  assert.match(reading.error, /^бэкапы: .*did not respond/);
  assert.equal(reading.attempts.length, 2);
  assert.deepEqual(reading.points, []);
  assert.equal(await readJob('veeam01-backup-a', reader, 'gone', NOW), undefined);
});

/* ------------------------------------------------------------------ *
 * Asking for it
 * ------------------------------------------------------------------ */

const FORUM = { id: Number(CHAT), type: 'supergroup', is_forum: true };
const pressed = (w, data) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  callback_query: { id: 'cb-report', data, message: { message_id: 9, message_thread_id: 1, is_topic_message: true, chat: FORUM } },
});

test('the 📄 Button under a Job card says the report is coming, then sends it as a PDF', async () => {
  const w = world();
  const { veeam } = edgeServer();
  const printer = printerOf();
  const { updates, commands } = ear(w, monitorOfServers(w, [serverOf(w, veeam)], printer));

  await pressed({ updates }, encode({ kind: 'report', id: 'j1', server: SERVER }));
  await commands.settled();

  const [note] = w.api.sent();
  assert.match(note.text, /^⏳ <b>Готовлю отчёт по заданию<\/b>\n\nЧитаю запуски, машины и точки за 30 дней/);
  const order = w.api.calls.map((call) => call.method).filter((method) => method === 'sendMessage' || method === 'sendDocument');
  assert.deepEqual(order, ['sendMessage', 'sendDocument'], 'сначала «готовлю», потом файл');
  assert.ok(w.api.of('sendChatAction').some((call) => call.action === 'upload_document'));
  const [sent] = w.api.of('sendDocument');
  assert.match(sent.document.filename, /^Задание OPS_Edge \d\d\.\d\d\.\d{4}\.pdf$/);
  assert.match(sent.caption, /^📄 <b>OPS_Edge<\/b> — /);
  assert.match(sent.caption, /\n<i>localhost · за 30 дней, на \d\d\.\d\d\.\d{4} \d\d:\d\d\.<\/i>$/);
  assert.match(printer.pages[0], /Машины/);
});

test('a job\'s report Button carries its server and id within Telegram\'s 64 bytes, and reads back', () => {
  const action = { kind: 'report', id: '1e218e3f-9e08-4e28-ae89-06077422eddf', server: 'veeam01-backup' };
  const data = encode(action);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(decode(data), action);
});

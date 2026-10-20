const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CHAT, SERVER, world, ear, veeamFake, serverOf, monitorOfServers, printerOf, monitorAccount } = require('./world.cjs');
const { jobReportOf } = require('../dist/estate/job-report');
const { jobReportPage } = require('../dist/estate/job-report-page');
const { sessionReportOf } = require('../dist/estate/session-report');
const { sessionReportPage, veeamSize, veeamDuration } = require('../dist/estate/session-report-page');
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

/* ------------------------------------------------------------------ *
 * The file: the job's sessions, as Veeam's own report prints them
 * ------------------------------------------------------------------ */

test('every session is a block of its own, newest first, a retry and a Full named as Veeam names them', () => {
  const report = sessionReportOf(edgeReading(), TZ);

  assert.equal(report.kind, 'Backup job');
  assert.deepEqual(report.sessions.map((session) => [session.title, session.status, `${session.processed} of ${session.of}`]), [
    ['OPS_Edge (Retry 1)', 'Error', '1 of 1'],
    ['OPS_Edge', 'Error', '3 of 3'],
    ['OPS_Edge (Retry 1)', 'Error', '1 of 1'],
    ['OPS_Edge', 'Error', '3 of 3'],
    ['OPS_Edge (Retry 1)', 'Error', '2 of 2'],
    ['OPS_Edge', 'Error', '3 of 3'],
  ]);
  const newestRun = report.sessions[1];
  assert.deepEqual(newestRun.counts, { success: 2, warning: 0, error: 1 });
  assert.deepEqual(newestRun.notes, ['Job finished with error at 10/13/2026 4:30:00 AM']);
  assert.equal(newestRun.transferred, 3 * GB);
  assert.equal(newestRun.totalSize, undefined, 'Veeam did not say how big the machines are');
  // edge-01's own outcome names the machine again: the row already does.
  assert.deepEqual(newestRun.machines[0].details, ["Error: The method is disabled by 'vShield_SVM'"]);
  assert.deepEqual(newestRun.machines[1].details, []);

  const full = sessionReportOf(edgeReading({
    attempts: [attempt('f1', '2026-10-13T04:00:00+05:00', 30, 'success', [{ ...task('db-01', 'success'), algorithm: 'Full' }, { ...task('web-01', 'success'), algorithm: 'Full' }])],
  }), TZ);
  assert.equal(full.sessions[0].title, 'OPS_Edge (Full)');
  assert.equal(full.sessions[0].status, 'Success');
  assert.deepEqual(full.sessions[0].notes, []);
});

test('a session\'s backup size is what it wrote; before the oldest file on disk it is not known', () => {
  const report = sessionReportOf(edgeReading({
    files: [
      { name: 'OPS_EdgeD2026-10-13T040002.vib', creationTime: '2026-10-13T04:00:02', backupSize: 4 * GB, dataSize: 18 * GB, dedupRatio: 71, compressRatio: 56 },
      { name: 'OPS_EdgeD2026-10-12T040002.vib', creationTime: '2026-10-12T04:00:02', backupSize: 3 * GB, dataSize: 9 * GB },
    ],
  }), TZ);
  const at = (start) => report.sessions.find((session) => session.start === Date.parse(start));

  const wrote = at('2026-10-13T04:00:00+05:00');
  assert.equal(wrote.backupSize, 4 * GB);
  assert.equal(wrote.dedupe.toFixed(1), '1.4');
  assert.equal(wrote.compression.toFixed(1), '1.8');
  // The retry after it wrote nothing: there are files that old, and none of its own.
  assert.deepEqual([at('2026-10-13T04:42:00+05:00').backupSize, at('2026-10-13T04:42:00+05:00').dedupe], [0, 1]);
  // 10.10 is before the oldest file kept: whatever it wrote is gone, not unwritten.
  assert.equal(at('2026-10-10T04:00:00+05:00').backupSize, undefined);
});

test('a machine\'s details are what its log says went wrong, each line once, the last line kept', () => {
  const failed = { ...task('db-01', 'failed', 'Getting VM info from vSphere'), id: 't-db', creationTime: '2026-10-13T23:50:00', endTime: '2026-10-14T00:10:00' };
  const report = sessionReportOf(edgeReading({
    attempts: [attempt('d1', '2026-10-13T23:45:00+05:00', 40, 'failed', [failed])],
    taskLogs: { 't-db': [
      { status: 'Succeeded', title: 'Queued for processing at 13.10.2026 23:50:00' },
      { status: 'Failed', title: 'Getting VM info from vSphere' },
      { status: 'Failed', title: 'Error: Cannot get service content.\r\nSoap fault.' },
      { status: 'Warning', title: 'Processing db-01 Error: Cannot get service content.' },
      { status: 'Failed', title: 'Processing finished with errors at 14.10.2026 0:10:00' },
    ] },
  }), TZ);
  const [machine] = report.sessions[0].machines;

  assert.deepEqual(machine.details, ['Getting VM info from vSphere', 'Error: Cannot get service content.', 'Soap fault.', 'Processing finished with errors at 14.10.2026 0:10:00']);
  // A task's time is the Veeam server's clock: 23:50 to 00:10, twenty minutes, into the next day.
  assert.equal(machine.minutes, 20);
});

test('the connection parameters Veeam writes after an error never reach the file, from a session, a machine or a line of its log', () => {
  const LOGON = 'Logon attempt with parameters [VC/ESX: [vc01.example.com];Port: 443;Login: [svc-backup@example.com];VMX Spec: [moref=vm-31466]]';
  const reading = edgeReading({
    attempts: [{
      session: {
        id: 'k1', creationTime: '2026-10-13T04:00:00+05:00', endTime: '2026-10-13T04:30:00+05:00',
        result: { result: 'failed', message: `Processing db-01 Error: Cannot get service content.\r\n${LOGON}` },
      },
      tasks: [
        // Its log is read, and says it on a line of its own.
        { ...task('db-01', 'failed', 'Getting VM info from vSphere'), id: 't-db' },
        // Its log is not: its own message is all there is, and opens with them.
        task('app-01', 'failed', `${LOGON}\r\nFailed to open disk for read.`),
        // A build that writes it all on one line.
        task('web-01', 'warning', `Failed to open VDDK disk ${LOGON} Failed to upload disk.`),
      ],
    }],
    taskLogs: { 't-db': [
      { status: 'Failed', title: 'Getting VM info from vSphere' },
      { status: 'Failed', title: `Error: Cannot get service content.\r\n${LOGON}` },
      { status: 'Failed', title: LOGON },
    ] },
  });

  const html = jobReportPage(jobReportOf(reading, TZ), sessionReportOf(reading, TZ), TZ);

  assert.doesNotMatch(html, /Logon attempt|Login:|svc-backup@example\.com|moref/);
  // And everything else Veeam said is still said, on both halves of the file.
  assert.match(html, /class="note">Processing db-01<br>Error: Cannot get service content\.<br>Job finished with error at /);
  assert.match(html, /<td class="note">Getting VM info from vSphere<br>Error: Cannot get service content\.<\/td>/);
  assert.match(html, /<td class="note">Failed to open disk for read\.<\/td>/);
  assert.match(html, /<td class="note">Failed to open VDDK disk Failed to upload disk\.<\/td>/);
  assert.match(html, /<div class="js-err">Failed to open disk for read\./);
});

test('past midnight is "(+N)" by whole days since the session started, as Veeam counts it, and seconds are not rounded up', () => {
  const html = (start, minutes) => sessionReportPage(sessionReportOf(edgeReading({ attempts: [attempt('l1', start, minutes, 'failed', [])] }), TZ), TZ);

  // 23:45 to 00:25: the next day, but not a day later.
  assert.match(html('2026-10-13T23:45:00+05:00', 40), /<td class="k">End time<\/td><td>12:25:00 AM<\/td>/);
  // Friday 21:48:48 to Sunday 19:41:50 — 45:53:02 — is "(+1)" in Veeam's report.
  const long = html('2026-10-10T21:48:48+05:00', 45 * 60 + 53 + 2.9 / 60);
  assert.match(long, /7:41:50 PM \(\+1\)/);
  assert.match(long, /<td>45:53:02<\/td>/);
});

test('a replica\'s backup size is what a good session sent and nothing for a failed one; a job started by hand has no retries', () => {
  const replica = edgeReading({
    job: { id: 'j1', name: 'OPS_Replica', type: 'VSphereReplica', result: 'failed' },
    configured: { ...edgeReading().configured, schedule: { runAutomatically: false, retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } } },
    files: [],
    attempts: [
      attempt('r2', '2026-10-13T04:42:00+05:00', 30, 'success', [task('db-01', 'success')]),
      attempt('r1', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', 'Error: A connection attempt failed because the connected party did not properly respond after a period of time 10.13.0.7:443')]),
    ],
  });
  const report = sessionReportOf(replica, TZ);

  assert.equal(report.kind, 'Replication job');
  assert.deepEqual(report.sessions.map((session) => [session.title, session.backupSize]), [['OPS_Replica', GB], ['OPS_Replica', 0]]);
  assert.equal(report.sessions[0].dedupe, 1);
});

test('a session still going says how far it has got, and its machines still going have no end', () => {
  // Neither has an end: however Veeam writes "not yet", the reader hands out none.
  const running = {
    session: { id: 'r1', creationTime: '2026-10-14T04:00:00+05:00', state: 'Working', progressPercent: 62, result: { result: 'none' } },
    tasks: [{ name: 'db-01', state: 'Working', result: { result: 'none' }, creationTime: '2026-10-14T04:01:00', progress: { processedSize: 40 * GB, readSize: 10 * GB, transferredSize: 2 * GB } }],
  };
  const report = sessionReportOf(edgeReading({ attempts: [running] }), TZ);
  const [session] = report.sessions;

  assert.equal(session.status, 'In progress');
  assert.deepEqual(session.notes, ['Processing (62% done)']);
  assert.equal(`${session.processed} of ${session.of}`, '0 of 1');
  assert.equal(session.machines[0].status, 'In progress');
  assert.equal(session.machines[0].end, undefined);
  assert.equal(session.totalSize, 40 * GB);
});

test('the page is Veeam\'s: its header, its day, its numbers, its Details; names escaped, nothing fetched', () => {
  const html = sessionReportPage(sessionReportOf(edgeReading({ job: { id: 'j1', name: 'OPS_<b>Edge</b>', type: 'Backup', result: 'failed' } }), TZ), TZ);

  assert.equal(html.match(/<div class="vb">/g).length, 6);
  assert.match(html, /Backup job: OPS_&lt;b&gt;Edge&lt;\/b&gt; \(Retry 1\)/);
  assert.doesNotMatch(html, /OPS_<b>Edge/);
  assert.match(html, /Tuesday, October 13, 2026 4:42:00 AM/);
  assert.match(html, /<td class="k">Backup size<\/td>/);
  assert.match(html, />Details</);
  assert.match(html, /<span class="st bad">Error<\/span>/);
  assert.match(html, /url\(data:font\/woff2;base64,/, 'the font is in the page');
  assert.doesNotMatch(html, /https?:\/\//, 'the page fetches nothing');
});

/* ------------------------------------------------------------------ *
 * The file's first page: the job at a glance
 * ------------------------------------------------------------------ */

test('the file opens with a page that says how the job stands, and the sessions follow on pages of their own', () => {
  const reading = edgeReading({ job: { id: 'j1', name: 'OPS_<b>Edge</b>', type: 'Backup', result: 'failed' } });
  const html = jobReportPage(jobReportOf(reading, TZ), sessionReportOf(reading, TZ), TZ);

  assert.equal(html.match(/<section class="js">/g).length, 1, 'one page before the sessions');
  assert.match(html, /Задание: OPS_&lt;b&gt;Edge&lt;\/b&gt;/);
  assert.match(html, /Сводка/);
  assert.match(html, /1 из 3 машин не сохранена ни разу за 30 дней/);
  assert.match(html, /Запуски за 30 дней/);
  assert.match(html, /Что сделать/);
  assert.match(html, /Исключить из задания 1 служебную машину NSX/);
  assert.match(html, /Машины/);
  assert.match(html, /Кто ещё писал в BKP03/);
  assert.match(html, /<div class="vr">/);
  assert.match(html, /@page sessions \{[^}]*margin: 9mm 10mm/);
  assert.match(html, /Backup job: OPS_&lt;b&gt;Edge&lt;\/b&gt;/);
  assert.doesNotMatch(html, /OPS_<b>Edge/);
  assert.doesNotMatch(html, /https?:\/\//, 'the page fetches nothing');
});

test('a replica is told by its runs, not by restore points the bot cannot see', () => {
  const replica = edgeReading({
    job: { id: 'j1', name: 'OPS_Replica', type: 'VSphereReplica', result: 'failed' },
    configured: { ...edgeReading().configured, virtualMachines: { includes: [{ type: 'VirtualMachine', name: 'db-01' }] } },
    files: [],
    points: [],
    neighbours: [],
    neighbourRuns: [],
    attempts: [
      attempt('r2', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', 'Error: A connection attempt failed because the connected party did not properly respond after a period of time 10.13.0.7:443')]),
      attempt('r1', '2026-10-12T04:00:00+05:00', 30, 'success', [task('db-01', 'success')]),
    ],
  });
  const report = jobReportOf(replica, TZ);
  const html = jobReportPage(report, sessionReportOf(replica, TZ), TZ);

  assert.match(html, /Машины реплицированы/);
  assert.match(html, /Последняя удачная/);
  assert.doesNotMatch(html, /точек нет/);
  assert.doesNotMatch(html, /Кто ещё писал/, 'nobody else writes there: no chart of nobody');
  assert.equal(report.steps[0].title, 'Проверить связь до 10.13.0.7:443');
  assert.equal(report.steps[0].severity, 'crit');
});

test('a run still going leaves "all failed" to the ones that ended, and a machine no run took on is said', () => {
  const going = {
    session: { id: 'g1', creationTime: '2026-10-14T04:00:00+05:00', state: 'Working', result: { result: 'none' } },
    tasks: [task('db-01', 'none')],
  };
  const reading = edgeReading({
    configured: { ...edgeReading().configured, virtualMachines: { includes: [{ type: 'VirtualMachine', name: 'db-01' }, { type: 'VirtualMachine', name: 'gone-01' }] } },
    attempts: [going, ...edgeReading().attempts.filter(({ session }) => !session.id.startsWith('c')).map((a) => ({ ...a, tasks: a.tasks.filter((t) => t.name === 'db-01') }))],
  });
  const report = jobReportOf(reading, TZ);

  assert.equal(report.status, 'crit');
  assert.equal(report.verdict, '1 из 2 машин задания ни один запуск не обработал; все 2 запуска закончились ошибкой');
  assert.equal(report.steps[0].title, 'Найти в vCenter 1 машину задания');
  assert.deepEqual(report.steps[0].tags, ['gone-01']);
});

test('sizes and durations are written as Veeam writes them', () => {
  assert.deepEqual([0, 512, 1.5 * 1024 ** 2, 9 * 1024 ** 4, 40.3 * 1024 ** 4].map(veeamSize), ['0 B', '512 B', '1.5 MB', '9 TB', '40.3 TB']);
  assert.equal(veeamSize(undefined), '—');
  assert.equal(veeamDuration(45 * 60 + 53 + 2 / 60), '45:53:02');
  assert.equal(veeamDuration(3), '0:03:00');
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

test('the log of a machine is read only when it did not end in a success: its own outcome says only the step', async () => {
  const askedLogs = [];
  const log = (id, records) => () => { askedLogs.push(id); return { records }; };
  const { veeam } = edgeServer({
    '/api/v1/sessions/s1/taskSessions': { data: [{ ...task('db-01', 'Failed', 'Getting VM info from vSphere'), id: 'tf' }, { ...task('web-01', 'Success'), id: 'ts' }] },
    '/api/v1/taskSessions/tf/logs': log('tf', [{ status: 'Failed', title: 'Error: Cannot get service content.' }]),
    '/api/v1/taskSessions/ts/logs': log('ts', []),
  });
  const reading = await readJob('veeam01-backup-a', new VeeamEstateReader(veeam, monitorAccount()), 'j1', NOW);

  assert.deepEqual(askedLogs, ['tf']);
  assert.deepEqual(reading.taskLogs, { tf: [{ status: 'Failed', title: 'Error: Cannot get service content.' }] });
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
  assert.match(printer.pages[0], /Что сделать/);
  assert.match(printer.pages[0], /Backup job: OPS_Edge/);
  assert.match(printer.pages[0], />Details</);
});

test('a job\'s report Button carries its server and id within Telegram\'s 64 bytes, and reads back', () => {
  const action = { kind: 'report', id: '1e218e3f-9e08-4e28-ae89-06077422eddf', server: 'veeam01-backup' };
  const data = encode(action);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(decode(data), action);
});

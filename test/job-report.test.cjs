const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CHAT, SERVER, world, ear, veeamFake, serverOf, idleMonitor, answersOf, printerOf, monitorAccount, jobReadsOf, telegramConfig } = require('./world.cjs');
const { jobReportOf, dayLabel } = require('../dist/estate/job-report');
const { jobReportPage } = require('../dist/estate/job-report-page');
const { sessionReportOf } = require('../dist/estate/session-report');
const { sessionReportPage, veeamSize, veeamDuration } = require('../dist/estate/session-report-page');
const { readJob, JobReports } = require('../dist/estate/job-reports');
const { readingOf } = require('../dist/estate/evidence');
const { assessProtection, judgementOf, standingsOf, thresholdsOf } = require('../dist/estate/job-standing');
const { renderProtection } = require('../dist/live/protection');
const { VeeamJobReads } = require('../dist/estate/job-reads');
const { VeeamEstateReader } = require('../dist/veeam/estate-reader.service');
const { VeeamApiError } = require('../dist/veeam/api.error');
const { encode, decode } = require('../dist/updates/keyboard');

/* ------------------------------------------------------------------ *
 * The Job report: what it says
 * ------------------------------------------------------------------ */

const TZ = 'Asia/Qyzylorda'; // +05:00, no summer time
const AT = Date.parse('2026-10-14T06:00:00Z'); // 11:00 on Wednesday 14.10, local
const GB = 1024 ** 3;
const MINUTE = 60_000;
const local = (at) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
/** "04:30", as the first page writes a time; `timezone` empty for the machine's own. */
const timeLabel = (at, timezone) => new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

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

/** 🛡's thresholds as shipped: three days at least, two and a half of the job's own intervals, three failed runs. */
const THRESHOLDS = thresholdsOf(telegramConfig());

const edgePoint = (id, session, name, at, type = 'Increment') => ({ id, backupId: 'b1', sessionId: session, name, type, creationTime: at });
/**
 * OPS_Edge's points as the scan read them: db-01 and web-01 each night a run
 * saved them, a Full on 10.10. A retry writes into its run's point, which
 * carries the first attempt's id.
 */
const EDGE_POINTS = [
  edgePoint('p10-db', 'a1', 'db-01', '2026-10-10T04:50:00+05:00', 'Full'),
  edgePoint('p10-web', 'a1', 'web-01', '2026-10-10T04:10:00+05:00', 'Full'),
  edgePoint('p12-db', 'b1', 'db-01', '2026-10-12T04:20:00+05:00'),
  edgePoint('p12-web', 'b1', 'web-01', '2026-10-12T04:10:00+05:00'),
  edgePoint('p13-db', 'c1', 'db-01', '2026-10-13T04:20:00+05:00'),
  edgePoint('p13-web', 'c1', 'web-01', '2026-10-13T04:10:00+05:00'),
];

/**
 * The job of `reading` as its server's Evidence judges it, the scan having
 * read the month's sessions, `points`, and how the machines of the failed
 * sessions ended — as /points and 🛡 have it at the report's moment.
 */
const judgedOf = (reading, points = EDGE_POINTS) => {
  const sessions = reading.attempts.map(({ session }) => ({ ...session, jobId: reading.job.id, sessionType: 'BackupJob' }));
  const outcomes = new Map(reading.attempts.map(({ session, tasks }) => [session.id, new Map((tasks ?? []).map((one) => [one.name, one.result.result]))]));
  const evidence = readingOf({ jobs: [reading.job], configurations: reading.configured ? [reading.configured] : [], backups: [{ id: 'b1', jobId: reading.job.id }], points, sessions })
    .evidence(outcomes, reading.at);
  return { status: 'ready', ...judgementOf(reading.job, evidence, { now: new Date(reading.at), timezone: TZ }, THRESHOLDS) };
};

/**
 * OPS_Edge, every day at 04:00: edge-01 is an NSX machine no run can save,
 * db-01 timed out once and its retry saved it, web-01 is fine. Nothing ran on
 * 11.10. A Full on the third Wednesday of the month; the newest is 10.10.
 * Its points are the Evidence's, of `points` read beside its sessions.
 */
const edgeReading = (over = {}, points = EDGE_POINTS) => {
  const reading = edgeRead(over);
  return { ...reading, evidence: over.evidence ?? judgedOf(reading, points) };
};

/** What is read of OPS_Edge but its Evidence. */
const edgeRead = (over) => ({
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
  // As the Job reads give them, by the rule the card's ⚡ reads its run by.
  bottlenecks: ['target', 'target', 'source'],
  repository: { id: 'r1', name: 'NAS01_SHARE_BKP03', type: 'Smb', capacityGB: 100 * 1024, freeGB: 15 * 1024 },
  // Each names the points it holds. Its time is the Veeam server's own clock, with no offset.
  files: [
    { name: 'OPS_EdgeD2026-10-13T040002.vib', creationTime: '2026-10-13T04:00:02', restorePointIds: ['p13-db', 'p13-web'], backupSize: 4 * GB, dataSize: 18 * GB },
    { name: 'OPS_EdgeD2026-10-12T040002.vib', creationTime: '2026-10-12T04:00:02', restorePointIds: ['p12-db', 'p12-web'], backupSize: 5 * GB, dataSize: 20 * GB },
    { name: 'OPS_EdgeD2026-10-10T040002.vbk', creationTime: '2026-10-10T04:00:02', restorePointIds: ['p10-db', 'p10-web'], backupSize: 100 * GB, dataSize: 400 * GB },
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

test('a monthly job owes its start on its day of the month, and one that did not come is missed', () => {
  // On the fourth Saturday at 22:00, as Veeam's own example has it — with the date beside it that Veeam does not go by.
  const report = jobReportOf(edgeReading({
    at: Date.parse('2026-10-26T06:00:00Z'), // 11:00 on Monday 26.10, local
    configured: {
      ...edgeRead({}).configured,
      schedule: { runAutomatically: true, monthly: { isEnabled: true, dayNumberInMonth: 'Fourth', dayOfWeek: 'saturday', dayOfMonth: 1, localTime: '22:00' } },
    },
    attempts: [attempt('m1', '2026-09-26T22:00:00+05:00', 40, 'success', [task('edge-01', 'success'), task('db-01', 'success'), task('web-01', 'success')])],
  }), TZ);

  assert.deepEqual(report.missed.map(local), ['24.10, 22:00']);
});

test('a job started every six hours misses the start it skipped, which the next one does not make up for', () => {
  const night = (day, hour) => attempt(`s${day}${hour}`, `2026-10-${day}T${hour}:00:00+05:00`, 30, 'success', [task('db-01', 'success'), task('web-01', 'success')]);
  const report = jobReportOf(edgeReading({
    configured: { ...edgeRead({}).configured, schedule: { runAutomatically: true, periodically: { isEnabled: true, periodicallyKind: 'Hours', frequency: 6 } } },
    // Newest first; nothing at 12:00 on 12.10.
    attempts: [
      night(13, 18), night(13, 12), night(13, '06'), night(13, '00'),
      night(12, 18), night(12, '06'), night(12, '00'),
      night(11, '00'),
    ],
  }), TZ);

  assert.deepEqual(report.missed.map(local), ['12.10, 12:00']);
});

test('a start that falls while the run before it is still going is not missed: Veeam does not start a running job', () => {
  // Every six hours, eight hours a run: Veeam starts it at 00, 08 and 16 and skips 06, 12 and 18.
  const night = (day, hour) => attempt(`s${day}${hour}`, `2026-10-${day}T${hour}:00:00+05:00`, 8 * 60, 'success', [task('db-01', 'success'), task('web-01', 'success')]);
  const report = jobReportOf(edgeReading({
    configured: { ...edgeRead({}).configured, schedule: { runAutomatically: true, periodically: { isEnabled: true, periodicallyKind: 'Hours', frequency: 6 } } },
    attempts: [
      night(13, 16), night(13, '08'), night(13, '00'),
      night(12, 16), night(12, '08'), night(12, '00'),
      night(11, 16), night(11, '08'), night(11, '00'),
    ],
  }), TZ);

  assert.deepEqual(report.missed.map(local), []);
});

test('a machine no run saves comes first, and one a retry saved says so', () => {
  const report = jobReportOf(edgeReading(), TZ);

  assert.deepEqual(report.machines.map((machine) => machine.name), ['edge-01', 'db-01', 'web-01'], 'the folder is not a machine');
  const [edge, db, web] = report.machines;
  assert.equal(edge.failing, true);
  assert.equal(edge.error, "The method is disabled by 'vShield_SVM'");
  assert.deepEqual(edge.history, ['failed', 'failed', 'failed']);
  assert.equal(db.error, 'Время ожидания операции истекло');
  assert.equal(db.errorTone, 'healed');
  assert.deepEqual(db.history, ['success', 'success', 'success']);
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
  // What 🛡 says of it first, in its words, then what the month's runs and machines say.
  assert.equal(report.verdict, '3 неудачных запуска подряд; 1 из 3 машин не сохранена ни разу за 30 дней');
  assert.deepEqual(report.findings.map((finding) => finding.title).slice(2), ['Все 3 запуска закончились ошибкой', 'Не было 1 запуска по расписанию', 'На BKP03 свободно 15%']);
  assert.equal(report.steps[0].title, 'Исключить из задания 1 служебную машину NSX');
  assert.deepEqual(report.steps[0].tags, ['edge-01']);
  const full = report.steps.find((step) => /Active Full/.test(step.title));
  assert.equal(full.title, 'Следующий Active Full — 21.10');
  assert.equal(full.severity, 'ok');
});

test('the chain is the Evidence\'s, a day a row: a Full where most of a run\'s points are, its size the files that hold them', () => {
  // On 13.10 app-01 joined the job: its first point is a Full, in a .vbk of its own, on an incremental night.
  const reading = edgeReading({
    attempts: edgeReading().attempts.map((one) => (one.session.id === 'c1' ? { ...one, tasks: [...one.tasks, task('app-01', 'success')] } : one)),
    files: [
      ...edgeReading().files,
      { name: 'OPS_EdgeD2026-10-13T042500.vbk', creationTime: '2026-10-13T04:25:00', restorePointIds: ['p13-app'], backupSize: 30 * GB, dataSize: 40 * GB },
    ],
  }, [...EDGE_POINTS, edgePoint('p13-app', 'c1', 'app-01', '2026-10-13T04:25:00+05:00', 'Full')]);
  const report = jobReportOf(reading, TZ);
  const day = (utcMidnight) => new Date(utcMidnight).toISOString().slice(0, 10);

  assert.deepEqual(report.chain.map((entry) => [day(entry.day), entry.full, entry.disk / GB]), [
    ['2026-10-13', false, 34],
    ['2026-10-12', false, 5],
    ['2026-10-10', true, 100],
  ]);
  assert.equal(report.disk, 139 * GB);
  // The Full the next one is held against is 10.10's, as /points has it.
  assert.deepEqual([report.lastFull.at, report.lastFull.disk], [Date.parse('2026-10-10T04:10:00+05:00'), 100 * GB]);
  // How far back each machine goes: the three runs it was saved in, as /points counts them.
  assert.deepEqual(report.depth, { points: 3, oldest: Date.parse('2026-10-10T04:10:00+05:00') });
  assert.equal(report.newestPoint, Date.parse('2026-10-13T04:25:00+05:00'));

  // On the page, where nothing went wrong and nobody else wrote: a day a row, or why there is none.
  const night = (id, day) => attempt(id, `2026-10-${day}T04:00:00+05:00`, 30, 'success', [task('db-01', 'success'), task('web-01', 'success')]);
  const quiet = (over, points) => {
    const reading = edgeReading({ neighbours: [], neighbourRuns: [], attempts: [night('c1', 13), night('b1', 12), night('a1', 10)], ...over }, points);
    const html = jobReportPage(jobReportOf(reading, TZ), sessionReportOf(reading, TZ), TZ);
    return html.slice(html.indexOf('Цепочка на диске'));
  };
  assert.match(quiet(), /<td class="v">13\.10<\/td><td class="v">инкремент<\/td><td class="v">4,0 ГБ<\/td><td class="v">18 ГБ<\/td>/);
  assert.match(quiet(), /<td class="v">10\.10<\/td><td class="v">Full<\/td><td class="v">100 ГБ<\/td><td class="v">400 ГБ<\/td>/);
  assert.match(quiet({}, []), /<td colspan="4" class="js-dim">У задания нет ни одной точки восстановления\.<\/td>/);
  assert.match(quiet({ evidence: { status: 'pending', reason: 'Точки восстановления ещё не прочитаны.' } }), /<td colspan="4" class="js-dim">Точки восстановления ещё не прочитаны\.<\/td>/);
});

test('who else writes to the repository is whoever was writing while the newest run was', () => {
  const report = jobReportOf(edgeReading(), TZ);

  assert.deepEqual(report.neighbours.rows.map((row) => [row.name, Boolean(row.own)]), [['OPS_Edge', true], ['OPS_Files', false]]);
  assert.equal(report.neighbours.jobs, 1);
  assert.equal(report.neighbours.of, 2);
  assert.equal(local(report.neighbours.origin), '12.10, 12:00', 'the chart starts at the noon before');
  assert.equal(report.bottleneck, 'target');
  // Said in Veeam's word for the stage, as its console says it.
  assert.match(jobReportPage(report, sessionReportOf(edgeReading(), TZ), TZ), /1 из 2 заданий · узкое место Target</);
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

test('a replica\'s backup size is what a good session sent and nothing for a failed one', () => {
  const replica = edgeReading({
    job: { id: 'j1', name: 'OPS_Replica', type: 'VSphereReplica', result: 'failed' },
    files: [],
    attempts: [
      attempt('r2', '2026-10-13T04:42:00+05:00', 30, 'success', [task('db-01', 'success')]),
      attempt('r1', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', 'Error: A connection attempt failed because the connected party did not properly respond after a period of time 10.13.0.7:443')]),
    ],
  });
  const report = sessionReportOf(replica, TZ);

  assert.equal(report.kind, 'Replication job');
  assert.deepEqual(report.sessions.map((session) => session.backupSize), [GB, 0]);
  assert.equal(report.sessions[0].dedupe, 1);
});

test('the first page and the sessions agree which session is a retry: none of a job only a hand starts', () => {
  // A failure, and a start five minutes after it ended.
  const night = [
    attempt('m2', '2026-10-13T04:35:00+05:00', 20, 'success', [task('db-01', 'success')]),
    attempt('m1', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', TIMEOUT)]),
  ];
  const told = (schedule) => {
    const reading = edgeReading({ configured: { ...edgeReading().configured, schedule }, attempts: night });
    const report = jobReportOf(reading, TZ);
    return {
      runs: report.runs.map((run) => run.pieces.length),
      healed: report.findings.some((finding) => /спасает повтор/.test(finding.title)),
      sessions: sessionReportOf(reading, TZ).sessions.map((session) => session.title),
    };
  };

  // Veeam's retry: one run of two attempts, the newer session its Retry 1.
  assert.deepEqual(told(edgeReading().configured.schedule), { runs: [2], healed: true, sessions: ['OPS_Edge (Retry 1)', 'OPS_Edge'] });
  // Started again by somebody: Veeam retries only what it starts. Two runs, and no retry on either half.
  const byHand = { ...edgeReading().configured.schedule, runAutomatically: false };
  assert.deepEqual(told(byHand), { runs: [1, 1], healed: false, sessions: ['OPS_Edge', 'OPS_Edge'] });
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

test('the page is Veeam\'s: its header, its day, its numbers, its Details; names escaped', () => {
  const html = sessionReportPage(sessionReportOf(edgeReading({ job: { id: 'j1', name: 'OPS_<b>Edge</b>', type: 'Backup', result: 'failed' } }), TZ), TZ);

  assert.equal(html.match(/<div class="vb">/g).length, 6);
  assert.match(html, /Backup job: OPS_&lt;b&gt;Edge&lt;\/b&gt; \(Retry 1\)/);
  assert.doesNotMatch(html, /OPS_<b>Edge/);
  assert.match(html, /Tuesday, October 13, 2026 4:42:00 AM/);
  assert.match(html, /<td class="k">Backup size<\/td>/);
  assert.match(html, />Details</);
  assert.match(html, /<span class="st bad">Error<\/span>/);
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
  // A machine is saved by a run of the month, whatever points a failed one left of it.
  assert.match(html, /Машины сохранены<\/td><td class="v"><span class="js-bad">2 из 3<\/span>/);
  assert.match(html, /Не сохранены<\/td><td class="v"><span class="js-bad">1<\/span>/);
  assert.match(html, /Откат<\/td><td class="v">на 3 точки, до 10\.10</);
  assert.match(html, /Запуски за 30 дней/);
  assert.match(html, /Что сделать/);
  assert.match(html, /Исключить из задания 1 служебную машину NSX/);
  assert.match(html, /Машины/);
  assert.match(html, /Кто ещё писал в BKP03/);
  assert.match(html, /<div class="vr">/);
  assert.match(html, /@page sessions \{[^}]*margin: 9mm 10mm/);
  assert.match(html, /Backup job: OPS_&lt;b&gt;Edge&lt;\/b&gt;/);
  assert.doesNotMatch(html, /OPS_<b>Edge/);
});

test('a replica is told by its runs, not by restore points the bot cannot see', () => {
  const replica = edgeReading({
    job: { id: 'j1', name: 'OPS_Replica', type: 'VSphereReplica', result: 'failed' },
    configured: { ...edgeReading().configured, virtualMachines: { includes: [{ type: 'VirtualMachine', name: 'db-01' }] } },
    files: [],
    neighbours: [],
    neighbourRuns: [],
    attempts: [
      attempt('r2', '2026-10-13T04:00:00+05:00', 30, 'failed', [task('db-01', 'failed', 'Error: A connection attempt failed because the connected party did not properly respond after a period of time 10.13.0.7:443')]),
      attempt('r1', '2026-10-12T04:00:00+05:00', 30, 'success', [task('db-01', 'success')]),
    ],
  }, []);
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

test('machines Veeam would not give are not called never saved, nor gone from vCenter: the page says what it could not read', () => {
  const NOT_READ = 'The Veeam server did not respond within 30000 ms';
  const page = (reading) => jobReportPage(jobReportOf(reading, TZ), sessionReportOf(reading, TZ), TZ);
  const machinesOf = (html) => html.slice(html.indexOf('js-vms'), html.indexOf('</table>', html.indexOf('js-vms')));

  // Not one session's machines: every machine of the job is unknown, not unsaved.
  const none = page(edgeReading({
    attempts: edgeReading().attempts.map(({ session }) => ({ session, unread: true })),
    error: `машины 6 сессий из 6: ${NOT_READ}`,
  }));
  assert.match(none, new RegExp(`Прочитано не всё: машины 6 сессий из 6: ${NOT_READ}`));
  assert.doesNotMatch(machinesOf(none), /никогда|0 из 0/);
  assert.equal(machinesOf(none).match(/нет сведений/g).length, 3);
  // Nor its configuration, which names them: there is nobody to list.
  const nobody = page(edgeReading({ configured: undefined, attempts: edgeReading().attempts.map(({ session }) => ({ session, unread: true })) }));
  assert.match(nobody, /Сведений по машинам нет: запусков не было, или Veeam их не отдал\./);

  // The newest night's: app-01, which no run read took on, may have been in it.
  const listed = edgeReading().configured.virtualMachines.includes;
  const newestReading = edgeReading({
    configured: { ...edgeReading().configured, virtualMachines: { includes: [...listed, { type: 'VirtualMachine', name: 'app-01' }] } },
    attempts: edgeReading().attempts.map((attempt) => (attempt.session.id.startsWith('c') ? { session: attempt.session, unread: true } : attempt)),
    error: `машины 2 сессий из 6: ${NOT_READ}`,
  });
  const newest = page(newestReading);
  assert.match(machinesOf(newest), /app-01<\/td><td><div class="js-hist">(<i [^>]+><\/i>)+<\/div><\/td><td class="v"><span class="js-dim">—<\/span><\/td><td class="v"><span class="js-dim">нет сведений<\/span>/);
  // Last: a machine never saved is the one to look at first.
  assert.deepEqual(jobReportOf(newestReading, TZ).machines.map((machine) => machine.name), ['edge-01', 'db-01', 'web-01', 'app-01']);
  assert.doesNotMatch(newest, /ни один запуск не обработал|Найти в vCenter/);

  // A replica is told by its runs: a machine none of them read is not one without a good run.
  const replica = page(edgeReading({
    job: { id: 'j1', name: 'OPS_Replica', type: 'VSphereReplica', result: 'failed' },
    attempts: edgeReading().attempts.map(({ session }) => ({ session, unread: true })),
  }));
  assert.match(replica, /Машины реплицированы<\/td><td class="v">—</);
  assert.match(replica, /Без удачной<\/td><td class="v">—</);
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
const DAY = 86_400_000;
const recent = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const EDGE = { id: 'j1', name: 'OPS_Edge', type: 'Backup', status: 'Stopped', result: 'failed' };

test('the Job reads read a job\'s month: its attempts, their machines — from the log where there are no task sessions — and what Veeam would not give', async () => {
  const asked = [];
  const reads = (routes) => new VeeamJobReads(new VeeamEstateReader(veeamFake(routes), monitorAccount()), TZ);
  const sessions = (data) => (req) => {
    asked.push(req.params);
    return { data };
  };

  const month = await reads({
    '/api/v1/jobs/j1': edgeReading().configured,
    '/api/v1/sessions': sessions([
      { id: 's3', jobId: 'j1', creationTime: recent(1), state: 'Working', result: { result: 'None' } },
      { id: 's2', jobId: 'j1', creationTime: recent(24), endTime: recent(23.5), result: { result: 'Failed' } },
      { id: 's1', jobId: 'j1', creationTime: recent(48), endTime: recent(47.5), result: { result: 'Success' } },
      // Before the month: not read.
      { id: 's0', jobId: 'j1', creationTime: recent(24 * 40), endTime: recent(24 * 40 - 1), result: { result: 'Success' } },
    ]),
    '/api/v1/sessions/s3/taskSessions': { data: [task('web-01', 'None')] },
    '/api/v1/sessions/s2/taskSessions': { data: [{ ...task('db-01', 'Failed', 'Getting VM info from vSphere'), id: 'tf' }, { ...task('web-01', 'Success'), id: 'ts' }] },
    '/api/v1/sessions/s1/taskSessions': () => { throw new Error('The Veeam server did not respond within 30000 ms'); },
    // Only a machine that did not end in a success has its log read: its own outcome says only the step.
    '/api/v1/taskSessions/tf/logs': { records: [{ status: 'Failed', title: 'Error: Cannot get service content.' }] },
    // The newest finished ones say what held them back; the one still going has not said yet.
    '/api/v1/sessions/s2/logs': { records: [{ title: 'Load: Source 3% > Proxy 0% > Network 7% > Target 97%' }, { title: 'Primary bottleneck: Target' }] },
    '/api/v1/sessions/s1/logs': { records: [{ title: 'Primary bottleneck: Source' }] },
  }).historyOf(EDGE, NOW - 30 * DAY);

  assert.deepEqual(asked.map(({ jobIdFilter, limit }) => [jobIdFilter, limit]), [['j1', 500]]);
  assert.equal(month.configured.storage.backupRepositoryId, 'r1');
  assert.deepEqual(month.attempts.map(({ session, tasks, unread }) => [session.id, tasks?.length, unread]), [['s3', 1, undefined], ['s2', 2, undefined], ['s1', undefined, true]]);
  assert.deepEqual(month.taskLogs, { tf: [{ status: 'Failed', title: 'Error: Cannot get service content.' }] });
  assert.deepEqual(month.bottlenecks, ['target', 'source']);
  // Machines Veeam would not give are not known, rather than none: that is said.
  assert.deepEqual(month.missing, ['машины 1 сессии из 3: The Veeam server did not respond within 30000 ms']);

  // A server whose REST API is 1.1 has no task sessions: each machine's outcome is in the session's log, read once.
  const logged = [];
  const older = await reads({
    '/api/v1/jobs/j1': () => { throw new Error('socket hang up'); },
    '/api/v1/sessions': sessions([{ id: 'o1', jobId: 'j1', creationTime: recent(24), endTime: recent(23.5), result: { result: 'Failed' } }]),
    '/api/v1/sessions/o1/taskSessions': () => { throw new VeeamApiError('Not found', 404); },
    '/api/v1/sessions/o1/logs': () => {
      logged.push('o1');
      return { records: [
        { status: 'Failed', title: 'Processing db-01 Error: Cannot get service content.' },
        { status: 'Succeeded', title: 'Processing web-01' },
        { status: 'Succeeded', title: 'Primary bottleneck: Target' },
      ] };
    },
  }).historyOf(EDGE, NOW - 30 * DAY);

  assert.deepEqual(older.attempts[0].tasks, [
    { name: 'db-01', result: { result: 'failed', message: 'Cannot get service content.' } },
    { name: 'web-01', result: { result: 'success' } },
  ]);
  assert.deepEqual(older.bottlenecks, ['target']);
  assert.deepEqual(logged, ['o1']);
  assert.deepEqual(older.missing, ['настройки: socket hang up']);
});

/**
 * OPS_Edge's server, for what its report reads beside the month: the job, its
 * repository, its backup with its files and points, and a neighbour with its
 * sessions. `asked` keeps what the sessions were asked with.
 */
const edgeServer = (over = {}) => {
  const asked = [];
  const veeam = veeamFake({
    '/api/v1/jobs/states': { data: [{ id: 'j1', name: 'OPS_Edge', type: 'Backup', status: 'Stopped', lastResult: 'Failed' }] },
    '/api/v1/jobs': { data: [
      { id: 'j1', name: 'OPS_Edge', storage: { backupRepositoryId: 'r1' } },
      { id: 'n1', name: 'OPS_Files', storage: { backupRepositoryId: 'r1' } },
      { id: 'n9', name: 'OPS_Elsewhere', storage: { backupRepositoryId: 'r9' } },
    ] },
    '/api/v1/sessions': (req) => {
      asked.push(req.params);
      return { data: [
        { id: 'x1', jobId: 'n1', creationTime: recent(24.2), endTime: recent(23), result: { result: 'Success' } },
        { id: 'x2', jobId: 'n9', creationTime: recent(24.2), endTime: recent(23), result: { result: 'Success' } },
      ] };
    },
    '/api/v1/backupInfrastructure/repositories/states': { data: [edgeReading().repository] },
    '/api/v1/backups': { data: [{ id: 'b1', name: 'OPS_Edge', jobId: 'j1' }, { id: 'b2', name: 'OPS_Other', jobId: 'j2' }] },
    '/api/v1/backups/b1/backupFiles': { data: edgeReading().files },
    // No restore point: the report has its points from the Evidence.
    ...over,
  });
  return { veeam, asked };
};

/** OPS_Edge's month, as its Job reads give it: a night that failed after one that did not. */
const edgeMonth = (history = {}) => jobReadsOf({
  configuration: edgeReading().configured,
  history: {
    attempts: [
      { session: { id: 's2', jobId: 'j1', creationTime: recent(24), endTime: recent(23.5), result: { result: 'failed' } }, tasks: [task('db-01', 'failed')] },
      { session: { id: 's1', jobId: 'j1', creationTime: recent(48), endTime: recent(47.5), result: { result: 'success' } }, tasks: [task('db-01', 'success')] },
    ],
    bottlenecks: ['target'],
    ...history,
  },
});

/** OPS_Edge's server's Evidence, of the one point its good night wrote. */
const edgeEvidence = () => readingOf({
  jobs: [EDGE],
  configurations: [edgeReading().configured],
  backups: [{ id: 'b1', name: 'OPS_Edge', jobId: 'j1' }],
  points: [{ id: 'p1', backupId: 'b1', sessionId: 's1', name: 'db-01', creationTime: recent(47.8) }],
  sessions: [
    { id: 's2', jobId: 'j1', sessionType: 'BackupJob', creationTime: recent(24), endTime: recent(23.5), result: { result: 'failed' } },
    { id: 's1', jobId: 'j1', sessionType: 'BackupJob', creationTime: recent(48), endTime: recent(47.5), result: { result: 'success' } },
  ],
}).evidence(new Map(), NOW);

test('a job\'s report has its month from the Job reads, its points from the Evidence, and beside them the repository, the files and the neighbours', async () => {
  const { veeam, asked } = edgeServer();
  const estate = { name: 'BAAS', reader: new VeeamEstateReader(veeam, monitorAccount()), reads: edgeMonth(), evidence: { evidence: edgeEvidence() } };
  const reading = await readJob(estate, 'j1', NOW, TZ, THRESHOLDS);

  assert.equal(reading.error, undefined);
  assert.equal(reading.job.name, 'OPS_Edge');
  assert.deepEqual(reading.attempts.map(({ session }) => session.id), ['s2', 's1']);
  assert.equal(reading.configured.storage.backupRepositoryId, 'r1');
  assert.deepEqual(reading.bottlenecks, ['target']);
  assert.equal(reading.repository.name, 'NAS01_SHARE_BKP03');
  assert.equal(reading.files.length, 3);
  // One moment to go back to, two days old: nothing wrong by 🛡's thresholds.
  assert.equal(reading.evidence.status, 'ready');
  assert.deepEqual([reading.evidence.points.runs, reading.evidence.points.newest], [1, Date.parse(recent(47.8))]);
  assert.equal(reading.evidence.verdict.trouble, undefined);
  assert.deepEqual(reading.neighbours, [{ id: 'n1', name: 'OPS_Files' }]);
  // Their sessions from a day before the newest run started.
  assert.deepEqual(asked.map((params) => params.createdAfterFilter), [recent(48)]);
  assert.deepEqual(reading.neighbourRuns.map((run) => run.jobId), ['n1']);
});

test('who else writes to the job\'s repository counts a replica, which names it only in its own settings', async () => {
  // OPS_Replica keeps its metadata on r1; in the job list it names no repository at all.
  const { veeam } = edgeServer({
    '/api/v1/jobs': { data: [
      { id: 'j1', name: 'OPS_Edge', storage: { backupRepositoryId: 'r1' } },
      { id: 'n1', name: 'OPS_Files', storage: { backupRepositoryId: 'r1' } },
      { id: 'n2', name: 'OPS_Replica', type: 'VSphereReplica' },
      { id: 'n9', name: 'OPS_Elsewhere', storage: { backupRepositoryId: 'r9' } },
    ] },
    '/api/v1/jobs/n2': { id: 'n2', name: 'OPS_Replica', type: 'VSphereReplica', jobSettings: { metadataRepositoryId: 'r1' } },
    '/api/v1/sessions': { data: [
      { id: 'x1', jobId: 'n1', creationTime: recent(24.2), endTime: recent(23), result: { result: 'Success' } },
      { id: 'x3', jobId: 'n2', creationTime: recent(24.1), endTime: recent(23.8), result: { result: 'Success' } },
    ] },
  });
  const estate = { name: 'BAAS', reader: new VeeamEstateReader(veeam, monitorAccount()), reads: edgeMonth(), evidence: { evidence: edgeEvidence() } };
  const reading = await readJob(estate, 'j1', NOW, TZ, THRESHOLDS);

  assert.deepEqual(reading.neighbours, [{ id: 'n1', name: 'OPS_Files' }, { id: 'n2', name: 'OPS_Replica' }]);
  assert.deepEqual(reading.neighbourRuns.map((run) => run.jobId), ['n1', 'n2']);
  // On the page, with whoever else wrote there during the newest run.
  const html = jobReportPage(jobReportOf(reading, TZ), sessionReportOf(reading, TZ), TZ);
  assert.match(html, /Кто ещё писал в BKP03[\s\S]*OPS_Replica[\s\S]*2 из 2 заданий/);
});

test('what could not be read, of the month or beside it, is said, and the rest is kept; a job that is gone is none', async () => {
  const { veeam } = edgeServer({ '/api/v1/backups': () => { throw new Error('The Veeam server did not respond within 30000 ms'); } });
  const reader = new VeeamEstateReader(veeam, monitorAccount());
  // No scan has finished on this server: that is said, and is no failure of this read.
  const pending = { status: 'pending', reason: 'Точки восстановления ещё не прочитаны.' };
  const estate = { name: 'BAAS', reader, reads: edgeMonth({ missing: ['машины 1 сессии из 2: socket hang up'] }), evidence: { evidence: pending } };
  const reading = await readJob(estate, 'j1', NOW, TZ, THRESHOLDS);

  assert.equal(reading.error, 'машины 1 сессии из 2: socket hang up; бэкапы: The Veeam server did not respond within 30000 ms');
  assert.equal(reading.attempts.length, 2);
  assert.deepEqual(reading.files, []);
  assert.deepEqual(reading.evidence, pending);
  assert.equal(await readJob(estate, 'gone', NOW, TZ, THRESHOLDS), undefined);
});

test('the report says of a job what 🛡 says, on the same Evidence: its verdict, how far back it goes, its newest point', async () => {
  // OPS_Edge saved both its machines three nights running, three weeks ago;
  // the one night since failed, and the point it wrote of db-01, which failed
  // in it, is no state to restore to. By its runs alone, one failure in four.
  const w = world();
  const job = { id: 'j1', name: 'OPS_Edge', type: 'Backup', status: 'Stopped', result: 'failed' };
  const configuration = { id: 'j1', name: 'OPS_Edge', schedule: { runAutomatically: true }, storage: { backupRepositoryId: 'r1' } };
  const night = (id, daysAgo, result) => ({
    id, jobId: 'j1', sessionType: 'BackupJob', creationTime: recent(24 * daysAgo + 0.5), endTime: recent(24 * daysAgo - 0.5), result: { result },
  });
  const sessions = [night('s4', 19, 'failed'), night('s3', 20, 'success'), night('s2', 21, 'success'), night('s1', 22, 'success')];
  const point = (session, name, daysAgo) => ({ id: `${session}-${name}`, backupId: 'b1', sessionId: session, name, type: 'Increment', creationTime: recent(24 * daysAgo) });
  const points = [
    ...[['s1', 22], ['s2', 21], ['s3', 20]].flatMap(([session, daysAgo]) => [point(session, 'db-01', daysAgo), point(session, 'web-01', daysAgo)]),
    point('s4', 'db-01', 19),
  ];
  const evidence = readingOf({ jobs: [job], configurations: [configuration], backups: [{ id: 'b1', jobId: 'j1', name: 'OPS_Edge' }], points, sessions })
    // How the machines of the night that failed ended, as the scan asks it.
    .evidence(new Map([['s4', new Map([['db-01', 'failed']])]]), NOW);

  const clock = { now: new Date(NOW), timezone: w.telegram.timezone };
  const [shield] = renderProtection(assessProtection({ standings: standingsOf([job], evidence), now: NOW, timezone: clock.timezone, ...thresholdsOf(w.telegram) }), clock);
  const [, said] = /🔴 <b>OPS_Edge<\/b> — (.+)/.exec(shield);
  assert.equal(said, 'нет бэкапа 20 дней');

  const veeam = veeamFake({
    '/api/v1/jobs/states': { data: [{ id: 'j1', name: 'OPS_Edge', type: 'Backup', status: 'Stopped', lastResult: 'Failed' }] },
    '/api/v1/backupInfrastructure/repositories/states': { data: [] },
    '/api/v1/backups': { data: [{ id: 'b1', name: 'OPS_Edge', jobId: 'j1' }] },
    '/api/v1/backups/b1/backupFiles': { data: [] },
    '/api/v1/jobs': { data: [configuration] },
  });
  const machines = (result) => [task('db-01', result), task('web-01', 'success')];
  const month = jobReadsOf({ configuration, history: { attempts: sessions.map((session) => ({ session, tasks: machines(session.result.result) })) } });
  const printer = printerOf();
  const estate = { name: 'BAAS', reader: new VeeamEstateReader(veeam, monitorAccount()), reads: month, evidence: { evidence } };
  const answer = await new JobReports(w.config, printer).answer(estate, 'j1');

  // The caption opens with 🛡's words and its colour, whatever the runs say after them.
  const [title, verdict] = answer.text.split('\n');
  assert.equal(title, '📄 <b>OPS_Edge</b> — 🔴 критично');
  assert.equal(verdict.split('; ')[0], `${said.charAt(0).toUpperCase()}${said.slice(1)}`);
  // It reads no restore point of its own: the Evidence has them, and nothing was left unread.
  assert.doesNotMatch(answer.text, /Прочитано не всё/);
  // Three moments a machine, the failed night's not among them, as /points counts them.
  const [page] = printer.pages;
  const moment = (daysAgo) => `${dayLabel(Date.parse(recent(24 * daysAgo)), clock.timezone)} ${timeLabel(Date.parse(recent(24 * daysAgo)), clock.timezone)}`;
  assert.match(page, new RegExp(`Последняя точка</td><td class="v">${moment(20)}<`));
  assert.match(page, new RegExp(`Откат</td><td class="v">на 3 точки, до ${dayLabel(Date.parse(recent(24 * 22)), clock.timezone)}<`));
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
  // Asked of the job's estate, with no cycle behind it.
  const { updates, commands } = ear(w, idleMonitor(), answersOf(w, [{ ...serverOf(w, veeam), reads: edgeMonth() }], printer));

  await pressed({ updates }, encode({ kind: 'report', id: 'j1', server: SERVER }));
  await commands.settled();

  const [note] = w.api.sent();
  assert.equal(note.text, [
    '⏳ <b>Готовлю отчёт по заданию</b>',
    '',
    // Its points are the last scan's: it reads none.
    'Читаю запуски и машины за 30 дней — это 20–30 секунд.',
    'PDF придёт сюда, а бот пока отвечает на другие команды.',
  ].join('\n'));
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
  // No scan has read this server's points yet: said as the Job card says it, and nothing claimed of them.
  assert.match(printer.pages[0], /<div class="js-partial">Точки восстановления ещё не прочитаны\.<\/div>/);
  assert.match(printer.pages[0], /Последняя точка<\/td><td class="v">—<\/td>/);
  assert.match(printer.pages[0], /Откат<\/td><td class="v">—<\/td>/);
});

test('a job\'s report Button carries its server and id within Telegram\'s 64 bytes, and reads back', () => {
  const action = { kind: 'report', id: '1e218e3f-9e08-4e28-ae89-06077422eddf', server: 'veeam01-backup' };
  const data = encode(action);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(decode(data), action);
});

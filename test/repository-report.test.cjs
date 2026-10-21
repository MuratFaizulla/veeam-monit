const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT, world, ear, veeamFake, serverOf, watching, idleMonitor, answersOf, printerOf, appConfig,
} = require('./world.cjs');
const { reportOf, repositoriesNamed, planOf } = require('../dist/estate/repository-report');
const { reportPage } = require('../dist/estate/repository-report-page');
const { readServer } = require('../dist/estate/repository-reports');
const { VeeamEstateReader } = require('../dist/veeam/estate-reader.service');

/* ------------------------------------------------------------------ *
 * The Repository report: what it says
 * ------------------------------------------------------------------ */

const HOUR = 3_600_000;
const AT = Date.parse('2026-09-14T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const GB = 1024;
const TB_BYTES = 1024 ** 4;

const repository = (id, name, path, { capacityTB = 100, freeTB = 40, type = 'Smb' } = {}) => ({
  id, name, type, path, capacityGB: capacityTB * GB, freeGB: freeTB * GB,
});
const nightly = (time = '22:00') => ({ runAutomatically: true, daily: { isEnabled: true, dailyKind: 'Everyday', localTime: time } });

/** A server's reading with nothing in it but what a test says. */
const serverReading = (server, over = {}) => ({
  server, repositories: [], jobs: [], attempts: [], loads: [], working: [], backups: [], ...over,
});

/**
 * One share, \\192.0.2.10\NAS01_BKP01, attached to two servers — the second
 * reaching it by another address — and, on the second, attached once more
 * under the name of a share it is not.
 */
const sharedReading = () => ({
  at: AT,
  days: 14,
  servers: [
    serverReading('veeam01-backup-a', {
      repositories: [repository('a1', 'NAS01_BKP01', '\\\\192.0.2.10\\NAS01_BKP01', { freeTB: 8 })],
      jobs: [
        { id: 'j1', name: 'OPS_Exchange', disabled: false, schedule: nightly('22:00'), backupRepositoryId: 'a1' },
        { id: 'j2', name: 'CUST_FINHUB', disabled: false, schedule: nightly('22:00'), backupRepositoryId: 'a1' },
      ],
      attempts: [
        // OPS_Exchange: a failed attempt Veeam retried at once, which worked — one Run, and a good one.
        { jobId: 'j1', startedAt: iso(AT - 38 * HOUR), endedAt: iso(AT - 37.5 * HOUR), result: 'failed' },
        { jobId: 'j1', startedAt: iso(AT - 37.4 * HOUR), endedAt: iso(AT - 36.5 * HOUR), result: 'success' },
        { jobId: 'j1', startedAt: iso(AT - 14 * HOUR), endedAt: iso(AT - 13 * HOUR), result: 'success' },
        // CUST_FINHUB: running for thirty hours where it takes one.
        { jobId: 'j2', startedAt: iso(AT - 62 * HOUR), endedAt: iso(AT - 61 * HOUR), result: 'success' },
        { jobId: 'j2', startedAt: iso(AT - 30 * HOUR), result: 'none' },
      ],
      loads: [{ jobId: 'j1', load: { source: 12, proxy: 4, network: 9, target: 93 } }],
      working: [{ jobId: 'j2', since: iso(AT - 30 * HOUR), percent: 40 }],
      backups: [
        { name: 'OPS_Exchange', repositoryId: 'a1', jobId: 'j1', size: 20 * TB_BYTES },
        // Its job is on the other server: not an orphan.
        { name: 'OPS_Billing', repositoryId: 'a1', jobId: 'elsewhere', size: 10 * TB_BYTES },
        // No job anywhere.
        { name: 'OPS_Retired', platform: 'VMware', repositoryId: 'a1', size: 30 * TB_BYTES, newest: '2026-05-29T01:00:00+05:00' },
      ],
    }),
    serverReading('veeam02-backup-b', {
      repositories: [
        repository('b1', 'NAS01_BKP01', '\\\\192.0.2.11\\NAS01_BKP01', { freeTB: 8 }),
        repository('b2', 'NAS01_BKP02', '\\\\192.0.2.11\\NAS01_BKP01', { freeTB: 8 }),
        repository('b3', 'BR_BACKUP', '\\\\198.51.100.7\\BR_BACKUP', { capacityTB: 40, freeTB: 30 }),
      ],
      jobs: [
        { id: 'k1', name: 'OPS_Billing', disabled: false, schedule: nightly('23:00'), backupRepositoryId: 'b1' },
        { id: 'k2', name: 'BR_Files', disabled: false, schedule: nightly('21:00'), backupRepositoryId: 'b3' },
      ],
      attempts: [{ jobId: 'k2', startedAt: iso(AT - 15 * HOUR), endedAt: iso(AT - 14.5 * HOUR), result: 'success' }],
    }),
  ],
});

const SITES = [{ name: 'Main', patterns: [] }, { name: 'Branch', patterns: ['BR*'] }];

test('one share attached to several servers is one repository, whatever address reaches it', () => {
  const report = reportOf(sharedReading(), SITES, 'UTC');
  const shared = report.repositories.find((candidate) => candidate.short === 'BKP01');

  assert.deepEqual(report.repositories.map((candidate) => candidate.name), ['NAS01_BKP01', 'BR_BACKUP']);
  assert.deepEqual(shared.servers, ['veeam01-backup-a', 'veeam02-backup-b']);
  assert.deepEqual(shared.writers.map((writer) => writer.name).sort(), ['CUST_FINHUB', 'OPS_Billing', 'OPS_Exchange']);
  // Its free space is one number, not three.
  assert.equal(Math.round(shared.freePercent), 8);
  assert.ok(shared.problems.some((problem) => problem.title === 'Подключён к 2 серверам Veeam'));
});

test('a repository named after a share it does not point at, and a share attached twice, are said', () => {
  const shared = reportOf(sharedReading(), SITES, 'UTC').repositories[0];

  assert.deepEqual(shared.settings, [
    { kind: 'name', server: 'veeam02-backup-b', repositories: ['NAS01_BKP02'], folder: 'NAS01_BKP01' },
    { kind: 'twice', server: 'veeam02-backup-b', repositories: ['NAS01_BKP01', 'NAS01_BKP02'] },
  ]);
  assert.ok(shared.actions.some((action) => action.what === 'Переименовать «NAS01_BKP02» на veeam02-backup-b — фактически это NAS01_BKP01'));
});

test('a chain no job on any server owns is an orphan; one whose job is on another server is not', () => {
  const shared = reportOf(sharedReading(), SITES, 'UTC').repositories[0];

  assert.deepEqual(shared.orphans.map((backup) => backup.name), ['OPS_Retired']);
  assert.equal(shared.orphanBytes, 30 * TB_BYTES);
});

test('a job running ten times longer than it takes hangs, and a day of it is critical', () => {
  const shared = reportOf(sharedReading(), SITES, 'UTC').repositories[0];

  assert.deepEqual(shared.hanging.map((writer) => writer.name), ['CUST_FINHUB']);
  assert.equal(shared.status, 'crit');
  const hanging = shared.problems.find((problem) => problem.icon === 'clock');
  assert.deepEqual([hanging.severity, hanging.title], ['crit', 'Висит 1 задача']);
  assert.match(hanging.detail, /CUST_FINHUB — идёт 30,0 ч, обычно 1,0 ч/);
  assert.equal(shared.verdict, 'Нужны действия: места почти нет: свободно 8%; висит 1 задача.');
});

test('a verdict says what is wrong in the words of the problems, units and all', () => {
  const reading = sharedReading();
  reading.servers[1].backups.push({ name: 'BR_Old', repositoryId: 'b3', size: 2 * TB_BYTES });
  const branch = reportOf(reading, SITES, 'UTC').repositories[1];

  assert.equal(branch.verdict, 'Работает, но есть что поправить: 2,0 ТБ бэкапов без задачи.');
});

test('errors are counted by Runs: an attempt Veeam retried into a success is not a failure', () => {
  const exchange = reportOf(sharedReading(), SITES, 'UTC').repositories[0].writers.find((writer) => writer.name === 'OPS_Exchange');

  assert.equal(exchange.runs.length, 2);
  assert.equal(exchange.failed, 0);
  assert.deepEqual(exchange.bottleneck, { stage: 'target', percent: 93 });
});

test('repositories are put in their site by name, and the site with no patterns takes the rest', () => {
  const report = reportOf(sharedReading(), SITES, 'UTC');

  assert.deepEqual(report.sites.map((site) => [site.name, site.repositories.map((candidate) => candidate.short)]), [
    ['Main', ['BKP01']],
    ['Branch', ['BR']],
  ]);
  // Room, quiet hours, nothing hanging: a new job fits there.
  assert.ok(report.sites[1].repositories[0].fit > 0);
  assert.equal(report.sites[0].repositories[0].fit, undefined);
});

test('a server that did not answer leaves its repositories with their space and nothing else', () => {
  const reading = sharedReading();
  reading.servers.push(serverReading('veeam03-backup-c', {
    error: 'The Veeam server did not respond within 30000 ms',
    repositories: [repository('c1', 'DR_NFS_01', 'nfs41://203.0.113.5:/DR_NFS_02', { type: 'Nfs', capacityTB: 40, freeTB: 33 })],
  }));
  const report = reportOf(reading, SITES, 'UTC');
  const silent = report.repositories.find((candidate) => candidate.name === 'DR_NFS');

  assert.equal(silent.status, 'unknown');
  assert.equal(silent.problems[0].title, 'Нет данных о задачах');
  assert.deepEqual(report.servers.map((server) => server.answered), [true, true, false]);
  assert.deepEqual(report.attachments.get(silent), [null, null, 'unknown']);
});

test('a start is moved only where the whole run stays in the backup window', () => {
  // Six nightly jobs of three hours, all at 22:00: the quieter hours are before and after.
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    id: `j${index}`, name: `OPS_Night_${index}`, disabled: false, schedule: nightly('22:00'), backupRepositoryId: 'a1',
  }));
  const attempts = jobs.flatMap((job) => [1, 2, 3].map((day) => ({
    jobId: job.id, startedAt: iso(AT - (14 + 24 * day) * HOUR), endedAt: iso(AT - (11 + 24 * day) * HOUR), result: 'success',
  })));
  const reading = {
    at: AT,
    days: 14,
    servers: [serverReading('veeam01-backup-a', {
      repositories: [repository('a1', 'NAS01_BKP01', '\\\\192.0.2.10\\NAS01_BKP01')],
      jobs,
      attempts,
    })],
  };
  const busy = reportOf(reading, [], 'UTC').repositories[0];

  assert.equal(busy.peak, 6);
  assert.equal(busy.plannedBefore, 6);
  assert.ok(busy.moves.length > 0);
  for (const move of busy.moves) {
    const end = move.toMinute + move.minutes;
    assert.ok(move.toMinute >= 18 * 60 ? end <= 31 * 60 : end <= 7 * 60, `${move.to} + ${move.minutes} мин в окне`);
  }
  assert.ok(busy.plannedAfter < busy.plannedBefore);
});

test('a repository is asked for by its short name, its full name or a part of either', () => {
  const report = reportOf(sharedReading(), SITES, 'UTC');

  assert.deepEqual(repositoriesNamed(report, 'bkp01').map((candidate) => candidate.short), ['BKP01']);
  assert.deepEqual(repositoriesNamed(report, 'br_backup').map((candidate) => candidate.short), ['BR']);
  assert.deepEqual(repositoriesNamed(report, 'nas01_bkp02').map((candidate) => candidate.short), ['BKP01']);
  assert.deepEqual(repositoriesNamed(report, 'nothing'), []);
});

test('a schedule is drawn as the days and the time it starts', () => {
  // Which days and minutes those are is the planner's reading, tested with it (runs.test.cjs); here, how the report draws them.
  assert.deepEqual(planOf(nightly('22:30')), { label: 'ежедневно', days: [0, 1, 2, 3, 4, 5, 6], starts: [1350], time: '22:30', periodic: false });
  assert.equal(planOf({ runAutomatically: true, daily: { isEnabled: true, dailyKind: 'WeekDays', localTime: '01:00' } }).label, 'пн–пт');
  assert.equal(planOf({ runAutomatically: true, daily: { isEnabled: true, dailyKind: 'SelectedDays', days: ['tuesday', 'friday'], localTime: '01:00' } }).label, 'вт, пт');
  assert.equal(planOf({ runAutomatically: true, periodically: { isEnabled: true, periodicallyKind: 'Hours', frequency: 4 } }).starts.length, 6);
  assert.equal(planOf({ runAutomatically: false }).label, 'вручную');
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

test('the whole report opens on a cover, then the cards, the attachments and every repository', () => {
  const report = reportOf(sharedReading(), SITES, 'UTC');
  const html = reportPage(report, undefined, 'UTC');

  assert.match(html, /<h1>Состояние репозиториев<\/h1>/);
  assert.match(html, /За 14 дней: 2 сервера Veeam, 2 хранилища на 2 площадках\.<\/p>/);
  assert.match(html, /<h2>Все хранилища<\/h2>/);
  assert.match(html, /<h2>Кто к чему подключён<\/h2>/);
  assert.match(html, /<h1 id="r-bkp01">BKP01/);
  assert.match(html, /<h1 id="r-br">BR/);
});

test('one repository asked for gets its own pages and no cover', () => {
  const report = reportOf(sharedReading(), SITES, 'UTC');
  const html = reportPage(report, repositoriesNamed(report, 'br'), 'UTC');

  assert.doesNotMatch(html, /Состояние репозиториев<\/h1>/);
  assert.match(html, /<h1 id="r-br">BR/);
  assert.doesNotMatch(html, /id="r-bkp01"/);
  assert.match(html, /<b>1<\/b> \/ \d+/);
});

test('names from Veeam are escaped on the page', () => {
  const reading = sharedReading();
  reading.servers[0].jobs[0].name = 'OPS_<b>Exchange</b>';
  const html = reportPage(reportOf(reading, SITES, 'UTC'), undefined, 'UTC');

  assert.match(html, /OPS_&lt;b&gt;Exchange&lt;\/b&gt;/);
  assert.doesNotMatch(html, /OPS_<b>Exchange/);
});

/* ------------------------------------------------------------------ *
 * Reading a server
 * ------------------------------------------------------------------ */

const auth = { configured: true, getAccessToken: async () => 'tok', invalidateAccessToken: () => {}, rejectToken: () => true };

/** A server with one repository, a backup job, a replica job and a backup no job owns. */
const veeamServer = (now = Date.now(), over = {}) => {
  const asked = [];
  const veeam = veeamFake({
    '/api/v1/backupInfrastructure/repositories/states': { data: [repository('r1', 'NAS01_BKP01', '\\\\192.0.2.10\\NAS01_BKP01')] },
    '/api/v1/jobs': { data: [
      { id: 'j1', name: 'OPS_Exchange', type: 'Backup', schedule: nightly(), storage: { backupRepositoryId: 'r1' } },
      { id: 'j2', name: 'OPS_Replica', type: 'VSphereReplica', schedule: nightly('23:00') },
      { id: 'j3', name: 'OPS_Elsewhere', type: 'Backup', storage: { backupRepositoryId: 'other' } },
    ] },
    // A replica names its repository only when read by id.
    '/api/v1/jobs/j2': { id: 'j2', name: 'OPS_Replica', type: 'VSphereReplica', jobSettings: { metadataRepositoryId: 'r1' } },
    '/api/v1/sessions': (req) => {
      asked.push(req.params);
      if (req.params?.stateFilter === 'Working') return { data: [{ id: 's9', jobId: 'j2', state: 'Working', creationTime: iso(now - HOUR), progressPercent: 30 }] };
      return { data: [
        { id: 's2', jobId: 'j1', creationTime: iso(now - 10 * HOUR), endTime: iso(now - 9 * HOUR), result: { result: 'Success' } },
        { id: 's1', jobId: 'j1', creationTime: iso(now - 34 * HOUR), endTime: iso(now - 33 * HOUR), result: { result: 'Failed' } },
        { id: 's3', jobId: 'j3', creationTime: iso(now - 10 * HOUR), endTime: iso(now - 9 * HOUR), result: { result: 'Success' } },
      ] };
    },
    '/api/v1/sessions/s2/logs': { records: [{ title: 'Load: Source 40% > Proxy 5% > Network 10% > Target 95%' }] },
    '/api/v1/sessions/s1/logs': { records: [{ title: 'Load: Source 60% > Proxy 5% > Network 10% > Target 85%' }] },
    '/api/v1/backups': { data: [
      { id: 'b1', name: 'OPS_Exchange', jobId: 'j1', repositoryId: 'r1', platformName: 'VMware' },
      { id: 'b2', name: 'OPS_Retired', repositoryId: 'r1', platformName: 'VMware' },
    ] },
    '/api/v1/backups/b1/backupFiles': { data: [{ backupSize: 5 * TB_BYTES, creationTime: '2026-09-13T22:40:00+05:00' }] },
    '/api/v1/backups/b2/backupFiles': () => { throw new Error('backup files are not there'); },
    '/api/v1/serverTime': { serverTime: iso(now) },
    ...over,
  });
  return { veeam, asked };
};

test('a server is read for its repositories, the jobs that write there and the chains on them', async () => {
  const { veeam, asked } = veeamServer();
  const reading = await readServer('veeam01-backup-a', new VeeamEstateReader(veeam, auth), new Date(Date.now() - 14 * 24 * HOUR));

  assert.equal(reading.error, undefined);
  assert.deepEqual(reading.jobs.map((job) => [job.name, job.backupRepositoryId, job.metadataRepositoryId]), [
    ['OPS_Exchange', 'r1', undefined],
    ['OPS_Replica', undefined, 'r1'],
    ['OPS_Elsewhere', 'other', undefined],
  ]);
  // Only the sessions of jobs that write here, and the load of their finished ones.
  assert.deepEqual(reading.attempts.map((attempt) => attempt.jobId), ['j1', 'j1']);
  assert.deepEqual(reading.loads.map((entry) => entry.load.target), [95, 85]);
  assert.deepEqual(reading.working, [{ jobId: 'j2', since: reading.working[0].since, percent: 30 }]);
  // A backup whose files could not be read is listed with no size.
  assert.deepEqual(reading.backups.map((backup) => [backup.name, backup.size]), [['OPS_Exchange', 5 * TB_BYTES], ['OPS_Retired', 0]]);
  assert.ok(asked.some((params) => params?.createdAfterFilter), 'сессии — только за период');
});

test('a server that stops answering keeps what it said before', async () => {
  const { veeam } = veeamServer(Date.now(), { '/api/v1/jobs': () => { throw new Error('The Veeam server did not respond within 30000 ms'); } });
  const reading = await readServer('veeam01-backup-a', new VeeamEstateReader(veeam, auth), new Date(0));

  assert.equal(reading.repositories.length, 1);
  assert.deepEqual(reading.jobs, []);
  assert.match(reading.error, /did not respond/);
});

/* ------------------------------------------------------------------ *
 * /repos
 * ------------------------------------------------------------------ */

const FORUM = { id: Number(CHAT), type: 'supergroup', is_forum: true };
const typed = (w, text) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  message: { message_id: 50, message_thread_id: 1, is_topic_message: true, text, chat: FORUM },
});

/** A key of the menu under the input field: its label arrives as a message of its own. */
let keyId = 700;
const keyed = async (w, label) => {
  keyId += 1;
  await w.updates.handleUpdate({
    update_id: Math.floor(Math.random() * 1e6),
    message: { message_id: keyId, message_thread_id: 1, is_topic_message: true, text: label, chat: FORUM },
  });
  return keyId;
};

const labels = (markup) => markup.keyboard.map((row) => row.map((key) => key.text));

/** What the cycle needs on top of what the report reads. */
const CYCLE = {
  '/api/v1/jobs/states': { data: [] },
  '/api/v1/restorePoints': { data: [] },
};

const reposWorld = (env = {}, routes = {}) => {
  const w = world({ REPORT_SITES: 'Main', ...env });
  const { veeam, asked } = veeamServer(Date.now(), { ...CYCLE, ...routes });
  const printer = printerOf();
  // A monitor beside the answers: its cycle is what tells the report menu the repositories there are.
  const { monitor, answers } = watching(w, [serverOf(w, veeam)], printer);
  const { updates, commands } = ear(w, monitor, answers);
  return { ...w, updates, commands, monitor, printer, asked };
};

/** A command typed, and whatever it said was coming. */
const answered = async (w, text) => {
  await typed(w, text);
  await w.commands.settled();
};

test('/repos says at once that the report is coming, then sends it as a PDF, showing it is being sent meanwhile', async () => {
  const w = reposWorld();

  await answered(w, '/repos');

  const [note] = w.api.sent();
  assert.match(note.text, /^⏳ <b>Готовлю отчёт по всем репозиториям<\/b>\n\nСобираю данные со всех серверов Veeam — это 1–2 минуты\./);
  const order = w.api.calls.map((call) => call.method);
  assert.ok(order.indexOf('sendMessage') < order.indexOf('sendDocument'), 'сначала «готовлю», потом файл');
  assert.ok(w.api.of('sendChatAction').some((call) => call.action === 'upload_document'), 'видно, что бот отправляет файл');
  const [sent] = w.api.of('sendDocument');
  assert.ok(sent, 'отчёт отправлен файлом');
  assert.equal(sent.chat_id, CHAT);
  assert.match(sent.document.filename, /^Репозитории Veeam \d\d\.\d\d\.\d{4}\.pdf$/);
  assert.ok(sent.document.content.toString().startsWith('%PDF'));
  assert.match(sent.caption, /^📄 <b>Репозитории Veeam<\/b> — 1 хранилище\n/);
  assert.match(sent.caption, /\n<i>Данные за 14 дней, на \d\d\.\d\d\.\d{4} \d\d:\d\d\. Один репозиторий: \/repos имя\.<\/i>$/);
  assert.match(w.printer.pages[0], /Состояние репозиториев/);
});

test('while the report is read the bot answers everything else, and the PDF comes when it is ready', async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const w = reposWorld({}, { '/api/v1/backups': async () => (await held, { data: [] }) });

  await typed(w, '/repos');
  await typed(w, '/menu');

  assert.match(w.api.sent().at(-1).text, /Меню Veeam Monitor/, 'другая команда отвечена, пока отчёт читается');
  assert.equal(w.api.of('sendDocument').length, 0);
  release();
  await w.commands.settled();
  assert.equal(w.api.of('sendDocument').length, 1);
});

test('the 📄 key offers every repository by site, and a repository\'s key sends that one', async () => {
  const w = reposWorld({ REPORT_SITES: 'Main,Branch=BR*' }, {
    '/api/v1/backupInfrastructure/repositories/states': { data: [
      repository('r1', 'NAS01_BKP01', '\\\\192.0.2.10\\NAS01_BKP01'),
      repository('r2', 'BR_BACKUP', '\\\\198.51.100.7\\BR_BACKUP', { capacityTB: 40, freeTB: 30 }),
    ] },
  });

  // Before the first cycle there is nothing to list but the whole report.
  await keyed(w, '📄 Отчёт');
  assert.match(w.api.sent().at(-1).text, /Список репозиториев появится после первой проверки/);

  await w.monitor.check();
  w.api.reset();
  const pressed = await keyed(w, '📄 Отчёт');
  const menu = w.api.sent().at(-1);
  assert.equal(menu.text, [
    '📄 <b>Отчёт по репозиториям</b>',
    '',
    '<b>Main</b>',
    '🗄 BKP01 — свободно 40%',
    '',
    '<b>Branch</b>',
    '🗄 BR — свободно 75%',
    '',
    'Выберите репозиторий кнопкой под полем ввода или «📚 Все репозитории».',
    'PDF собирается 1–2 минуты, повторный в течение получаса — за секунды.',
  ].join('\n'));
  assert.deepEqual(labels(menu.reply_markup), [['📚 Все репозитории'], ['🗄 BKP01'], ['🗄 BR'], ['⬅️ На главную']]);
  // Only for whoever pressed it, as the server menu is.
  assert.equal(menu.reply_markup.selective, true);
  assert.equal(menu.reply_parameters.message_id, pressed);

  w.api.reset();
  const chosen = await keyed(w, '🗄 BKP01');
  const note = w.api.sent().at(-1);
  assert.match(note.text, /^⏳ <b>Готовлю отчёт: BKP01<\/b>/);
  assert.deepEqual(labels(note.reply_markup)[0], ['🖥 Серверы', '📄 Отчёт'], 'и главное меню вернулось');
  assert.equal(note.reply_parameters.message_id, chosen);
  await w.commands.settled();
  assert.match(w.api.of('sendDocument')[0].document.filename, /^Репозиторий BKP01 /);
});

test('a name that matches no repository is said at once, with the names there are, and nothing is read', async () => {
  const w = reposWorld();
  await w.monitor.check();
  const reads = w.asked.length;
  w.api.reset();

  await answered(w, '/repos nothing');

  assert.equal(w.api.sent().length, 1);
  assert.match(w.api.sent()[0].text, /Репозитория «nothing» нет[\s\S]*Есть: BKP01\./);
  assert.equal(w.api.of('sendDocument').length, 0);
  assert.equal(w.asked.length, reads, 'Veeam ни о чём не спрошен');
});

test('/repos with a name sends that repository alone', async () => {
  const w = reposWorld();

  await answered(w, '/repos bkp01');

  // Before the first cycle has seen the repositories, the name as typed.
  assert.match(w.api.sent()[0].text, /^⏳ <b>Готовлю отчёт: bkp01<\/b>/);
  const [one] = w.api.of('sendDocument');
  assert.match(one.document.filename, /^Репозиторий BKP01 /);
  assert.match(one.caption, /<b>BKP01<\/b> — /);
  assert.doesNotMatch(w.printer.pages[0], /Состояние репозиториев<\/h1>/);
});

test('a second /repos within half an hour is a matter of seconds, and asks Veeam nothing', async () => {
  const w = reposWorld();

  await answered(w, '/repos');
  const reads = w.asked.length;
  w.store.cooldowns.clear('command:read');
  w.api.reset();
  await answered(w, '/repos bkp01');

  assert.match(w.api.sent()[0].text, /Данные собраны недавно — PDF будет через несколько секунд\./);
  assert.equal(w.asked.length, reads);
  assert.equal(w.api.of('sendDocument').length, 1);
});

/* ------------------------------------------------------------------ *
 * Printing: the envelope both reports' pages go in, and the browser
 * ------------------------------------------------------------------ */

test('a report\'s page goes in one envelope: its fonts inside it, and nothing fetched, whatever the page names', () => {
  const { envelope } = require('../dist/estate/report-envelope');
  const html = envelope({
    lang: 'ru',
    title: 'OPS_<b>Edge</b> — 14.10.2026 11:00',
    style: '.js { color: #000; }',
    body: '<img src="https://example.com/logo.png"><p>OPS_Edge</p>',
  });

  // Inter is inside the page: the server has no font with Cyrillic of its own.
  assert.match(html, /@font-face[^}]+url\(data:font\/woff2;base64,/);
  // The browser prints with no sandbox: the page may fetch nothing, not even what it names.
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">/);
  assert.doesNotMatch(html.replace('https://example.com/logo.png', ''), /https?:\/\//, 'the envelope names no address of its own');
  assert.match(html, /^<!doctype html><html lang="ru"><head><meta charset="utf-8">/);
  assert.match(html, /<title>OPS_&lt;b&gt;Edge&lt;\/b&gt; — 14\.10\.2026 11:00<\/title>/);
  assert.match(html, /\.js \{ color: #000; \}<\/style><\/head><body><img src="https:\/\/example\.com\/logo\.png"><p>OPS_Edge<\/p><\/body><\/html>$/);
});

test('without a browser the report says it cannot be printed rather than staying silent', async () => {
  const w = world({ REPORT_BROWSER: '/nowhere/chrome-headless-shell' });
  const { veeam } = veeamServer();
  const { ReportPrinter } = require('../dist/estate/report-printer');
  const { configService } = require('./world.cjs');
  const { updates, commands } = ear(w, idleMonitor(), answersOf(w, [serverOf(w, veeam)], new ReportPrinter(configService(w.app))));

  await updates.handleUpdate({
    update_id: 1,
    message: { message_id: 50, message_thread_id: 1, is_topic_message: true, text: '/repos', chat: FORUM },
  });
  await commands.settled();

  assert.equal(w.api.of('sendDocument').length, 0);
  assert.match(w.api.sent().pop().text, /Не удалось ответить[\s\S]*Нет браузера для PDF: \/nowhere\/chrome-headless-shell/);
});

test('one report is printed at a time, and one that fails does not hold up the next', async () => {
  const fs = require('node:fs');
  const { ReportPrinter } = require('../dist/estate/report-printer');
  const { configService } = require('./world.cjs');
  let printing = 0;
  let most = 0;
  // A browser that takes its time, prints the page it was given as it is, and cannot print a broken one.
  const browser = async (page, pdf) => {
    printing += 1;
    most = Math.max(most, printing);
    await new Promise((resolve) => setTimeout(resolve, 5));
    printing -= 1;
    const html = fs.readFileSync(page, 'utf8');
    if (html === 'broken') throw new Error('Браузер не напечатал PDF');
    fs.writeFileSync(pdf, `%PDF ${html}`);
  };
  const printer = new ReportPrinter(configService(appConfig()), browser);

  const prints = ['a', 'broken', 'c'].map((html) => printer.print(html).then(String, (error) => error.message));

  assert.deepEqual(await Promise.all(prints), ['%PDF a', 'Браузер не напечатал PDF', '%PDF c']);
  assert.equal(most, 1);
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

test('REPORT_SITES names the sites in order, each with its patterns or as the one taking the rest', () => {
  assert.deepEqual(appConfig({ REPORT_SITES: 'Main, Branch=BR*|DR*' }).report.sites, [
    { name: 'Main', patterns: [] },
    { name: 'Branch', patterns: ['BR*', 'DR*'] },
  ]);
  assert.throws(() => appConfig({ REPORT_SITES: 'Main,Branch' }), /REPORT_SITES may leave the patterns out of one site only/);
  assert.throws(() => appConfig({ REPORT_SITES: 'Main,main=X*' }), /REPORT_SITES names one site twice/);
  assert.throws(() => appConfig({ REPORT_DAYS: '90' }), /REPORT_DAYS must be an integer from 1 to 60/);
});

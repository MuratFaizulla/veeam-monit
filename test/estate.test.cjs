const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SERVER, world, veeamFake, job, exchange, configuredJob, kingstonNight, monitorAccount, serverOf, jobReadsOf,
  answersOf, answersWorld, idleAnswers, EstateAnswers, telegramConfig,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Answers about a server, apart from the cycle
 *
 * Which server a question is about, and what is said about it, used to be
 * nine members of the monitor, each the same pass-through to a server's
 * estate: a test of one command built the whole monitor and ran its cycle
 * first. Asked here of the answers alone, over server estates with no cycle.
 * ------------------------------------------------------------------ */

const TWO = { VEEAM_SERVERS: 'AST=https://ast.example.com:9419,BAAS=https://baas.example.com:9419' };

/** What a server's Veeam answers when it has `jobs` and nothing else to say about them. */
const routesOf = (jobs) => ({
  '/api/v1/jobs/states': { data: jobs },
  '/api/v1/sessions': { data: [] },
  '/api/v1/jobs': { data: [] },
  '/api/v1/backups': { data: [] },
  '/api/v1/backupInfrastructure/repositories': { data: [] },
  '/api/v1/backupInfrastructure/proxies': { data: [] },
});

/** One server of a world with `jobs` and their Job reads, none of which say anything. */
const quiet = (w, jobs, endpoint) => ({
  ...serverOf(w, veeamFake(routesOf(jobs)), monitorAccount(), undefined, endpoint),
  reads: jobReadsOf(),
});

/** AST, listed first, and BAAS, a job of its own each, answered about with no cycle. */
const astAndBaas = () => {
  const w = world(TWO);
  const [ast, baas] = w.app.veeam.servers;
  const answers = answersOf(w, [quiet(w, [job('a1', 'SQL Daily', 'Failed')], ast), quiet(w, [job('b1', 'Files', 'Success')], baas)]);
  return { ...w, answers };
};

test('a question is about the Selected server, and a Button\'s about the server it named', async () => {
  const w = astAndBaas();

  // Typed, a question names no server: it is about the one selected, the first until somebody picks another.
  const typed = await w.answers.describeJob('SQL');
  assert.ok(typed.text.startsWith('🖥 <b>AST</b>\n\n'), typed.text);
  assert.match(typed.text, /SQL Daily/);
  assert.equal(typed.server, 'ast', 'and carries its key for the Buttons under it');

  w.store.selectServer('baas');
  assert.match((await w.answers.describeJob('Files')).text, /^🖥 <b>BAAS<\/b>\n\n[^]*Files/u);

  // A Button names its server: pressed after somebody selected another, it opens the job it was labelled with.
  const pressed = await w.answers.describeJobById('a1', 'ast');
  assert.ok(pressed.text.startsWith('🖥 <b>AST</b>\n\n'), pressed.text);
  assert.deepEqual([pressed.jobId, pressed.server], ['a1', 'ast']);
  // One from before there was a list names none, and one may name a server since taken off it: the Selected one.
  for (const named of [undefined, 'gone']) {
    const answer = await w.answers.describeJobById('b1', named);
    assert.deepEqual([answer.jobId, answer.server], ['b1', 'baas'], String(named));
  }

  // Selected and then taken off the list, a server leaves the first one shown.
  w.store.selectServer('gone');
  assert.equal((await w.answers.describeJob('SQL')).server, 'ast');
});

test('the Summary asked for is the daily one, its title naming the server as the daily one\'s does', async () => {
  const w = astAndBaas();

  const summary = await w.answers.summary();
  // The very same event the daily message sends, rendered: its title says the server, so nothing goes above it.
  assert.ok(summary.text.startsWith('🔴 <b>AST · Veeam: сводка по заданиям</b>\n'), summary.text);
  assert.match(summary.text, /🔴 SQL Daily/);
  assert.deepEqual(summary.jobs, [{ id: 'a1', name: 'SQL Daily' }], 'the jobs it names, for the Buttons under it');
  assert.equal(summary.server, 'ast');

  w.store.selectServer('baas');
  assert.match((await w.answers.summary()).text, /<b>BAAS · Veeam: сводка по заданиям<\/b>/);
});

test('the job menu is the Selected server\'s, and a job\'s points and report are on the server its Button named', async () => {
  const w = astAndBaas();

  assert.deepEqual(await w.answers.jobChoices(), { server: 'AST', jobs: [{ name: 'SQL Daily', mark: 'failed' }] });
  w.store.selectServer('baas');
  assert.deepEqual(await w.answers.jobChoices(), { server: 'BAAS', jobs: [{ name: 'Files', mark: 'success' }] });
  assert.match((await w.answers.describePoints('Files')).text, /^🖥 <b>BAAS<\/b>\n\n🗂 <b>Files<\/b>/u);

  const points = await w.answers.describePointsById('a1', 'ast');
  assert.ok(points.text.startsWith('🖥 <b>AST</b>\n\n🗂 <b>SQL Daily</b>'), points.text);
  assert.deepEqual([points.jobId, points.server, points.about], ['a1', 'ast', 'points']);

  // Said at once to be coming, and read where the Button said: the file says which server it covers.
  const report = w.answers.jobReport('a1', 'ast');
  assert.match(report.text, /^⏳ <b>Готовлю отчёт по заданию<\/b>/u);
  const file = await report.later();
  assert.match(file.text, /\n<i>AST · за 30 дней, на /u);
  assert.match(file.document.filename, /^Задание SQL Daily /u);
});

test('the idle answers the tests use answer exactly the questions the real ones do', () => {
  // Two adapters of one seam drift apart silently. Read off the class rather
  // than listed by hand — a list kept by hand was one more place every new
  // command had to be added — which works because its methods are its
  // questions and nothing else.
  const questions = Object.getOwnPropertyNames(EstateAnswers.prototype).filter((name) => name !== 'constructor');
  const idle = idleAnswers();
  assert.deepEqual(Object.keys(idle).sort(), [...questions].sort());
  for (const name of questions) assert.equal(typeof idle[name], 'function', name);
});

test('with one server an answer says nothing of which it is about, and carries its key all the same', async () => {
  const w = world();
  const answers = answersOf(w, [serverOf(w, veeamFake(routesOf([job('1', 'SQL Daily', 'Success')])))]);

  const summary = await answers.summary();
  assert.ok(summary.text.startsWith('🟢 <b>Veeam: сводка по заданиям</b>\n'), summary.text);
  const card = await answers.describeJob('SQL');
  assert.doesNotMatch(card.text, /🖥/u);
  assert.deepEqual([summary.server, card.server], [SERVER, SERVER]);
});

/* ------------------------------------------------------------------ *
 * The Job card: one job, by a half-remembered name or by a Button
 * ------------------------------------------------------------------ */

/** The Selected server's Evidence, read as a cycle reads it: what a card or /points about a job answers from. */
const scanned = async (w) => w.evidence.refresh(true, await w.server.reader.jobStates());

test('an approximate name finds the job somebody meant', () => {
  const { matchJob } = require('../dist/estate/job-card');
  const jobs = [
    { id: '1', name: 'OPS_Veeam_DB_Kingston' },
    { id: '2', name: 'OPS_Kingston_EM_DB' },
    { id: '3', name: 'OPS_Exchange' },
  ];

  assert.deepEqual(matchJob(jobs, 'ops_exchange'), { found: 'one', job: jobs[2] });
  // The words in the other order, separated by underscores nobody types.
  assert.deepEqual(matchJob(jobs, 'kingston em'), { found: 'one', job: jobs[1] });
  assert.deepEqual(matchJob(jobs, 'нет такого'), { found: 'none' });
});

test('a name that fits several jobs is listed, never guessed at', () => {
  const { matchJob } = require('../dist/estate/job-card');
  const jobs = [{ id: '1', name: 'OPS_Veeam_DB_Kingston' }, { id: '2', name: 'OPS_Kingston_EM_DB' }];

  // Answering confidently about the wrong job is worse than answering with a
  // list: the asker would have no way of noticing.
  const match = matchJob(jobs, 'kingston');

  assert.equal(match.found, 'many');
  // The jobs, not their names: a button has to address what it opens.
  assert.deepEqual(match.jobs.map((j) => j.name), ['OPS_Kingston_EM_DB', 'OPS_Veeam_DB_Kingston']);
  assert.deepEqual(match.jobs.map((j) => j.id), ['2', '1']);
});

test('/job answers about one job, which no live topic can', async () => {
  const w = exchange({}, answersWorld);
  await scanned(w);

  const { text } = await w.answers.describeJob('exchange');

  assert.match(text, /OPS_Exchange/);
  assert.match(text, /Последний результат:<\/b> ошибка/);
  assert.match(text, /<i>бэкап ВМ/, 'the kind of job in words, not Veeam\'s "Backup"');
  assert.match(text, /Точки восстановления/);
  assert.match(text, /Последние запуски/);
});

test('/job without a name says how to use it instead of failing', async () => {
  const w = answersWorld({}, [job('1', 'SQL Daily', 'Success')]);

  assert.match((await w.answers.describeJob('')).text, /Укажите задание/);
});

test('/job shows how the job is set up, not just how it ran', async () => {
  const reply = (await configuredJob().answers.describeJob('APP_DB1')).text;

  assert.match(reply, /Расписание:<\/b> пн, ср, пт в 03:12/, 'дни в порядке недели');
  assert.match(reply, /Повтор при ошибке:<\/b> 3 раза через 10 мин/);
  assert.match(reply, /Репозиторий:<\/b> SITE1_NAS_BKP06/, 'имя, а не id');
  assert.match(reply, /Прокси:<\/b> автоматически/);
  assert.match(reply, /Хранение:<\/b> 7 дней/);
  assert.match(reply, /Режим:<\/b> Incremental, Active Full по сб/);
  assert.match(reply, /Машины \(1\)/);
  assert.match(reply, /APPDB1-T3Q4 — 3,9 TB · 192\.0\.2\.194/);
});

test('/job names the machine that failed, which the job name never does', async () => {
  const reply = (await configuredJob().answers.describeJob('APP_DB1')).text;

  assert.match(reply, /Что именно не прошло/);
  // The task says only the step it stopped at; the session says, of the same
  // machine, why. The machine's own error is the one worth reading.
  assert.match(reply, /🔴 APPDB1-T3Q4 — Virtual Machine APPDB1-T3Q4 is unavailable and will be skipped/);
  assert.doesNotMatch(reply, /Getting VM info/);
});

test('a job that is not failing is not asked which machine failed', async () => {
  const w = answersWorld({}, [job('1', 'SQL Daily', 'Success')]);

  // The per-object read costs a request and answers a question nobody asked:
  // a recovered job's failures are already in its run list.
  assert.doesNotMatch((await w.answers.describeJob('SQL')).text, /Что именно не прошло/);
});

test('a named proxy is told apart from automatic selection', () => {
  const { settingsOf } = require('../dist/estate/job-card');
  const names = {
    repositories: new Map([['r1', 'SITE1_BKP06']]),
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
  // OPS_Billing_Prod takes its fulls every third Wednesday; the card said
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
    'Incremental, Active Full в 3-ю ср месяца',
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
  // The per-object block is about to say this at length; saying it twice is
  // how the card turned into a wall of the same Veeam paragraph.
  assert.doesNotMatch((await configuredJob().answers.describeJob('APP_DB1')).text, /<b>Причина:<\/b>/);

  // Where a run failed before it reached any object, there is no per-object
  // block and the session message is the whole story.
  const plain = answersWorld({}, [job('1', 'SQL Daily', 'Failed')]);
  const reply = (await plain.answers.describeJob('SQL')).text;
  assert.match(reply, /<b>Причина:<\/b> Agent failed to process method/);
  assert.doesNotMatch(reply, /Что именно не прошло/);
});

test('a Job card never shows the connection parameters Veeam writes after a reason', async () => {
  // No per-machine detail to read, so both the reason line and the run list
  // come from the sessions' own messages — which the run list showed raw.
  const w = answersWorld({}, [job('1', 'OPS_Kingston_vCenters', 'Failed')], {
    '/api/v1/sessions': { data: [kingstonNight('n2', 29), kingstonNight('n1', 27)] },
  });

  const reply = (await w.answers.describeJob('Kingston')).text;

  assert.match(reply, /<b>Причина:<\/b> comp01vc01 — Cannot get service content\. \/ Soap fault\. Temporary failure in name resolution/);
  const runs = reply.slice(reply.indexOf('Последние запуски'));
  assert.equal((runs.match(/comp01vc01 — Cannot get service content/g) ?? []).length, 2, `в списке запусков:\n${runs}`);
  assert.doesNotMatch(reply, /Logon attempt|svc@example\.com/);
});

test('a job that disappeared between the message and the press says so', async () => {
  const w = answersWorld({}, [job('1', 'SQL Daily', 'Success')]);

  assert.match((await w.answers.describeJobById('gone')).text, /больше не найдено/);
});

/* ------------------------------------------------------------------ *
 * What held the last run back
 * ------------------------------------------------------------------ */

const GB = 1024 ** 3;

/** A machine of a run: its task and the lines its own log would carry. */
const machineTask = (id, name, over = {}) => ({
  id, name, type: 'Backup', algorithm: 'Full', result: { result: 'Success' },
  progress: { bottleneck: 'Target', duration: '01:00:00', readSize: 100 * GB, transferredSize: 40 * GB },
  ...over,
});

const diskLog = (proxy, mode, owner) => [
  ...(owner ? [`VM owner: ${owner}`] : []),
  'Using gateway veeam01.example.com for repository BKP07',
  `Using backup proxy ${proxy} for disk Hard disk 1 [${mode}]`,
  'Busy: Source 3% > Proxy 0% > Network 7% > Target 97%',
];

/** CUST_HOUSING_1 on 3 October: a vCloud job, its vApp's task beside its machines'. */
const cloudRun = (over = {}) => ({
  startedAt: '2026-10-03T21:00:23+05:00',
  endedAt: '2026-10-04T01:47:33+05:00',
  log: ['Job started at 03.10.2026 21:00:23', 'Load: Source 3% > Proxy 0% > Network 7% > Target 97%', 'Primary bottleneck: Target'],
  tasks: [
    machineTask('vapp', 'housing_city_vApp', { progress: { duration: '04:44:52', readSize: 300 * GB, transferredSize: 120 * GB } }),
    machineTask('m1', 'BDSRV1', { progress: { duration: '04:40:31', readSize: 100 * GB, transferredSize: 40 * GB } }),
    machineTask('m2', 'WEB2', { progress: { duration: '02:46:30', readSize: 100 * GB, transferredSize: 40 * GB } }),
    machineTask('m3', 'AD01', { algorithm: 'Increment', progress: { duration: '00:30:07', readSize: 100 * GB, transferredSize: 40 * GB } }),
  ],
  machineLogs: new Map([
    ['vapp', ['vApp processing started at 03.10.2026 21:01:31', 'Waiting for all VM backup tasks to complete to finish vApp backup']],
    ['m1', diskLog('192.0.2.20', 'nbd', 'housing_city_vApp')],
    ['m2', diskLog('192.0.2.21', 'hotadd', 'housing_city_vApp')],
    ['m3', diskLog('VMware Backup Proxy', 'nbd', 'housing_city_vApp')],
  ]),
  cloud: true,
  timezone: 'Asia/Qyzylorda',
  ...over,
});

test('a run is read from its logs: the stage that held it back, the path its data took', () => {
  const { speedOf } = require('../dist/estate/run-speed');
  const speed = speedOf(cloudRun());

  assert.deepEqual(speed.load, { source: 3, proxy: 0, network: 7, target: 97 });
  assert.equal(speed.bottleneck, 'target');
  assert.equal(speed.took, (4 * 3600 + 47 * 60 + 10) * 1000);
  // The vApp's task reports its machines' bytes over again.
  assert.equal(speed.machines, 3);
  assert.equal(speed.read, 300 * GB);
  assert.equal(speed.transferred, 120 * GB);
  assert.deepEqual([speed.fulls, speed.increments], [2, 1]);
  assert.deepEqual(Object.fromEntries(speed.modes), { nbd: 2, hotadd: 1 });
  assert.deepEqual(speed.proxies, ['192.0.2.20', '192.0.2.21', 'VMware Backup Proxy']);
  assert.deepEqual(speed.gateways, ['veeam01.example.com']);
  assert.deepEqual(speed.slowest.map((machine) => machine.name), ['BDSRV1', 'WEB2', 'AD01'], 'the vApp is no machine');
});

test('a vApp nobody recognised costs the sum, never a doubled one', () => {
  const { speedOf } = require('../dist/estate/run-speed');
  // Its own log unread, and no machine's log naming it its owner.
  const speed = speedOf(cloudRun({ machineLogs: new Map([['m1', diskLog('192.0.2.20', 'nbd')]]) }));
  assert.equal(speed.read, undefined);
  assert.equal(speed.transferred, undefined);
  assert.equal(speed.bottleneck, 'target', 'the rest is still said');
  assert.equal(speed.logged, 1);
});

test('without Veeam naming a stage, the busiest one is the bottleneck; with nothing read, nothing is said', () => {
  const { speedOf } = require('../dist/estate/run-speed');
  const unnamed = speedOf(cloudRun({ log: ['Load: Source 85% > Proxy 7% > Network 28% > Target 30%'] }));
  assert.equal(unnamed.bottleneck, 'source');

  // OPS_edge_vCenters on 6 October: vCenter unreachable, every machine read 0 bytes.
  const nothing = speedOf({
    startedAt: '2026-10-06T06:04:26+05:00', endedAt: '2026-10-06T06:16:11+05:00',
    log: ['Job finished with error at 06.10.2026 6:16:11'],
    tasks: [machineTask('t', 'vc01', { algorithm: 'None', progress: { bottleneck: 'NotDefined', readSize: 0, transferredSize: 0 } })],
    machineLogs: new Map(), cloud: false, timezone: 'Asia/Qyzylorda',
  });
  assert.equal(nothing, undefined);
});

test('the card says what held the run back and what that means, in a few lines', () => {
  const { speedOf } = require('../dist/estate/run-speed');
  const { renderJobCard } = require('../dist/estate/job-card');
  const card = renderJobCard(
    {
      name: 'CUST_HOUSING_1', type: 'CloudDirectorBackup', disabled: false, lastResult: 'success',
      sessions: [], sessionsCut: false, retryWindowMs: 0, failedObjects: [], machines: [], excluded: 0,
      speed: speedOf(cloudRun()),
    },
    { now: new Date('2026-10-06T10:00:00+05:00'), timezone: 'Asia/Qyzylorda' },
  );
  const block = card.split('\n\n').find((part) => part.startsWith('<b>⚡'));
  assert.equal(block, [
    '<b>⚡ Скорость запуска 03.10 в 21:00</b>',
    'Full у 2 ВМ, инкремент у 1 · прочитано 300 ГБ за 4 ч 47 мин — 18 МБ/с · передано 120 ГБ',
    'Узкое место: <b>Target 97%</b> — репозиторий или его шлюз не успевают писать',
    'Загрузка: Source 3% · Proxy 0% · Network 7% · Target 97%',
    'Чтение: NBD (по сети через ESXi) — 2 диска, HotAdd — 1 диск, прокси 192.0.2.20–21, VMware Backup Proxy (сам сервер Veeam)',
    'Запись: через шлюз veeam01.example.com',
    'Дольше всех: BDSRV1 — 4 ч 40 мин · WEB2 — 2 ч 46 мин · AD01 — 30 мин',
  ].join('\n'));
});

test('proxies of one network are folded into ranges', () => {
  const { speedOf } = require('../dist/estate/run-speed');
  const { renderJobCard } = require('../dist/estate/job-card');
  const proxies = ['192.0.2.27', '192.0.2.20', '192.0.2.22', '192.0.2.21', '192.0.2.24', '198.51.100.162'];
  const speed = speedOf(cloudRun({
    cloud: false,
    tasks: proxies.map((proxy, i) => machineTask(`t${i}`, `vm${i}`)),
    machineLogs: new Map(proxies.map((proxy, i) => [`t${i}`, diskLog(proxy, 'nbd')])),
  }));
  const card = renderJobCard(
    { name: 'J', disabled: false, lastResult: 'success', sessions: [], sessionsCut: false, retryWindowMs: 0,
      failedObjects: [], machines: [], excluded: 0, speed },
    { now: new Date('2026-10-06T10:00:00+05:00'), timezone: 'UTC' },
  );
  assert.match(card, /^Чтение: NBD \(по сети через ESXi\), прокси 192\.0\.2\.20–22, 24, 27, 198\.51\.100\.162$/mu);
});

/** OPS_Billing_Prod's one finished run, as its Job reads give it. */
const NIGHT = { id: 'night', startedAt: '2026-10-01T22:00:00+05:00', endedAt: '2026-10-01T22:37:00+05:00', result: 'success' };
const NIGHT_LOG = ['Load: Source 14% > Proxy 8% > Network 12% > Target 89%', 'Primary bottleneck: Target'];

test('the Job reads read what Veeam wrote while running an attempt: its log, its machines, and the logs of the thirty longest', async () => {
  const { VeeamApiError } = require('../dist/veeam/api.error');
  const reads = (routes) => serverOf(world(), veeamFake(routes)).reads;
  const log = { records: [{ title: 'Load: Source 14% > Proxy 8% > Network 12% > Target 89%' }, { title: 'Primary bottleneck:  Target' }] };
  // Thirty-one machines: vm30 the longest at forty minutes, vm0 the shortest at ten.
  const tasks = Array.from({ length: 31 }, (_, i) => machineTask(`t${i}`, `vm${i}`, { progress: { duration: `00:${10 + i}:00` } }));
  const asked = [];
  const record = await reads({
    '/api/v1/sessions/night/logs': log,
    '/api/v1/sessions/night/taskSessions': { data: tasks },
    ...Object.fromEntries(tasks.map(({ id }) => [`/api/v1/taskSessions/${id}/logs`, () => {
      asked.push(id);
      if (id === 't30') throw new Error('socket hang up');
      return { records: [{ title: 'Using backup proxy 192.0.2.21 for disk Hard disk 1  [hotadd]' }] };
    }])),
  }).recordOf(NIGHT);

  assert.deepEqual(record.log, NIGHT_LOG, 'a line each, as Veeam breaks none');
  assert.equal(record.tasks.length, 31);
  assert.equal(asked.length, 30);
  assert.ok(!asked.includes('t0'), 'the shortest machine is not worth a request');
  // A machine whose log Veeam would not give is left out.
  assert.equal(record.machineLogs.size, 29);
  assert.deepEqual(record.machineLogs.get('t29'), ['Using backup proxy 192.0.2.21 for disk Hard disk 1 [hotadd]']);

  // A server whose REST API is 1.1 has no task sessions: the session's own log is all there is.
  const older = await reads({
    '/api/v1/sessions/night/logs': log,
    '/api/v1/sessions/night/taskSessions': () => { throw new VeeamApiError('Not found', 404); },
  }).recordOf(NIGHT);
  assert.deepEqual([older.log, older.tasks, older.machineLogs.size], [NIGHT_LOG, [], 0]);

  // Without the session's log there is nothing to say.
  const silent = reads({
    '/api/v1/sessions/night/logs': () => { throw new Error('socket hang up'); },
    '/api/v1/sessions/night/taskSessions': { data: [] },
  });
  assert.equal(await silent.recordOf(NIGHT), undefined);
});

/** /job about OPS_Billing_Prod, whose Job reads say Veeam wrote `record` while running its one finished run. */
const billingCard = async (record) => {
  const { JobQueryService } = require('../dist/estate/job-query.service');
  const w = world();
  const { reader, auth, evidence, inventory } = serverOf(w, veeamFake({
    '/api/v1/jobs/states': { data: [job('1', 'OPS_Billing_Prod', 'Success')] },
    '/api/v1/backupInfrastructure/repositories': { data: [] },
    '/api/v1/backupInfrastructure/proxies': { data: [] },
  }));
  const reads = jobReadsOf({ sessions: [NIGHT], records: record ? { night: record } : {} });
  return (await new JobQueryService(w.config, reader, auth, evidence, inventory, reads).describeJob('billing')).text;
};

test('/job says what held the last run back, from what Veeam wrote while running it', async () => {
  const card = await billingCard({
    log: NIGHT_LOG,
    tasks: [
      machineTask('t1', 'app-prod-svc-01', { algorithm: 'Increment', progress: { duration: '00:35:00', readSize: 70 * GB, transferredSize: 20 * GB } }),
      machineTask('t2', 'app-prod-web-02', { algorithm: 'Increment', progress: { duration: '00:29:00', readSize: 70 * GB, transferredSize: 20 * GB } }),
    ],
    machineLogs: new Map([['t1', diskLog('192.0.2.21', 'hotadd')], ['t2', diskLog('192.0.2.22', 'hotadd')]]),
  });

  assert.match(card, /^<b>⚡ Скорость запуска .*<\/b>\nИнкремент · прочитано 140 ГБ за 37 мин — 65 МБ\/с · передано 40 ГБ$/mu);
  assert.match(card, /^Узкое место: <b>Target 89%<\/b> — репозиторий или его шлюз не успевают писать$/mu);
  assert.match(card, /^Чтение: HotAdd, прокси 192\.0\.2\.21–22$/mu);
  assert.match(card, /^Дольше всех: app-prod-svc-01 — 35 мин · app-prod-web-02 — 29 мин$/mu);
});

test('a run whose machines Veeam does not list still says the stage, from the session\'s own log', async () => {
  // veeam02, REST API 1.1.
  const card = await billingCard({ log: NIGHT_LOG, tasks: [], machineLogs: new Map() });

  assert.match(card, /^Узкое место: <b>Target 89%<\/b>/mu);
  assert.doesNotMatch(card, /Чтение:/);
});

test('a run Veeam would say nothing about leaves the card as it was', async () => {
  const card = await billingCard(undefined);

  assert.match(card, /OPS_Billing_Prod/);
  assert.doesNotMatch(card, /⚡/u);
});

/* ------------------------------------------------------------------ *
 * The Summary: every job of the Selected server, counted once
 * ------------------------------------------------------------------ */

test('/digest counts every job and names the ones that went wrong', async () => {
  const w = answersWorld({}, [
    job('1', 'SQL Daily', 'Failed'),
    job('2', 'Files', 'Success'),
    job('3', 'Exchange', 'Warning'),
  ]);

  const { text } = await w.answers.summary();

  assert.match(text, /Всего заданий:<\/b> 3/);
  assert.match(text, /Успешно:<\/b> 1/);
  // The same rendering the daily message uses: a plain list in a <pre> block,
  // marked with the icons every other message uses for the two results.
  assert.match(text, /🔴 SQL Daily/);
  assert.match(text, /🟡 Exchange/);
  assert.doesNotMatch(text, /FAILED|WARNING/);
});

test('a job switched off in Veeam is counted apart, never as a failure', () => {
  // The summary listed OPS_MGMT_VEEAM_OLD and others as FAILED: the last run
  // of each had failed, before somebody switched it off. Nobody expects a job
  // that is off to run, so its last result is history, not a problem to fix.
  const { summarise, digestEvent } = require('../dist/estate/digest');
  const { jobOf } = require('../dist/veeam/estate');
  const jobs = [
    { id: '1', name: 'SQL Daily', status: 'Stopped', lastResult: 'Failed' },
    { id: '2', name: 'OPS_MGMT_VEEAM_OLD', status: 'Disabled', lastResult: 'Failed' },
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
  assert.doesNotMatch(event.body, /OPS_MGMT_VEEAM_OLD|Old warning/);
});

test('a running job Veeam still calls disabled is counted as running', async () => {
  const { summarise } = require('../dist/estate/digest');
  const { jobOf } = require('../dist/veeam/estate');
  const jobs = [
    { id: '1', name: 'Kingston EM', status: 'Disabled', lastResult: 'Success' },
    { id: '2', name: 'Kingston DB', status: 'Disabled', lastResult: 'Success' },
    { id: '3', name: 'Queued', status: 'Working', lastResult: 'Success' },
  ].map(jobOf);

  // Two of these are transferring right now under a session Veeam opened by
  // hand; their own status keeps saying "disabled" the whole time. Counting
  // from the status alone said one job was running while three were.
  assert.equal(summarise(jobs, new Set(['1', '2'])).running, 3);
  assert.equal(summarise(jobs, new Set()).running, 1, 'без сессий — только по статусу');
});

/* ------------------------------------------------------------------ *
 * The Points report: what /points says of one job, by the verdict 🛡
 * lists it by, and the page it is printed from
 * ------------------------------------------------------------------ */

const { readingOf } = require('../dist/estate/evidence');
const { judgementOf, thresholdsOf, verdictOf } = require('../dist/estate/job-standing');
const { pointsReportOf, ELSEWHERE } = require('../dist/estate/points-report');
const { pointsReportPage } = require('../dist/estate/points-report-page');
const { jobOf } = require('../dist/veeam/estate');

const TZ = 'Asia/Qyzylorda'; // +05:00, no summer time
const NOW = Date.parse('2026-10-22T09:45:00+05:00'); // a Thursday morning
const THRESHOLDS = thresholdsOf(telegramConfig());
const local = (iso) => Date.parse(`${iso}+05:00`);
const dayAfter = (day, days = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const SNAPSHOT = 'Failed to create VM snapshot. The operation is not allowed in the current state.';

/**
 * A job's nights as Veeam says them, and the reading its Points report is
 * made from: every night at 22:00 from `first` to `last`, each machine a
 * point at 22:05, a Full on the days in `fulls`. On a day of `failed` the
 * machines named fail, with what Veeam said, and write nothing; of `setAside`
 * they fail and leave a point the scan sets aside; of `silent` they get
 * nothing and nothing is said. Its points are the Evidence's, judged as 🛡
 * judges them; the failures with Veeam's words are the Job reads'.
 */
const nightsOf = ({ machines, first, last, fulls, failed = {}, setAside = {}, silent = {}, files = true, job: state = {}, retention = 14 }) => {
  const job = jobOf({ id: 'j1', name: 'OPS_Exchange', type: 'Backup', status: 'Stopped', lastResult: 'Success', ...state });
  const configuration = {
    id: 'j1',
    schedule: { runAutomatically: true, daily: { isEnabled: true, dailyKind: 'Everyday', localTime: '22:00' } },
    storage: {
      retentionPolicy: { type: 'RestorePoints', quantity: retention },
      advancedSettings: { activeFulls: { isEnabled: true, weekly: { isEnabled: true, days: ['saturday'] } } },
    },
  };
  const sessions = [];
  const points = [];
  const written = [];
  const outcomes = new Map();
  const failures = [];
  for (let day = first; day <= last; day = dayAfter(day)) {
    const id = `s-${day}`;
    const down = [...Object.keys(failed[day] ?? {}), ...(setAside[day] ?? [])];
    sessions.push({ id, jobId: 'j1', sessionType: 'BackupJob', creationTime: `${day}T22:00:00+05:00`, endTime: `${day}T22:50:00+05:00`, result: { result: down.length ? 'failed' : 'success' } });
    if (down.length) outcomes.set(id, new Map(machines.map((machine) => [machine, down.includes(machine) ? 'failed' : 'success'])));
    for (const [machine, reason] of Object.entries(failed[day] ?? {})) failures.push({ machine, at: local(`${day}T22:00:00`), reason });
    const full = fulls.includes(day);
    const ids = machines
      .filter((machine) => !(failed[day] ?? {})[machine] && !(silent[day] ?? []).includes(machine))
      .map((machine) => {
        points.push({ id: `${day}-${machine}`, backupId: 'b1', sessionId: id, name: machine, type: full ? 'Full' : 'Increment', creationTime: `${day}T22:05:00+05:00` });
        return `${day}-${machine}`;
      });
    if (ids.length) written.push({ restorePointIds: ids, dataSize: (full ? 300 : 20) * GB, backupSize: (full ? 100 : 8) * GB });
  }
  // Newest first, as Veeam lists them.
  const evidence = readingOf({ jobs: [job], configurations: [configuration], backups: [{ id: 'b1', jobId: 'j1' }], points: points.reverse(), sessions })
    .evidence(outcomes, NOW - 5 * 60_000);
  return {
    at: NOW,
    server: 'BAAS',
    job,
    evidence: {
      status: 'ready',
      scannedAt: evidence.scannedAt,
      ...judgementOf(job, evidence, { now: new Date(NOW), timezone: TZ }, THRESHOLDS),
      schedule: evidence.schedulesByJob.get('j1'),
      setAside: evidence.machineFailuresByJob.get('j1') ?? [],
    },
    failures,
    ...(files ? { files: written } : {}),
    repository: 'ARCHIVE',
    named: machines,
    topic: 'Protection',
  };
};

/** A machine's days, a letter a day: F a Full, i an increment, X a failure, · retention's, _ nothing. */
const drawn = (report, name) =>
  report.calendar.rows.find((row) => row.name === name).cells.map((cell) => ({ full: 'F', increment: 'i', failed: 'X', retired: '·', none: '_' })[cell]).join('');
const tiles = (report) => report.tiles.map(({ label, value, note }) => [label, value, note]);

const EXCHANGE = ['ex-mbx-01', 'ex-mbx-03', 'ex-edge-01'];
/** OPS_Exchange on 22 October: a Full on Saturdays, and none on the 17th; ex-mbx-03 failed twice on its snapshot, ex-edge-01 once. */
const exchangeNights = (over = {}) => nightsOf({
  machines: EXCHANGE,
  first: '2026-10-03',
  last: '2026-10-21',
  fulls: ['2026-10-03', '2026-10-10'],
  failed: { '2026-10-19': { 'ex-mbx-03': SNAPSHOT }, '2026-10-20': { 'ex-mbx-03': SNAPSHOT } },
  setAside: { '2026-10-14': ['ex-edge-01'] },
  ...over,
});

test('the Points report says of a job what 🛡 says, in its words, and the five numbers under it', () => {
  const report = pointsReportOf(exchangeNights(), TZ);

  assert.equal(report.drawn, true);
  assert.deepEqual([report.status, report.word], ['warn', 'Внимание']);
  assert.deepEqual(report.verdict, { icon: '🟡', problem: 'пропущен Full 17.10', facts: ['бэкапы идут', 'последний Full 10.10'] });
  assert.deepEqual(report.facts, ['Репозиторий ARCHIVE', '3 машины', 'Ежедневно в 22:00, Active Full по сб', 'Хранение 14 точек']);
  assert.deepEqual(tiles(report).slice(0, 4), [
    ['Последняя точка', '21.10 22:05', 'у всех 3 машин'],
    // Nineteen moments each machine can be rolled back to, the nights a failed run left of it not among them.
    ['Можно откатиться', '19 точек', 'до 03.10 22:05'],
    ['Текущая цепочка', 'Full 10.10 + 11', 'инкрементов'],
    ['Следующий Full', 'сб 24.10, 22:00', 'Full 17.10 пропущен'],
  ]);
  assert.equal(report.tiles[3].alarm, true);
  assert.deepEqual(tiles(report)[4], ['На диске', '336 ГБ', 'данных 940 ГБ']);
  assert.deepEqual([report.newest, report.depth], [local('2026-10-21T22:05:00'), { points: 19, oldest: local('2026-10-03T22:05:00') }]);
});

test('each machine\'s days are drawn: a Full, an increment, its own failure, retention\'s days and today\'s', () => {
  const report = pointsReportOf(exchangeNights(), TZ);
  const { days, rows } = report.calendar;

  assert.equal(days.length, 35);
  assert.deepEqual([days[0].day, days[34].day], [Date.UTC(2026, 8, 18), Date.UTC(2026, 9, 22)]);
  // Saturdays owe a Full; the 17th went without one.
  assert.deepEqual(days.flatMap((day, at) => (day.fullDay ? [at] : [])), [1, 8, 15, 22, 29]);
  assert.deepEqual(days.flatMap((day, at) => (day.missed ? [at] : [])), [29]);
  assert.deepEqual(rows.map((row) => [row.name, row.points]), [['ex-mbx-01', 19], ['ex-mbx-03', 17], ['ex-edge-01', 18]]);

  // Before the oldest point retention kept, and today, whose run has not written yet.
  const before = '·'.repeat(15);
  assert.equal(drawn(report, 'ex-mbx-01'), `${before}Fiiiiii${'F'}${'i'.repeat(11)}_`);
  // Red where Veeam said the machine failed, not where the run did: the run of the 19th failed for every machine.
  assert.equal(drawn(report, 'ex-mbx-03'), `${before}FiiiiiiF${'i'.repeat(8)}XXi_`);
  // A point the scan set aside is the machine's failure too, said or not.
  assert.equal(drawn(report, 'ex-edge-01'), `${before}FiiiiiiFiiiXiiiiiii_`);
});

test('the machines\' errors are grouped by what Veeam said, the newest first, and a night nothing was said of is said so', () => {
  const report = pointsReportOf(exchangeNights({
    silent: { '2026-10-21': ['ex-edge-01'] },
  }), TZ);

  assert.deepEqual(report.errors, [
    // The job ran on the 21st and ex-edge-01 got neither a point nor a failure.
    { machines: ['ex-edge-01'], days: [Date.UTC(2026, 9, 21)], failed: false },
    { machines: ['ex-mbx-03'], days: [Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 20)], reason: SNAPSHOT, failed: true },
    { machines: ['ex-edge-01'], days: [Date.UTC(2026, 9, 14)], failed: true },
  ]);
});

test('what to do follows from what was found: a missed Full first, then a machine saved again, then retention', () => {
  const report = pointsReportOf(exchangeNights(), TZ);

  assert.deepEqual(report.steps, [
    {
      title: 'Запустить Active Full вручную',
      detail: 'Full 17.10 не было: восстановление последней точки читает 12 файлов. По расписанию следующий — сб 24.10, 22:00.',
      important: true,
    },
    // Failed in the last week, and saved since: worth a look, not urgent. ex-edge-01's failure is older.
    { title: 'Посмотреть ex-mbx-03', detail: 'Запуски 19.10, 20.10 упали; 21.10 она снова сохранена.', important: false },
    // Fourteen kept, nineteen held: the chain of the 3rd goes whole, once the one after it holds fourteen.
    { title: 'Хранение держит 19 точек вместо 14', detail: 'Veeam удаляет цепочку только целиком: цепочка 03.10 уйдёт около 23.10.', important: false },
  ]);
  assert.deepEqual(report.chains.spans.map(({ full, from, to, increments, data, disk, current, leaves }) => [full, from, to, increments, data / GB, disk / GB, current, leaves]), [
    [Date.UTC(2026, 9, 3), 15, 22, 6, 420, 148, false, Date.UTC(2026, 9, 23)],
    [Date.UTC(2026, 9, 10), 22, 35, 11, 520, 188, true, undefined],
  ]);
  assert.deepEqual([report.chains.retired, report.chains.missed], [15, [29]]);
  assert.deepEqual(report.chains.increment, { data: 20 * GB, disk: 8 * GB });
});

test('a job in order says so, and that nothing needs doing but what is worth knowing', () => {
  const report = pointsReportOf(exchangeNights({ fulls: ['2026-10-03', '2026-10-10', '2026-10-17'], failed: {}, setAside: {}, retention: 21 }), TZ);

  assert.deepEqual([report.status, report.word], ['ok', 'Норма']);
  assert.deepEqual(report.verdict, { icon: '🟢', problem: 'в порядке', facts: ['Full вовремя'] });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.steps, [], 'twenty-one kept and nineteen held: nothing to say of retention either');
  assert.deepEqual(tiles(report)[3], ['Следующий Full', 'сб 24.10, 22:00', 'по расписанию']);
  assert.deepEqual(report.next, { day: Date.UTC(2026, 9, 24), weekday: 'сб', time: '22:00' });
});

test('a job in trouble trades the chain and the next Full for its last Full and its failing machines, and says what to do about them', () => {
  // Nothing saved since the 13th: two machines fail on their snapshot, the third gets nothing and nothing is said.
  const failing = {};
  const silent = {};
  for (let day = '2026-10-14'; day <= '2026-10-21'; day = dayAfter(day)) {
    failing[day] = { 'ex-mbx-01': SNAPSHOT, 'ex-mbx-03': SNAPSHOT };
    silent[day] = ['ex-edge-01'];
  }
  const report = pointsReportOf(exchangeNights({ failed: failing, setAside: {}, silent, job: { lastResult: 'Failed' } }), TZ);

  assert.deepEqual([report.status, report.word], ['crit', 'Критично']);
  assert.equal(report.verdict.problem, 'нет бэкапа 8 дней');
  assert.deepEqual(tiles(report).slice(0, 4), [
    ['Последняя точка', '13.10 22:05', '8 дней назад'],
    ['Можно откатиться', '11 точек', 'до 03.10 22:05'],
    ['Последний Full', '10.10', 'Full не было 11 дней'],
    ['Машины с ошибками', '2 из 3', 'последние запуски упали'],
  ]);
  assert.deepEqual(report.steps.map(({ title, important }) => [title, important]), [
    ['Разобрать ошибку на 2 машинах', true],
    ['Проверить ex-edge-01', true],
    ['Запустить Active Full вручную', true],
  ]);
  // The first sentence of what Veeam said, and the days.
  assert.equal(report.steps[0].detail, '«Failed to create VM snapshot.» повторяется 14.10–21.10, 8 дней.');
  assert.equal(report.steps[1].detail, 'С 14.10 у неё нет точек, хотя задание шло, а ошибки Veeam не записал.');
  assert.equal(drawn(report, 'ex-edge-01').slice(-9), '________' + '_', 'nothing said is no failure');

  // No machine says why, so the job's own trouble is what to look into.
  const quiet = pointsReportOf(exchangeNights({ last: '2026-10-13', failed: {}, setAside: {}, job: { lastResult: 'Failed' } }), TZ);
  assert.deepEqual(quiet.steps[0], {
    title: 'Выяснить, почему нет новых точек',
    detail: 'Последний 13.10 в 22:05 · обычно раз в сутки · пропущено 7 запусков · не сделан Full 17.10.',
    important: true,
  });
});

test('with no Evidence yet, or points the scan does not read, there is nothing to draw and the report says why', () => {
  const reading = exchangeNights();
  const pending = pointsReportOf({ ...reading, evidence: { status: 'pending', reason: 'Точки восстановления ещё не прочитаны.' } }, TZ);
  assert.deepEqual(pending, { drawn: false, at: NOW, server: 'BAAS', name: 'OPS_Exchange', why: 'Точки восстановления ещё не прочитаны.' });

  // A replica is judged by its runs, as 🛡 judges it.
  const verdict = verdictOf({ id: 'j1', name: 'R', runs: [], byRuns: true, cadenceDays: null, failures: 0 }, { now: new Date(NOW), timezone: TZ }, THRESHOLDS);
  const replica = pointsReportOf({ ...reading, evidence: { ...reading.evidence, byRuns: true, verdict, points: undefined } }, TZ);
  assert.equal(replica.drawn, false);
  assert.equal(replica.verdict.problem, 'нет успешных запусков');
  assert.equal(replica.why, ELSEWHERE);

  // A job switched off is drawn, and not judged.
  const { verdict: _, ...judged } = reading.evidence;
  const off = pointsReportOf({ ...reading, evidence: { ...judged, excused: 'disabled' } }, TZ);
  assert.deepEqual([off.status, off.word, off.verdict.problem, off.steps], ['unknown', 'Выключено в Veeam', 'новых точек от него не ждут', []]);
});

test('the page is the one drawn: the head, the five numbers, the days a machine to a row and the three cards, with nothing fetched and no emoji', () => {
  const reading = exchangeNights({ job: { name: 'OPS_<b>Exchange</b>' } });
  const html = pointsReportPage(pointsReportOf(reading, TZ), TZ);

  assert.equal(html.match(/<section class="page">/g).length, 1);
  // The envelope: Inter inside it, and a rule that nothing is fetched.
  assert.match(html, /@font-face[^}]+url\(data:font\/woff2;base64,/);
  assert.match(html, /content="default-src 'none';/);
  assert.match(html, /font-family: 'Inter Variable'/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u, 'the server\'s browser may have no font for emoji');
  assert.match(html, /<h1 class="job">OPS_&lt;b&gt;Exchange&lt;\/b&gt;<\/h1>/);
  assert.doesNotMatch(html, /OPS_<b>Exchange/);
  assert.match(html, />Внимание<\/span>/);
  assert.match(html, /<div class="verdict">Пропущен Full 17\.10 — бэкапы идут · последний Full 10\.10\.<\/div>/);
  // «сб 24.10, 22:00» is drawn smaller than «19 точек», and stays on its line.
  assert.match(html, /<div class="tl-v m">сб 24\.10, 22:00<\/div><div class="tl-s bad">Full 17\.10 пропущен<\/div>/);
  assert.match(html, /<h2>Точки по дням, 18\.09–22\.10<\/h2>/);
  assert.match(html, /<span class="hd we fd miss">17<\/span>/);
  assert.match(html, /<span class="lg"><span class="sw c i mf"><\/span>Full не выполнен<\/span>/);
  assert.match(html, /<span class="nm">ex-mbx-03<\/span>(?:<i class="c [^"]+"><\/i>){35}<span class="cnt bad">17<\/span>/);
  assert.match(html, /<i class="c x"><\/i><i class="c x"><\/i><i class="c i"><\/i><i class="c e"><\/i><span class="cnt bad">17/);
  assert.match(html, /<h3>Ошибки машин<\/h3><p class="err"><span class="who"><b>ex-mbx-03<\/b> · 19\.10, 20\.10<\/span><span class="errt">Failed to create VM snapshot\./);
  assert.match(html, /<b>1\. Запустить Active Full вручную<\/b><span class="ad">Full 17\.10 не было: восстановление последней точки читает 12 файлов\.<span class="imp">Важно<\/span>/);
  assert.match(html, /<b>2\. Посмотреть ex-mbx-03<\/b><span class="ad">[^<]+<span class="note">К сведению<\/span>/);
  assert.match(html, /Full 03\.10, уйдёт ~23\.10/);
  assert.match(html, /<tr><td>Full 10\.10 \(текущая\)<\/td><td class="n">11<\/td><td class="n">520 ГБ<\/td><td class="n">188 ГБ<\/td><\/tr>/);
  assert.match(html, /Точки — как их видит тема Protection, чтение 22\.10 09:40/);

  const calm = pointsReportPage(pointsReportOf(exchangeNights({ fulls: ['2026-10-03', '2026-10-10', '2026-10-17'], failed: {}, setAside: {}, retention: 21 }), TZ), TZ);
  assert.match(calm, /<b>Ничего делать не нужно\.<\/b><\/p><p class="act calm">Следующий Full — сб 24\.10 в 22:00, по расписанию\.<\/p>/);
  assert.match(calm, /<p class="err">Ошибок за 35 дней нет\.<\/p>/);
  assert.doesNotMatch(calm, /Full не выполнен/, 'no missed Full, nothing in the legend for one');
});

test('a job of many machines goes on over further pages, the days\' header on each, and its errors and steps hold what fits', () => {
  const machines = Array.from({ length: 60 }, (_, at) => `farm-app-${String(at + 1).padStart(2, '0')}`);
  const failing = {};
  for (let day = '2026-10-14'; day <= '2026-10-21'; day = dayAfter(day)) {
    failing[day] = Object.fromEntries(machines.slice(0, 30).map((machine, at) => [machine, at < 20 ? SNAPSHOT : 'The method is disabled by \'vShield_SVM\'']));
  }
  const report = pointsReportOf(nightsOf({ machines, first: '2026-10-03', last: '2026-10-21', fulls: ['2026-10-03', '2026-10-10'], failed: failing, silent: Object.fromEntries(Object.keys(failing).map((day) => [day, machines.slice(30, 40)])) }), TZ);
  const html = pointsReportPage(report, TZ);

  const pages = html.split('<section class="page">').slice(1);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => (page.match(/<span class="nm">/g) ?? []).length), [8, 26, 26]);
  for (const [at, page] of pages.entries()) {
    assert.match(page, /<span class="hd" style="text-align:left">Машина<\/span>/, `page ${at + 1} has the days' header`);
    assert.match(page, new RegExp(`стр\\. ${at + 1} из 3`));
  }
  assert.match(pages[1], /Точки по дням, 18\.09–22\.10 · продолжение/);
  assert.match(pages[1], /Машины 9–34 из 60/);
  assert.match(pages[2], /<span class="nm">farm-app-60<\/span>/);
  // Three groups of errors, two of them shown; three steps.
  assert.equal(report.errors.length, 3);
  assert.equal((pages[0].match(/<p class="err">/g) ?? []).length, 2);
  assert.match(pages[0], /<span class="more">и ещё 1 — в сетке<\/span>/);
  assert.equal((pages[0].match(/<p class="act">/g) ?? []).length, 3);
});

test('a backup file is put in the run whose points it holds, and a Full still being written is said as such', () => {
  const { sizesOf } = require('../dist/estate/points-sizes');
  const runs = [
    { at: local('2026-09-19T23:32:00'), full: true, pointIds: ['vcd3', 'vcd5'], machines: ['vcd3', 'vcd5'] },
    { at: local('2026-09-29T23:32:00'), full: false, pointIds: ['vcd3-29'], machines: ['vcd3'] },
    { at: local('2026-09-30T23:32:00'), full: false, pointIds: ['vcd3-30'], machines: ['vcd3'] },
    { at: local('2026-09-30T23:50:00'), full: true, pointIds: ['writing'], machines: ['vcd5'] },
  ];
  const sizes = sizesOf([
    // Per-machine files: two of them make the Full.
    { name: 'vcd3.vbk', restorePointIds: ['vcd3'], dataSize: 428 * GB, backupSize: 257 * GB },
    { name: 'vcd5.vbk', restorePointIds: ['vcd5'], dataSize: 428 * GB, backupSize: 257 * GB },
    { name: 'vcd3.vib', restorePointIds: ['vcd3-29'], dataSize: 312.5 * GB, backupSize: 103.4 * GB },
    { name: 'vcd3.vib', restorePointIds: ['vcd3-30'], dataSize: 110.9 * GB, backupSize: 47.8 * GB },
    { name: 'next.vbk', restorePointIds: ['writing'], dataSize: 0, backupSize: 0 },
    // Written since the scan: it takes up space, and is no run's yet.
    { name: 'late.vib', restorePointIds: ['unknown'], dataSize: 30 * GB, backupSize: 10 * GB },
  ], runs);

  assert.deepEqual(sizes.full, { at: runs[0].at, data: 856 * GB, disk: 514 * GB });
  assert.equal(sizes.fullWriting, runs[3].at);
  assert.equal(sizes.increment.runs, 2);

  // CUST_ERP_ISMR: about 100 GB a night, and 1.3 TB the night after its Full.
  const nights = [100, 110, 1300].map((gb, n) => ({ at: local(`2026-09-2${n}T00:05:00`), full: false, pointIds: [`n${n}`], machines: ['erp'] }));
  const typical = sizesOf(nights.map((night, n) => ({ restorePointIds: night.pointIds, dataSize: [100, 110, 1300][n] * GB, backupSize: GB })), nights);
  assert.equal(typical.increment.data, 110 * GB, 'one heavy night does not make every night look like it');

  assert.equal(sizesOf([], runs), undefined, 'no files, nothing to say');
  const unmatched = sizesOf([{ restorePointIds: ['x'], dataSize: GB, backupSize: GB }], runs);
  assert.deepEqual(unmatched, { onDisk: GB }, 'a Full with no file found is not one being written');
});

test('sizes are written as the Veeam console writes them, in binary units', () => {
  const { sizeWords } = require('../dist/telegram/words');
  assert.deepEqual(
    [1.5 * GB, 0.9 * GB, 40 * GB, 75.6 * GB, 856 * GB, 15900 * GB].map(sizeWords),
    ['1.5 ГБ', '922 МБ', '40 ГБ', '75.6 ГБ', '856 ГБ', '15.5 ТБ'],
  );
});

test('a job\'s points are read when asked: its backup files once, the machines of its failed attempts, and never by the scan', async () => {
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const asked = [];
  let refused = false;
  const routes = {
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': { data: [{ id: 'b1', jobId: '1', name: 'OPS_vCloud_edge' }] },
    '/api/v1/restorePoints': {
      data: [
        { id: 'i', backupId: 'b1', sessionId: 's2', name: 'vcd3', type: 'Increment', creationTime: ago(1) },
        { id: 'f', backupId: 'b1', sessionId: 's1', name: 'vcd3', type: 'Full', creationTime: ago(2) },
      ],
    },
    // Yesterday's attempt, before its point: vcd4 failed in it, and the scan has no point of it to ask about.
    '/api/v1/sessions': { data: [{ id: 's3', jobId: '1', sessionType: 'BackupJob', creationTime: ago(1.01), endTime: ago(1.005), result: { result: 'Failed' } }] },
    '/api/v1/sessions/s3/taskSessions': { data: [
      { name: 'vcd4', result: { result: 'Failed', message: 'Processing vcd4 Error: Failed to create VM snapshot.\nLogon attempt with parameters [VC/ESX: [vc01];Login: [svc@example.com]]' } },
    ] },
    '/api/v1/jobs/1': { id: '1', storage: { backupRepositoryId: 'r1' }, virtualMachines: { includes: [{ type: 'VirtualMachine', name: 'vcd3' }, { type: 'VirtualMachine', name: 'vcd4' }] } },
    '/api/v1/backupInfrastructure/repositories': { data: [{ id: 'r1', name: 'ARCHIVE' }] },
    '/api/v1/backupInfrastructure/proxies': { data: [] },
    '/api/v1/backups/b1/backupFiles': (req) => {
      asked.push(req.path);
      if (refused) throw new Error('HTTP 403 Forbidden');
      return {
        data: [
          { name: 'vcd3.vbk', restorePointIds: ['f'], dataSize: 856 * GB, backupSize: 514 * GB },
          { name: 'vcd3.vib', restorePointIds: ['i'], dataSize: 150 * GB, backupSize: 40 * GB },
        ],
      };
    },
  };
  const w = answersWorld({}, [job('1', 'OPS_vCloud_edge', 'Success')], routes);
  await scanned(w);
  assert.equal(asked.length, 0, 'the scan never reads files; only a question does');

  const said = await w.answers.describePoints('edge');
  assert.equal(said.text, '⏳ <b>Готовлю PDF по точкам OPS_vCloud_edge</b> — несколько секунд.');
  assert.equal(asked.length, 0, 'nothing is read before it is said to be coming');
  const file = await said.later();
  assert.equal(asked.length, 1);
  assert.deepEqual([file.jobId, file.about, file.server], ['1', 'points', SERVER]);
  const [page] = w.printer.pages;
  assert.match(page, /<div class="tl-v">554 ГБ<\/div><div class="tl-s">данных 1,0 ТБ<\/div>/);
  // The job names a machine no point holds: it has a row, red where its attempt said it failed, and what Veeam said —
  // without the service account Veeam wrote after it.
  assert.match(page, /Репозиторий ARCHIVE · 2 машины/);
  assert.match(page, /<span class="nm">vcd4<\/span>(?:<i class="c r"><\/i>){32}(?:<i class="c [ex]"><\/i>){3}<span class="cnt bad">0<\/span>/);
  assert.match(page, /<span class="who"><b>vcd4<\/b> · \d\d\.\d\d<\/span><span class="errt">Failed to create VM snapshot\.<\/span>/);
  assert.doesNotMatch(page, /svc@example\.com|Logon attempt/);

  refused = true;
  await (await w.answers.describePoints('edge')).later();
  assert.match(w.printer.pages[1], /<div class="tl-v">—<\/div><div class="tl-s">файлы не прочитаны<\/div>/, 'the report, without sizes');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SERVER, world, veeamFake, job, exchange, configuredJob, kingstonNight, monitorAccount, serverOf, jobReadsOf,
  answersOf, answersWorld, idleAnswers, EstateAnswers,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Answers about a server, apart from the cycle
 *
 * Which server a question is about, and what is said about it, used to be
 * nine members of the monitor, each the same pass-through to a server's
 * estate: a test of one command built the whole monitor and ran its cycle
 * first. Asked here of the answers alone, over server estates with no cycle.
 * ------------------------------------------------------------------ */

const TWO = { VEEAM_SERVERS: 'AST=https://ast.example:9419,BAAS=https://baas.example:9419' };

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
 * /points: one job's restore points, by the verdict 🛡 lists it by
 * ------------------------------------------------------------------ */

const POINTS_NOW = { now: new Date('2026-10-01T10:23:00+05:00'), timezone: 'Asia/Qyzylorda' };
const local = (iso) => Date.parse(`${iso}+05:00`);

/** OPS_TelegramBot on 1 October: Active Full on Saturdays, the last one on 5 September. */
const telegramBot = (over = {}) => ({
  runs: 17, points: 17, machines: 1, intervalDays: 1,
  oldest: local('2026-09-05T21:43:00'), newest: local('2026-09-30T21:43:00'),
  chain: { fulls: 1, lastFull: local('2026-09-05T21:43:00'), sinceFull: 16 },
  retention: { quantity: 7, unit: 'days' },
  fulls: [{ kind: 'active', weekdays: [6] }],
  ...over,
});

/** 🛡's thresholds as configured by default. */
const POINTS_RULE = { staleDays: 3, overdueFactor: 2.5, minStreak: 3 };

/** A /points card as the answer builds it: the job's points, and the verdict 🛡 gives it. */
const pointsCard = (card) => {
  const { verdictOf } = require('../dist/estate/job-standing');
  const { points, failures = 0 } = card;
  // The Standing /points gathers, from points given as the Evidence holds them.
  const standing = {
    id: '1',
    name: card.name,
    lastRun: card.lastRun,
    runs: points?.newest === undefined ? [] : [points.newest],
    byRuns: Boolean(card.elsewhere),
    cadenceDays: points?.intervalDays ?? null,
    failures,
    depth: points,
    retention: points?.retention,
    fulls: points?.fulls,
  };
  const verdict = card.excused || card.unavailable ? undefined : verdictOf(standing, POINTS_NOW, POINTS_RULE);
  return require('../dist/estate/points-card').renderPointsCard({ ...card, verdict }, POINTS_NOW);
};

test('/points says where one job stands, how far back it reaches and the Fulls it went without', () => {
  const text = pointsCard({ name: 'OPS_TelegramBot', points: telegramBot() });

  assert.match(text, /^🗂 <b>OPS_TelegramBot<\/b> · точки восстановления$/mu);
  assert.match(text, /^🟡 <b>Пропущены Full 12\.09, 19\.09, 26\.09<\/b>\n<i>бэкапы идут · последний Full 05\.09<\/i>$/mu);
  assert.match(text, /^<b>Точек на ВМ:<\/b> 17 · <b>ВМ:<\/b> 1 · <b>в Veeam всего:<\/b> 17$/mu);
  assert.match(text, /^<b>Самая ранняя:<\/b> 05\.09 в 21:43$/mu);
  assert.match(text, /^<b>Самая новая:<\/b> вчера в 21:43$/mu);
  assert.match(text, /^<b>Цепочка:<\/b> Full 05\.09 \+ 16 инкр\.$/mu);
  assert.match(text, /^<b>Full по расписанию:<\/b> Active Full по сб$/mu);
  assert.match(text, /^<b>Хранение:<\/b> 7 дней$/mu);
  assert.match(text, /^<b>Ритм:<\/b> раз в сутки$/mu);
});

test('/points opens with what 🛡 says of the job, in the words 🛡 says it', () => {
  const late = pointsCard({ name: 'J', points: telegramBot({ newest: local('2026-09-27T21:43:00') }) });
  assert.match(
    late,
    /^🟠 <b>Нет бэкапа 3 дня<\/b>\n<i>последний 27\.09 в 21:43 · обычно раз в сутки · пропущено 2 запуска · не сделан Full 12\.09, 19\.09, 26\.09<\/i>$/mu,
  );

  const failing = pointsCard({ name: 'J', failures: 4, points: telegramBot({ fulls: undefined }) });
  assert.match(failing, /^🟠 <b>4 неудачных запуска подряд<\/b>\n<i>последний бэкап вчера в 21:43 · обычно раз в сутки<\/i>$/mu);

  const onTime = pointsCard({
    name: 'J',
    points: telegramBot({ chain: { fulls: 2, lastFull: local('2026-09-26T22:00:00'), sinceFull: 4 } }),
  });
  assert.match(onTime, /^🟢 <b>В порядке<\/b>\n<i>Full вовремя<\/i>$/mu);
  assert.match(onTime, /^<b>Цепочка:<\/b> Full 26\.09 \+ 4 инкр\. · цепочек в хранении: 2$/mu);

  const fresh = pointsCard({ name: 'J', points: telegramBot({ intervalDays: null, fulls: undefined }) });
  assert.match(fresh, /^🟢 <b>В порядке<\/b>\n<i>ритм ещё не ясен<\/i>$/mu);
  assert.ok(!/Full по расписанию/u.test(fresh), 'nothing said about Fulls nobody configured');
});

test('/points calls a nightly job two days without a point fine, as 🛡 does, and says the run it skipped', () => {
  // 🗂's verdict, which /points kept after 🗂 became part of 🛡, called this
  // job behind; 🛡 counted it among the fine ones.
  const text = pointsCard({
    name: 'J',
    points: telegramBot({
      newest: local('2026-09-29T08:00:00'),
      chain: { fulls: 2, lastFull: local('2026-09-26T22:00:00'), sinceFull: 3 },
    }),
  });
  assert.match(text, /^🟢 <b>В порядке<\/b>\n<i>пропущен 1 запуск · Full вовремя<\/i>$/mu);
  assert.ok(!/Отстаёт/u.test(text), text);
});

test('/points does not judge a job nobody expects points from, and says why there are none', () => {
  const off = pointsCard({ name: 'J', excused: 'disabled', points: telegramBot() });
  assert.match(off, /^⚪ <b>Выключено в Veeam<\/b>/mu);
  assert.ok(!/В порядке|Нет бэкапа|Пропущен/u.test(off), off);
  assert.match(off, /<b>Точек на ВМ:<\/b> 17/u, 'what it kept is still shown');

  assert.match(pointsCard({ name: 'J' }), /^🔴 <b>Нет ни одной точки<\/b>$/mu);
  const replica = pointsCard({ name: 'J', elsewhere: true });
  assert.match(replica, /^🔴 <b>Нет успешных запусков<\/b>$/mu, 'judged by its runs, as 🛡 judges it');
  assert.match(replica, /хранит отдельно/u);
  assert.match(pointsCard({ name: 'J', unavailable: 'Точки ещё не прочитаны.' }), /Точки ещё не прочитаны\./u);
});

test('/points draws the last weeks a day to a mark, in the operator\'s zone', () => {
  // OPS_vCloud_edge on 1 October: a Full on Saturday 19 September, then
  // nothing for nine nights, then increments. The run at 02:00 on the 30th is
  // the 29th in UTC, and the calendar is the operator's.
  const retained = [
    { at: local('2026-09-19T23:58:00'), full: true, pointIds: [] },
    { at: local('2026-09-29T23:35:00'), full: false, pointIds: [] },
    { at: local('2026-09-30T02:00:00'), full: false, pointIds: [] },
  ];
  const text = pointsCard({ name: 'OPS_vCloud_edge', points: telegramBot({ retained }) });

  const calendar = [
    '      пн вт ср чт пт сб вс',
    '14.09                 █  ·',
    '21.09  ·  ·  ·  ·  ·  ·  ·',
    '28.09  ·  ▒  ▒  ○',
  ];
  assert.ok(text.includes(`<pre>${calendar.join('\n')}</pre>`), text);
  assert.match(text, /^<i>█ Full {2}▒ инкремент {2}· нет точки {2}○ сегодня ещё нет<\/i>$/mu);

  // A server that does not type its points draws points, not Fulls.
  const untyped = pointsCard({ name: 'J', points: telegramBot({ retained: retained.map(({ at }) => ({ at, pointIds: [] })) }) });
  assert.match(untyped, /<i>▒ точка {2}· нет точки/u);
  assert.ok(!/█/u.test(untyped));

  assert.ok(!/<pre>/u.test(pointsCard({ name: 'J', points: telegramBot() })), 'nothing drawn without the runs');
});

test('a backup file is put in the run whose points it holds, and a Full still being written is said as such', () => {
  const { sizesOf } = require('../dist/estate/points-sizes');
  const GB = 2 ** 30;
  const runs = [
    { at: local('2026-09-19T23:32:00'), full: true, pointIds: ['vcd3', 'vcd5'] },
    { at: local('2026-09-29T23:32:00'), full: false, pointIds: ['vcd3-29'] },
    { at: local('2026-09-30T23:32:00'), full: false, pointIds: ['vcd3-30'] },
    { at: local('2026-09-30T23:50:00'), full: true, pointIds: ['writing'] },
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

  const text = pointsCard({ name: 'OPS_vCloud_edge', points: telegramBot(), sizes });
  assert.match(text, /^<b>Full 19\.09:<\/b> 856 ГБ данных → 514 ГБ на диске · новый Full с 30\.09 ещё пишется$/mu);
  assert.match(text, /^<b>Инкремент:<\/b> обычно 212 ГБ данных \(≈25% от Full\) → 75\.6 ГБ на диске$/mu);
  assert.match(text, /^<b>На диске всего:<\/b> 675 ГБ$/mu);

  // CUST_ERP_ISMR: about 100 GB a night, and 1.3 TB the night after its Full.
  const nights = [100, 110, 1300].map((gb, n) => ({ at: local(`2026-09-2${n}T00:05:00`), full: false, pointIds: [`n${n}`] }));
  const typical = sizesOf(nights.map((night, n) => ({ restorePointIds: night.pointIds, dataSize: [100, 110, 1300][n] * GB, backupSize: GB })), nights);
  assert.equal(typical.increment.data, 110 * GB, 'one heavy night does not make every night look like it');

  assert.equal(sizesOf([], runs), undefined, 'no files, nothing to say');
  const unmatched = sizesOf([{ restorePointIds: ['x'], dataSize: GB, backupSize: GB }], runs);
  assert.deepEqual(unmatched, { onDisk: GB }, 'a Full with no file found is not one being written');
});

test('sizes are written as the Veeam console writes them, in binary units', () => {
  const { sizeWords } = require('../dist/telegram/words');
  const GB = 2 ** 30;
  assert.deepEqual(
    [1.5 * GB, 0.9 * GB, 40 * GB, 75.6 * GB, 856 * GB, 15900 * GB].map(sizeWords),
    ['1.5 ГБ', '922 МБ', '40 ГБ', '75.6 ГБ', '856 ГБ', '15.5 ТБ'],
  );
});

test('/points reads the job\'s backup files when asked, and answers without them when Veeam will not give them', async () => {
  const GB = 2 ** 30;
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  let filesAsked = 0;
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
    '/api/v1/sessions': { data: [] },
    '/api/v1/backups/b1/backupFiles': () => {
      filesAsked += 1;
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
  assert.equal(filesAsked, 0, 'the scan never reads files; only a question does');

  const text = (await w.answers.describePoints('edge')).text;
  assert.equal(filesAsked, 1);
  assert.match(text, /<pre> {6}пн вт ср чт пт сб вс\n/u);
  assert.match(text, /<b>Full \d\d\.\d\d:<\/b> 856 ГБ данных → 514 ГБ на диске/u);
  assert.match(text, /<b>Инкремент:<\/b> обычно 150 ГБ данных \(≈18% от Full\) → 40 ГБ на диске/u);
  assert.match(text, /<b>На диске всего:<\/b> 554 ГБ/u);

  refused = true;
  const without = (await w.answers.describePoints('edge')).text;
  assert.match(without, /🗂 <b>OPS_vCloud_edge<\/b> · точки восстановления/u);
  assert.ok(!/На диске всего/u.test(without), 'the card, without sizes');
});

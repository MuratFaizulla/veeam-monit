const { test } = require('node:test');
const assert = require('node:assert/strict');

const { estatesOf } = require('./world.cjs');
const { calendarOf, isOutlier } = require('../dist/estate/calendar-reports');
const { calendarReportPage } = require('../dist/estate/calendar-report-page');
const { EstateAnswers } = require('../dist/estate/estate-answers');

/* ------------------------------------------------------------------ *
 * The Calendar report: one server's month
 * ------------------------------------------------------------------ */

const TZ = 'Asia/Qyzylorda'; // +05:00, no summer time
const AT = Date.parse('2026-11-18T11:00:00Z'); // 16:00 on Wednesday 18.11, local
const MINUTE = 60_000;

/** A nightly job at 21:00 with a Synthetic Full on Saturdays, as Veeam configures one. */
const nightly = (id, over = {}) => ({
  id,
  schedule: { runAutomatically: true, daily: { isEnabled: true, dailyKind: 'Everyday', localTime: '21:00' }, ...over.schedule },
  storage: {
    backupRepositoryId: 'r1',
    retentionPolicy: { type: 'RestorePoints', quantity: 14 },
    advancedSettings: { synthenticFulls: { isEnabled: true, weekly: { isEnabled: true, days: ['Saturday'] } } },
  },
});

/** A run of job `jobId` that started on November `day` at `time`, local, and went `minutes`. */
const run = (jobId, day, minutes, result = 'success', time = '21:00') => {
  const start = Date.parse(`2026-11-${String(day).padStart(2, '0')}T${time}:00+05:00`);
  return { jobId, startedAt: new Date(start).toISOString(), endedAt: new Date(start + minutes * MINUTE).toISOString(), result };
};

const reading = (over = {}) => {
  // Every night of the month so far but the 15th; the 9th and 10th failed;
  // the 5th waited until 23:50 and went on until 07:30; the 12th hung for fifteen hours.
  const attempts = [];
  for (let day = 1; day <= 17; day++) {
    if (day === 15) continue;
    const minutes = day === 5 ? 460 : day === 12 ? 900 : day === 7 || day === 14 ? 300 : 120 + day;
    attempts.push(run('j1', day, minutes, day === 9 || day === 10 ? 'failed' : 'success', day === 5 ? '23:50' : '21:00'));
  }
  return {
    server: 'veeam01',
    at: AT,
    timezone: TZ,
    states: [
      { id: 'j1', name: 'SQL_prod', type: 'Backup', status: 'active', result: 'success', nextRun: '2026-11-18T16:00:00Z' },
      { id: 'j2', name: 'SQL_copy', type: 'BackupCopy', status: 'active', result: 'success' },
      { id: 'j3', name: 'DEV_old', type: 'Backup', status: 'disabled', result: 'none' },
    ],
    configurations: [
      nightly('j1'),
      { id: 'j2', schedule: { runAutomatically: true, afterThisJob: { isEnabled: true, jobName: 'SQL_prod' } } },
      nightly('j3'),
    ],
    repositories: new Map([['r1', 'REPO1']]),
    attempts,
    proxies: [],
    machines: new Map(),
    ...over,
  };
};

test('the calendar plans each day from the schedule, a Full on the days the job owes one', () => {
  const report = calendarOf(reading());
  const [sql, copy, dev] = report.jobs;

  assert.deepEqual([report.year, report.month, report.today], [2026, 10, 18]);
  assert.equal(sql.planned.length, 30);
  assert.equal(sql.planned[0], 'run'); // Sunday the 1st
  assert.equal(sql.planned[6], 'full'); // Saturday the 7th
  assert.equal(sql.start, 21 * 60);
  assert.equal(sql.schedule, 'ежедневно в 21:00');
  assert.equal(sql.repository, 'REPO1');
  assert.equal(sql.retention, '14 точек');
  assert.equal(sql.next, 'сегодня 21:00');

  // A job run after another runs on that one's days; a disabled job on none.
  assert.equal(copy.kind, 'copy');
  assert.equal(copy.after, 'SQL_prod');
  assert.deepEqual(copy.planned.map(Boolean), sql.planned.map(Boolean));
  assert.equal(dev.enabled, false);
  assert.ok(dev.planned.every((plan) => plan === undefined));
});

test('a day the schedule asked for and nothing ran is a missed run; a Full is the first run of a Full day', () => {
  const { jobs: [sql] } = calendarOf(reading());

  const missed = sql.runs.filter((one) => one.result === 'missed');
  assert.deepEqual(missed.map((one) => one.day), [15]);
  // Nothing in the restore points said which runs wrote a Full: the days the job owes one say it.
  assert.deepEqual(sql.runs.filter((one) => one.full).map((one) => one.day), [7, 14]);
  assert.deepEqual(sql.runs.filter((one) => one.result === 'failed').map((one) => one.day), [9, 10]);
});

test('a run that hung is no measure of how long the job goes', () => {
  const { jobs: [sql] } = calendarOf(reading());

  assert.equal(sql.outliers, 1);
  assert.equal(sql.longest, 460, 'the night until 07:30 counts; the fifteen hours do not');
  assert.equal(sql.usualFull, 300);

  assert.equal(isOutlier(900, 130), true);
  assert.equal(isOutlier(60, 10), false, 'a ten-minute job that took an hour was slow, not hung');
  assert.equal(isOutlier(900, undefined), false);
});

test('the cover says what failed nights in a row, what ran past the window and what never ran', () => {
  const report = calendarOf(reading());
  const titles = report.findings.map((finding) => finding.title);

  assert.ok(titles.includes('SQL_prod падало 2 ночи подряд, 9–10 ноября'), titles.join(' | '));
  assert.ok(titles.includes('SQL_prod заканчивается после 07:00'), titles.join(' | '));
  assert.ok(titles.includes('SQL_prod не запускалось по расписанию 1 раз'), titles.join(' | '));
  assert.equal(report.verdict.status, 'crit');
  assert.match(report.findings.find((finding) => /подряд/.test(finding.title)).text, /снова проходит/);
});

test('the Calendar report is printed with every job, its name escaped, and tonight in full when the cover cannot hold it', () => {
  const many = Array.from({ length: 14 }, (_, index) => ({ id: `n${index}`, name: `NIGHT_${index}`, type: 'Backup', status: 'active', result: 'success' }));
  const base = reading();
  const report = calendarOf({
    ...base,
    states: [...base.states, { id: 'x', name: '<b>bold</b>', type: 'Backup', status: 'active', result: 'success' }, ...many],
    configurations: [...base.configurations, nightly('x'), ...many.map(({ id }) => nightly(id))],
  });
  const html = calendarReportPage(report, AT, TZ);

  assert.ok(!html.includes('<b>bold</b>'), 'a job name is text, not markup');
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  for (const part of ['Календарь · Ноябрь 2026', 'Задания по дням', 'Одна ночь по часам', 'Сколько идёт одновременно', 'Расписание каждого задания']) {
    assert.ok(html.includes(part), part);
  }
  // Seventeen jobs start tonight: eleven on the cover, all of them on a page of their own.
  assert.match(html, /и ещё 6 — все запуски ночи на отдельной странице/);
  assert.match(html, /Сегодня ночью <small>1–17 из 17/);
  // The reference keeps every job, the disabled one too.
  assert.equal((html.match(/<td class="nm">/g) ?? []).length >= 18 + 17, true);
});

test('/calendar is about the Selected server, or the one its name points at', () => {
  const servers = [
    { name: 'veeam01ast01', key: 'ast01' },
    { name: 'veeamtonit', key: 'tonit' },
  ];
  const store = { selectedServer: () => 'tonit' };
  const reports = { asked: (estate) => ({ text: `календарь ${estate.name}`, later: async () => ({ text: 'pdf' }) }) };
  const answers = new EstateAnswers(estatesOf(servers), store, undefined, undefined, undefined, reports);

  assert.equal(answers.calendar('').text, 'календарь veeamtonit');
  assert.equal(answers.calendar('AST01').text, 'календарь veeam01ast01');
  assert.equal(answers.calendar('ast').text, 'календарь veeam01ast01', 'part of the name');
  const none = answers.calendar('baas');
  assert.match(none.text, /Сервера «baas» нет/);
  assert.match(none.text, /veeam01ast01, veeamtonit/);
  assert.equal(none.later, undefined);
});

test('how long a job goes is judged by the month shown, the month before only when this one has no runs', () => {
  // A Full on the Saturdays: two days long in October, six hours in November.
  const october = [3, 10, 17, 24, 31].map((day) => {
    const start = Date.parse(`2026-10-${String(day).padStart(2, '0')}T21:00:00+05:00`);
    return { jobId: 'j1', startedAt: new Date(start).toISOString(), endedAt: new Date(start + 3000 * MINUTE).toISOString(), result: 'success' };
  });
  const november = [run('j1', 7, 360), run('j1', 14, 380), run('j1', 16, 30), run('j1', 17, 32)];
  const { jobs: [sql] } = calendarOf(reading({ attempts: [...october, ...november] }));

  assert.equal(sql.usualFull, 360);
  assert.equal(sql.longest, 380);
  assert.equal(sql.usual, 30);

  // A job that has not run this month yet is drawn as it went before.
  const { jobs: [quiet] } = calendarOf(reading({ attempts: october }));
  assert.equal(quiet.usualFull, 3000);
});

test('the jobs\' machines are counted under the vCenter they name, and the proxies with the jobs pinned to them', () => {
  const base = reading();
  const configurations = base.configurations.map((config) =>
    config.id === 'j1'
      ? {
          ...config,
          virtualMachines: { includes: [{ name: 'SQL01', type: 'VirtualMachine', hostName: 'vc01.local' }, { name: 'Prod', type: 'Folder', hostName: 'vc01.local' }] },
          storage: { ...config.storage, backupProxies: { autoSelectEnabled: false, proxyIds: ['p1'] } },
        }
      : config,
  );
  const report = calendarOf({
    ...base,
    configurations,
    proxies: [
      { id: 'p1', name: 'proxy01', server: { transportMode: 'virtualAppliance', maxTaskCount: 8 } },
      { id: 'p2', name: 'proxy02', server: { transportMode: 'network', maxTaskCount: 4 } },
    ],
    machines: new Map([['j1', ['SQL01', 'SQL02', 'APP01']]]),
  });
  const [sql] = report.jobs;

  assert.equal(sql.machines, 3);
  assert.deepEqual(sql.vcenters, ['vc01.local']);
  assert.deepEqual(sql.objects, [{ name: 'SQL01' }, { name: 'Prod', kind: 'папка' }]);
  assert.deepEqual(sql.proxies, ['proxy01']);
  assert.deepEqual(report.infrastructure.vcenters, [{ name: 'vc01.local', jobs: ['SQL_prod'], machines: 3 }]);
  assert.deepEqual(report.infrastructure.proxies, [
    { name: 'proxy01', mode: 'Hot-Add', tasks: 8, pinned: ['SQL_prod'] },
    { name: 'proxy02', mode: 'NBD (сеть)', tasks: 4, pinned: [] },
  ]);
  assert.equal(report.infrastructure.machines, 3);

  const html = calendarReportPage(report, AT, TZ);
  assert.match(html, /Машины, vCenter и прокси/);
  assert.match(html, /vc01\.local <small>3 ВМ · 1 задание/);
  assert.match(html, /Prod <span class="muted">\(папка\)/);
});

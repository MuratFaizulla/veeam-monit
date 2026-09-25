const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, veeamFake, monitorWorld, job, evidenceOf } = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Runs: one rule for which sessions are one run
 *
 * Veeam retries a failed job by starting another session. The alert, the
 * failure streak and the job card each used to fold sessions into runs by
 * their own rule, and the streak's rule — start to start — counted a run whose
 * attempts took longer than the allowance as several runs.
 * ------------------------------------------------------------------ */

const HOUR = 3_600_000;
const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** Three attempts at one run, shaped like the REMS_DBS03 night: a long first
 * attempt, then two retries ten minutes after each previous one ended. */
const oneRetriedRun = (end) => [
  { id: 's3', jobId: '1', sessionType: 'BackupJob', creationTime: iso(end - 1 * MINUTE),
    endTime: iso(end), result: { result: 'Failed', message: 'attempt 3' } },
  { id: 's2', jobId: '1', sessionType: 'BackupJob', creationTime: iso(end - 53 * MINUTE),
    endTime: iso(end - 11 * MINUTE), result: { result: 'Failed', message: 'attempt 2' } },
  { id: 's1', jobId: '1', sessionType: 'BackupJob', creationTime: iso(end - 4 * HOUR - 9 * MINUTE),
    endTime: iso(end - 63 * MINUTE), result: { result: 'Failed', message: 'attempt 1' } },
];

const RETRY_POLICY = { runAutomatically: true, retry: { isEnabled: true, retryCount: 3, awaitMinutes: 10 } };

const evidenceOver = (sessions) => {
  const w = world();
  const veeam = veeamFake({
    '/api/v1/jobs': { data: [{ id: '1', schedule: RETRY_POLICY }] },
    '/api/v1/backups': { data: [] },
    '/api/v1/restorePoints': { data: [] },
    '/api/v1/sessions': { data: sessions },
  });
  return evidenceOf(w, veeam);
};

test('one run that Veeam retried twice is one failed run in the streak, not three', async () => {
  const evidence = evidenceOver(oneRetriedRun(Date.now() - HOUR));
  await evidence.refresh(true, [job('1', 'REMS_DBS03', 'Failed')]);

  assert.equal(evidence.evidence.status, 'ready');
  // The alert for the same night says "3 из 4"; the streak must agree that it
  // was one run. Start to start, the gaps are 52 minutes and over three hours.
  assert.equal(evidence.evidence.streakByJob.get('1'), 1);
});

test('the streak counts separate failed runs back to the last success', async () => {
  const now = Date.now();
  const evidence = evidenceOver([
    ...oneRetriedRun(now - HOUR),
    { id: 'y', jobId: '1', sessionType: 'BackupJob', creationTime: iso(now - 25 * HOUR),
      endTime: iso(now - 24 * HOUR), result: { result: 'Failed' } },
    { id: 'ok', jobId: '1', sessionType: 'BackupJob', creationTime: iso(now - 49 * HOUR),
      endTime: iso(now - 48 * HOUR), result: { result: 'Success' } },
    { id: 'old', jobId: '1', sessionType: 'BackupJob', creationTime: iso(now - 73 * HOUR),
      endTime: iso(now - 72 * HOUR), result: { result: 'Failed' } },
  ]);
  await evidence.refresh(true, [job('1', 'REMS_DBS03', 'Failed')]);

  assert.equal(evidence.evidence.streakByJob.get('1'), 2, 'два неудачных запуска после последнего успешного');
});

/* ------------------------------------------------------------------ *
 * Evidence is read in the cycle that refreshed it
 * ------------------------------------------------------------------ */

test('the first alert after Veeam comes back still knows the retry policy', async () => {
  let down = false;
  let sessions = [];
  const w = monitorWorld({}, [job('1', 'REMS_DBS03', 'Success')], {
    '/api/v1/serverTime': () => {
      if (down) throw new Error('connect ECONNREFUSED');
      return { serverTime: '2026-09-14T11:00:00+05:00' };
    },
    '/api/v1/jobs': { data: [{ id: '1', schedule: RETRY_POLICY }] },
    '/api/v1/sessions': () => ({ data: sessions }),
  });
  await w.monitor.check();

  // One cycle Veeam did not answer. The evidence of that cycle is pending —
  // which is right for that cycle, and was then what the next cycle's alert
  // read, because the alert ran before the refresh did.
  down = true;
  await w.monitor.check();
  down = false;
  w.api.reset();

  sessions = oneRetriedRun(Date.now() - HOUR).slice(1);
  w.setJobs([job('1', 'REMS_DBS03', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().find((message) => /REMS_DBS03/.test(message.text));
  assert.ok(alert, 'об отказе сообщено');
  assert.match(alert.text, /Попытка:<\/b> 2 из 4/);
});

/* ------------------------------------------------------------------ *
 * The job card lists runs, not sessions
 * ------------------------------------------------------------------ */

test('a job card lists one retried run as one line, with its attempts counted', async () => {
  const { CHAT } = require('./world.cjs');
  const end = Date.now() - HOUR;
  const w = monitorWorld({}, [job('1', 'REMS_DBS03', 'Failed')], {
    '/api/v1/jobs/1': { id: '1', name: 'REMS_DBS03', schedule: RETRY_POLICY },
    '/api/v1/backupInfrastructure/repositories': { data: [] },
    '/api/v1/backupInfrastructure/proxies': { data: [] },
    '/api/v1/sessions': { data: [
      ...oneRetriedRun(end),
      { id: 'ok', jobId: '1', sessionType: 'BackupJob', creationTime: iso(end - 24 * HOUR),
        endTime: iso(end - 23 * HOUR), result: { result: 'Success', message: 'ok' } },
    ] },
    '/api/v1/sessions/s3/taskSessions': { data: [] },
  });

  await w.updates.handleUpdate({
    update_id: 1,
    message: { message_id: 1, text: '/job REMS_DBS03', chat: { id: Number(CHAT), type: 'supergroup', is_forum: true } },
  });
  const card = w.api.sent().at(-1).text;
  const list = card.slice(card.indexOf('Последние запуски'));
  const lines = list.split('\n').filter((line) => /^[🟢🟡🔴⚪]/u.test(line));

  assert.equal(lines.length, 2, `один неудачный запуск и один успешный:\n${list}`);
  assert.match(lines[0], /^🔴/);
  assert.match(lines[0], /попыток: 3/);
  assert.match(list, /attempt 3/, 'причина — от последней попытки');
  assert.doesNotMatch(lines[1], /попыток/, 'у запуска с одной попыткой счётчика нет');
});

/**
 * `nights` nightly Runs of one job, newest first, each `attempts` long: every
 * attempt but the last fails, and Veeam retries ten minutes after it ended.
 * Veeam answers with only as many as asked for, newest first.
 */
const nightlyRuns = (nights, attempts) => {
  const sessions = [];
  const midnight = Date.now() - 12 * HOUR;
  for (let night = 0; night < nights; night += 1) {
    for (let attempt = attempts - 1; attempt >= 0; attempt -= 1) {
      const start = midnight - night * 24 * HOUR + attempt * 15 * MINUTE;
      const last = attempt === attempts - 1;
      sessions.push({
        id: `n${night}a${attempt}`, jobId: '1', sessionType: 'BackupJob',
        creationTime: iso(start), endTime: iso(start + 5 * MINUTE),
        result: { result: last ? 'Success' : 'Failed', message: last ? 'ok' : `attempt ${attempt + 1}` },
      });
    }
  }
  return (req) =>
    req.params?.stateFilter === 'Working'
      ? { data: [] }
      : { data: sessions.slice(req.params?.skip ?? 0, (req.params?.skip ?? 0) + (req.params?.limit ?? sessions.length)) };
};

const cardRuns = async (sessions, retryCount) => {
  const { CHAT } = require('./world.cjs');
  const policy = { runAutomatically: true, retry: { isEnabled: true, retryCount, awaitMinutes: 10 } };
  const w = monitorWorld({}, [job('1', 'OPS_Nightly', 'Success')], {
    '/api/v1/jobs/1': { id: '1', name: 'OPS_Nightly', schedule: policy },
    '/api/v1/backupInfrastructure/repositories': { data: [] },
    '/api/v1/backupInfrastructure/proxies': { data: [] },
    '/api/v1/sessions': sessions,
  });
  await w.updates.handleUpdate({
    update_id: 1,
    message: { message_id: 1, text: '/job OPS_Nightly', chat: { id: Number(CHAT), type: 'supergroup', is_forum: true } },
  });
  const card = w.api.sent().at(-1).text;
  const list = card.slice(card.indexOf('Последние запуски'));
  return list.split('\n').filter((line) => /^[🟢🟡🔴⚪]/u.test(line));
};

test('a job card shows five whole runs of a job that retries three times, not two', async () => {
  // Six sessions used to be read and folded: one whole night and half of the
  // one before it, presented as a run of two attempts.
  const lines = await cardRuns(nightlyRuns(8, 4), 3);

  assert.equal(lines.length, 5, lines.join('\n'));
  for (const line of lines) assert.match(line, /^🟢.*попыток: 4$/u);
});

test('the oldest run of a read that stopped at its limit is left out, not shown cut', async () => {
  // Seven attempts a night: thirty sessions are four whole nights and two
  // attempts of a fifth, which would read as a night that took two.
  const lines = await cardRuns(nightlyRuns(6, 7), 6);

  assert.equal(lines.length, 4, lines.join('\n'));
  for (const line of lines) assert.match(line, /попыток: 7$/u);
});

/* ------------------------------------------------------------------ *
 * The rule itself, with no Veeam behind it
 * ------------------------------------------------------------------ */

const { runsOf, failureStreakOf, attemptOf, retryWindowOf } = require('../dist/monitor/runs');
const at = (text) => `2026-09-17T${text}:00+05:00`;
const attempt = (start, end, result) => ({ startedAt: at(start), endedAt: at(end), result });
const WINDOW = retryWindowOf(RETRY_POLICY);

test('a retry links to the end of the attempt before it, not to its start', () => {
  // 52 minutes start to start, ten minutes end to start: one run.
  const runs = runsOf([attempt('03:54', '03:55', 'Failed'), attempt('03:02', '03:44', 'Failed')], WINDOW);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].attempts.length, 2);
  assert.equal(runs[0].result, 'failed');
});

test('a run ends with the attempt that finished it, and a success is nobody\'s retry', () => {
  const runs = runsOf([
    attempt('04:10', '04:30', 'Success'),
    attempt('03:54', '04:00', 'Warning'),
    attempt('03:00', '03:30', 'Success'),
  ], WINDOW);
  assert.deepEqual(runs.map((run) => [run.result, run.attempts.length]), [['success', 2], ['success', 1]]);
});

test('a gap wider than the window starts a new run', () => {
  const runs = runsOf([attempt('05:00', '05:10', 'Failed'), attempt('03:00', '03:30', 'Failed')], WINDOW);
  assert.equal(runs.length, 2);
  assert.equal(attemptOf([attempt('05:00', '05:10', 'Failed'), attempt('03:00', '03:30', 'Failed')], WINDOW), 1);
});

test('the streak counts runs that did not succeed, a warning among them, back to a success', () => {
  const sessions = [
    attempt('09:00', '09:10', 'Warning'),
    attempt('07:00', '07:10', 'Failed'),
    attempt('06:45', '06:50', 'Failed'),
    attempt('05:00', '05:10', 'Success'),
    attempt('03:00', '03:10', 'Failed'),
  ];
  assert.equal(failureStreakOf(sessions, WINDOW), 2, 'warning and one retried failure; the success stops it');
  assert.equal(failureStreakOf([], WINDOW), 0);
});

test('an alert before any scan has finished still knows the job\'s retry policy', async () => {
  // After a restart the evidence is pending until the first scan finishes, and
  // a scan can fail outright. The alert used to lose "из 4" for as long as it
  // did; the job's own configuration answers the same question in one request.
  let sessions = [];
  const w = monitorWorld({}, [job('1', 'REMS_DBS03', 'Success')], {
    '/api/v1/backups': () => { throw new Error('backups unavailable'); },
    '/api/v1/jobs/1': { id: '1', name: 'REMS_DBS03', schedule: RETRY_POLICY },
    '/api/v1/sessions': () => ({ data: sessions }),
  });
  await w.monitor.check();
  assert.equal(w.evidence.evidence.status, 'pending', 'скан так и не прошёл');
  w.api.reset();

  sessions = oneRetriedRun(Date.now() - HOUR).slice(1);
  w.setJobs([job('1', 'REMS_DBS03', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().find((message) => /REMS_DBS03/.test(message.text));
  assert.match(alert.text, /Попытка:<\/b> 2 из 4/);
});

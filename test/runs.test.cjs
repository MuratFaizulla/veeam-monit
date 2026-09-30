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
  const w = monitorWorld({}, [job('1', 'TTC_Nightly', 'Success')], {
    '/api/v1/jobs/1': { id: '1', name: 'TTC_Nightly', schedule: policy },
    '/api/v1/backupInfrastructure/repositories': { data: [] },
    '/api/v1/backupInfrastructure/proxies': { data: [] },
    '/api/v1/sessions': sessions,
  });
  await w.updates.handleUpdate({
    update_id: 1,
    message: { message_id: 1, text: '/job TTC_Nightly', chat: { id: Number(CHAT), type: 'supergroup', is_forum: true } },
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

const { runsOf, failureStreakOf, attemptOf, retryWindowOf } = require('../dist/estate/runs');
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

test('the streak counts failed runs back to one that did not fail, and a warning did not', () => {
  const sessions = [
    attempt('09:00', '09:10', 'Failed'),
    attempt('07:00', '07:10', 'Failed'),
    attempt('06:45', '06:50', 'Failed'),
    attempt('05:00', '05:10', 'Warning'),
    attempt('03:00', '03:10', 'Failed'),
  ];
  assert.equal(failureStreakOf(sessions, WINDOW), 2, 'one failure, one retried failure; the warning stops it');
  assert.equal(failureStreakOf([], WINDOW), 0);
  // TTC-ODOO: a week of snapshot-removal warnings, each run leaving a point.
  const warned = ['09:00', '07:00', '05:00'].map((start) => attempt(start, start.replace(':00', ':20'), 'Warning'));
  assert.equal(failureStreakOf(warned, WINDOW), 0, 'warnings are not failures');
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

test('a job the last scan did not know still gets its retry policy', async () => {
  // Evidence is ready, but the job was created after the scan: its schedule is
  // not in it, and the alert used to go without "из 4" until the next scan.
  let sessions = [];
  const w = monitorWorld({}, [job('1', 'NEW_JOB', 'Success')], {
    '/api/v1/jobs': { data: [] },
    '/api/v1/jobs/1': { id: '1', name: 'NEW_JOB', schedule: RETRY_POLICY },
    '/api/v1/sessions': () => ({ data: sessions }),
  });
  await w.monitor.check();
  assert.equal(w.evidence.evidence.status, 'ready');
  w.api.reset();

  sessions = oneRetriedRun(Date.now() - HOUR).slice(1);
  w.setJobs([job('1', 'NEW_JOB', 'Failed')]);
  await w.monitor.check();

  const alert = w.api.sent().find((message) => /NEW_JOB/.test(message.text));
  assert.match(alert.text, /Попытка:<\/b> 2 из 4/);
});

/* ------------------------------------------------------------------ *
 * Session history: read whole once, then only its last days
 *
 * The Evidence needs every session Veeam keeps. Read whole on every scan, that
 * was twenty pages of up to seven seconds on veeam01ast01 — the heaviest
 * queries the bot sent — to learn about the hundred-odd sessions since the
 * scan before.
 * ------------------------------------------------------------------ */

const { SessionHistory } = require('../dist/estate/session-history');
const { monitorAccount, VeeamEstateReader } = require('./world.cjs');

const DAY = 24 * HOUR;

/** A Veeam keeping `sessions`, answering `createdAfterFilter` as Veeam does. */
const keeping = (sessions) => {
  const veeam = {
    sessions,
    asked: [],
    down: false,
  };
  const fake = veeamFake({
    '/api/v1/sessions': (req) => {
      veeam.asked.push(req.params?.createdAfterFilter);
      if (veeam.down) throw new Error('connect ETIMEDOUT 10.10.0.162:9419');
      const after = req.params?.createdAfterFilter;
      return {
        data: after
          ? veeam.sessions.filter((session) => Date.parse(session.creationTime) > Date.parse(after))
          : veeam.sessions,
      };
    },
  });
  return { veeam, history: new SessionHistory(new VeeamEstateReader(fake, monitorAccount())) };
};

const session = (id, begun, over = {}) => ({
  id, jobId: '1', sessionType: 'BackupJob', creationTime: iso(begun), result: { result: 'None' }, ...over,
});

/** Runs `body` with the clock moved on by `ms`. */
const later = async (ms, body) => {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await body();
  } finally {
    Date.now = realNow;
  }
};

test('the session history is read whole once, then only its last days, merged in by id', async () => {
  const now = Date.now();
  const going = session('going', now - HOUR, { state: 'Working' });
  const july = session('july', now - 90 * DAY, { endTime: iso(now - 90 * DAY + HOUR), result: { result: 'Success' } });
  const { veeam, history } = keeping([going, july]);

  assert.equal((await history.read()).length, 2);
  assert.equal(veeam.asked[0], undefined, 'the first read is whole');

  // The run that was going has failed since, and another has begun.
  veeam.sessions = [
    { ...going, state: 'Stopped', endTime: iso(now), result: { result: 'Failed' } },
    session('next', now + MINUTE, { jobId: '2', state: 'Working' }),
    july,
  ];
  const read = new Map((await history.read()).map((kept) => [kept.id, kept]));

  const since = Date.parse(veeam.asked[1]);
  assert.ok(Math.abs(since - (now - 2 * DAY)) < MINUTE, `reaching two days before the previous read: ${veeam.asked[1]}`);
  assert.deepEqual([...read.keys()].sort(), ['going', 'july', 'next']);
  assert.equal(read.get('going').result.result, 'failed', 'the run that was going is read again, with its end');
  assert.equal(read.get('going').endTime, iso(now));
  assert.equal(read.get('july').result.result, 'success', 'and July is kept without being asked for');
});

test('a day on, the session history is read whole again, and what Veeam dropped is gone', async () => {
  const now = Date.now();
  const { veeam, history } = keeping([session('recent', now - HOUR), session('expired', now - 95 * DAY)]);
  await history.read();

  // Past its history retention, Veeam no longer has it; only a whole read can tell.
  veeam.sessions = [session('recent', now - HOUR)];
  const read = await later(DAY + MINUTE, () => history.read());

  assert.equal(veeam.asked[1], undefined, 'read whole');
  assert.deepEqual(read.map((kept) => kept.id), ['recent']);
});

test('a session history read Veeam did not answer loses nothing, and the next one reaches back as far', async () => {
  const now = Date.now();
  const { veeam, history } = keeping([session('kept', now - HOUR)]);
  await history.read();

  veeam.down = true;
  await assert.rejects(() => later(2 * HOUR, () => history.read()), /ETIMEDOUT/);
  veeam.down = false;
  const read = await later(4 * HOUR, () => history.read());

  assert.equal(veeam.asked[2], veeam.asked[1], 'from the last read that worked, not the one that failed');
  assert.deepEqual(read.map((kept) => kept.id), ['kept']);
});

test('on a Veeam whose points name no session, the runs are the sessions on the clock, and the log says who failed', async () => {
  // veam01baas01, REST API 1.1: no sessionId on a point and no task sessions.
  // Every machine's point used to be a run of its own, and the topic read
  // "пропущено 390535 запусков" of a job that ran once a night.
  const { VeeamApiError } = require('../dist/veeam/api.error');
  const now = Date.now();
  const nights = [1, 2, 3, 4].map((n) => now - n * DAY);
  const sessions = nights.map((start, i) => ({
    id: `n${i}`, jobId: '1', sessionType: 'BackupJob', creationTime: iso(start), endTime: iso(start + HOUR),
    result: { result: i === 0 ? 'Failed' : 'Success' },
  }));
  const points = nights.flatMap((start, i) => [
    { id: `a${i}`, backupId: 'b1', name: 'app01', creationTime: iso(start + 1 * MINUTE) },
    { id: `d${i}`, backupId: 'b1', name: 'db01', creationTime: iso(start + 3 * MINUTE) },
  ]);
  const w = world();
  const evidence = evidenceOf(w, veeamFake({
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': { data: [{ id: 'b1', jobId: '1', name: 'J' }] },
    '/api/v1/restorePoints': { data: points },
    '/api/v1/sessions': { data: sessions },
    '/api/v1/sessions/n0/taskSessions': () => {
      throw new VeeamApiError('Not found', 404);
    },
    '/api/v1/sessions/n0/logs': { records: [
      { status: 'Succeeded', title: 'Processing app01' },
      { status: 'Failed', title: 'Processing db01 Error: Failed to open VDDK disk' },
    ] },
  }));

  await evidence.refresh(true, [{ id: '1', name: 'J', type: 'Backup', result: 'failed' }]);
  const scanned = evidence.evidence;

  assert.equal(scanned.status, 'ready');
  assert.equal(scanned.depthByJob.get('1').runs, 4, 'four nights, not eight machines');
  assert.equal(scanned.depthByJob.get('1').points, 7, 'the failed machine of the failed night goes');
  assert.equal(scanned.failedPoints, 1);
  assert.ok(Math.abs(scanned.cadenceByJob.get('1') - 1) < 0.01, `once a day: ${scanned.cadenceByJob.get('1')}`);
});

test('the Evidence reads the whole session history on its first scan only', async () => {
  const w = world();
  const asked = [];
  const evidence = evidenceOf(w, veeamFake({
    '/api/v1/jobs': { data: [] },
    '/api/v1/backups': { data: [] },
    '/api/v1/restorePoints': { data: [] },
    '/api/v1/sessions': (req) => {
      asked.push(req.params?.createdAfterFilter);
      return { data: [] };
    },
  }));

  await evidence.refresh(true, []);
  await later(3 * HOUR, () => evidence.refresh(true, []));

  assert.equal(asked.length, 2, 'one read per scan');
  assert.equal(asked[0], undefined, 'the first whole');
  assert.ok(asked[1], 'the next only what is new');
  assert.equal(evidence.evidence.status, 'ready');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, veeamFake, monitorWorld, job, BackupEvidenceService } = require('./world.cjs');

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
  const auth = { configured: true, getAccessToken: async () => 'tok', invalidateAccessToken: () => {}, rejectToken: () => true };
  return new BackupEvidenceService(w.config, veeam, auth);
};

test('one run that Veeam retried twice is one failed run in the streak, not three', async () => {
  const evidence = evidenceOver(oneRetriedRun(Date.now() - HOUR));
  await evidence.refresh('tok', [job('1', 'REMS_DBS03', 'Failed')]);

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
  await evidence.refresh('tok', [job('1', 'REMS_DBS03', 'Failed')]);

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

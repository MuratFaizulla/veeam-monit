const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, veeamFake, monitorOf, monitorWorld, job, CHAT, VeeamEstateReader } = require('./world.cjs');
const { VeeamApiError } = require('../dist/veeam/api.error');
const { VeeamMonitorAuthService } = require('../dist/veeam/monitor-auth.service');

/* ------------------------------------------------------------------ *
 * Reading Veeam: one module that holds the token and knows the paths
 *
 * The token used to be a string captured at the start of a cycle and handed
 * from reader to reader. A refused call was retried with a fresh one, but the
 * string everybody else carried stayed the refused one, so every later call of
 * that cycle was refused too — and the login-storm guard then declined to get
 * another. One 403 cost the rest of the cycle: repositories, the Evidence, the
 * live reads.
 * ------------------------------------------------------------------ */

const SIGNED_IN = { VEEAM_MONITOR_USERNAME: 'svc', VEEAM_MONITOR_PASSWORD: 'p' };

/**
 * A Veeam that issues tokens `tok-1`, `tok-2`… and answers 403 to any token in
 * `refused`. The real auth service signs in against it, so the token rules
 * under test are the service's own, not a fake's idea of them.
 */
const tokenVeeam = (routes) => {
  const refused = new Set();
  const state = { refused, logins: 0 };
  const guarded = Object.fromEntries(
    Object.entries(routes).map(([path, answer]) => [
      path,
      (req) => {
        if (req.accessToken && refused.has(req.accessToken)) {
          throw new VeeamApiError('Veeam API responded with HTTP 403', 403);
        }
        return typeof answer === 'function' ? answer(req, state) : answer;
      },
    ]),
  );
  const veeam = veeamFake(guarded);
  veeam.login = async () => ({ access_token: `tok-${(state.logins += 1)}`, expires_in: 3600 });
  return { veeam, state };
};

const textsOf = (w) =>
  w.api.calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
    .map((call) => call.payload.text);

test('a token refused in the middle of a cycle costs one sign-in, not the rest of the cycle', async () => {
  const w = world({ ...SIGNED_IN, TELEGRAM_LIVE: 'true', TELEGRAM_REPOSITORY_FREE_PERCENT: '10' });
  const { veeam, state } = tokenVeeam({
    '/api/v1/serverTime': { serverTime: '2026-09-14T11:00:00+05:00' },
    // Veeam answers the job list and refuses the same token from then on —
    // what this server does, in bursts, to a token it has just issued.
    '/api/v1/jobs/states': (req, s) => {
      s.refused.add(req.accessToken);
      return { data: [job('1', 'SQL Daily', 'Success')] };
    },
    '/api/v1/jobs': { data: [{ id: '1', schedule: { runAutomatically: true } }] },
    '/api/v1/backups': { data: [] },
    '/api/v1/restorePoints': { data: [] },
    '/api/v1/sessions': { data: [] },
    '/api/v1/backupInfrastructure/repositories/states': {
      data: [{ id: 'r1', name: 'Repo01', capacityGB: 1000, freeGB: 40 }],
    },
  });
  const auth = new VeeamMonitorAuthService(w.app.veeam, veeam);
  const monitor = monitorOf(w, veeam, auth);

  await monitor.check();

  assert.equal(state.logins, 2, 'one sign-in for the cycle, one for the refusal');
  assert.equal(monitor.status.lastError, null, 'no step of the cycle failed');
  const texts = textsOf(w);
  assert.ok(texts.some((t) => /Repo01: мало свободного места/.test(t)), 'repositories were read');
  assert.ok(!texts.some((t) => /не прочитаны/.test(t)), 'the Evidence was read');
  assert.ok(!texts.some((t) => /временно недоступны/.test(t)), 'the Working sessions were read');
});

test('a refusal that reaches a whole batch of pages at once costs one sign-in and no page', async () => {
  const w = world(SIGNED_IN);
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `p${i}` }));
  const { veeam, state } = tokenVeeam({
    '/api/v1/restorePoints': (req, s) => {
      const { skip, limit } = req.params;
      // The first page is answered; the five read together after it all
      // carry the token Veeam has started refusing.
      if (skip === 0) s.refused.add(req.accessToken);
      return { data: rows.slice(skip, skip + limit), pagination: { total: rows.length, skip, limit } };
    },
  });
  const reader = new VeeamEstateReader(veeam, new VeeamMonitorAuthService(w.app.veeam, veeam));

  const points = await reader.restorePoints();

  // Five refusals, one burst: the first gets a new token and the other four
  // use it, rather than finding the login-storm guard saying no and failing
  // the whole Evidence scan with them.
  assert.equal(points.length, 3000);
  assert.equal(new Set(points.map((point) => point.id)).size, 3000);
  assert.equal(state.logins, 2);
});

test('a token somebody already replaced is simply retried with the new one', async () => {
  let token = 'old';
  let rejected = 0;
  const reader = new VeeamEstateReader(
    {
      request: async ({ accessToken }) => {
        if (accessToken === 'old') {
          // Refused, and meanwhile another request's refusal was dealt with.
          token = 'new';
          throw new VeeamApiError('Veeam API responded with HTTP 403', 403);
        }
        return { data: [{ id: accessToken }] };
      },
    },
    { getAccessToken: async () => token, rejectToken: () => (rejected += 1) > 0 },
  );

  assert.deepEqual(await reader.backups(), [{ id: 'new' }]);
  // The guard allows one forced sign-in a minute; spending it on a token
  // nobody uses any more would leave it saying no to the refusal that matters.
  assert.equal(rejected, 0);
});

/* ------------------------------------------------------------------ *
 * Which machine failed, and why, on either REST API
 * ------------------------------------------------------------------ */

test('a server without task sessions still says which machine failed and why, from the session log', async () => {
  // veeam02, REST API 1.1: the task sessions answer 404, and the log is
  // the only place a machine's outcome is written.
  const reader = new VeeamEstateReader(
    veeamFake({
      '/api/v1/sessions/s1/taskSessions': () => { throw new VeeamApiError('Not found', 404); },
      '/api/v1/sessions/s1/logs': { records: [
        { status: 'Succeeded', title: 'Job started at 9/29/2026 8:47:52 PM' },
        { status: 'Failed', title: 'Processing Test_web' },
        { status: 'Failed', title: 'Processing vApp_retail_new Error: Failed to process the following VMs: Test_web' },
        { status: 'Failed', title: 'Failed to create processing task for VM dom002.example.com Error: Failed to retrieve object hierarchy' },
        { status: 'Failed', title: 'Virtual Machine dc01.mgmt.example.com is unavailable and will be skipped from processing' },
        { status: 'Succeeded', title: 'Processing Argus' },
        { status: 'Failed', title: 'Job finished with error at 9/29/2026 8:50:28 PM' },
      ] },
    }),
    { getAccessToken: async () => 'tok', rejectToken: () => true },
  );

  assert.deepEqual(await reader.machineResults('s1'), [
    { name: 'Test_web', result: 'failed', reason: undefined },
    { name: 'vApp_retail_new', result: 'failed', reason: 'Failed to process the following VMs: Test_web' },
    { name: 'dom002.example.com', result: 'failed', reason: 'Failed to retrieve object hierarchy' },
    {
      name: 'dc01.mgmt.example.com',
      result: 'failed',
      reason: 'Virtual Machine dc01.mgmt.example.com is unavailable and will be skipped from processing',
    },
    { name: 'Argus', result: 'success', reason: undefined },
  ]);
});

/* ------------------------------------------------------------------ *
 * What is running: one read, one definition
 * ------------------------------------------------------------------ */

test('a cycle reads the Working sessions once, and ▶️, 📈 and the Summary count the same run', async () => {
  let workingReads = 0;
  // Switched off in Veeam and transferring anyway: only the session says so.
  const byHand = { id: '9', name: 'Started by hand', type: 'Backup', status: 'Disabled', lastResult: 'Success' };
  const w = monitorWorld(
    { TELEGRAM_LIVE: 'true', TELEGRAM_TIMEZONE: 'UTC', TELEGRAM_DIGEST_HOUR: String(new Date().getUTCHours()) },
    [byHand, job('1', 'SQL Daily', 'Success')],
    {
      '/api/v1/sessions': (req) => {
        if (req.params?.stateFilter === 'Working') workingReads += 1;
        return {
          data: [
            { id: 's1', jobId: '9', state: 'Working', progressPercent: 30, creationTime: new Date().toISOString() },
            // A session Veeam has finished, which a server ignoring the filter
            // hands back anyway: not running, by the one definition.
            { id: 's0', jobId: '1', state: 'Stopped', creationTime: '2026-09-14T01:00:00Z', endTime: '2026-09-14T02:00:00Z' },
          ],
        };
      },
      '/api/v1/sessions/s1/taskSessions': { data: [] },
    },
  );

  await w.monitor.check();

  assert.equal(workingReads, 1, 'one read of the Working sessions for the whole cycle');
  const texts = textsOf(w);
  assert.ok(texts.some((t) => /Сейчас выполняется: 1 задание/.test(t)), '▶️ counts one');
  assert.ok(texts.some((t) => /Выполняется заданий:<\/b> 1/.test(t)), '📈 counts one');
  assert.ok(texts.some((t) => /сводка по заданиям[\s\S]*Выполняются:<\/b> 1/.test(t)), 'the daily Summary counts one');
});

/* ------------------------------------------------------------------ *
 * A job, translated once
 * ------------------------------------------------------------------ */

test('a job Veeam gave no name is called by its id in the alert, the Summary and ▶️ alike', async () => {
  const unnamed = (lastResult) => ({ id: '5f1c0e2a', type: 'Backup', status: 'Working', lastResult });
  const w = monitorWorld({ TELEGRAM_LIVE: 'true' }, [unnamed('Success')]);
  await w.monitor.check();
  w.setJobs([unnamed('Failed')]);
  await w.monitor.check();
  await w.updates.handleUpdate({
    update_id: 1,
    message: { message_id: 1, text: '/digest', chat: { id: Number(CHAT), type: 'supergroup', is_forum: true } },
  });

  const texts = textsOf(w);
  assert.ok(texts.some((t) => /5f1c0e2a: ОШИБКА/.test(t)), 'the alert');
  assert.ok(w.api.of('createForumTopic').some((topic) => topic.name === '5f1c0e2a'), 'the topic the alert is routed to');
  assert.ok(texts.some((t) => /🔴 5f1c0e2a/.test(t)), 'the Summary');
  assert.ok(texts.some((t) => /Сейчас выполняется: 1 задание[\s\S]*<b>5f1c0e2a<\/b>/.test(t)), '▶️');
  assert.ok(!texts.some((t) => /без имени|неизвестное задание/.test(t)), 'and nowhere by another name');
});

test('a job is translated once: an id, one name, one spelling of its result', () => {
  const { jobOf } = require('../dist/veeam/estate');

  assert.deepEqual(
    [jobOf({ id: 'a', name: 'SQL Daily', lastResult: 'Failed' }), jobOf({ id: 'b', lastResult: 'None' }), jobOf({ id: 'c' })]
      .map(({ id, name, result }) => ({ id, name, result })),
    [
      { id: 'a', name: 'SQL Daily', result: 'failed' },
      { id: 'b', name: 'b', result: 'none' },
      { id: 'c', name: 'c', result: 'none' },
    ],
  );
  // Nothing can address it, remember it or match a session to it.
  assert.equal(jobOf({ name: 'no id' }), undefined);
});

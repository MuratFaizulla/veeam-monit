const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monitorWorld, job, capacities } = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Which alerts a cycle owes, asked without a cycle
 *
 * The rules lived in private monitor methods, reachable only by driving a
 * whole cycle through a fake Veeam and a fake Telegram — and the ones nobody
 * had driven that way were simply untested: warnings, the repository
 * critical/warning split, the recovery that re-arms a repository alarm, and
 * the hour the daily summary goes out.
 * ------------------------------------------------------------------ */

/** Veeam's job states, translated as the estate reader translates them, and what they owe. */
const owed = (states, remembered, seeding = false) => {
  const { jobTransitions } = require('../dist/monitor/transitions');
  const { jobOf } = require('../dist/veeam/estate');
  return jobTransitions(states.map(jobOf), (id) => remembered[id], seeding);
};
const severities = (transitions) =>
  Object.fromEntries(transitions.map((t) => [t.job.id, t.severity]));

test('a job moving into a warning is announced as a warning, from success or from failure', () => {
  assert.deepEqual(
    severities(owed(
      [job('a', 'A', 'Warning'), job('b', 'B', 'Warning'), job('c', 'C', 'Failed')],
      { a: 'success', b: 'failed', c: 'warning' },
    )),
    { a: 'warning', b: 'warning', c: 'critical' },
  );
});

test('only a success after something bad is worth a message', () => {
  assert.deepEqual(
    severities(owed(
      [job('a', 'A', 'Success'), job('b', 'B', 'Success'), job('c', 'C', 'Success')],
      { a: 'warning', b: 'success', c: undefined },
    )),
    { a: 'success', b: null, c: null },
  );
});

test('a running retry is not a result, and is not remembered over one', () => {
  const [t] = owed([{ id: 'a', name: 'A', lastResult: 'None', status: 'Working' }], { a: 'failed' });
  assert.equal(t.severity, null);
  assert.equal(t.remember, 'failed');
});

test('the first cycle an installation ever sees only takes notes', () => {
  const transitions = owed([job('a', 'A', 'Failed')], {}, true);
  assert.equal(transitions[0].severity, null);
  assert.equal(transitions[0].remember, 'failed');
});

const repo = (id, freePercent) => ({
  id, name: `BKP_${id}`, capacityGB: 1000, freeGB: freePercent === undefined ? undefined : freePercent * 10,
  hostName: '192.0.2.13', path: `\\192.0.2.13\${id}`,
});

test('a repository under the threshold warns, under half of it is critical, above it re-arms', () => {
  const { repositoryAlarms } = require('../dist/monitor/repository-alarms');
  const { events, cleared } = repositoryAlarms(
    capacities([repo('ok', 40), repo('low', 15), repo('empty', 5), repo('unknown', undefined)]),
    { thresholdPercent: 20, cooldownMs: 60_000 },
  );

  // In the order capacities() gives them, fullest first; the pairs are the point.
  const bySubject = Object.fromEntries(events.map((e) => [e.subject, e]));
  assert.deepEqual(Object.keys(bySubject).sort(), ['BKP_empty', 'BKP_low']);
  assert.equal(bySubject.BKP_low.severity, 'warning');
  assert.equal(bySubject.BKP_empty.severity, 'critical');
  assert.match(bySubject.BKP_low.title, /Repository BKP_low is low on space/);
  assert.equal(bySubject.BKP_low.dedupeKey, 'repo:low');
  assert.deepEqual(cleared, ['repo:ok'], 'восстановившийся снова может предупредить');
});

test('with the threshold off, no repository raises or clears anything', () => {
  const { repositoryAlarms } = require('../dist/monitor/repository-alarms');
  assert.deepEqual(
    repositoryAlarms(capacities([repo('low', 1)]), { thresholdPercent: 0, cooldownMs: 60_000 }),
    { events: [], cleared: [] },
  );
});

test('the daily summary goes out at the configured hour of the configured zone, not the server\'s', () => {
  const { digestDue } = require('../dist/estate/digest');
  // 08:30 in Qyzylorda (UTC+5) is 03:30 UTC.
  assert.equal(digestDue(new Date('2026-09-25T03:30:00Z'), 8, 'Asia/Qyzylorda'), true);
  assert.equal(digestDue(new Date('2026-09-25T08:30:00Z'), 8, 'Asia/Qyzylorda'), false, 'не сейчас');
  assert.equal(digestDue(new Date('2026-09-25T08:30:00Z'), 8, 'UTC'), true);
  assert.equal(digestDue(new Date('2026-09-25T08:30:00Z'), -1, 'UTC'), false, 'сводка выключена');
});

test('a monitor with no service account says so once, not every cycle', async () => {
  const w = monitorWorld({}, [job('1', 'A', 'Success')]);
  w.auth.configured = false;
  await w.monitor.check();
  await w.monitor.check();

  const told = w.api.sent().filter((m) => /Job monitoring is off/.test(m.text));
  assert.equal(told.length, 1);
});

test('a summary counted without the Working sessions says its running figure is partial', () => {
  // When the sessions could not be read the count falls back to job status,
  // which misses every run started by hand on a job switched off. The daily
  // summary used to send that smaller number as if it were the whole truth.
  const { summarise, digestEvent } = require('../dist/estate/digest');
  const jobs = [{ ...job('1', 'A', 'Success'), id: '1', name: 'A', result: 'success', status: 'Working' }];
  const running = (event) => event.fields.find(([label]) => label === 'Выполняются')[1];

  assert.equal(running(digestEvent(summarise(jobs, new Set()))), 1);
  assert.match(String(running(digestEvent(summarise(jobs, new Set(), 'timeout')))), /^1 .*по статусу/);
});

/* ------------------------------------------------------------------ *
 * Server watch: whether a server answers and its account signs in,
 * asked without a cycle
 *
 * The monitor kept this in private methods and in memory: an outage the bot
 * was started into was never announced though its recovery was, a sign-in
 * that came back after a restart came back without a word, and /status said
 * «Последняя ошибка» of whatever failed last, until a restart.
 * ------------------------------------------------------------------ */

/**
 * A Server watch over a server that answers and signs in as `state` says,
 * remembering into `record` — the server's part of the state file, which a
 * restart hands to the next watch.
 */
const watched = (record = {}) => {
  const { ServerWatch } = require('../dist/monitor/server-watch');
  const { ServerMemory } = require('../dist/telegram/server-memory');
  const state = { up: true, signs: true, outcome: 'delivered' };
  const sent = [];
  const forgotten = [];
  const server = {
    http: {
      baseUrl: 'https://veeam01main.example.com:9419',
      reachability: async () =>
        state.up ? { reachable: true, serverTime: 'now' } : { reachable: false, error: 'connect ECONNREFUSED 192.0.2.10:9419' },
    },
    auth: {
      configured: true,
      username: 'svc_monitor',
      getAccessToken: async () => {
        if (!state.signs) throw new Error('Veeam API 401: Authentication failed');
        return 'token';
      },
    },
  };
  const watch = new ServerWatch(
    server,
    new ServerMemory(record, () => {}),
    async (event) => {
      sent.push(event.title);
      return { outcome: state.outcome };
    },
    { authCooldownMs: 3_600_000, forget: (key) => forgotten.push(key) },
  );
  return { watch, state, sent, forgotten, record };
};

test('a server that does not answer the first time it is seen is reported; one that answers is not', async () => {
  const down = watched();
  down.state.up = false;
  assert.deepEqual(await down.watch.observe(), { reachable: false, authenticated: false });
  assert.deepEqual(down.sent, ['Veeam is unreachable']);

  const up = watched();
  assert.deepEqual(await up.watch.observe(), { reachable: true, authenticated: true });
  assert.deepEqual(up.sent, [], 'starting up is not an event');
  assert.deepEqual(up.record, { reachable: true, authenticated: true });
});

test('an outage across a restart is reported once, and its recovery after it', async () => {
  const before = watched();
  before.state.up = false;
  await before.watch.observe();

  // The bot restarts while the server is still down.
  const after = watched(before.record);
  after.state.up = false;
  await after.watch.observe();
  assert.deepEqual(after.sent, [], 'already said');

  after.state.up = true;
  await after.watch.observe();
  assert.deepEqual(after.sent, ['Veeam is reachable again']);
});

test('a change nobody was told of is said again on the next pass', async () => {
  const w = watched({ reachable: true });
  w.state.up = false;
  w.state.outcome = 'failed';
  await w.watch.observe();

  w.state.outcome = 'delivered';
  await w.watch.observe();
  await w.watch.observe();
  assert.deepEqual(w.sent, ['Veeam is unreachable', 'Veeam is unreachable']);
});

test('a sign-in that comes back after a restart is announced', async () => {
  const before = watched();
  before.state.signs = false;
  assert.deepEqual(await before.watch.observe(), { reachable: true, authenticated: false });
  assert.deepEqual(before.sent, ['Veeam: the monitor account cannot sign in']);

  const after = watched(before.record);
  await after.watch.observe();
  assert.deepEqual(after.sent, ['Veeam: the monitor account signs in again']);
  assert.deepEqual(after.forgotten, ['veeam:auth:failed'], 'the next failure is news at once');

  await after.watch.observe();
  assert.equal(after.sent.length, 1, 'and only once');
});

test('the health says what went wrong in this pass, and a clean pass clears it', async () => {
  const w = watched();
  assert.deepEqual(w.watch.health, { reachable: null, authenticated: null, error: null }, 'not asked yet');

  w.state.up = false;
  await w.watch.observe();
  assert.equal(w.watch.health.error, 'connect ECONNREFUSED 192.0.2.10:9419');

  w.state.up = true;
  await w.watch.observe();
  assert.equal(w.watch.health.error, null);

  w.watch.failed('Veeam 500 Internal Server Error');
  assert.equal(w.watch.health.error, 'Veeam 500 Internal Server Error', 'a later step of the pass');
  await w.watch.observe();
  assert.equal(w.watch.health.error, null);
});

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
  hostName: '10.10.27.13', path: `\\10.10.27.13\${id}`,
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
  assert.match(bySubject.BKP_low.title, /BKP_low: мало свободного места/);
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
  const { digestDue } = require('../dist/monitor/digest');
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

  const told = w.api.sent().filter((m) => /Мониторинг заданий выключен/.test(m.text));
  assert.equal(told.length, 1);
});

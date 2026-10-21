const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { world, monitorWorld, job, capacities, clockAt } = require('./world.cjs');

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

/** A server's sending that delivers everything, and keeps what it was asked to send and to forget. */
const recording = () => {
  const sending = {
    sent: [],
    forgotten: [],
    send: async (event) => {
      sending.sent.push(event);
      return { outcome: 'delivered' };
    },
    forget: (key) => sending.forgotten.push(key),
  };
  return sending;
};

test('a repository under the threshold warns, and under half of it is critical', async () => {
  const { sendRepositoryAlarms } = require('../dist/monitor/repository-alarms');
  const sending = recording();
  await sendRepositoryAlarms(
    capacities([repo('ok', 40), repo('low', 15), repo('empty', 5), repo('unknown', undefined)]),
    { thresholdPercent: 20, cooldownMs: 60_000 },
    sending,
  );

  // In the order capacities() gives them, fullest first; the pairs are the point.
  const bySubject = Object.fromEntries(sending.sent.map((e) => [e.subject, e]));
  assert.deepEqual(Object.keys(bySubject).sort(), ['BKP_empty', 'BKP_low']);
  assert.equal(bySubject.BKP_low.severity, 'warning');
  assert.equal(bySubject.BKP_empty.severity, 'critical');
  assert.match(bySubject.BKP_low.title, /Repository BKP_low is low on space/);
});

test('with the threshold off, no repository raises or clears anything', async () => {
  const { sendRepositoryAlarms } = require('../dist/monitor/repository-alarms');
  const sending = recording();
  await sendRepositoryAlarms(capacities([repo('low', 1), repo('ok', 50)]), { thresholdPercent: 0, cooldownMs: 60_000 }, sending);
  assert.deepEqual(sending.sent, []);
  assert.deepEqual(sending.forgotten, []);
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
 * Server sending: what the monitor says about one server, and that
 * server's cooldowns, asked without a cycle
 *
 * Only the monitor knew how to make a cooldown one server's, so the Server
 * watch was handed a way to forget one, the repository alarms handed their
 * keys back to be scoped, and the tests asserted the keys as they lie in the
 * state file.
 * ------------------------------------------------------------------ */

const HOUR = 3_600_000;

/** A server's sending in world `w`, delivered as the service delivers, against `clock`. */
const sendingOf = (w, server, { several = false, clock = clockAt('2026-09-25T08:30:00Z') } = {}) => {
  const { ServerSending } = require('../dist/monitor/server-sending');
  return new ServerSending(
    server,
    (event, cooldowns) => w.service.notify(event, cooldowns),
    w.store.cooldowns,
    { several, now: clock.now },
  );
};

const AST = { key: 'ast', name: 'AST' };
const BAAS = { key: 'baas', name: 'BAAS' };

/** The alert a failed job is worth, kept quiet for an hour. */
const failedJob = (id, name = 'Files') => ({
  kind: 'job', severity: 'critical', subject: name, title: `${name} — failed`,
  dedupeKey: `job:${id}:failed`, cooldownMs: HOUR,
});

test('with several servers an alert says which server it is about, and its cooldown is that server\'s alone', async () => {
  const w = world();
  const ast = sendingOf(w, AST, { several: true });
  const baas = sendingOf(w, BAAS, { several: true });

  assert.equal((await baas.send(failedJob('b1'))).outcome, 'delivered');
  assert.match(w.api.sent()[0].text, /BAAS · Files — failed/);
  assert.equal((await baas.send(failedJob('b1'))).outcome, 'cooldown');
  // The same job id on two servers is two conditions, not one.
  assert.equal((await ast.send(failedJob('b1'))).outcome, 'delivered');
  assert.match(w.api.sent()[1].text, /AST · Files — failed/);
});

test('a cooldown in a state file from before is honoured, with one server and with several', async () => {
  // Written by hand on purpose: this is what the file of a running
  // installation holds, and an upgrade must read it as it lies.
  const file = path.join(os.tmpdir(), `veeam-cooldowns-${Math.random().toString(36).slice(2)}.json`);
  const until = Date.parse('2026-09-25T09:00:00Z');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, chats: {}, topics: {}, liveMessages: {}, answers: {}, jobResults: {},
    cooldowns: { 'job:1:failed': until, 'baas:job:2:failed': until },
  }));
  const w = world({}, {}, file);

  // One server: the keys are what they always were, and the title names none.
  const only = sendingOf(w, { key: 'localhost', name: 'localhost' });
  assert.equal((await only.send(failedJob('1'))).outcome, 'cooldown');
  assert.equal((await only.send(failedJob('3'))).outcome, 'delivered');
  assert.match(w.api.sent()[0].text, /<b>Files — failed<\/b>/);

  // Several: each server's own.
  assert.equal((await sendingOf(w, BAAS, { several: true }).send(failedJob('2'))).outcome, 'cooldown');
  assert.equal((await sendingOf(w, AST, { several: true }).send(failedJob('2'))).outcome, 'delivered');

  w.store.flush();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

test('a cooldown forgotten lets the next alert out at once, on its own server only', async () => {
  const w = world();
  const ast = sendingOf(w, AST, { several: true });
  const baas = sendingOf(w, BAAS, { several: true });
  await ast.send(failedJob('1'));
  await baas.send(failedJob('1'));

  baas.forget('job:1:failed');
  assert.equal((await baas.send(failedJob('1'))).outcome, 'delivered');
  assert.equal((await ast.send(failedJob('1'))).outcome, 'cooldown');

  const only = sendingOf(world(), { key: 'localhost', name: 'localhost' });
  await only.send(failedJob('1'));
  only.forget('job:1:failed');
  assert.equal((await only.send(failedJob('1'))).outcome, 'delivered', 'with one server too');
});

test('a repository short of space is said once per cooldown, and at once after it was back above the threshold', async () => {
  const { sendRepositoryAlarms } = require('../dist/monitor/repository-alarms');
  const w = world();
  const clock = clockAt('2026-09-25T08:30:00Z');
  const sending = sendingOf(w, BAAS, { several: true, clock });
  let free = 15;
  const pass = () => sendRepositoryAlarms(capacities([repo('low', free)]), { thresholdPercent: 20, cooldownMs: 12 * HOUR }, sending);
  const said = () => w.api.sent().filter((m) => /BAAS · Repository BKP_low is low on space/.test(m.text)).length;

  await pass();
  await pass();
  assert.equal(said(), 1, 'once per cooldown');
  clock.pass(12 * HOUR);
  await pass();
  assert.equal(said(), 2, 'and again once it has run out');

  free = 40;
  await pass();
  free = 15;
  await pass();
  assert.equal(said(), 3, 'back above the threshold, the next shortage is news at once');
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
 * restart hands to the next watch — and sending through a sending that holds
 * back what it delivered under a key until that key is forgotten: `quiet`,
 * the cooldowns of the state file, which a restart hands on too.
 */
const watched = (record = {}, quiet = new Set()) => {
  const { ServerWatch } = require('../dist/monitor/server-watch');
  const { ServerMemory } = require('../dist/telegram/server-memory');
  const state = { up: true, signs: true, outcome: 'delivered' };
  const sent = [];
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
  const sending = {
    send: async (event) => {
      if (quiet.has(event.dedupeKey)) return { outcome: 'cooldown' };
      sent.push(event.title);
      if (state.outcome === 'delivered' && event.dedupeKey) quiet.add(event.dedupeKey);
      return { outcome: state.outcome };
    },
    forget: (key) => quiet.delete(key),
  };
  const watch = new ServerWatch(server, new ServerMemory(record, () => {}), sending, { authCooldownMs: 3_600_000 });
  return { watch, state, sent, record, quiet };
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

test('a sign-in that comes back after a restart is announced, and the next failure is news at once', async () => {
  const before = watched();
  before.state.signs = false;
  assert.deepEqual(await before.watch.observe(), { reachable: true, authenticated: false });
  assert.deepEqual(before.sent, ['Veeam: the monitor account cannot sign in']);

  const after = watched(before.record, before.quiet);
  await after.watch.observe();
  assert.deepEqual(after.sent, ['Veeam: the monitor account signs in again']);
  await after.watch.observe();
  assert.equal(after.sent.length, 1, 'and only once');

  // Within the hour the failure before the restart is held back for, and
  // said all the same.
  after.state.signs = false;
  await after.watch.observe();
  assert.deepEqual(after.sent, ['Veeam: the monitor account signs in again', 'Veeam: the monitor account cannot sign in']);
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

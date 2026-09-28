const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CHAT, world, ear, veeamFake, job, monitorAccount, serverOf, monitorOfServers, TelegramStateStore,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Several Veeam servers: every one watched, one shown
 * ------------------------------------------------------------------ */

const TWO = { VEEAM_SERVERS: 'AST=https://ast.example:9419,BAAS=https://baas.example:9419' };

/** A Veeam that remembers what it was asked, so a test can say what it was not. */
const recorded = (fake) => {
  const asked = [];
  const request = fake.request;
  return {
    ...fake,
    asked,
    request: async (req) => {
      asked.push(req);
      return request(req);
    },
    paths: () => asked.map((req) => req.path),
  };
};

const routesOf = (states, extra = {}) => ({
  '/api/v1/serverTime': { serverTime: '2026-09-14T11:00:00+05:00' },
  '/api/v1/jobs/states': () => ({ data: states() }),
  '/api/v1/sessions': { data: [{ result: { message: 'Agent failed to process method' } }] },
  '/api/v1/jobs': { data: [] },
  '/api/v1/backups': { data: [] },
  '/api/v1/restorePoints': { data: [] },
  '/api/v1/backupInfrastructure/repositories/states': { data: [] },
  '/api/v1/backupInfrastructure/repositories': { data: [] },
  '/api/v1/backupInfrastructure/proxies': { data: [] },
  ...extra,
});

/** Two servers, AST listed first, each with its own jobs and its own Veeam. */
function twoServers({ env = {}, ast = [], baas = [], astRoutes = {}, baasRoutes = {}, stateFile } = {}) {
  const w = world({ ...TWO, ...env }, {}, stateFile);
  let jobs = { ast, baas };
  const veeamAst = recorded(veeamFake(routesOf(() => jobs.ast, astRoutes), 'https://ast.example:9419'));
  const veeamBaas = recorded(veeamFake(routesOf(() => jobs.baas, baasRoutes), 'https://baas.example:9419'));
  const [astEndpoint, baasEndpoint] = w.app.veeam.servers;
  const monitor = monitorOfServers(w, [
    serverOf(w, veeamAst, monitorAccount(), undefined, astEndpoint),
    serverOf(w, veeamBaas, monitorAccount(), undefined, baasEndpoint),
  ]);
  const { commands, updates } = ear(w, monitor);
  return {
    ...w, monitor, commands, updates, veeamAst, veeamBaas,
    setJobs: (next) => (jobs = { ...jobs, ...next }),
  };
}

const said = (w, text) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  message: {
    message_id: 1, message_thread_id: 1, is_topic_message: true, text,
    chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
  },
});

const pressed = (w, data) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  callback_query: {
    id: 'cb-servers', data,
    message: {
      message_id: 9, message_thread_id: 1, is_topic_message: true,
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  },
});

/** Runs a pass once the one a selection started has finished. */
const settled = async (w) => {
  while ((await w.monitor.check()) === 'busy') await new Promise(setImmediate);
};

const texts = (w) => w.api.sent().map((message) => message.text);

test('every server is watched, and an alert says which server it is about', async () => {
  const w = twoServers({
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Success')],
  });
  await w.monitor.check();
  w.api.reset();

  // BAAS is not the one shown, and its failure is reported all the same.
  w.setJobs({ baas: [job('b1', 'Files', 'Failed')] });
  await w.monitor.check();

  const alerts = texts(w);
  assert.equal(alerts.length, 1, alerts.join('\n---\n'));
  assert.match(alerts[0], /BAAS · Files: ОШИБКА/);
  assert.equal(w.store.jobResultsOf('baas').of('b1'), 'failed');
  assert.equal(w.store.jobResultsOf('ast').of('a1'), 'success');
  // The same job id on two servers would be two conditions, not one.
  assert.ok(w.store.snapshot().cooldowns['baas:job:b1:failed'] > Date.now());
});

test('a server added to the list is learned quietly, whatever the others remember', async () => {
  const w = twoServers({
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Failed')],
  });
  // AST has been watched for months; BAAS was added to the list today.
  w.store.jobResultsOf('ast').record('a1', 'success');

  await w.monitor.check();

  assert.deepEqual(texts(w), [], 'the first sight of a server is not an event');
  assert.equal(w.store.jobResultsOf('baas').of('b1'), 'failed', 'but it is remembered');
});

test('the live slots show the selected server, named on top, and the health lists them all', async () => {
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Success')],
  });

  await w.monitor.check();

  const slots = texts(w);
  assert.ok(slots.length > 0);
  for (const slot of slots) assert.ok(slot.startsWith('🖥 <b>AST</b>\n\n'), slot);
  const health = slots.find((slot) => /Серверы:/.test(slot));
  assert.match(health, /<b>AST<\/b> — показан здесь/);
  assert.match(health, /🟢 BAAS/);

  // The Evidence scan is paid for by the server shown, and only by it.
  assert.ok(w.veeamAst.paths().includes('/api/v1/restorePoints'));
  assert.ok(!w.veeamBaas.paths().includes('/api/v1/restorePoints'));
  assert.ok(!w.veeamBaas.asked.some((req) => req.params?.stateFilter === 'Working'));
});

test('pressing a server in /servers switches the slots to it, in the same message', async () => {
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Warning'), job('b2', 'Mail', 'Success')],
  });
  await w.monitor.check();

  await said(w, '/servers');
  const menu = w.api.sent().at(-1);
  assert.match(menu.text, /✅ <b>AST<\/b> — 🟢 1 задание, всё в порядке/);
  assert.match(menu.text, /▫️ <b>BAAS<\/b> — 🟢 2 задания, с предупреждением: 1/);
  assert.deepEqual(
    menu.reply_markup.inline_keyboard[0].map((button) => [button.text, button.callback_data]),
    [['✅ AST', 'a:srv:ast'], ['BAAS', 'a:srv:baas']],
  );

  w.api.reset();
  await pressed(w, 'a:srv:baas');
  await settled(w);

  const [edited] = w.api.of('editMessageText').filter((edit) => edit.message_id === 9);
  assert.ok(edited, 'the menu is redrawn where it was pressed');
  assert.match(edited.text, /✅ <b>BAAS<\/b>/);
  assert.match(edited.text, /Переключено на <b>BAAS<\/b>/);
  assert.equal(w.store.selectedServer(), 'baas');

  const slots = w.api.of('editMessageText').filter((edit) => edit.message_id !== 9);
  assert.ok(slots.length > 0, 'the live slots were redrawn');
  for (const slot of slots) assert.ok(slot.text.startsWith('🖥 <b>BAAS</b>\n\n'), slot.text);
  assert.ok(w.veeamBaas.paths().includes('/api/v1/restorePoints'), 'and BAAS is scanned now');
});

test('a job\'s Button opens the job on its own server, whichever is selected', async () => {
  const w = twoServers({
    ast: [job('a1', 'SQL Daily', 'Failed')],
    baas: [job('b1', 'Files', 'Success')],
  });

  await said(w, '/digest');
  const summary = w.api.sent().at(-1);
  // Named as the daily one is: the very same event, rendered instead of sent.
  assert.match(summary.text, /AST · Veeam: сводка по заданиям/);
  assert.equal(summary.reply_markup.inline_keyboard[0][0].callback_data, 'a:job:ast:a1');

  // Somebody selects BAAS before anybody presses the button above.
  w.store.selectServer('baas');
  w.store.cooldowns.clear('command:read');
  await pressed(w, 'a:job:ast:a1');

  const card = w.api.sent().at(-1);
  assert.ok(card.text.startsWith('🖥 <b>AST</b>'), card.text);
  assert.match(card.text, /SQL Daily/);
});

test('a server that does not answer says so in the menu, and the others go on', async () => {
  const w = twoServers({
    ast: [job('a1', 'SQL Daily', 'Success')],
    baasRoutes: {
      '/api/v1/serverTime': () => {
        throw new Error('connect ETIMEDOUT');
      },
    },
  });
  await w.monitor.check();

  await said(w, '/servers');
  const menu = w.api.sent().at(-1).text;
  assert.match(menu, /<b>AST<\/b> — 🟢 1 задание/);
  assert.match(menu, /<b>BAAS<\/b> — 🔴 не отвечает/);
  assert.ok(!w.veeamBaas.paths().includes('/api/v1/jobs/states'), 'nothing is asked of a server that is down');
});

test('the daily Summary goes out once per server, each saying which', async () => {
  const w = twoServers({
    env: { TELEGRAM_DIGEST_HOUR: String(new Date().getUTCHours()), TELEGRAM_TIMEZONE: 'UTC' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Success')],
  });

  await w.monitor.check();

  const digests = texts(w).filter((text) => /сводка по заданиям/.test(text));
  assert.equal(digests.length, 2);
  assert.ok(digests.some((text) => /AST · Veeam: сводка/.test(text)));
  assert.ok(digests.some((text) => /BAAS · Veeam: сводка/.test(text)));
  const { cooldowns } = w.store.snapshot();
  assert.ok(cooldowns['ast:digest'] > Date.now() && cooldowns['baas:digest'] > Date.now());
});

test('a state file from before the server list is read as the first server\'s', () => {
  const file = path.join(os.tmpdir(), `veeam-servers-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1, chats: {}, topics: {}, cooldowns: {}, liveMessages: {}, answers: {},
    jobResults: { j1: 'failed' },
  }));

  const store = new TelegramStateStore(file, [], 'ast');
  assert.equal(store.jobResultsOf('ast').of('j1'), 'failed');
  assert.equal(store.jobResultsOf('baas').seeded(), false);

  store.keepServers(new Set(['baas']));
  assert.equal(store.jobResultsOf('ast').of('j1'), undefined, 'a server taken off the list is forgotten');
  store.flush();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

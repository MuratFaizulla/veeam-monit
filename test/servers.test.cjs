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
function twoServers({ env = {}, ast = [], baas = [], astRoutes = {}, baasRoutes = {}, stateFile, handlers = {} } = {}) {
  const w = world({ ...TWO, ...env }, handlers, stateFile);
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

/** A key of the menu under the input field: its label arrives as a message of its own. */
let keyId = 500;
const keyed = (w, label, thread = 1) => {
  keyId += 1;
  return {
    id: keyId,
    done: w.updates.handleUpdate({
      update_id: Math.floor(Math.random() * 1e6),
      message: {
        message_id: keyId, message_thread_id: thread, is_topic_message: true, text: label,
        chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
      },
    }),
  };
};

const labels = (markup) => markup.keyboard.map((row) => row.map((key) => key.text));

/** Runs a pass once the one a selection started has finished. */
const settled = async (w) => {
  while ((await w.monitor.check()) === 'busy') await new Promise(setImmediate);
};

const texts = (w) => w.api.sent().map((message) => message.text);

/** 🩺, which opens with how many of the servers are fine. */
const healthOf = (w) => texts(w).find((slot) => /^\S+ <b>(Оба|Все|\d+ из \d+) сервер/u.test(slot));

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
  assert.equal(w.store.jobMemoryOf('baas').resultOf('b1'), 'failed');
  assert.equal(w.store.jobMemoryOf('ast').resultOf('a1'), 'success');
  // The same job id on two servers would be two conditions, not one.
  assert.ok(w.store.snapshot().cooldowns['baas:job:b1:failed'] > Date.now());
});

test('a server added to the list is learned quietly, whatever the others remember', async () => {
  const w = twoServers({
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Failed')],
  });
  // AST has been watched for months; BAAS was added to the list today.
  w.store.jobMemoryOf('ast').remember('a1', 'success');

  await w.monitor.check();

  assert.deepEqual(texts(w), [], 'the first sight of a server is not an event');
  assert.equal(w.store.jobMemoryOf('baas').resultOf('b1'), 'failed', 'but it is remembered');
});

test('the live slots show the selected server, named on top, and the health lists them all', async () => {
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Success')],
  });

  await w.monitor.check();

  // The health is about every server and names each itself; a name on top
  // would say it is about the selected one only.
  const health = healthOf(w);
  const slots = texts(w).filter((slot) => slot !== health);
  assert.ok(slots.length > 0);
  for (const slot of slots) assert.ok(slot.startsWith('🖥 <b>AST</b>\n\n'), slot);
  assert.ok(health.startsWith('🟢 <b>Оба сервера в порядке</b>\n\n'), health);
  // Which one is shown is said in words: ⚪ beside the others read as "off".
  assert.match(health, /^🟢 <b>AST<\/b> · 1 задание · <i>показан в темах<\/i>$/mu);
  assert.match(health, /^🟢 <b>BAAS<\/b> · 1 задание$/mu);

  // The Evidence scan is paid for by the server shown, and only by it.
  assert.ok(w.veeamAst.paths().includes('/api/v1/restorePoints'));
  assert.ok(!w.veeamBaas.paths().includes('/api/v1/restorePoints'));
  assert.ok(!w.veeamBaas.asked.some((req) => req.params?.stateFilter === 'Working'));
});

test('a server selected again has its restore points read at once, unless they were read minutes ago', async () => {
  // Only the selected server is scanned, so one selected again still holds
  // the reading from when it was last shown: up to two hours old at the
  // cadence that keeps the load on Veeam down.
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true', TELEGRAM_PROTECTION_INTERVAL_MIN: '120' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Success')],
  });
  const scans = (veeam) => veeam.paths().filter((path) => path === '/api/v1/restorePoints').length;
  const realNow = Date.now;
  try {
    await w.monitor.check();
    w.monitor.select('baas');
    await settled(w);
    assert.equal(scans(w.veeamBaas), 1, 'BAAS is read when it is first shown');

    w.monitor.select('ast');
    await settled(w);
    assert.equal(scans(w.veeamAst), 1, 'straight back: the reading of a moment ago stands');

    Date.now = () => realNow() + 30 * 60_000;
    w.monitor.select('baas');
    await settled(w);
    assert.equal(scans(w.veeamBaas), 2, 'half an hour on, it is read the moment it is shown');
    await w.monitor.check();
    assert.equal(scans(w.veeamBaas), 2, 'and then keeps to its cadence');
  } finally {
    Date.now = realNow;
  }
});

test('the health gives every server\'s IP address, together under the list', async () => {
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Success')],
  });
  // What each connection resolved the names to.
  w.veeamAst.address = '192.0.2.162';
  w.veeamBaas.address = '198.51.100.123';

  await w.monitor.check();

  // What a network engineer is asked to open, all in one place.
  const health = healthOf(w);
  assert.match(health, /\n\n<b>Адреса:<\/b>\nAST — <code>192\.0\.2\.162<\/code>\nBAAS — <code>198\.51\.100\.123<\/code>\n\n/);
  assert.doesNotMatch(health, /<b>Сервер:<\/b>/, 'one list for every server, not the selected one apart');
});

test('a server in trouble is red in the health whichever is shown, and says what the trouble is', async () => {
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baasRoutes: { '/api/v1/serverTime': () => { throw new Error('connect ECONNREFUSED'); } },
  });

  await w.monitor.check();

  // The one that fell over while another was selected is the one somebody
  // needs to see here: first, and with Veeam's or the network's own words.
  const health = healthOf(w);
  assert.ok(health.startsWith('🟡 <b>1 из 2 серверов в порядке</b>\n\n🔴 <b>BAAS</b> — не отвечает\n<i>'), health);
  assert.match(health, /ECONNREFUSED/u);
  assert.match(health, /^🟢 <b>AST<\/b> · 1 задание · <i>показан в темах<\/i>$/mu);
});

test('the health counts the servers that are fine, and puts the ones in trouble first, saying why', () => {
  const { renderHealth } = require('../dist/live/format');
  const clock = { now: new Date('2026-10-06T03:47:00+05:00'), timezone: 'Asia/Qyzylorda' };
  const server = (name, over = {}) => ({ name, selected: false, reachable: true, authenticated: true, jobs: 10, ...over });
  const health = (servers) => renderHealth({
    reachable: true, authenticated: true, serverUrl: 'https://veeam01.example.com:9419',
    trackedJobs: 112, intervalMs: 60_000, servers,
  }, clock);

  const locked = 'Your account has been locked out for 00:30:00 due to repeated failed log-in attempts. Следующая попытка входа — через 31 мин.';
  const text = health([
    server('veeam01', { selected: true, jobs: 112, address: '192.0.2.10' }),
    server('veeam02', { jobs: 1 }),
    server('veeam04', { authenticated: false, error: locked, address: '198.51.100.20' }),
    server('veeam05', { reachable: null, authenticated: null, jobs: undefined }),
  ]);
  const [headline, list, addresses] = text.split('\n\n');
  assert.equal(headline, '🟡 <b>2 из 4 серверов в порядке</b>');
  assert.deepEqual(list.split('\n'), [
    '🔴 <b>veeam04</b> — вход не выполнен',
    `<i>${locked}</i>`,
    '🟢 <b>veeam01</b> · 112 заданий · <i>показан в темах</i>',
    '🟢 <b>veeam02</b> · 1 задание',
    '⚪ <b>veeam05</b> — ещё не опрошен',
  ]);
  assert.equal(addresses, '<b>Адреса:</b>\nveeam01 — <code>192.0.2.10</code>\nveeam04 — <code>198.51.100.20</code>');

  const headlineOf = (servers) => health(servers).split('\n')[0];
  assert.equal(headlineOf([server('a'), server('b'), server('c')]), '🟢 <b>Все 3 сервера в порядке</b>');
  assert.equal(headlineOf([server('a'), server('b')]), '🟢 <b>Оба сервера в порядке</b>');
  assert.equal(
    headlineOf([server('a'), server('b', { reachable: null, authenticated: null })]),
    '🟢 <b>1 из 2 серверов в порядке, 1 ещё не опрошен</b>',
  );
  assert.equal(headlineOf([server('a', { reachable: false }), server('b', { reachable: false })]), '🔴 <b>0 из 2 серверов в порядке</b>');
  assert.ok(!/Адреса/u.test(health([server('a'), server('b')])), 'no addresses resolved, no list of them');
});

test('the menu under the input field turns into the servers, and a server\'s key switches the slots to it', async () => {
  const w = twoServers({
    env: { TELEGRAM_LIVE: 'true' },
    ast: [job('a1', 'SQL Daily', 'Success')],
    baas: [job('b1', 'Files', 'Warning'), job('b2', 'Mail', 'Success')],
  });
  await w.monitor.check();
  w.api.reset();

  const servers = keyed(w, '🖥 Серверы');
  await servers.done;
  const list = w.api.sent().at(-1);
  assert.match(list.text, /✅ <b>AST<\/b> — 🟢 1 задание, всё в порядке/);
  assert.match(list.text, /▫️ <b>BAAS<\/b> — 🟢 2 задания, с предупреждением: 1/);
  assert.deepEqual(labels(list.reply_markup), [['✅ AST', 'BAAS'], ['⬅️ На главную']]);
  // Only for whoever pressed it: the rest of the group keeps the main menu.
  assert.equal(list.reply_markup.selective, true);
  assert.equal(list.reply_parameters.message_id, servers.id);

  const baas = keyed(w, 'BAAS');
  await baas.done;
  await settled(w);

  const switched = w.api.sent().find((message) => /Показан сервер BAAS/.test(message.text));
  assert.ok(switched, 'the switch is confirmed');
  assert.deepEqual(labels(switched.reply_markup)[0], ['🖥 Серверы'], 'and the main menu is back');
  assert.equal(switched.reply_parameters.message_id, baas.id);
  assert.equal(w.store.selectedServer(), 'baas');

  const edits = w.api.of('editMessageText').map((edit) => edit.text);
  const health = edits.filter((text) => /^\S+ <b>(Оба|Все|\d+ из \d+) сервер/u.test(text)).at(-1);
  const slots = edits.filter((text) => text !== health);
  assert.ok(slots.length > 0, 'the live slots were redrawn');
  for (const slot of slots) assert.ok(slot.startsWith('🖥 <b>BAAS</b>\n\n'), slot);
  assert.match(health, /^🟢 <b>BAAS<\/b> · 2 задания · <i>показан в темах<\/i>$/mu, 'and 🩺 says which is shown');
  assert.ok(w.veeamBaas.paths().includes('/api/v1/restorePoints'), 'and BAAS is scanned now');
});

test('the keys of the main menu are answered as the commands they stand for', async () => {
  const w = twoServers({ ast: [job('a1', 'SQL Daily', 'Failed')] });
  await w.monitor.check();
  w.api.reset();

  await keyed(w, '📊 Сводка').done;
  assert.match(w.api.sent().at(-1).text, /AST · Veeam: сводка по заданиям/);

  const home = keyed(w, '⬅️ На главную');
  await home.done;
  const menu = w.api.sent().at(-1);
  assert.deepEqual(labels(menu.reply_markup), [
    ['🖥 Серверы'],
    ['📊 Сводка', '🔄 Проверить'],
    ['📦 Задание', '🗂 Точки'],
    ['🩺 Статус', '📑 Темы'],
    ['🧹 Очистить', '🤖 Помощь'],
  ]);
  assert.equal(menu.reply_markup.is_persistent, true);
  assert.equal(menu.reply_parameters.message_id, home.id);

  // Outside General the keys are ignored, like every command.
  w.api.reset();
  await keyed(w, '🩺 Статус', 77).done;
  assert.deepEqual(w.api.sent(), []);
});

test('a job\'s keys offer the jobs that need somebody, as the commands do asked with no name', async () => {
  // Two worlds each, so the rate limit armed by one cannot answer the other.
  const answerTo = async (said) => {
    const w = twoServers({ ast: [job('a1', 'SQL Daily', 'Failed')] });
    await keyed(w, said).done;
    return w.api.sent().at(-1);
  };

  for (const [label, command] of [['📦 Задание', '/job'], ['🗂 Точки', '/points'], ['📑 Темы', '/topics']]) {
    const [key, typed] = [await answerTo(label), await answerTo(command)];
    assert.equal(key.text, typed.text, `${label} = ${command}`);
    assert.deepEqual(key.reply_markup?.inline_keyboard, typed.reply_markup?.inline_keyboard);
  }
  const card = await answerTo('📦 Задание');
  assert.match(card.text, /Укажите задание/);
  assert.equal(card.reply_markup.inline_keyboard[0][0].text, 'SQL Daily', 'and offers the one that failed');
});

test('the 🧹 key asks first, and only its Button empties General', async () => {
  const w = twoServers({ ast: [job('a1', 'SQL Daily', 'Success')] });
  await keyed(w, '/status').done;
  w.api.reset();

  await keyed(w, '🧹 Очистить').done;
  const question = w.api.sent().at(-1);
  assert.match(question.text, /Очистить General\?/);
  assert.deepEqual(question.reply_markup.inline_keyboard, [[{ text: '🧹 Да, очистить', callback_data: 'a:clr' }]]);
  assert.deepEqual([...w.api.of('deleteMessages'), ...w.api.of('deleteMessage')], [], 'nothing is deleted yet');

  w.api.reset();
  await pressed(w, 'a:clr');
  const deleted = [
    ...w.api.of('deleteMessages').flatMap((call) => call.message_ids),
    ...w.api.of('deleteMessage').map((call) => call.message_id),
  ];
  assert.ok(deleted.length > 0, 'the Button clears');
  assert.match(w.api.sent().at(-1).text, /Убрано/);
});

test('the menu is put under the input field once, not at every start', async () => {
  const w = twoServers({
    // A webhook world: long polling would leave a loop running for as long as the test process lives.
    env: { TELEGRAM_WEBHOOK_URL: 'https://veeam.example.com', TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-for-tests-0123456789' },
    handlers: {
      getChat: (payload) => ({ ok: true, result: { id: Number(payload.chat_id), type: 'supergroup', is_forum: true } }),
    },
  });

  await w.updates.onModuleInit();
  const offered = w.api.sent().filter((message) => message.reply_markup?.keyboard);
  assert.equal(offered.length, 1);
  assert.match(offered[0].text, /Меню Veeam Monitor/);
  assert.equal(offered[0].reply_markup.selective, undefined, 'for everybody in the group');

  w.api.reset();
  await w.updates.onModuleInit();
  assert.deepEqual(w.api.sent().filter((message) => message.reply_markup?.keyboard), [], 'a restart says nothing');
});

test('/clear empties General of everything the bot saw there, and ends on the menu', async () => {
  // It used to take back only the bot's own answers. What people typed stayed —
  // a column of "/digest" and "/status" with nothing after them — and so did
  // every message carrying the menu, and the events posted to General.
  const w = twoServers({
    env: { TELEGRAM_ROUTING_MODE: 'single', TELEGRAM_SEVERITIES: 'info,success,warning,critical' },
    ast: [job('a1', 'SQL Daily', 'Success')],
  });
  const forum = { id: Number(CHAT), type: 'supergroup', is_forum: true };
  let next = 700;
  const inGeneral = (text) => {
    next += 1;
    return w.updates.handleUpdate({
      update_id: next,
      message: { message_id: next, message_thread_id: 1, is_topic_message: true, text, chat: forum },
    });
  };

  await inGeneral('/status');
  await inGeneral('всем привет');
  await inGeneral('🖥 Серверы');
  await inGeneral('⬅️ На главную');
  await w.service.notify({ kind: 'infrastructure', severity: 'info', subject: 'monitor', title: 'Мониторинг запущен' });
  // And an alert, which lives in its own topic and is not General's to clear.
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'SQL Daily: ОШИБКА' });
  const before = w.api.calls
    .filter((call) => call.method === 'sendMessage')
    .map((call, index) => ({ id: 1001 + index, thread: call.payload.message_thread_id }));
  w.api.reset();

  await inGeneral('/clear');

  const deleted = [
    ...w.api.of('deleteMessages').flatMap((call) => call.message_ids),
    ...w.api.of('deleteMessage').map((call) => call.message_id),
  ];
  for (const id of [701, 702, 703, 704, 705]) assert.ok(deleted.includes(id), `what people said goes: ${id}`);
  for (const { id, thread } of before) {
    if (thread === undefined) assert.ok(deleted.includes(id), `the bot's message ${id} in General goes`);
    else assert.ok(!deleted.includes(id), `the message ${id} in topic ${thread} stays`);
  }

  const last = w.api.sent().at(-1);
  assert.equal(w.api.sent().length, 1, 'one message is left in General');
  assert.match(last.text, /Убрано/);
  assert.ok(last.reply_markup.keyboard, 'and it puts the menu back under the input field');
  assert.equal(last.reply_markup.selective, undefined, 'for everybody');
  assert.equal(w.store.menuOf(CHAT).messageId, 1001 + before.length, 'it is the menu the bot now keeps');
});

test('the menu comes back by itself when its message is deleted, and only then', async () => {
  let answer = 'there';
  const w = twoServers({
    handlers: {
      editMessageReplyMarkup: () => ({
        there: { ok: false, error_code: 400, description: "Bad Request: message can't be edited" },
        gone: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
        flaky: { ok: false, error_code: 502, description: 'Bad Gateway' },
      })[answer],
    },
  });
  const menus = () => w.api.sent().filter((message) => message.reply_markup?.keyboard);

  await w.commands.keepMenu();
  assert.equal(menus().length, 1, 'posted when the chat has none');
  const first = w.store.menuOf(CHAT).messageId;

  for (const state of ['there', 'flaky']) {
    answer = state;
    w.api.reset();
    await w.commands.keepMenu();
    assert.deepEqual(menus(), [], `${state}: left alone`);
    assert.equal(w.store.menuOf(CHAT).messageId, first);
  }

  answer = 'gone';
  w.api.reset();
  await w.commands.keepMenu();
  assert.equal(menus().length, 1, 'deleted: posted again');
  assert.equal(menus()[0].reply_markup.selective, undefined, 'for everybody');
  assert.notEqual(w.store.menuOf(CHAT).messageId, first);
});

test('a job\'s Button opens the job on its own server, whichever is selected', async () => {
  // Buttons under a message are still how a job is opened.
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

test('a server that does not answer says so in the server list, and the others go on', async () => {
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
  assert.equal(store.jobMemoryOf('ast').resultOf('j1'), 'failed');
  assert.equal(store.jobMemoryOf('baas').seeded(), false);

  store.keepServers(new Set(['baas']));
  assert.equal(store.jobMemoryOf('ast').resultOf('j1'), undefined, 'a server taken off the list is forgotten');
  store.flush();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

test('a server taken off the list takes the runs being followed on it along', () => {
  const file = path.join(os.tmpdir(), `veeam-servers-${Math.random().toString(36).slice(2)}.json`);
  const store = new TelegramStateStore(file, [], 'ast');
  for (const server of ['ast', 'baas']) {
    store.jobMemoryOf(server).remember('j1', 'failed');
    store.jobMemoryOf(server).follow('j1', { attempt: 1, retryBy: Date.now() + 60_000 });
  }

  store.keepServers(new Set(['ast']));

  // Remembered only through the result, the run used to stay in the file for
  // good, and come back to be followed if the server was ever listed again.
  const { jobResults, retrying } = store.snapshot();
  assert.deepEqual(Object.keys(jobResults), ['ast']);
  assert.deepEqual(Object.keys(retrying), ['ast']);
  assert.equal(store.jobMemoryOf('baas').retryingOf('j1'), undefined);
  assert.equal(store.jobMemoryOf('ast').retryingOf('j1').attempt, 1, 'the server kept keeps its run');
  store.flush();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

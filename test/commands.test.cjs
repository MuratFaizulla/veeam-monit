const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT, SERVER, world, answersWorld, exchange, configuredJob, job, idleMonitor, idleAnswers,
  TelegramCommandsService, TelegramGeneral, TelegramUpdatesService, TelegramChatAccess,
} = require('./world.cjs');
const { COMMANDS, BOT_COMMANDS } = require('../dist/updates/commands');

/* ------------------------------------------------------------------ *
 * Commands, declared once
 * ------------------------------------------------------------------ */

const FORUM = { id: Number(CHAT), type: 'supergroup', is_forum: true };

/** Somebody typed this in General. */
const typed = (w, text) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  message: { message_id: 50, message_thread_id: 1, is_topic_message: true, text, chat: FORUM },
});

/** Somebody pressed a Button under one of the bot's answers in General. */
const pressed = (w, data) => w.updates.handleUpdate({
  update_id: Math.floor(Math.random() * 1e6),
  callback_query: {
    id: 'cb-commands',
    data,
    message: { message_id: 60, message_thread_id: 1, is_topic_message: true, chat: FORUM },
  },
});

/** The /help answer, split into its paragraphs. */
const helpParagraphs = async () => {
  const w = world();
  await typed(w, '/help');
  return w.api.sent().at(-1).text.split('\n\n');
};

const paragraphOf = (paragraphs, name) =>
  paragraphs.find((paragraph) => paragraph.startsWith(`<b>/${name}`));

test('every declared command is in the menu and has a paragraph in /help', async () => {
  const paragraphs = await helpParagraphs();

  assert.deepEqual(
    BOT_COMMANDS.map((entry) => entry.command),
    ['status', 'menu', 'servers', 'digest', 'job', 'points', 'repos', 'check', 'topics', 'clear', 'help'],
  );
  for (const { name } of COMMANDS) {
    assert.ok(BOT_COMMANDS.some((entry) => entry.command === name), `/${name} в меню`);
    assert.ok(paragraphOf(paragraphs, name), `/${name} описан в /help`);
  }
});

test('the menu and /help agree that commands work in General', async () => {
  // A command is answered only in General (see 'commands and old buttons in
  // other topics are ignored'). The menu once promised /clear "в этой теме"
  // while /help said General, and only /help was telling the truth.
  const paragraphs = await helpParagraphs();

  for (const { command, description } of BOT_COMMANDS) {
    const paragraph = paragraphOf(paragraphs, command);
    assert.doesNotMatch(description, /(этой|текущей) тем/, `меню /${command}`);
    assert.doesNotMatch(paragraph, /(этой|текущей) тем/, `/help /${command}`);
    assert.equal(
      /General/.test(description),
      /General/.test(paragraph),
      `/${command}: меню и /help называют одно и то же место`,
    );
  }
});

test('a command with a Button answers the same whether typed or pressed', async () => {
  const { encode } = require('../dist/updates/keyboard');
  const withButton = COMMANDS.filter((command) => command.button);

  // The five Buttons under the bot's answers that stand for a command. A job's
  // own carry an id and are not commands.
  assert.deepEqual(
    withButton.map(({ name, button }) => [name, button]),
    [['status', 'status'], ['digest', 'summary'], ['check', 'check'], ['clear', 'clear'], ['help', 'help']],
  );
  for (const { name, button } of withButton) {
    // Two worlds, so the rate limit armed by one cannot answer the other.
    const typing = world();
    const pressing = world();
    await typed(typing, `/${name}`);
    await pressed(pressing, encode({ kind: button }));

    const [asked, got] = [typing.api.sent(), pressing.api.sent()];
    assert.equal(got.length, 1, `кнопка ${button} отвечена`);
    assert.equal(got[0].text, asked[0].text, `кнопка ${button} = /${name}`);
    assert.deepEqual(got[0].reply_markup, asked[0].reply_markup);
  }
});

test('everything the menu offers is answered, and so are the hidden spellings', async () => {
  for (const { command } of BOT_COMMANDS) {
    const w = world();
    await typed(w, `/${command}`);
    await w.commands.settled();
    // /repos says the file is coming, then sends it.
    assert.equal(w.api.sent().length, 1, `/${command} отвечен`);
    assert.equal(w.api.of('sendDocument').length, command === 'repos' ? 1 : 0, `/${command} и файл`);
  }

  // Not in the menu, never in /help: /start is what Telegram sends on "Start",
  // and is answered with the menu, as the company's other bots answer it;
  // /chatid is what people type when setting the bot up, and is /status.
  for (const [alias, meant] of [['/start', '/menu'], ['/chatid', '/status']]) {
    const expected = world();
    await typed(expected, meant);
    const w = world();
    await typed(w, alias);
    assert.equal(w.api.sent().at(-1).text, expected.api.sent().at(-1).text, `${alias} = ${meant}`);
    assert.ok(!BOT_COMMANDS.some((entry) => `/${entry.command}` === alias), `${alias} не в меню`);
  }
});

/* ------------------------------------------------------------------ *
 * Hearing an Update and interpreting it are two modules
 * ------------------------------------------------------------------ */

test('a command is answered with no polling loop or webhook anywhere near it', async () => {
  // A polling world — no TELEGRAM_WEBHOOK_URL — and no intake constructed at
  // all. When interpretation lived in the class that owns the polling loop, a
  // test that started that class on a world like this never finished.
  const w = world();
  const commands = new TelegramCommandsService(w.config, w.transport, w.topics, w.store, idleMonitor(), idleAnswers(), new TelegramGeneral(w.transport, w.store, w.posted));

  await commands.answer({
    update_id: 1,
    message: { message_id: 5, text: '/digest', chat: FORUM },
  });

  assert.equal(w.api.sent().at(-1).text, 'сводка');
  assert.deepEqual(
    w.api.calls.map((call) => call.method).filter((method) => method !== 'sendMessage'),
    [],
    'no getUpdates, no setWebhook, no setMyCommands',
  );
  assert.equal(typeof commands.onModuleInit, 'undefined', 'nothing for Nest to start');
});

/** Intake over a world, with the commands module replaced by a list of what it was handed. */
const intakeOf = (w) => {
  const handed = [];
  const intake = new TelegramUpdatesService(w.config, w.transport, w.topics, w.store, {
    answer: async (update, access) => { handed.push({ update, access }); },
  }, new TelegramChatAccess(w.config, w.transport));
  return { intake, handed };
};

test('intake registers the configured chat and its topics, then hands the Update on', async () => {
  const w = world();
  const { intake, handed } = intakeOf(w);
  const update = {
    update_id: 3,
    message: {
      message_id: 7, message_thread_id: 88, chat: FORUM,
      forum_topic_created: { name: 'Своя тема' },
    },
  };

  await intake.handleUpdate(update);

  assert.equal(w.topics.list(CHAT)['Своя тема'], 88, 'тема запомнена');
  assert.deepEqual(handed, [{ update, access: 'recipient' }], 'и Update передан толкованию как есть');
  assert.deepEqual(w.api.sent(), [], 'intake сам ничего не отвечает');
});

test('a group the bot was added to by somebody else is left, and learns nothing', async () => {
  const w = world();
  const { intake, handed } = intakeOf(w);
  const stranger = { id: -1009999, type: 'supergroup', is_forum: true, title: 'Другая группа' };

  await intake.handleUpdate({
    update_id: 4,
    my_chat_member: { chat: stranger, new_chat_member: { status: 'member' } },
  });
  await intake.handleUpdate({
    update_id: 5,
    message: {
      message_id: 8, message_thread_id: 88, chat: stranger, text: '/digest',
      forum_topic_created: { name: 'Своя тема' },
    },
  });

  assert.deepEqual(w.api.of('leaveChat').map((call) => call.chat_id), [stranger.id, stranger.id]);
  assert.ok(!w.store.chats().some(([id]) => id === String(stranger.id)), 'не стал получателем');
  assert.deepEqual(w.topics.list(String(stranger.id)), {}, 'его темы не запомнены');
  assert.deepEqual(handed, [], 'и ничего не передано толкованию');

  // Being removed from it is the end of it, not another goodbye.
  await intake.handleUpdate({
    update_id: 6,
    my_chat_member: { chat: stranger, new_chat_member: { status: 'left' } },
  });
  assert.equal(w.api.of('leaveChat').length, 2);
});

test('a private chat is answered only for somebody in the configured group, and never sent alerts', async () => {
  const w = world({}, {
    getChatMember: (payload) => ({
      ok: true,
      result: { status: payload.user_id === 42 ? 'member' : 'left' },
    }),
  });
  const { intake, handed } = intakeOf(w);
  const colleague = { id: 42, type: 'private', first_name: 'Коллега' };
  const stranger = { id: 99, type: 'private', first_name: 'Кто-то' };

  await intake.handleUpdate({ update_id: 7, message: { message_id: 1, text: '/start', chat: colleague } });
  await intake.handleUpdate({ update_id: 8, message: { message_id: 1, text: '/start', chat: stranger } });
  await intake.handleUpdate({ update_id: 9, message: { message_id: 2, text: '/digest', chat: colleague } });

  assert.deepEqual(handed.map(({ update, access }) => [update.message.chat.id, access]), [[42, 'member'], [42, 'member']]);
  // Asked of Telegram once, then remembered.
  assert.equal(w.api.of('getChatMember').filter((call) => call.user_id === 42).length, 1);
  assert.deepEqual(w.api.of('leaveChat'), [], 'a private chat is not "left"');
  assert.deepEqual(w.store.chats().map(([id]) => id), [CHAT], 'neither private chat receives anything');
});

test('a colleague\'s private chat gets the menu and the commands', async () => {
  const w = world({}, {
    getChatMember: () => ({ ok: true, result: { status: 'administrator' } }),
  });
  const colleague = { id: 42, type: 'private', first_name: 'Коллега' };

  await w.updates.handleUpdate({ update_id: 10, message: { message_id: 3, text: '/start', chat: colleague } });

  const menu = w.api.sent().at(-1);
  assert.equal(menu.chat_id, '42');
  assert.match(menu.text, /Меню Veeam Monitor/);
  assert.ok(menu.reply_markup.keyboard, 'the keyboard under the input field');
});

test('before any chat is configured, the bot says only the chat\'s id', async () => {
  const w = world({ TELEGRAM_CHAT_IDS: '' });
  const newGroup = { id: -1005555, type: 'supergroup', title: 'Новая группа' };

  for (const [index, text] of ['/digest', '/chatid'].entries()) {
    await w.updates.handleUpdate({ update_id: 20 + index, message: { message_id: 30 + index, text, chat: newGroup } });
  }

  const sent = w.api.sent();
  assert.equal(sent.length, 1, '/digest is not answered');
  assert.match(sent[0].text, /ID этого чата: <code>-1005555<\/code>/);
  assert.doesNotMatch(sent[0].text, /Veeam отвечает|Учётная запись/, 'nothing about the estate');
  assert.deepEqual(w.api.of('leaveChat'), [], 'and nobody is left while the bot is being set up');
  assert.deepEqual(w.store.chats(), []);
});

/* ------------------------------------------------------------------ *
 * The HTTP endpoints: who may call them
 *
 * The keys were checked by guards no test ever called: a guard that let an
 * empty key through, or a route that lost its guard, would have passed
 * everything.
 * ------------------------------------------------------------------ */

const { TelegramAdminGuard, TelegramWebhookGuard } = require('../dist/updates/access.guard');
const { TelegramController } = require('../dist/updates/telegram.controller');

const ADMIN_KEY = 'admin-key-for-tests-0123456789abcdef';
const WEBHOOK_SECRET = 'webhook-secret-for-tests-0123456789';

const guarded = (Guard, secrets) => new Guard({ getOrThrow: () => ({ adminKey: '', webhookSecret: '', ...secrets }) });

/** Whether `guard` lets a request with these headers through; a refusal is a 403. */
const lets = (guard, headers) => {
  try {
    return guard.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) });
  } catch (error) {
    assert.equal(error.getStatus?.(), 403, error.message);
    return false;
  }
};

test('an operator endpoint opens to the admin key and to nothing else', () => {
  const guard = guarded(TelegramAdminGuard, { adminKey: ADMIN_KEY, webhookSecret: WEBHOOK_SECRET });

  assert.equal(lets(guard, { 'x-telegram-admin-key': ADMIN_KEY }), true);
  assert.equal(lets(guard, {}), false, 'no key');
  assert.equal(lets(guard, { 'x-telegram-admin-key': '' }), false);
  assert.equal(lets(guard, { 'x-telegram-admin-key': ADMIN_KEY.replace(/.$/, 'X') }), false, 'one character off');
  assert.equal(lets(guard, { 'x-telegram-admin-key': ADMIN_KEY.slice(0, -1) }), false, 'a prefix');
  assert.equal(lets(guard, { 'x-telegram-admin-key': `${ADMIN_KEY}0` }), false, 'longer');
  assert.equal(lets(guard, { 'x-telegram-admin-key': [ADMIN_KEY] }), false, 'not a single header');
  assert.equal(lets(guard, { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }), false, 'the webhook secret is not the admin key');
});

test('with no key configured, every guarded endpoint is closed, not open', () => {
  const admin = guarded(TelegramAdminGuard, {});
  const webhook = guarded(TelegramWebhookGuard, {});
  for (const value of ['', 'anything', undefined]) {
    assert.equal(lets(admin, { 'x-telegram-admin-key': value }), false);
    assert.equal(lets(webhook, { 'x-telegram-bot-api-secret-token': value }), false);
  }
});

test('the webhook opens to the secret Telegram sends, and not to the admin key', () => {
  const guard = guarded(TelegramWebhookGuard, { adminKey: ADMIN_KEY, webhookSecret: WEBHOOK_SECRET });

  assert.equal(lets(guard, { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }), true);
  assert.equal(lets(guard, { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET.slice(1) }), false);
  assert.equal(lets(guard, { 'x-telegram-admin-key': ADMIN_KEY }), false);
});

test('every Telegram endpoint carries a key guard: the webhook Telegram\'s, the rest the admin key', () => {
  const routes = Object.getOwnPropertyNames(TelegramController.prototype)
    .filter((name) => name !== 'constructor')
    .filter((name) => Reflect.getMetadata('path', TelegramController.prototype[name]) !== undefined);
  assert.ok(routes.length >= 8, `routes found: ${routes.join(', ')}`);
  for (const name of routes) {
    const guards = Reflect.getMetadata('__guards__', TelegramController.prototype[name]) ?? [];
    const expected = name === 'webhook' ? TelegramWebhookGuard : TelegramAdminGuard;
    assert.ok(guards.includes(expected), `${name} is guarded by ${expected.name}`);
  }
});

/* ------------------------------------------------------------------ *
 * General: what was said there, the menu kept there, and taking it back
 * ------------------------------------------------------------------ */

test('General takes back what was heard and said in it, and what Telegram was not answering for on a later pass', async () => {
  const refused = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted for everyone" };
  let busy = true;
  const w = world({}, {
    // One message the bot may not delete fails the whole batch, and the rest
    // go one at a time.
    deleteMessages: () => refused,
    deleteMessage: (payload) => {
      if (payload.message_id === 12) return refused;
      if (payload.message_id === 13 && busy) {
        return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } };
      }
      return undefined;
    },
  });
  const chat = { id: Number(CHAT), type: 'supergroup' };
  for (const id of [11, 12, 13]) w.general.heard({ message_id: id, chat });
  const answer = await w.general.say({ chatId: CHAT }, { lines: ['ответ'] });

  // 11 is the "/clear" itself: taken back, not counted.
  assert.deepEqual(await w.general.clear({ chatId: CHAT }, 11), { removed: 1, stuck: 1, pending: 1 });
  assert.deepEqual(w.api.of('deleteMessage').map((payload) => payload.message_id).sort((a, b) => a - b), [11, 12, 13, answer]);
  assert.equal(await w.general.clear({ chatId: CHAT }), 'nothing', 'what was tried is not counted again');

  // A 429 used to be counted with the refusals, and the message forgotten.
  busy = false;
  w.api.reset();
  await w.general.keepMenu();
  assert.deepEqual(w.api.of('deleteMessage').map((payload) => payload.message_id), [13], 'the refused one is not asked again');
  w.api.reset();
  await w.general.keepMenu();
  assert.deepEqual(w.api.of('deleteMessage'), [], 'and the one gone, not either');
});

test('a menu of an older layout is deleted on a later pass when Telegram did not answer for it', async () => {
  // Its deletion was asked once and the answer ignored: one dropped
  // connection, and the old menu stayed beside the new one for good.
  let reachable = false;
  const w = world({}, {
    deleteMessage: () => {
      if (!reachable) throw new Error('socket hang up');
    },
  });
  await w.general.keepMenu();
  const old = w.store.menuOf(CHAT).messageId;
  w.store.rememberMenu(CHAT, 'a layout of an older version', old);

  await w.general.keepMenu();
  assert.notEqual(w.store.menuOf(CHAT).messageId, old, 'the new menu is posted');
  reachable = true;
  w.api.reset();
  await w.general.keepMenu();
  assert.deepEqual(w.api.of('deleteMessage').map((payload) => payload.message_id), [old], 'the old one goes next time');
  assert.deepEqual(w.api.sent(), []);
});

test('a chat that removed the bot is let go by General, as by the alerts', async () => {
  // The menu is looked at every few minutes and posted when it is missing; in
  // a chat the bot was removed from, both are answered 403, for ever.
  const kicked = { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' };
  for (const [way, menuHeld] of [['posting the menu', false], ['looking at the menu', true]]) {
    let removed = false;
    const answer = () => (removed ? kicked : undefined);
    const w = world({}, { sendMessage: answer, editMessageReplyMarkup: answer });
    if (menuHeld) await w.general.keepMenu();

    removed = true;
    w.api.reset();
    await w.general.keepMenu();
    assert.deepEqual(w.store.chats(), [], `${way}: the chat is let go`);

    w.api.reset();
    await w.general.keepMenu();
    assert.deepEqual(w.api.calls, [], `${way}: and nothing more is asked of it`);
  }
});

/* ------------------------------------------------------------------ *
 * An answer, its Buttons and the menu
 *
 * What an answer says is the estate's (estate.test.cjs). What it offers next,
 * and where it is said, is the commands': asked here of answers about one
 * server, with no cycle behind them.
 * ------------------------------------------------------------------ */

/** The Selected server's Evidence, read as a cycle reads it: what /points answers from. */
const scanned = async (w) => w.evidence.refresh(true, await w.server.reader.jobStates());

test('a button and its reader cannot disagree about what it means', () => {
  const { encode, decode } = require('../dist/updates/keyboard');
  const { BOT_COMMANDS } = require('../dist/updates/commands');

  for (const action of [{ kind: 'summary' }, { kind: 'check' }, { kind: 'help' }, { kind: 'status' }, { kind: 'clear' }]) {
    assert.deepEqual(decode(encode(action)), action, `${action.kind} выживает круг`);
  }
  // The longest key configuration allows, beside a GUID.
  const job = { kind: 'job', id: '1e218e3f-9e08-4e28-ae89-06077422eddf', server: 'veeam01-backup-a' };
  assert.deepEqual(decode(encode(job)), job, 'сервер и GUID помещаются в 64 байта Telegram');
  const points = { ...job, kind: 'points' };
  assert.deepEqual(decode(encode(points)), points, 'и для точек задания');
  assert.deepEqual(decode('a:pts:1e218e3f-9e08-4e28-ae89-06077422eddf'), {
    kind: 'points', id: '1e218e3f-9e08-4e28-ae89-06077422eddf',
  });
  // A job's Button from before there was a list names no server.
  assert.deepEqual(decode('a:job:1e218e3f-9e08-4e28-ae89-06077422eddf'), {
    kind: 'job', id: '1e218e3f-9e08-4e28-ae89-06077422eddf',
  });

  // A button from a version that had actions this one does not.
  assert.equal(decode('a:whatever'), undefined);
  assert.equal(decode(undefined), undefined);

  // The menu names only commands the bot actually answers.
  assert.deepEqual(
    BOT_COMMANDS.map((c) => c.command).sort(),
    ['check', 'clear', 'digest', 'help', 'job', 'menu', 'points', 'repos', 'servers', 'status', 'topics'],
  );
});

test('the command menu is registered with Telegram at startup', async () => {
  // A webhook world on purpose: long polling would leave a loop running for as
  // long as the test process lives.
  const w = world({
    TELEGRAM_WEBHOOK_URL: 'https://veeam.example.com',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-for-tests-0123456789',
  });

  await w.updates.onModuleInit();

  const published = w.api.of('setMyCommands').at(-1);
  assert.ok(published, 'меню отправлено в Bot API');
  assert.ok(published.commands.some((c) => c.command === 'job' && /имени/.test(c.description)));
  // Without this Telegram never delivers a press, and every button is dead.
  assert.ok(w.api.of('setWebhook').at(-1).allowed_updates.includes('callback_query'));
});

test('a summary asked for in General is answered in General', async () => {
  const w = answersWorld({ TELEGRAM_ROUTING_MODE: 'single' }, [job('1', 'SQL Daily', 'Success')]);

  await w.updates.handleUpdate({
    update_id: 7,
    message: {
      message_id: 1,
      text: '/digest',
      chat: FORUM,
    },
  });

  // Routed as an event, a clean summary would land in the recoveries topic by
  // its severity — nowhere near whoever asked for it. An answer is not an event.
  const reply = w.api.sent().at(-1);
  assert.match(reply.text, /сводка по заданиям/);
  assert.equal(reply.message_thread_id, undefined, 'в General, а не в теме по severity');
  assert.equal(w.api.of('createForumTopic').length, 0, 'и без создания темы');
});

test('the summary offers the jobs it just named', async () => {
  const w = answersWorld({}, [
    job('1', 'SQL Daily', 'Failed'),
    job('2', 'Files', 'Success'),
    job('3', 'Exchange', 'Warning'),
  ]);

  await typed(w, '/digest');

  const rows = w.api.sent().at(-1).reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((row) => row[0].text), ['SQL Daily', 'Exchange', '🔄 Обновить']);
  // Addressed by id: a name would not fit the 64 bytes, and would open the
  // wrong job if the estate changed between the message and the press. And by
  // server, which may no longer be the one selected when it is pressed.
  assert.equal(rows[0][0].callback_data, `a:job:${SERVER}:1`);
});

test('pressing a job button opens that job, without anybody typing a name', async () => {
  const w = configuredJob();

  // A Button from before there was a list: no server, so the first one.
  await pressed(w, 'a:job:1');

  const sent = w.api.sent().at(-1);
  assert.equal(sent.message_thread_id, undefined, 'ответ в General');
  assert.match(sent.text, /OPS_ERP_APP_DB1/);
  assert.match(sent.text, /Расписание:<\/b> пн, ср, пт в 03:12/);
  // And the card offers its own refresh, so the loop closes, and its month as a PDF.
  assert.deepEqual(
    sent.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    [`a:job:${SERVER}:1`, `a:pts:${SERVER}:1`, 'a:sum', `a:rpt:${SERVER}:1`],
  );
});

test('a press is acknowledged before the work, not after', async () => {
  const w = answersWorld({}, [job('1', 'SQL Daily', 'Success')]);

  await pressed(w, 'a:sum');

  // Telegram spins on the presser's screen until this is answered, so it must
  // not wait behind a Veeam read.
  const order = w.api.calls.map((call) => call.method);
  assert.equal(order[0], 'answerCallbackQuery');
  assert.ok(order.includes('sendMessage'));
});

test('a button this version does not know is acknowledged and ignored', async () => {
  const w = world();

  await pressed(w, 'a:from-a-future-version');

  assert.equal(w.api.of('answerCallbackQuery').length, 1, 'спиннер снят');
  assert.deepEqual(w.api.sent(), [], 'и ничего не отвечено наугад');
});

/** The Buttons under a message, by what they ask. */
const pressedBy = (message) => message.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);

test('/points with a name says at once that the PDF is coming, then sends it with what it found and the Buttons to ask again or open the card', async () => {
  const w = exchange({}, answersWorld);
  await scanned(w);

  await typed(w, '/points exchange');
  await w.commands.settled();

  const [note] = w.api.sent();
  assert.equal(note.message_thread_id, undefined, 'answered in General');
  assert.equal(note.text, '⏳ <b>Готовлю PDF по точкам OPS_Exchange</b> — несколько секунд.');
  const order = w.api.calls.map((call) => call.method).filter((method) => method === 'sendMessage' || method === 'sendDocument');
  assert.deepEqual(order, ['sendMessage', 'sendDocument'], 'first the note, then the file');
  assert.ok(w.api.of('sendChatAction').some((call) => call.action === 'upload_document'));

  const [sent] = w.api.of('sendDocument');
  assert.match(sent.document.filename, /^Точки OPS_Exchange \d\d\.\d\d\.\d{4}\.pdf$/);
  // What 🛡 says of the job, its newest point and how far back it goes — the point a failed run left is none — and when it was read.
  const lines = sent.caption.split('\n');
  assert.equal(lines[0], '🗂 <b>OPS_Exchange</b> · точки восстановления');
  assert.match(lines[1], /^🔴 <b>Нет бэкапа \d+ дн(?:я|ей)<\/b>$/u);
  assert.match(lines[2], /^<i>последний \d\d\.\d\d в \d\d:\d\d<\/i>$/u);
  assert.match(lines[3], /^Последняя точка \d\d\.\d\d \d\d:\d\d · откат на 1 точку, до \d\d\.\d\d \d\d:\d\d$/u);
  assert.match(sent.caption, /\n\n<i>localhost · за 35 дней, на \d\d\.\d\d\.\d{4} \d\d:\d\d\.<\/i>$/u);
  // "<1%" read as a tag once, and Telegram refused the whole answer.
  assert.doesNotMatch(sent.caption, /<(?!\/?(?:b|i|pre|code|a)[ >])/u, 'every < opens a tag Telegram knows');
  assert.deepEqual(pressedBy(sent), [`a:pts:${SERVER}:1`, `a:job:${SERVER}:1`, 'a:sum']);
  assert.equal(w.printer.pages.length, 1);
  assert.match(w.printer.pages[0], /<h1 class="job">OPS_Exchange<\/h1>/);
});

test('/points before the points are read says why at once, and draws nothing', async () => {
  const w = exchange({}, answersWorld);

  await typed(w, '/points exchange');
  await w.commands.settled();

  const sent = w.api.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '🗂 <b>OPS_Exchange</b> · точки восстановления\n\nТочки восстановления ещё не прочитаны.');
  assert.deepEqual(pressedBy(sent[0]), [`a:pts:${SERVER}:1`, `a:job:${SERVER}:1`, 'a:sum'], 'asking again is one press away');
  assert.deepEqual(w.api.of('sendDocument'), []);
  assert.deepEqual(w.printer.pages, []);
});

test('/points without a name offers the jobs that need somebody, and a press sends their points', async () => {
  const w = exchange({}, answersWorld);
  await scanned(w);

  await typed(w, '/points');

  const reply = w.api.sent().at(-1);
  assert.match(reply.text, /Укажите задание/u);
  assert.match(reply.text, /которым нужно внимание/u);
  const offered = reply.reply_markup.inline_keyboard[0][0];
  assert.deepEqual([offered.text, offered.callback_data], ['OPS_Exchange', `a:pts:${SERVER}:1`]);

  // Asking again within seconds is held back; a press a while later is not.
  w.store.cooldowns.clear('command:read');
  await pressed(w, offered.callback_data);
  await w.commands.settled();
  assert.equal(w.api.sent().at(-1).text, '⏳ <b>Готовлю PDF по точкам OPS_Exchange</b> — несколько секунд.');
  assert.match(w.api.of('sendDocument').at(-1).caption, /^🗂 <b>OPS_Exchange<\/b> · точки восстановления\n/u);
});

test('the 🗂 key lists every job by 🛡\'s verdict, the worst first, and a job\'s key sends its points, the list staying for the next', async () => {
  const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const w = answersWorld({}, [
    job('2', 'OPS_Files', 'Success'),
    { ...job('3', 'OPS_Archive', 'Success'), status: 'Disabled' },
    job('1', 'OPS_Exchange', 'Failed'),
  ], {
    '/api/v1/jobs': { data: ['1', '2', '3'].map((id) => ({ id, schedule: { runAutomatically: true } })) },
    '/api/v1/backups': { data: [{ id: 'b1', jobId: '1' }, { id: 'b2', jobId: '2' }] },
    '/api/v1/restorePoints': {
      data: [
        { id: 'p2', backupId: 'b2', name: 'fs-01', creationTime: ago(2) },
        { id: 'p1', backupId: 'b1', name: 'mbx-01', creationTime: ago(24 * 20) },
      ],
    },
    '/api/v1/sessions': { data: [] },
    '/api/v1/jobs/1': { id: '1' },
    '/api/v1/backups/b1/backupFiles': { data: [] },
    '/api/v1/backupInfrastructure/repositories': { data: [] },
    '/api/v1/backupInfrastructure/proxies': { data: [] },
  });
  await scanned(w);

  await typed(w, '🗂 Точки');
  const list = w.api.sent().at(-1);
  assert.equal(list.text, [
    `🗂 <b>Точки восстановления · ${SERVER}</b> — 3`,
    '',
    'Нужно внимание: 🔴 1.',
    '',
    'Выберите задание кнопкой под полем ввода — придёт PDF по его точкам: сначала те, кому нужно внимание, как в 🛡, дальше по алфавиту.',
    'Другой сервер — «🖥 Серверы». По части имени — <code>/points часть имени</code>.',
  ].join('\n'));
  // 🛡's list first, then the fine, then the one nobody expects points from: Veeam's own result says nothing here.
  assert.deepEqual(list.reply_markup.keyboard.map((row) => row.map((key) => key.text)), [
    ['🗂 🔴 OPS_Exchange'], ['🗂 🟢 OPS_Files'], ['🗂 ⚪ OPS_Archive'], ['⬅️ На главную'],
  ]);
  assert.equal(list.reply_markup.selective, true, 'only for whoever pressed it');
  assert.equal(list.reply_parameters.message_id, 50);

  w.api.reset();
  await typed(w, '🗂 🔴 OPS_Exchange');
  await w.commands.settled();
  const [note] = w.api.sent();
  assert.equal(note.text, '⏳ <b>Готовлю PDF по точкам OPS_Exchange</b> — несколько секунд.');
  const [file] = w.api.of('sendDocument');
  assert.match(file.caption, /^🗂 <b>OPS_Exchange<\/b> · точки восстановления\n🔴 <b>Нет бэкапа 20 дней<\/b>\n/u);
  assert.deepEqual(pressedBy(file), [`a:pts:${SERVER}:1`, `a:job:${SERVER}:1`, 'a:sum']);
  // Nothing said since puts another keyboard under the input field: the list is there for the next job.
  assert.deepEqual(w.api.calls.filter((call) => call.payload?.reply_markup?.keyboard), []);
});

test('/points with a name several jobs share offers each, and each opens its points', async () => {
  const w = answersWorld({}, [job('1', 'OPS_Veeam_DB_Kingston', 'Success'), job('2', 'OPS_Kingston_EM_DB', 'Success')]);

  await typed(w, '/points kingston');

  const buttons = w.api.sent().at(-1).reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes(`a:pts:${SERVER}:1`) && buttons.includes(`a:pts:${SERVER}:2`), buttons.join(' '));
  assert.ok(!buttons.some((data) => data.startsWith('a:job:')), 'not the cards it was not asked for');
});

/* ------------------------------------------------------------------ *
 * /clear: General taken back, the record left alone
 * ------------------------------------------------------------------ */

test('/clear takes back the answers and leaves the record alone', async () => {
  const w = world();
  // Alerts, which are a record of something that happened, in their job's topic.
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'SQL Daily — failed' });
  await w.service.notify({ kind: 'job', severity: 'success', subject: 'SQL Daily', title: 'SQL Daily — succeeded' });
  const alerts = w.api.sent().map((_, i) => 1001 + i);
  assert.ok(alerts.length > 0);
  // And some chatter.
  await typed(w, '/status');
  await typed(w, '/help');
  w.api.reset();

  await typed(w, '/clear');

  const deleted = w.api.of('deleteMessages').flatMap((call) => call.message_ids);
  assert.equal(deleted.length, 2, 'оба ответа убраны');
  for (const id of alerts) {
    assert.ok(!deleted.includes(id), `оповещение ${id} не тронуто`);
  }
  assert.match(w.api.sent().at(-1).text, /Убрано 2 сообщения/);
});

test('/clear removes only answers in General', async () => {
  const w = world();
  const inThread = (thread, text) => w.updates.handleUpdate({
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      message_thread_id: thread,
      is_topic_message: thread !== undefined,
      text,
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  });

  await inThread(1, '/help');
  w.store.answerLog.remember(CHAT, 9001, 77);
  await inThread(undefined, '/help');
  w.api.reset();

  await inThread(1, '/clear');

  const deleted = w.api.of('deleteMessages').flatMap((call) => call.message_ids);
  assert.equal(deleted.length, 2);
  assert.ok(!deleted.includes(9001));
  assert.equal(w.api.sent().at(-1).message_thread_id, undefined);
});

test('/clear with nothing to remove says so instead of claiming work', async () => {
  const w = world();

  await typed(w, '/clear');

  assert.equal(w.api.of('deleteMessages').length, 0);
  assert.match(w.api.sent().at(-1).text, /Нечего убирать/);
});

test('/clear says what went, what will not, and what it deletes once Telegram answers', async () => {
  const refused = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" };
  const w = world({}, {
    // One message the bot may not delete fails the whole call, and the rest
    // go one at a time.
    deleteMessages: () => refused,
    deleteMessage: (payload) => ({
      1001: { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
      1002: refused,
      1003: '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
    })[payload.message_id],
  });
  await typed(w, '/status');
  await typed(w, '/help');
  await typed(w, '/topics');
  await typed(w, '/digest');
  w.api.reset();

  await typed(w, '/clear');

  // Four answers: one deleted, one somebody deleted by hand, one the bot may
  // not delete, and one Telegram did not answer for — which used to be counted
  // with the third, and forgotten.
  const answer = w.api.sent().at(-1).text;
  assert.match(answer, /Убрано 2 сообщения/);
  assert.match(answer, /\n1 не поддались — у меня нет права удалять чужие сообщения, или им больше двух суток\./);
  assert.match(answer, /\n1 удалю чуть позже — Telegram сейчас не отвечает\./);
});

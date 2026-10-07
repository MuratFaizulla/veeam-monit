const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT, world, idleMonitor, TelegramCommandsService, TelegramGeneral, TelegramUpdatesService, TelegramChatAccess,
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
    ['status', 'menu', 'servers', 'digest', 'job', 'points', 'check', 'topics', 'clear', 'help'],
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
    assert.equal(w.api.sent().length, 1, `/${command} отвечен`);
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
  const commands = new TelegramCommandsService(w.config, w.transport, w.topics, w.store, idleMonitor(), new TelegramGeneral(w.transport, w.store));

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

test('General takes back what was heard and said in it, and counts what would not go', async () => {
  const refused = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted for everyone" };
  const w = world({}, {
    // One message the bot may not delete fails the whole batch, and the rest
    // go one at a time.
    deleteMessages: () => refused,
    deleteMessage: (payload) => (payload.message_id === 12 ? refused : undefined),
  });
  const chat = { id: Number(CHAT), type: 'supergroup' };
  w.general.heard({ message_id: 11, chat });
  w.general.heard({ message_id: 12, chat });
  const answer = await w.general.say({ chatId: CHAT }, { lines: ['ответ'] });

  // 11 is the "/clear" itself: taken back, not counted.
  assert.deepEqual(await w.general.clear({ chatId: CHAT }, 11), { removed: 1, stuck: 1 });
  assert.deepEqual(w.api.of('deleteMessage').map((payload) => payload.message_id).sort((a, b) => a - b), [11, 12, answer]);
  assert.equal(await w.general.clear({ chatId: CHAT }), 'nothing', 'what was tried is not tried again');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT, world, idleMonitor, TelegramCommandsService, TelegramUpdatesService,
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
    ['status', 'menu', 'servers', 'digest', 'job', 'check', 'topics', 'clear', 'help'],
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

  // The four Buttons under the bot's answers that stand for a command. The
  // fifth kind, a job's own, carries an id and is not a command.
  assert.deepEqual(
    withButton.map(({ name, button }) => [name, button]),
    [['status', 'status'], ['digest', 'summary'], ['check', 'check'], ['help', 'help']],
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
  // /chatid is what people type when setting the bot up. Both are /status.
  const status = world();
  await typed(status, '/status');
  for (const alias of ['/start', '/chatid']) {
    const w = world();
    await typed(w, alias);
    assert.equal(w.api.sent().at(-1).text, status.api.sent().at(-1).text, `${alias} = /status`);
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
  const commands = new TelegramCommandsService(w.config, w.transport, w.topics, w.store, idleMonitor());

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

test('intake registers the chat and its topics, then hands the Update on', async () => {
  const w = world();
  const handed = [];
  const intake = new TelegramUpdatesService(w.config, w.transport, w.topics, w.store, {
    answer: async (update) => { handed.push(update); },
  });
  const other = { id: -1009999, type: 'supergroup', is_forum: true, title: 'Другая группа' };
  const update = {
    update_id: 3,
    message: {
      message_id: 7, message_thread_id: 88, chat: other,
      forum_topic_created: { name: 'Своя тема' },
    },
  };

  await intake.handleUpdate(update);

  assert.ok(w.store.chats().some(([id]) => id === String(other.id)), 'чат зарегистрирован');
  assert.equal(w.topics.list(String(other.id))['Своя тема'], 88, 'тема запомнена');
  assert.deepEqual(handed, [update], 'и Update передан толкованию как есть');
  assert.deepEqual(w.api.sent(), [], 'intake сам ничего не отвечает');
});

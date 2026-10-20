const { test } = require('node:test');
const assert = require('node:assert/strict');
const { world, CHAT } = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * A remembered thread that is gone, while its name points elsewhere
 * ------------------------------------------------------------------ */

const FORUM = { id: Number(CHAT), type: 'supergroup', is_forum: true };
const THREAD_GONE = { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };

test('a deleted thread does not take a different, living topic of the same name with it', async () => {
  // The chat this was found in: the slot remembered thread 86 (a topic somebody
  // had renamed), while the configured name mapped to 301. Deleting 86 used to
  // drop the name's mapping too — so the retry found no topic by that name and
  // created a third one beside 301.
  const w = world({}, {
    sendMessage: (payload) => (payload.message_thread_id === 86 ? THREAD_GONE : undefined),
  });
  w.store.rememberTopic(CHAT, '📅 Upcoming runs', 301);

  await w.topics.send(FORUM, '📅 Upcoming runs', 'text', 86);

  assert.deepEqual(w.api.of('createForumTopic'), [], 'новая тема не создана');
  assert.equal(w.api.sent().at(-1).message_thread_id, 301, 'сообщение ушло в живую тему');
  assert.equal(w.store.threadId(CHAT, '📅 Upcoming runs'), 301);
});

test('a topic Telegram could not create for a moment is created with the next message, one it refused is not asked again', async () => {
  // Any failure used to shut topic creation in the chat until a restart: one
  // 429 sent every new job's alerts to General for good.
  const replies = [
    ['a moment', { ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } }, 2, true],
    ['for good', { ok: false, error_code: 400, description: 'Bad Request: not enough rights to create a topic' }, 1, false],
  ];
  for (const [name, reply, asked, inTopic] of replies) {
    let failing = true;
    const w = world({}, {
      createForumTopic: () => {
        if (!failing) return undefined;
        failing = false;
        return reply;
      },
    });

    await w.topics.send(FORUM, 'SQL Daily', 'первое');
    assert.equal(w.api.sent().at(-1).message_thread_id, undefined, `${name}: meanwhile in General`);
    await w.topics.send(FORUM, 'SQL Daily', 'второе');
    assert.equal(w.api.of('createForumTopic').length, asked, `${name}: asked ${asked}`);
    assert.equal(w.api.sent().at(-1).message_thread_id !== undefined, inTopic, `${name}: the next message in its topic`);
  }
});

test('a deleted thread its name pointed at is forgotten and re-created', async () => {
  const w = world({}, {
    sendMessage: (payload) => (payload.message_thread_id === 77 ? THREAD_GONE : undefined),
  });
  w.store.rememberTopic(CHAT, '🚨 Alerts', 77);

  await w.topics.send(FORUM, '🚨 Alerts', 'text');

  assert.equal(w.api.of('createForumTopic').length, 1, 'тема пересоздана');
  assert.notEqual(w.store.threadId(CHAT, '🚨 Alerts'), 77);
});

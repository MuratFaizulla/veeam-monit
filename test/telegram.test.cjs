const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// One harness for every test file. Everything it pulls out of dist/ is
// re-exported, so each file opens with the same line and takes what it needs.
const {
  CHAT, SERVER, appConfig, telegramConfig, configService, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService, monitorOf, monitorAccount,
  announcement, probe, capacities, capacityOf,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Events a human asks for
 * ------------------------------------------------------------------ */

test('an announcement with no text is refused, with the reason', () => {
  assert.deepEqual(announcement('   '), { ok: false, message: 'text is required' });
  assert.deepEqual(announcement(undefined), { ok: false, message: 'text is required' });
  assert.deepEqual(announcement('  Плановые работы  '), {
    ok: true,
    event: { kind: 'manual', severity: 'info', title: 'Плановые работы' },
  });
});

test('a probe for an unknown kind names the kinds that exist', () => {
  const refused = probe({ kind: 'backup' });
  assert.equal(refused.ok, false);
  // The list has to come from the same place the type does, or the message
  // starts describing an older set of kinds than the router accepts.
  assert.equal(refused.message, `kind must be one of ${NOTIFICATION_KINDS.join(', ')}`);
  assert.equal(probe({ severity: 'fatal' }).message, `severity must be one of ${NOTIFICATION_SEVERITIES.join(', ')}`);
});

test('a probe with nothing filled in is still a routable job event', () => {
  const built = probe({});
  assert.equal(built.ok, true);
  assert.equal(built.event.kind, 'job');
  assert.equal(built.event.severity, 'info');
  assert.ok(built.event.title.length > 0);
});

test('a probe goes through the real routing path, topic creation included', async () => {
  const w = world();
  const built = probe({ kind: 'job', severity: 'critical', subject: 'SQL Daily' });

  const report = await w.service.notify(built.event);

  assert.equal(report.outcome, 'delivered');
  assert.deepEqual(w.api.of('createForumTopic').map((p) => p.name), ['SQL Daily']);
});

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

test('a forum chat receives every job in its own topic instead of General', async () => {
  const w = world();

  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'SQL Daily: ОШИБКА' });
  await w.service.notify({ kind: 'job', severity: 'warning', subject: 'VM Weekly', title: 'VM Weekly: предупреждение' });

  assert.deepEqual(w.api.of('createForumTopic').map((p) => p.name), ['SQL Daily', 'VM Weekly']);
  const sent = w.api.sent();
  assert.equal(sent.length, 2);
  // The bug this fixes: without message_thread_id everything lands in General.
  assert.ok(sent.every((payload) => typeof payload.message_thread_id === 'number'));
  assert.notEqual(sent[0].message_thread_id, sent[1].message_thread_id);
  assert.equal(sent[0].parse_mode, 'HTML');
});

test('a topic is created once and reused for later events of the same job', async () => {
  const w = world();
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'first' });
  await w.service.notify({ kind: 'job', severity: 'success', subject: 'SQL Daily', title: 'second' });

  assert.equal(w.api.of('createForumTopic').length, 1);
  const sent = w.api.sent();
  assert.equal(sent[0].message_thread_id, sent[1].message_thread_id);
});

test('infrastructure and repository events use their own topics, not a job topic', async () => {
  const w = world();
  await w.service.notify({ kind: 'infrastructure', severity: 'critical', title: 'сервер недоступен' });
  await w.service.notify({ kind: 'repository', severity: 'warning', subject: 'Repo01', title: 'мало места' });

  assert.deepEqual(
    w.api.of('createForumTopic').map((p) => p.name),
    [w.telegram.kindTopics.infrastructure, w.telegram.kindTopics.repository],
  );
});

test('severity mode groups every kind into one topic per severity', async () => {
  const w = world({ TELEGRAM_ROUTING_MODE: 'severity' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'B', title: 'b' });
  await w.service.notify({ kind: 'infrastructure', severity: 'warning', title: 'c' });

  assert.deepEqual(
    w.api.of('createForumTopic').map((p) => p.name),
    [w.telegram.severityTopics.critical, w.telegram.severityTopics.warning],
  );
  const sent = w.api.sent();
  assert.equal(sent[0].message_thread_id, sent[1].message_thread_id);
  assert.notEqual(sent[1].message_thread_id, sent[2].message_thread_id);
});

test('single mode splits alerts, recoveries and everything else', async () => {
  const w = world({ TELEGRAM_ROUTING_MODE: 'single' });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  await w.service.notify({ kind: 'job', severity: 'success', subject: 'A', title: 'recovered' });
  await w.service.notify({ kind: 'manual', severity: 'info', title: 'плановые работы' });

  assert.deepEqual(
    w.api.of('createForumTopic').map((topic) => topic.name),
    ['🚨 Alerts', '🟢 Recovered'],
  );
  const sent = w.api.sent();
  assert.equal(sent[0].message_thread_id, 101, 'the failure');
  // A recovery answers an alert somebody is waiting on; in General it would
  // arrive among everything else.
  assert.equal(sent[1].message_thread_id, 102, 'the recovery');
  assert.equal(sent[2].message_thread_id, undefined, 'and the rest stays in General');
});

test('a non-forum chat never gets a thread id', async () => {
  const w = world();
  w.store.mergeChat({ id: Number(CHAT), type: 'group', is_forum: false });
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });

  assert.equal(w.api.of('createForumTopic').length, 0);
  assert.equal(w.api.sent()[0].message_thread_id, undefined);
});

test('routes file overrides the strategy and can drop events', async () => {
  const routes = path.join(os.tmpdir(), `routes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(
    routes,
    JSON.stringify({
      // First match wins, so the mute rule has to come before the DBA rule.
      routes: [
        { match: { severity: 'success' }, drop: true },
        { match: { kind: 'job', subject: '^sql-' }, topic: 'DBA' },
      ],
    }),
  );
  const w = world({ TELEGRAM_ROUTES_FILE: routes });

  const dba = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL-01', title: 'a' });
  const dropped = await w.service.notify({ kind: 'job', severity: 'success', subject: 'SQL-01', title: 'b' });
  const other = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'FS-01', title: 'c' });

  assert.equal(dba.topic, 'DBA');
  assert.equal(dropped.skipped, true);
  assert.equal(other.topic, 'FS-01');
  assert.deepEqual(w.api.of('createForumTopic').map((p) => p.name), ['DBA', 'FS-01']);
  fs.rmSync(routes, { force: true });
});

test('an unreadable routes file falls back to the strategy instead of failing', async () => {
  const w = world({ TELEGRAM_ROUTES_FILE: path.join(os.tmpdir(), 'does-not-exist.json') });
  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  assert.equal(report.sent, 1);
  assert.equal(report.topic, 'A');
});

test('severity filter suppresses the kinds an installation does not want', async () => {
  const w = world({ TELEGRAM_SEVERITIES: 'critical,warning' });
  const report = await w.service.notify({ kind: 'job', severity: 'success', subject: 'A', title: 'a' });
  assert.equal(report.skipped, true);
  assert.equal(w.api.sent().length, 0);
});

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

test('a deleted topic is forgotten, re-created and the message still arrives', async () => {
  let deleted = true;
  const w = world({}, {
    sendMessage: (payload) => {
      if (deleted && payload.message_thread_id === 55) {
        return { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };
      }
      return undefined;
    },
  });
  w.store.rememberTopic(CHAT, 'SQL Daily', 55);

  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'SQL Daily', title: 'a' });

  assert.equal(report.sent, 1);
  assert.equal(w.api.of('createForumTopic').length, 1);
  assert.equal(w.store.threadId(CHAT, 'SQL Daily'), 101, 'the stale thread id was replaced');
  deleted = false;
});

test('a 429 is retried after exactly the delay Telegram asked for', async () => {
  let limited = true;
  const w = world({}, {
    sendMessage: () => {
      if (!limited) return undefined;
      limited = false;
      return { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } };
    },
  });

  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  assert.equal(report.sent, 1);
  assert.equal(w.api.sent().length, 2);
});

test('a chat the bot was removed from is unregistered instead of retried forever', async () => {
  const w = world({}, {
    sendMessage: () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked' }),
  });

  const report = await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a' });
  assert.equal(report.failed, 1);
  assert.deepEqual(w.store.chats(), []);
});

test('job names are HTML-escaped so Telegram cannot reject or mis-render them', async () => {
  const w = world();
  await w.service.notify({
    kind: 'job',
    severity: 'critical',
    subject: 'A & B',
    title: '<b>A & B</b>: ОШИБКА',
    body: 'error <script>alert(1)</script>',
  });

  const text = w.api.sent()[0].text;
  assert.match(text, /&lt;b&gt;A &amp; B&lt;\/b&gt;/);
  assert.doesNotMatch(text, /<script>/);
});

test('messages are cut to Telegram’s 4096-character limit', async () => {
  const w = world();
  await w.service.notify({ kind: 'job', severity: 'critical', subject: 'A', title: 'a', body: 'x\n'.repeat(4000) });
  assert.ok(w.api.sent()[0].text.length <= 4096);
});

/* ------------------------------------------------------------------ *
 * The transport: how a call ended
 * ------------------------------------------------------------------ */

/** A transport on its own, over a fake Bot API answering with `handlers`. */
const transportOf = (handlers = {}) => {
  const api = fakeBotApi(handlers);
  const config = configService(appConfig({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_SEND_INTERVAL_MS: '0' }));
  return { api, transport: new TelegramTransportService(config, api.fn) };
};

const refusal = (code, description, parameters) => ({ ok: false, error_code: code, description, parameters });

test('the transport says how a call ended, whatever came back', async () => {
  // Each caller used to read Telegram's codes for itself, and they disagreed.
  // A proxy's error page carries no code, was read as 0, and the live module
  // took 0 < 500 for a refusal: the message it should have deleted on a
  // later pass was written off, and ▶️ showed two again.
  const replies = [
    ['taken', 'deleteMessage', () => undefined, 'done'],
    ['an edit that would change nothing', 'editMessageText', () => refusal(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'), 'done'],
    ['deleted by somebody', 'deleteMessage', () => refusal(400, 'Bad Request: message to delete not found'), 'gone'],
    ['deleted before the edit', 'editMessageText', () => refusal(400, 'Bad Request: message to edit not found'), 'gone'],
    ['a topic deleted', 'sendMessage', () => refusal(400, 'Bad Request: message thread not found'), 'gone'],
    ['too old to delete', 'deleteMessage', () => refusal(400, "Bad Request: message can't be deleted"), 'refused'],
    ['too old to edit', 'editMessageText', () => refusal(400, "Bad Request: message can't be edited"), 'refused'],
    ['no right to make topics', 'createForumTopic', () => refusal(400, 'Bad Request: not enough rights to create a topic'), 'refused'],
    ['the bot removed', 'deleteMessage', () => refusal(403, 'Forbidden: bot was kicked from the supergroup chat'), 'chat-gone'],
    ['a chat that is not there', 'editMessageText', () => refusal(400, 'Bad Request: chat not found'), 'chat-gone'],
    ['rate limited', 'deleteMessage', () => refusal(429, 'Too Many Requests: retry after 0', { retry_after: 0 }), 'later'],
    ['Telegram overloaded', 'deleteMessage', () => refusal(502, 'Bad Gateway'), 'later'],
    ["a proxy's error page", 'deleteMessage', () => '<html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>', 'later'],
    ['a dropped connection', 'deleteMessage', () => { throw new Error('socket hang up'); }, 'later'],
  ];
  for (const [name, method, reply, outcome] of replies) {
    const { transport } = transportOf({ [method]: reply });
    const ended = await transport.ask(method, { chat_id: CHAT, message_id: 5 });
    assert.equal(ended.outcome, outcome, name);
    if (outcome === 'done') continue;
    // What the log says of it: the method and Telegram's words, never a page.
    assert.match(ended.error.message, new RegExp(`^${method} -> `), name);
    assert.doesNotMatch(ended.error.message, /<html/, name);
    // A caller that wants the result is told the same, by what it throws.
    await assert.rejects(transportOf({ [method]: reply }).transport.call(method, { chat_id: CHAT }), { outcome }, name);
  }

  const created = await transportOf().transport.ask('createForumTopic', { chat_id: CHAT, name: 'A' });
  assert.deepEqual(created, { outcome: 'done', result: { message_thread_id: 101, name: 'A' } });
});

test('a 429 on any call holds that chat\'s later calls, queued or not, for as long as Telegram asked', async (t) => {
  // Only the queued messages used to wait. The live module's edits and
  // deletes went on at once into a chat Telegram had asked to be left alone,
  // and each earned another 429.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 20, 12) });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
  };
  let limited = true;
  const { api, transport } = transportOf({
    editMessageText: () => {
      if (!limited) return undefined;
      limited = false;
      return refusal(429, 'Too Many Requests: retry after 30', { retry_after: 30 });
    },
  });

  assert.equal((await transport.ask('editMessageText', { chat_id: CHAT, message_id: 5, text: 'a' })).outcome, 'later');
  const deleted = transport.deleteMessage(CHAT, 5);
  const sent = transport.sendMessage({ chatId: CHAT }, 'b');
  await transport.deleteMessage('-1009876543210', 6);
  await settle();
  assert.deepEqual(
    api.calls.map((call) => [call.method, call.payload.chat_id]),
    [['editMessageText', CHAT], ['deleteMessage', '-1009876543210']],
    'another chat is not held',
  );

  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(api.calls.length, 2, 'not a moment early');

  t.mock.timers.tick(1);
  assert.equal((await deleted).outcome, 'done');
  await sent;
  assert.deepEqual(api.calls.slice(2).map((call) => call.method).sort(), ['deleteMessage', 'sendMessage']);
});

test('a message Telegram refuses is not sent again, one it never answered is', async () => {
  // Only a 400 used to end it: any other refusal was sent four times over.
  let pages = 0;
  const { api, transport } = transportOf({
    sendMessage: (payload) => {
      if (payload.text === 'refused') return refusal(401, 'Unauthorized');
      if (payload.text === 'unanswered' && pages++ === 0) return '<html><body>502 Bad Gateway</body></html>';
      return undefined;
    },
  });

  await assert.rejects(transport.sendMessage({ chatId: CHAT }, 'refused'), { outcome: 'refused' });
  assert.equal(api.sent().length, 1, 'asking again changes nothing');
  api.reset();
  assert.equal(typeof (await transport.sendMessage({ chatId: CHAT }, 'unanswered')), 'number');
  assert.equal(api.sent().length, 2, 'tried again, and taken');
});

/* ------------------------------------------------------------------ *
 * A message the bot posted: replaced, deleted, written off
 * ------------------------------------------------------------------ */

const { PostedMessages } = require('../dist/telegram/posted-messages');
const { LiveMessages } = require('../dist/telegram/live-messages');
const { TelegramApiError } = require('../dist/telegram/transport.service');

const HOUR = 3_600_000;
const SENT = Date.UTC(2026, 9, 20, 9);

/**
 * The transport as the Posted messages see it: each delete ends as the test
 * says, by message id — one outcome, or a list taken in turn — and `done`
 * where it says nothing; `batch` is for every deleteMessages call. `asked`
 * is every id asked about, a batch as one list.
 */
const deletions = (outcomes = {}) => {
  const asked = [];
  const next = (key) => (Array.isArray(outcomes[key]) ? outcomes[key].shift() : outcomes[key]) ?? 'done';
  const ended = (method, outcome) =>
    outcome === 'done' ? { outcome, result: true } : { outcome, error: new TelegramApiError(method, outcome, 'as the test says') };
  return {
    asked,
    deleteMessage: async (chatId, messageId) => {
      asked.push(messageId);
      return ended('deleteMessage', next(messageId));
    },
    deleteMessages: async (chatId, messageIds) => {
      asked.push(messageIds);
      return ended('deleteMessages', next('batch'));
    },
  };
};

/** Posted messages over a plain record, on a clock the test turns. */
const postedOf = (outcomes, record = {}) => {
  const clock = { now: SENT };
  const transport = deletions(outcomes);
  const posted = new PostedMessages(transport, new LiveMessages(record, () => {}), () => clock.now);
  return { clock, transport, posted, record };
};

test('a message is replaced 36 hours after it was sent, and one of unknown age at once', () => {
  // Telegram stops letting a bot edit or delete its message about two days
  // after it was sent, however recently it was written to; replaced later
  // than that, a live slot was left with a frozen message beside its new one.
  const { clock, posted } = postedOf();
  clock.now = SENT + 36 * HOUR;
  assert.equal(posted.due({ messageId: 5, createdAt: SENT }), false, 'not a moment early');
  clock.now += 1;
  assert.equal(posted.due({ messageId: 5, createdAt: SENT }), true);
  // Written before the send time was kept: minutes or weeks old, and betting
  // on minutes is how the frozen message came about.
  assert.equal(posted.due({ messageId: 5 }), true);
});

test('a message Telegram could not be reached to delete is deleted on a later pass, a restart between', async () => {
  // Given up on after one try that met a dropped connection, a replaced live
  // message stayed in its topic for good, frozen beside the new one.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'posted-')), 'state.json');
  const before = new TelegramStateStore(file, [CHAT]);
  const transport = deletions({ 5: ['later', 'done'] });
  const posted = new PostedMessages(transport, before.liveMessages, () => SENT + HOUR);
  assert.deepEqual(await posted.delete(CHAT, [{ messageId: 5, createdAt: SENT }]), { deleted: [], pending: [5], stuck: [] });
  before.flush();

  const after = new TelegramStateStore(file, [CHAT]);
  const restarted = new PostedMessages(transport, after.liveMessages, () => SENT + 2 * HOUR);
  await restarted.sweep(CHAT);
  assert.deepEqual(transport.asked, [5, 5], 'asked again after the restart');
  await restarted.sweep(CHAT);
  assert.deepEqual(transport.asked, [5, 5], 'and, gone, not asked about again');
  await new Promise(setImmediate);
});

test('a message still not deleted 48 hours after it was sent is written off, not asked about', async () => {
  const { clock, transport, posted } = postedOf({ batch: 'later', 5: 'later' });
  clock.now = SENT + HOUR;
  assert.deepEqual((await posted.delete(CHAT, [{ messageId: 5, createdAt: SENT }, { messageId: 6 }])).pending, [5, 6]);

  clock.now = SENT + 48 * HOUR;
  transport.asked.length = 0;
  await posted.sweep(CHAT);
  assert.deepEqual(transport.asked, [5], 'in time it is asked; of an age nobody knows, it is not');

  // Telegram no longer lets a bot delete it: only a person can.
  clock.now += 1;
  await posted.sweep(CHAT);
  await posted.sweep(CHAT);
  assert.deepEqual(transport.asked, [5], 'past its time');
});

test('a message Telegram refuses to delete is not asked about again, and a chat that removed the bot is the caller\'s', async () => {
  const { transport, posted } = postedOf({ 5: 'refused', 6: 'chat-gone' });
  assert.deepEqual(await posted.delete(CHAT, [{ messageId: 5, createdAt: SENT }]), { deleted: [], pending: [], stuck: [5] });
  await posted.sweep(CHAT);
  assert.deepEqual(transport.asked, [5], 'only a person can remove it');

  // No answer about the message: the chat is let go by whoever asked, as
  // Delivery lets it go.
  await assert.rejects(posted.delete(CHAT, [{ messageId: 6, createdAt: SENT }]), { outcome: 'chat-gone' });
});

test('many messages go in one call, the rest one at a time when one of them cannot go', async () => {
  const sent = (...ids) => ids.map((messageId) => ({ messageId, createdAt: SENT }));
  assert.deepEqual(await postedOf().posted.delete(CHAT, sent(1, 2, 3)), { deleted: [1, 2, 3], pending: [], stuck: [] });

  // One message the bot may not delete fails the whole call.
  const one = postedOf({ batch: 'refused', 2: 'refused', 3: 'later' });
  assert.deepEqual(await one.posted.delete(CHAT, sent(1, 2, 3)), { deleted: [1], pending: [3], stuck: [2] });
  assert.deepEqual(one.transport.asked, [[1, 2, 3], 1, 2, 3]);

  // Unanswered as a whole, each would be too: all of them wait for a later pass.
  const none = postedOf({ batch: ['later', 'done'] });
  assert.deepEqual(await none.posted.delete(CHAT, sent(1, 2, 3)), { deleted: [], pending: [1, 2, 3], stuck: [] });
  await none.posted.sweep(CHAT);
  assert.deepEqual(none.transport.asked, [[1, 2, 3], [1, 2, 3]]);
});

/* ------------------------------------------------------------------ *
 * Update handling
 * ------------------------------------------------------------------ */

test('a chat named in configuration is registered before any update arrives', async () => {
  const file = path.join(os.tmpdir(), `veeam-seed-${Math.random().toString(36).slice(2)}.json`);
  const telegram = telegramConfig({ TELEGRAM_CHAT_IDS: CHAT, TELEGRAM_STATE_FILE: file });
  // The registry is asked on its own, with no service constructed at all: the
  // seeding must not depend on which provider Nest happens to build first.
  const store = new TelegramStateStore(file, telegram.chatIds);

  assert.deepEqual(
    store.chats().map(([id]) => id),
    [CHAT],
  );
  fs.rmSync(file, { force: true });
});

test('the reported mode follows the transport, not a flag somebody set', async () => {
  const w = world();
  // No webhook URL and the polling loop was never started, so neither transport
  // is up. Reporting "webhook" here is what used to hide a failed start.
  assert.equal(w.updates.mode, 'starting');
  assert.equal(w.updates.webhookConfigured, false);

  const file = path.join(os.tmpdir(), `veeam-off-${Math.random().toString(36).slice(2)}.json`);
  const store = new TelegramStateStore(file);
  const config = configService(appConfig({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_STATE_FILE: file }));
  const transport = new TelegramTransportService(config);
  const topics = new TelegramTopicsService(config, transport, store);
  assert.equal(new TelegramUpdatesService(config, transport, topics, store).mode, 'disabled');
  fs.rmSync(file, { force: true });
});

test('status counts every chat and every topic the bot knows', async () => {
  const w = world();
  w.topics.remember(CHAT, '🔴 Errors', 11);
  w.topics.remember(CHAT, '🟡 Warnings', 12);

  assert.deepEqual(w.service.reach, {
    enabled: true,
    chats: 1,
    topics: 2,
    queue: { pending: 0, dropped: 0 },
  });
});

test('a topic created by a human in the group is learned from the update', async () => {
  const w = world();
  await w.updates.handleUpdate({
    update_id: 1,
    message: {
      message_id: 5,
      message_thread_id: 77,
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
      forum_topic_created: { name: 'Ручной топик' },
    },
  });

  assert.equal(w.topics.list(CHAT)['Ручной топик'], 77);
});

test('commands answer in General, including messages marked as topic 1', async () => {
  const w = world();
  await w.updates.handleUpdate({
    update_id: 2,
    message: {
      message_id: 6,
      message_thread_id: 1,
      is_topic_message: true,
      text: '/chatid@VeeamMonitorExampleBot',
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  });

  const sent = w.api.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, undefined);
  assert.match(sent[0].text, /Chat ID/);
});

test('commands and old buttons in other topics are ignored', async () => {
  const w = world();
  const chat = { id: Number(CHAT), type: 'supergroup', is_forum: true };
  for (const [index, command] of ['/start', '/check', '/digest', '/job SQL', '/clear'].entries()) {
    await w.updates.handleUpdate({
      update_id: index + 10,
      message: {
        message_id: index + 20,
        message_thread_id: 42,
        is_topic_message: true,
        text: command,
        chat,
      },
    });
  }
  await w.updates.handleUpdate({
    update_id: 20,
    callback_query: {
      id: 'press-in-other-topic',
      data: 'a:chk',
      message: { message_id: 30, message_thread_id: 42, is_topic_message: true, chat },
    },
  });

  assert.equal(w.api.sent().length, 0);
  assert.equal(w.api.of('deleteMessage').length, 0, '/clear must not delete anything');
  assert.equal(w.api.of('answerCallbackQuery').length, 1, 'old button presses are acknowledged');
  assert.equal(w.store.cooldowns.isSuppressed('command:check'), false, '/check did not run');
});

test('General commands work when Telegram omits topic fields', async () => {
  const w = world();
  await w.updates.handleUpdate({
    update_id: 21,
    message: {
      message_id: 31,
      text: '/status',
      chat: { id: Number(CHAT), type: 'supergroup', is_forum: true },
    },
  });
  assert.equal(w.api.sent().length, 1);
  assert.equal(w.api.sent()[0].message_thread_id, undefined);
});

/* ------------------------------------------------------------------ *
 * Delivery accounting: nothing is marked as reported until it is sent
 * ------------------------------------------------------------------ */

/** Telegram rejects the message outright; not a rate limit, not a dead chat. */
const rejectSend = (isBroken) => ({
  sendMessage: () =>
    isBroken() ? { ok: false, error_code: 400, description: 'Bad Request: nope' } : undefined,
});

test('a delivery that reached nobody does not burn the cooldown', async () => {
  let broken = true;
  const w = world({}, rejectSend(() => broken));
  const event = () => ({
    kind: 'job',
    severity: 'critical',
    subject: 'SQL Daily',
    title: 'SQL Daily: ОШИБКА',
    dedupeKey: 'job:1:failed',
    cooldownMs: 60_000,
  });

  const first = await w.service.notify(event());
  assert.equal(first.outcome, 'failed');
  assert.equal(w.store.snapshot().cooldowns['job:1:failed'], undefined, 'окно не должно быть взведено');

  broken = false;
  const second = await w.service.notify(event());
  assert.equal(second.outcome, 'delivered', 'повтор проходит, а не глушится кулдауном');

  const third = await w.service.notify(event());
  assert.equal(third.outcome, 'cooldown', 'после успешной доставки окно взведено');
});

test('the delivery report names why an event was not sent', async () => {
  const w = world({ TELEGRAM_SEVERITIES: 'critical' });
  const base = { kind: 'job', subject: 'A', title: 'a' };

  assert.equal((await w.service.notify({ ...base, severity: 'warning' })).outcome, 'severity-filtered');
  assert.equal((await w.service.notify({ ...base, severity: 'critical' })).outcome, 'delivered');

  const keyed = { ...base, severity: 'critical', dedupeKey: 'k', cooldownMs: 60_000 };
  assert.equal((await w.service.notify(keyed)).outcome, 'delivered');
  assert.equal((await w.service.notify(keyed)).outcome, 'cooldown');

  w.store.dropChat(CHAT);
  assert.equal((await w.service.notify({ ...base, severity: 'critical' })).outcome, 'no-chats');
});

test('a transition whose delivery failed is retried on the next cycle', async () => {
  let broken = true;
  const w = monitorWorld({}, [job('1', 'SQL Daily', 'Success')], {}, rejectSend(() => broken));

  await w.monitor.check();
  assert.equal(w.store.jobMemoryOf(SERVER).resultOf('1'), 'success', 'первый цикл засеял состояние');

  w.setJobs([job('1', 'SQL Daily', 'Failed')]);
  await w.monitor.check();
  assert.equal(
    w.store.jobMemoryOf(SERVER).resultOf('1'),
    'success',
    'провалившаяся отправка не отмечает переход как обработанный',
  );
  assert.equal(w.monitor.status.undelivered > 0, true);

  broken = false;
  w.api.reset();
  await w.monitor.check();

  const sent = w.api.sent();
  assert.equal(sent.length, 1, 'переход сообщается на следующем цикле');
  assert.match(sent[0].text, /SQL Daily/);
  assert.match(sent[0].text, /SQL Daily — failed<\/b>/);
  assert.equal(w.store.jobMemoryOf(SERVER).resultOf('1'), 'failed');
  assert.equal(w.monitor.status.lastOutcome, 'delivered');
});

test('a failing job step does not abort the repository check', async () => {
  const w = world({ TELEGRAM_REPOSITORY_FREE_PERCENT: '10' });
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': () => {
      throw new Error('Veeam 500 Internal Server Error');
    },
    // Answered, so the only failure in this cycle is the one the test is about.
    '/api/v1/sessions': { data: [] },
    '/api/v1/backupInfrastructure/repositories/states': {
      data: [{ id: 'r1', name: 'Repo01', capacityGB: 1000, freeGB: 40 }],
    },
  });
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

  await monitor.check();

  assert.ok(
    w.api.sent().some((payload) => /Repo01/.test(payload.text)),
    'репозитории проверены, несмотря на упавший шаг заданий',
  );
  assert.match(monitor.status.lastError, /Veeam 500/);
  assert.ok(monitor.status.lastCheckAt, 'цикл дошёл до конца');
});

test('the last error is the last pass\'s: a pass that goes well clears it', async () => {
  const w = world();
  let broken = true;
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': () => {
      if (broken) throw new Error('Veeam 500 Internal Server Error');
      return { data: [] };
    },
    '/api/v1/sessions': { data: [] },
    '/api/v1/backupInfrastructure/repositories/states': { data: [] },
  });
  const monitor = monitorOf(w, veeam, monitorAccount());

  await monitor.check();
  assert.match(monitor.status.lastError, /Veeam 500/);

  broken = false;
  await monitor.check();
  // /status used to say «Последняя ошибка: Veeam 500» until the bot restarted.
  assert.equal(monitor.status.lastError, null);
  assert.equal(monitor.servers()[0].lastError, null);
});

test('the digest cooldown is armed only once the digest was delivered', async () => {
  let broken = true;
  const hour = new Date().getHours();
  const w = world({ TELEGRAM_DIGEST_HOUR: String(hour) }, rejectSend(() => broken));
  const veeam = veeamFake({
    '/api/v1/serverTime': { serverTime: 'now' },
    '/api/v1/jobs/states': { data: [job('1', 'SQL Daily', 'Failed')] },
  });
  const auth = monitorAccount();
  const monitor = monitorOf(w, veeam, auth);

  await monitor.check();
  assert.equal(w.store.snapshot().cooldowns['digest'], undefined, 'неудачная сводка не глушит сутки');

  broken = false;
  w.api.reset();
  await monitor.check();

  assert.ok(
    w.api.sent().some((payload) => /сводка по заданиям/.test(payload.text)),
    'сводка отправлена на следующем цикле',
  );
  assert.ok(w.store.snapshot().cooldowns['digest'] > Date.now(), 'теперь окно взведено');
});

test('every state write persists without the caller managing save()', async () => {
  const file = path.join(os.tmpdir(), `veeam-telegram-${Math.random().toString(36).slice(2)}.json`);
  const w = world({}, {}, file);

  w.store.rememberTopic(CHAT, 'SQL Daily', 77);
  w.store.jobMemoryOf(SERVER).remember('job-1', 'failed');
  w.store.cooldowns.arm('k', 60_000);
  w.store.flush();

  // A second store over the same file sees everything, and no caller in the
  // three modules above ever had to remember a save.
  const reopened = new TelegramStateStore(file, [CHAT]);
  assert.equal(reopened.threadId(CHAT, 'SQL Daily'), 77);
  assert.equal(reopened.jobMemoryOf(SERVER).resultOf('job-1'), 'failed');
  assert.equal(reopened.cooldowns.isSuppressed('k'), true);
  assert.deepEqual(
    reopened.chats().map(([id]) => id),
    [CHAT],
    'чат, засеянный из конфигурации, тоже сохранён',
  );

  reopened.jobMemoryOf(SERVER).keepOnly(new Set(['other']));
  reopened.flush();
  assert.equal(new TelegramStateStore(file).jobMemoryOf(SERVER).resultOf('job-1'), undefined);
  fs.rmSync(file, { force: true });
});

test('what was said about a server survives a restart, and goes with the server', async () => {
  const file = path.join(os.tmpdir(), `veeam-servers-${Math.random().toString(36).slice(2)}.json`);
  const store = new TelegramStateStore(file, [CHAT]);
  store.serverMemoryOf('veeam01main').remember({ reachable: false, authenticated: true });
  store.serverMemoryOf('veeam02baas').remember({ reachable: true });
  store.flush();

  const reopened = new TelegramStateStore(file, [CHAT]);
  assert.equal(reopened.serverMemoryOf('veeam01main').reachable, false);
  assert.equal(reopened.serverMemoryOf('veeam01main').authenticated, true);

  // A server taken off the list takes what was said about it along.
  reopened.keepServers(new Set(['veeam01main']));
  reopened.flush();
  const after = new TelegramStateStore(file, [CHAT]);
  assert.equal(after.serverMemoryOf('veeam02baas').reachable, undefined);
  assert.equal(after.serverMemoryOf('veeam01main').reachable, false);
  fs.rmSync(file, { force: true });
});

test('a server entry this version would not have written is forgotten, not the file', async () => {
  const file = path.join(os.tmpdir(), `veeam-servers-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    chats: { [CHAT]: { id: Number(CHAT), type: 'supergroup', is_forum: true } },
    topics: { [CHAT]: { Alerts: 5 } },
    jobResults: {}, cooldowns: {}, liveMessages: {},
    servers: { veeam01main: { reachable: 'yes' }, veeam02baas: { reachable: false } },
  }));

  const store = new TelegramStateStore(file, [CHAT]);

  assert.equal(store.serverMemoryOf('veeam01main').reachable, undefined, 'seen afresh');
  assert.equal(store.serverMemoryOf('veeam02baas').reachable, false);
  assert.equal(store.threadId(CHAT, 'Alerts'), 5, 'the topics beside it are kept');
  fs.rmSync(file, { force: true });
});

test('only configured chats are sent to, and one remembered by an older version is forgotten', async () => {
  const file = path.join(os.tmpdir(), `veeam-strangers-${Math.random().toString(36).slice(2)}.json`);
  // What an older version wrote after a stranger pressed Start in a private chat.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    chats: { [CHAT]: { id: Number(CHAT), type: 'supergroup', is_forum: true }, 99: { id: 99, type: 'private' } },
    topics: { 99: { Alerts: 5 } },
    jobResults: {}, cooldowns: {},
    liveMessages: { 99: { health: { messageId: 1, hash: 'h', at: 1 } } },
    answers: { 99: [{ messageId: 1, at: Date.now() }] },
  }));

  const store = new TelegramStateStore(file, [CHAT]);
  assert.deepEqual(store.chats().map(([id]) => id), [CHAT]);
  store.mergeChat({ id: 77, type: 'private' });
  assert.deepEqual(store.chats().map(([id]) => id), [CHAT], 'a new stranger is not taken in either');
  store.flush();

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.chats), [CHAT]);
  for (const part of ['topics', 'liveMessages', 'answers']) {
    assert.equal(saved[part]['99'], undefined, `${part} of the stranger forgotten`);
  }
  await new Promise(setImmediate);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

test('a job deleted in Veeam takes everything remembered about it along, in one write', () => {
  const { JobMemory } = require('../dist/telegram/job-memory');
  const record = {
    results: { gone: 'failed', kept: 'success' },
    retrying: { gone: { attempt: 1, retryBy: 1 } },
  };
  let saves = 0;
  const memory = new JobMemory(record, () => (saves += 1));

  memory.keepOnly(new Set(['kept']));

  // Pruned only by its result, the run stayed in the file for good.
  assert.deepEqual(record, { results: { kept: 'success' }, retrying: {} });
  assert.equal(saves, 1);
  memory.keepOnly(new Set(['kept']));
  assert.equal(saves, 1, 'ничего не изменилось — ничего не записано');
});

test('a job entry this version cannot read is left out, and the rest of the state is kept', async () => {
  const file = path.join(os.tmpdir(), `veeam-memory-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: 1, chats: {}, topics: { [CHAT]: { Alerts: 5 } }, cooldowns: {}, liveMessages: {}, answers: {},
    jobResults: { [SERVER]: { ok: 'failed', broken: 5 }, junk: 'x' },
    retrying: { [SERVER]: { ok: { attempt: 2, lastRun: '2026-09-30T04:33:41Z', retryBy: 1 }, text: 'x', odd: { attempt: '2' } }, bad: [] },
  }));

  const store = new TelegramStateStore(file, [CHAT]);

  // Checked whole, one bad entry used to cost the file — and with it the
  // chats, the topics and the live messages, for the sake of one job.
  assert.equal(store.threadId(CHAT, 'Alerts'), 5, 'темы на месте');
  const memory = store.jobMemoryOf(SERVER);
  assert.equal(memory.resultOf('ok'), 'failed');
  assert.equal(memory.resultOf('broken'), undefined);
  assert.deepEqual(memory.retryingOf('ok'), { attempt: 2, lastRun: '2026-09-30T04:33:41Z', retryBy: 1 });
  assert.equal(memory.retryingOf('text'), undefined);
  assert.equal(memory.retryingOf('odd'), undefined);
  const { jobResults, retrying } = store.snapshot();
  assert.deepEqual(Object.keys(jobResults), [SERVER]);
  assert.deepEqual(Object.keys(retrying), [SERVER]);

  // A file from before runs were followed has none, and is read as such.
  fs.writeFileSync(file, JSON.stringify({
    version: 1, chats: {}, topics: {}, cooldowns: {}, liveMessages: {}, answers: {}, jobResults: { [SERVER]: { ok: 'failed' } },
  }));
  const older = new TelegramStateStore(file, [CHAT]);
  assert.equal(older.jobMemoryOf(SERVER).resultOf('ok'), 'failed');
  assert.equal(older.jobMemoryOf(SERVER).retryingOf('ok'), undefined);

  await new Promise(setImmediate);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

test('a damaged Telegram state is restored from the last complete copy', async () => {
  const file = path.join(os.tmpdir(), `veeam-backup-${Math.random().toString(36).slice(2)}.json`);
  const store = new TelegramStateStore(file, [CHAT]);
  store.jobMemoryOf(SERVER).remember('job-1', 'failed');
  store.flush();
  assert.ok(fs.existsSync(`${file}.bak`));

  fs.writeFileSync(file, '{broken', 'utf8');
  const restored = new TelegramStateStore(file, [CHAT]);
  assert.equal(restored.jobMemoryOf(SERVER).resultOf('job-1'), 'failed');
  assert.deepEqual(restored.chats().map(([id]) => id), [CHAT]);
  restored.flush();
  assert.equal(new TelegramStateStore(file).jobMemoryOf(SERVER).resultOf('job-1'), 'failed');

  await new Promise(setImmediate);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.bak`, { force: true });
});

/* The parts of the state store, on a plain object: no file, no store. */

test('the answer log keeps one topic apart from the next, and forgets what Telegram would refuse', () => {
  const { AnswerLog, ANSWERS_KEPT } = require('../dist/telegram/answer-log');
  const { DELETABLE_MS } = require('../dist/telegram/posted-messages');
  const record = {};
  let saves = 0;
  const log = new AnswerLog(record, () => { saves += 1; });
  const ids = (said) => said.map(({ messageId }) => messageId);

  log.remember('c', 1);         // General
  log.remember('c', 2, 7);      // topic 7
  log.remember('c', 3, 7);
  assert.deepEqual(ids(log.inTopic('c', 7)), [3, 2], 'newest first, topic 7 only');
  assert.deepEqual(ids(log.inTopic('c')), [1], 'General is its own scope, not "everything"');
  assert.equal(saves, 3);

  // Older than Telegram lets a bot delete: not offered, and dropped on the next write.
  record.c.unshift({ messageId: 0, at: Date.now() - DELETABLE_MS - 1 });
  assert.deepEqual(ids(log.inTopic('c')), [1]);

  log.forget('c', [1, 2, 3]);
  assert.equal(record.c, undefined, 'an emptied chat leaves nothing behind');

  for (let id = 0; id < ANSWERS_KEPT + 20; id += 1) log.remember('d', id);
  assert.equal(record.d.length, ANSWERS_KEPT);
  assert.equal(ids(log.inTopic('d'))[0], ANSWERS_KEPT + 19, 'the ceiling drops the oldest');
});

test('a cooldown is armed only when asked, and clears itself when it runs out', () => {
  const { Cooldowns } = require('../dist/telegram/cooldowns');
  const record = { stale: Date.now() - 1 };
  const cooldowns = new Cooldowns(record, () => {});

  assert.equal(cooldowns.isSuppressed('k'), false);
  assert.equal(cooldowns.isSuppressed(undefined), false);
  cooldowns.arm('k', 60_000);
  assert.equal(cooldowns.isSuppressed('k'), true);
  assert.equal(record.stale, undefined, 'arming sweeps windows that already ran out');
  cooldowns.clear('k');
  assert.equal(cooldowns.isSuppressed('k'), false);
});

test('dropping a chat takes its live slots with it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'state-')), 'state.json');
  const store = new TelegramStateStore(file, ['-1001']);
  store.liveMessages.remember('-1001', 'health', { messageId: 5, hash: 'h', at: 1 });
  store.dropChat('-1001');
  assert.equal(store.liveMessages.of('-1001', 'health'), undefined);
  assert.equal(store.snapshot().liveMessages['-1001'], undefined);
});

test('the idle monitor the tests use offers exactly what the real one does', async () => {
  // Two adapters of one seam drift apart silently: a command reads a field the
  // real monitor has and the stub lacks, and every test built on the stub
  // passes against a shape production never sees.
  const { idleMonitor, monitorWorld, job } = require('./world.cjs');
  const idle = idleMonitor();
  const real = monitorWorld({}, [job('1', 'A', 'Success')]).monitor;

  for (const member of ['check', 'summary', 'describeJob', 'describeJobById', 'describePoints', 'describePointsById', 'repositoryReport', 'repositoryChoices', 'jobChoices', 'jobReport']) {
    assert.equal(typeof real[member], 'function', `MonitorService.${member}`);
    assert.equal(typeof idle[member], 'function', `idle monitor ${member}`);
  }
  assert.deepEqual(Object.keys(idle.status).sort(), Object.keys(real.status).sort());
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// One harness for every test file. Everything it pulls out of dist/ is
// re-exported, so each file opens with the same line and takes what it needs.
const {
  CHAT, telegramConfig, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService,
  announcement, probe, capacities, capacityOf,
  NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES,
} = require('./world.cjs');

/* ------------------------------------------------------------------ *
 * Reading a whole collection
 *
 * This existed only as a private method reachable through a monitor cycle, and
 * no fake ever returned a pagination envelope — so the offset stepping written
 * to keep a nine-thousand-session read from stalling the cycle had never once
 * executed in a test.
 * ------------------------------------------------------------------ */

/** A Veeam that holds `total` rows and answers honest pages of `size`. */
const collection = (total, size, quirks = {}) => {
  const asked = [];
  const rows = Array.from({ length: total }, (_, i) => ({ id: `row-${i}` }));
  return {
    asked,
    reader: {
      auth: { invalidateAccessToken: () => {}, getAccessToken: async () => 'fresh' },
      accessToken: 'tok',
      veeam: {
        request: async ({ params }) => {
          asked.push({ skip: params.skip, limit: params.limit });
          const limit = quirks.cap ? Math.min(params.limit, quirks.cap) : params.limit;
          return {
            data: rows.slice(params.skip, params.skip + limit),
            pagination: quirks.silent ? undefined : { total, skip: params.skip, limit },
          };
        },
      },
    },
  };
};

test('a collection is read whole, in one page when it fits', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(40, 500);

  const rows = await allPages(c.reader, '/api/v1/backups', {}, 500);

  assert.equal(rows.length, 40);
  assert.equal(c.asked.length, 1, 'a short first page is the whole collection');
});

test('a collection longer than one page is read by offset, not by walking', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(1200, 500);

  const rows = await allPages(c.reader, '/api/v1/restorePoints', {}, 500);

  assert.equal(rows.length, 1200);
  assert.deepEqual(rows[0], { id: 'row-0' });
  assert.deepEqual(rows[1199], { id: 'row-1199' });
  assert.deepEqual(c.asked.map((a) => a.skip), [0, 500, 1000]);
});

test('the step follows the limit Veeam actually gave, not the one asked for', async () => {
  const { allPages } = require('../dist/veeam/pages');
  // Asked for 500, capped at 200: stepping by 500 would skip two thirds.
  const c = collection(700, 500, { cap: 200 });

  const rows = await allPages(c.reader, '/api/v1/sessions', {}, 500);

  assert.equal(rows.length, 700, 'no row is missed');
  assert.deepEqual(new Set(rows.map((r) => r.id)).size, 700, 'and none is read twice');
});

test('a server that reports no total is walked until a page comes back short', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(250, 100, { silent: true });

  const rows = await allPages(c.reader, '/api/v1/jobs', {}, 100);

  assert.equal(rows.length, 250);
  assert.deepEqual(c.asked.map((a) => a.skip), [0, 100, 200]);
});

test('a token that expires mid-read is refreshed and the page re-fetched', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const { VeeamApiError } = require('../dist/veeam/api.error');
  let invalidated = false;
  let first = true;
  const reader = {
    auth: {
      invalidateAccessToken: () => (invalidated = true),
      getAccessToken: async () => 'fresh',
    },
    accessToken: 'stale',
    veeam: {
      request: async ({ accessToken }) => {
        if (first) {
          first = false;
          throw new VeeamApiError('Veeam rejected the token', 401);
        }
        return { data: [{ id: accessToken }], pagination: { total: 1, skip: 0, limit: 500 } };
      },
    },
  };

  const rows = await allPages(reader, '/api/v1/backups', {}, 500);

  assert.ok(invalidated, 'the expired token is dropped');
  assert.deepEqual(rows, [{ id: 'fresh' }], 'the page is re-fetched with the new one');
});

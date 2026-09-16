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
      auth: { rejectToken: () => true, getAccessToken: async () => 'fresh' },
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

/** A reader whose first request is refused with `status`, and works after. */
const refusedOnce = (status) => {
  const { VeeamApiError } = require('../dist/veeam/api.error');
  const state = { rejected: 0, tokensUsed: [] };
  let first = true;
  return {
    state,
    reader: {
      auth: {
        rejectToken: () => (state.rejected += 1) > 0,
        getAccessToken: async () => 'fresh',
      },
      accessToken: 'stale',
      veeam: {
        request: async ({ accessToken }) => {
          state.tokensUsed.push(accessToken);
          if (first) {
            first = false;
            throw new VeeamApiError(`Veeam API responded with HTTP ${status}`, status);
          }
          return { data: [{ id: accessToken }], pagination: { total: 1, skip: 0, limit: 500 } };
        },
      },
    },
  };
};

test('a token that expires mid-read is refreshed and the page re-fetched', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const { state, reader } = refusedOnce(401);

  const rows = await allPages(reader, '/api/v1/backups', {}, 500);

  assert.equal(state.rejected, 1, 'the refused token is dropped');
  assert.deepEqual(rows, [{ id: 'fresh' }], 'the page is re-fetched with the new one');
});

test('a 403 is a refused token too, not a dead end', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const { state, reader } = refusedOnce(403);

  // This is the failure that used to need a restart: 403 on every endpoint,
  // starting the moment a token was renewed, with nothing in the code treating
  // it as a reason to ask for another one. The service then waited out the
  // token's full hour while every cycle failed.
  const rows = await allPages(reader, '/api/v1/backups', {}, 500);

  assert.equal(state.rejected, 1);
  assert.deepEqual(state.tokensUsed, ['stale', 'fresh']);
  assert.deepEqual(rows, [{ id: 'fresh' }]);
});

test('a refusal the auth service has already acted on is not re-fetched', async () => {
  const { authorized } = require('../dist/veeam/pages');
  const { VeeamApiError } = require('../dist/veeam/api.error');
  let logins = 0;
  const reader = {
    // Says no: this same refusal was acted on moments ago.
    auth: { rejectToken: () => false, getAccessToken: async () => `token-${(logins += 1)}` },
    accessToken: 'stale',
    veeam: { request: async () => { throw new VeeamApiError('Forbidden', 403); } },
  };

  await assert.rejects(
    () => authorized(reader, { method: 'GET', path: '/api/v1/jobs/states' }),
    /Forbidden/,
  );
  // One cycle's worth of calls carries one token and needs one new one, not a
  // login per call against a Veeam that is refusing everything.
  assert.equal(logins, 0);
});

test('a failure that is not about the token is passed straight through', async () => {
  const { authorized } = require('../dist/veeam/pages');
  const { VeeamApiError } = require('../dist/veeam/api.error');
  let rejected = 0;
  const reader = {
    auth: { rejectToken: () => (rejected += 1) > 0, getAccessToken: async () => 'fresh' },
    accessToken: 'stale',
    veeam: { request: async () => { throw new VeeamApiError('Internal server error', 500); } },
  };

  await assert.rejects(
    () => authorized(reader, { method: 'GET', path: '/api/v1/jobs/states' }),
    /Internal server error/,
  );
  assert.equal(rejected, 0, 'a working token is not thrown away over a server fault');
});

test('one burst of refusals buys one new token, not one per call', async () => {
  const { VeeamMonitorAuthService } = require('../dist/veeam/monitor-auth.service');
  const config = { getOrThrow: () => ({ veeamUsername: 'svc', veeamPassword: 'p' }) };
  const auth = new VeeamMonitorAuthService(config, { login: async () => ({ access_token: 't' }) });

  assert.equal(auth.rejectToken(), true, 'the first refusal is acted on');
  assert.equal(auth.rejectToken(), false, 'and the rest of the same burst is not');
});

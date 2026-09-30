const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// One harness for every test file. Everything it pulls out of dist/ is
// re-exported, so each file opens with the same line and takes what it needs.
const {
  CHAT, appConfig, telegramConfig, configService, fakeBotApi, world, veeamFake, monitorWorld, job, exchange,
  configuration, TelegramStateStore, TelegramTransportService, TelegramTopicsService,
  TelegramRoutingService, TelegramService, TelegramUpdatesService, TelegramLiveService,
  MonitorService, BackupEvidenceService, VeeamHttpService, VeeamEstateReader,
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
    page: async (skip, requested) => {
      asked.push({ skip, limit: requested });
      const limit = quirks.cap ? Math.min(requested, quirks.cap) : requested;
      return {
        data: rows.slice(skip, skip + limit),
        pagination: quirks.silent ? undefined : { total, skip, limit },
      };
    },
  };
};

test('a collection is read whole, in one page when it fits', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(40, 500);

  const rows = await allPages(c.page, 500);

  assert.equal(rows.length, 40);
  assert.equal(c.asked.length, 1, 'a short first page is the whole collection');
});

test('a collection longer than one page is read by offset, not by walking', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(1200, 500);

  const rows = await allPages(c.page, 500);

  assert.equal(rows.length, 1200);
  assert.deepEqual(rows[0], { id: 'row-0' });
  assert.deepEqual(rows[1199], { id: 'row-1199' });
  assert.deepEqual(c.asked.map((a) => a.skip), [0, 500, 1000]);
});

test('the step follows the limit Veeam actually gave, not the one asked for', async () => {
  const { allPages } = require('../dist/veeam/pages');
  // Asked for 500, capped at 200: stepping by 500 would skip two thirds.
  const c = collection(700, 500, { cap: 200 });

  const rows = await allPages(c.page, 500);

  assert.equal(rows.length, 700, 'no row is missed');
  assert.deepEqual(new Set(rows.map((r) => r.id)).size, 700, 'and none is read twice');
});

test('a server that reports no total is walked until a page comes back short', async () => {
  const { allPages } = require('../dist/veeam/pages');
  const c = collection(250, 100, { silent: true });

  const rows = await allPages(c.page, 100);

  assert.equal(rows.length, 250);
  assert.deepEqual(c.asked.map((a) => a.skip), [0, 100, 200]);
});

/**
 * An estate reader over a Veeam that refuses its first request with `status`,
 * and an auth service holding `stale` until told the token was refused.
 */
const refusedOnce = (status) => {
  const { VeeamApiError } = require('../dist/veeam/api.error');
  const state = { rejected: 0, tokensUsed: [] };
  let token = 'stale';
  let first = true;
  const auth = {
    rejectToken: () => {
      state.rejected += 1;
      token = 'fresh';
      return true;
    },
    getAccessToken: async () => token,
  };
  const veeam = {
    request: async ({ accessToken }) => {
      state.tokensUsed.push(accessToken);
      if (first) {
        first = false;
        throw new VeeamApiError(`Veeam API responded with HTTP ${status}`, status);
      }
      return { data: [{ id: accessToken }], pagination: { total: 1, skip: 0, limit: 500 } };
    },
  };
  return { state, reader: new VeeamEstateReader(veeam, auth) };
};

test('a token that expires mid-read is refreshed and the page re-fetched', async () => {
  const { state, reader } = refusedOnce(401);

  const rows = await reader.backups();

  assert.equal(state.rejected, 1, 'the refused token is dropped');
  assert.deepEqual(rows, [{ id: 'fresh' }], 'the page is re-fetched with the new one');
});

test('a 403 is a refused token too, not a dead end', async () => {
  const { state, reader } = refusedOnce(403);

  // This is the failure that used to need a restart: 403 on every endpoint,
  // starting the moment a token was renewed, with nothing in the code treating
  // it as a reason to ask for another one. The service then waited out the
  // token's full hour while every cycle failed.
  const rows = await reader.backups();

  assert.equal(state.rejected, 1);
  assert.deepEqual(state.tokensUsed, ['stale', 'fresh']);
  assert.deepEqual(rows, [{ id: 'fresh' }]);
});

test('a refusal the auth service has already acted on is not re-fetched', async () => {
  const { VeeamApiError } = require('../dist/veeam/api.error');
  let requests = 0;
  const reader = new VeeamEstateReader(
    { request: async () => { requests += 1; throw new VeeamApiError('Forbidden', 403); } },
    // Says no: this same refusal was acted on moments ago, and nobody has a
    // better token than the one just refused.
    { rejectToken: () => false, getAccessToken: async () => 'stale' },
  );

  await assert.rejects(() => reader.jobStates(), /Forbidden/);
  // Not a login per call against a Veeam that is refusing everything, and not
  // the refused token again either.
  assert.equal(requests, 1);
});

test('a failure that is not about the token is passed straight through', async () => {
  const { VeeamApiError } = require('../dist/veeam/api.error');
  let rejected = 0;
  const reader = new VeeamEstateReader(
    { request: async () => { throw new VeeamApiError('Internal server error', 500); } },
    { rejectToken: () => (rejected += 1) > 0, getAccessToken: async () => 'fresh' },
  );

  await assert.rejects(() => reader.jobStates(), /Internal server error/);
  assert.equal(rejected, 0, 'a working token is not thrown away over a server fault');
});

/** The config a signed-in monitor starts from: its account is in the veeam block. */
const monitorAccount = () =>
  appConfig({ VEEAM_MONITOR_USERNAME: 'svc', VEEAM_MONITOR_PASSWORD: 'p' }).veeam;

test('one burst of refusals buys one new token, not one per call', async () => {
  const { VeeamMonitorAuthService } = require('../dist/veeam/monitor-auth.service');
  const auth = new VeeamMonitorAuthService(monitorAccount(), { login: async () => ({ access_token: 't' }) });

  assert.equal(auth.rejectToken(), true, 'the first refusal is acted on');
  assert.equal(auth.rejectToken(), false, 'and the rest of the same burst is not');
});

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

/** A Veeam whose refresh grant returns 200 and a token it then refuses. */
const veeamAuth = () => {
  const calls = [];
  return {
    calls,
    veeam: {
      login: async () => {
        calls.push('login');
        return { access_token: `password-${calls.length}`, refresh_token: 'r', expires_in: 3600 };
      },
      refresh: async () => {
        calls.push('refresh');
        return { access_token: `refreshed-${calls.length}`, refresh_token: 'r', expires_in: 3600 };
      },
    },
  };
};

const authService = (veeam) => {
  const { VeeamMonitorAuthService } = require('../dist/veeam/monitor-auth.service');
  return new VeeamMonitorAuthService(monitorAccount(), veeam);
};

test('a token refused after a refresh sends the next sign-in through the password grant', async () => {
  const v = veeamAuth();
  const auth = authService(v.veeam);

  assert.equal(await auth.getAccessToken(), 'password-1');
  // An hour passes and the token is renewed the cheap way.
  auth.invalidateAccessToken();
  assert.equal(await auth.getAccessToken(), 'refreshed-2');

  // Veeam answers 403 to it — on this server a refreshed token is refused,
  // which is the hourly outage that used to be cleared only by a restart.
  assert.equal(auth.rejectToken(), true);
  assert.equal(await auth.getAccessToken(), 'password-3', 'a real sign-in, not another refresh');

  // And it does not go back to refreshing, or the outage would return hourly.
  auth.invalidateAccessToken();
  assert.equal(await auth.getAccessToken(), 'password-4');
  assert.deepEqual(v.calls, ['login', 'refresh', 'login', 'login']);
});

test('where refreshing works it is never switched off', async () => {
  const v = veeamAuth();
  const auth = authService(v.veeam);

  await auth.getAccessToken();
  auth.invalidateAccessToken();
  await auth.getAccessToken();
  auth.invalidateAccessToken();
  await auth.getAccessToken();

  assert.deepEqual(v.calls, ['login', 'refresh', 'refresh'], 'nothing refused anything');
});

/* ------------------------------------------------------------------ *
 * The API version each server speaks
 * ------------------------------------------------------------------ */

test('a server that does not speak the configured API version is spoken to in the newest it offers', async () => {
  const http = require('node:http');
  const { VeeamHttpService } = require('../dist/veeam/http.service');
  const asked = [];
  // An older Veeam, exactly as veam01baas01 answered a 1.2 client.
  const old = http.createServer((req, res) => {
    asked.push(req.headers['x-api-version']);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-api-version'] !== '1.1-rev2') {
      res.statusCode = 400;
      res.end(JSON.stringify({
        errorCode: 'BadRequest',
        message: 'Unsupported RESTAPI version. The following versions are supported: v1.0-rev1, v1.0-rev2, v1.1-rev0, v1.1-rev1, v1.1-rev2',
      }));
      return;
    }
    res.end(JSON.stringify({ serverTime: '2026-09-28T10:40:01+05:00' }));
  });
  await new Promise((listening) => old.listen(0, '127.0.0.1', listening));
  const veeam = new VeeamHttpService({
    name: 'old', baseUrl: `http://127.0.0.1:${old.address().port}`,
    apiVersion: '1.2-rev1', insecureTls: false, timeoutMs: 5000,
  });
  try {
    assert.deepEqual(await veeam.reachability(), { reachable: true, serverTime: '2026-09-28T10:40:01+05:00' });
    await veeam.reachability();
    assert.deepEqual(asked, ['1.2-rev1', '1.1-rev2', '1.1-rev2'], 'refused once, then spoken to in its own version');
  } finally {
    old.close();
  }
});

test('a Veeam with its own self-signed certificate is trusted by that certificate, and by nothing else', async (t) => {
  // What both production servers present: "Veeam Backup Server Certificate",
  // signed by itself, with no host name in it. A CA bundle cannot help — the
  // name check fails anyway — so the only way to verify it is to pin it.
  const { selfSigned } = require('./world.cjs');
  const own = selfSigned();
  const other = selfSigned();
  if (!own || !other) return t.skip('openssl is not installed');
  const https = require('node:https');
  const { X509Certificate } = require('node:crypto');
  const { VeeamHttpService } = require('../dist/veeam/http.service');
  const server = https.createServer({ key: own.key, cert: own.cert }, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ serverTime: '2026-09-29T18:00:00+05:00' }));
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  const veeam = (pem) => new VeeamHttpService({
    name: 'self-signed', baseUrl: `https://127.0.0.1:${server.address().port}`,
    apiVersion: '1.2-rev1', insecureTls: false, timeoutMs: 5000,
    ...(pem ? { tls: { pem, fingerprint: new X509Certificate(pem).fingerprint256 } } : {}),
  });
  try {
    assert.equal((await veeam(own.cert).reachability()).reachable, true, 'its own certificate is enough');
    const impostor = await veeam(other.cert).reachability();
    assert.equal(impostor.reachable, false, 'another certificate is refused');
    assert.match(impostor.error, /VEEAM_TLS_CERTS/, 'and the refusal says what to set');
    assert.equal((await veeam(undefined).reachability()).reachable, false, 'nothing self-signed is trusted unpinned');
  } finally {
    server.close();
  }
});

test('a server named in its URL is known by the address its name resolved to on connecting', async (t) => {
  // What the health message shows beside the name: the address a firewall
  // rule is written for. It comes from the connection itself, so it is the
  // address the bot really went to, and costs no DNS question of its own.
  const { selfSigned } = require('./world.cjs');
  const own = selfSigned();
  if (!own) return t.skip('openssl is not installed');
  const https = require('node:https');
  const { X509Certificate } = require('node:crypto');
  const { VeeamHttpService } = require('../dist/veeam/http.service');
  const server = https.createServer({ key: own.key, cert: own.cert }, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ serverTime: '2026-09-30T10:00:00+05:00' }));
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  const veeam = (host) => new VeeamHttpService({
    name: 'named', baseUrl: `https://${host}:${server.address().port}`,
    apiVersion: '1.2-rev1', insecureTls: false, timeoutMs: 5000,
    tls: { pem: own.cert, fingerprint: new X509Certificate(own.cert).fingerprint256 },
  });
  try {
    const named = veeam('localhost');
    assert.equal(named.address, undefined, 'nothing is claimed before the first connection');
    assert.equal((await named.reachability()).reachable, true);
    assert.match(named.address, /127\.0\.0\.1/, 'the address the name resolved to');

    assert.equal(veeam('127.0.0.1').address, '127.0.0.1', 'a URL that is an address is its own answer');
  } finally {
    server.close();
  }
});

test('/api/health answers inside the container probe even when Veeam swallows the connection', async () => {
  // What a firewall that drops packets looks like from here: the connection is
  // taken and nothing ever comes back. The probe waited out the monitor's own
  // 30 seconds, Docker gave up after 5, and a working container was reported
  // unhealthy for as long as Veeam was out of reach.
  const net = require('node:net');
  const { VeeamHttpService } = require('../dist/veeam/http.service');
  const { HealthController } = require('../dist/http/health.controller');
  const sockets = [];
  const silent = net.createServer((socket) => sockets.push(socket));
  await new Promise((listening) => silent.listen(0, '127.0.0.1', listening));
  const http = new VeeamHttpService({
    name: 'silent', baseUrl: `http://127.0.0.1:${silent.address().port}`,
    apiVersion: '1.2-rev1', insecureTls: false, timeoutMs: 30_000,
  });
  try {
    const startedAt = Date.now();
    const health = await new HealthController({ all: [{ http }] }).check();
    assert.ok(Date.now() - startedAt < 5_000, `answered in ${Date.now() - startedAt} ms`);
    assert.equal(health.status, 'degraded');
    assert.equal(health.servers[0].reachable, false);
  } finally {
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

test('only a refusal of the version is read as one, and the newest version it names wins', () => {
  const { spokenVersion } = require('../dist/veeam/http.service');
  assert.equal(
    spokenVersion('Unsupported RESTAPI version. The following versions are supported: v1.1-rev2, v1.0-rev1, v1.1-rev10'),
    '1.1-rev10',
  );
  assert.equal(spokenVersion('Veeam API responded with HTTP 400'), undefined);
  assert.equal(spokenVersion('Job v1.1-rev2 not found'), undefined);
});

/* ------------------------------------------------------------------ *
 * What Veeam's words about a session mean
 *
 * One machine's failure is written the same way in a task's message, a
 * session's message and a session log, wrapped in boilerplate: the line that
 * repeats the connection parameters — service account included — and the
 * agent's call stack in prose. Shown raw, a Job card's run list carried them
 * into the chat.
 * ------------------------------------------------------------------ */

const { machineLine, sessionText, blameOf } = require('../dist/veeam/session-text');

const VDDK =
  'Processing EMMDB1-T3Q4 Error: Failed to open VDDK disk [[AST01_A400_SSD_DATA09] EMMDB1-T3Q4/EMMDB1-T3Q4_1.vmdk] ( is read-only mode - [true] )\r\n' +
  'Logon attempt with parameters [VC/ESX: [10.11.1.194];Port: 443;Login: [svc@example.com];VMX Spec: [moref=vm-31466]]\r\n' +
  'Failed to open disk for read.\r\n' +
  "Failed to upload disk 'vddkConnSpec>'\r\n" +
  'Agent failed to process method {DataTransfer.SyncDisk}.';
const DNS =
  'Processing comp01vc01.ast01.mgmt.cloudttc.kz Error: Cannot get service content.\r\n' +
  "Soap fault. Temporary failure in name resolutionDetail: 'getaddrinfo failed in tcp_connect()', endpoint: 'https://vc01cast.t-cloud.kz:443/sdk'\r\n" +
  'Logon attempt with parameters [VC/ESX: [vc01cast.t-cloud.kz];Port: 443;Login: [svc@example.com]]';

test('Veeam\'s ways of saying a machine failed are read as the machine and the reason', () => {

  // Two lines of it: the connection parameters are not a reason, and what
  // follows the second is the agent's call stack.
  assert.deepEqual(machineLine(VDDK), {
    machine: 'EMMDB1-T3Q4',
    reason: 'Failed to open VDDK disk [[AST01_A400_SSD_DATA09] EMMDB1-T3Q4/EMMDB1-T3Q4_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.',
  });
  // The second line is the one that says it was DNS.
  assert.deepEqual(
    machineLine("Processing EMM1-Dy2M Error: Cannot get service content.\r\nSoap fault. Temporary failure in name resolutionDetail: 'getaddrinfo failed in tcp_connect()'"),
    { machine: 'EMM1-Dy2M', reason: "Cannot get service content. / Soap fault. Temporary failure in name resolutionDetail: 'getaddrinfo failed in tcp_connect()'" },
  );
  assert.deepEqual(
    machineLine('Failed to create processing task for VM t-dom002.t-cloud.kz Error: Failed to retrieve object hierarchy: exception ID d1dd9757'),
    { machine: 't-dom002.t-cloud.kz', reason: 'Failed to retrieve object hierarchy: exception ID d1dd9757' },
  );
  assert.deepEqual(
    machineLine('Virtual Machine REMS-DBS03 (937da18e-dc71-48f4-b68e-9cee11ccb42b) is unavailable and will be skipped from processing'),
    { machine: 'REMS-DBS03', reason: 'Virtual Machine REMS-DBS03 (937da18e-dc71-48f4-b68e-9cee11ccb42b) is unavailable and will be skipped from processing' },
  );
  assert.deepEqual(
    machineLine('Error: Выдано исключение типа "Veeam.Backup.AgentProvider.AgentClosedException".'),
    { reason: 'Выдано исключение типа "Veeam.Backup.AgentProvider.AgentClosedException".' },
  );
  // A name and no reason: Veeam said which, not why.
  assert.deepEqual(machineLine('Processing Sirius'), { machine: 'Sirius', reason: undefined });
});

test('a session\'s message is shown as a machine and its reason, never with the connection parameters', () => {
  assert.equal(
    sessionText(VDDK),
    'EMMDB1-T3Q4 — Failed to open VDDK disk [[AST01_A400_SSD_DATA09] EMMDB1-T3Q4/EMMDB1-T3Q4_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.',
  );
  assert.equal(
    sessionText(DNS),
    "comp01vc01.ast01.mgmt.cloudttc.kz — Cannot get service content. / Soap fault. Temporary failure in name resolutionDetail: 'getaddrinfo failed in tcp_connect()', endpoint: 'https://vc01cast.t-cloud.kz:443/sdk'",
  );
  // A name with no reason stays as Veeam wrote it: "Processing" is what says
  // the name is a machine.
  assert.equal(sessionText('Processing EMMDB1-T3Q4'), 'Processing EMMDB1-T3Q4');
  // A reason that names its machine already is not given the name twice.
  const unavailable = 'Virtual Machine REMS-DBS03 (937da18e-dc71-48f4-b68e-9cee11ccb42b) is unavailable and will be skipped from processing';
  assert.equal(sessionText(unavailable), unavailable);
  assert.equal(sessionText('Removing VM snapshot Details: A connection attempt failed'), 'Removing VM snapshot Details: A connection attempt failed');
  assert.equal(sessionText('   '), undefined);
  assert.equal(sessionText(undefined), undefined);
  for (const text of [VDDK, DNS].map(sessionText)) assert.doesNotMatch(text, /Logon attempt|svc@example\.com|DataTransfer/);
});

test('a session blames a machine only when it names one and says why', () => {
  assert.deepEqual(blameOf(DNS), {
    machine: 'comp01vc01.ast01.mgmt.cloudttc.kz',
    reason: "Cannot get service content. / Soap fault. Temporary failure in name resolutionDetail: 'getaddrinfo failed in tcp_connect()', endpoint: 'https://vc01cast.t-cloud.kz:443/sdk'",
  });
  assert.equal(blameOf('Processing EMMDB1-T3Q4'), undefined, 'a name alone blames nobody');
  assert.equal(blameOf('Error: Выдано исключение типа "AgentClosedException".'), undefined, 'a reason alone names nobody');
  assert.equal(blameOf(undefined), undefined);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { appConfig, configService, idleMonitor, monitorWorld } = require('./world.cjs');
const { metricsText, PROMETHEUS_TEXT } = require('../dist/http/metrics');
const { MetricsController } = require('../dist/http/metrics.controller');

/* ------------------------------------------------------------------ *
 * HTTP: /api/metrics
 *
 * /api/health is asked of the transports, and tested beside them
 * (veeam.test.cjs). What is here is what the cycle read, as Prometheus reads it.
 * ------------------------------------------------------------------ */

const ZONE = 'Asia/Qyzylorda';
const GIB = 2 ** 30;
const at = (text) => Math.floor(Date.parse(text) / 1000);

/** The world's one server watched by the real monitor, with a failed job, a running one and a repository. */
const estate = () =>
  monitorWorld(
    {},
    [
      {
        id: 'j1', name: 'OPS_Exchange', type: 'Backup', status: 'Inactive', lastResult: 'Failed',
        lastRun: '2026-11-20T23:04:18+05:00', nextRun: '2026-11-27T23:04:00+05:00', objectsCount: 1,
      },
      { id: 'j2', name: 'CUST_FINHUB', type: 'VSphereReplica', status: 'Running', lastResult: 'None', lastRun: '2026-11-25T15:59:00+05:00' },
    ],
    {
      '/api/v1/backupInfrastructure/repositories/states': {
        data: [{ id: 'r1', name: 'Repo01', capacityGB: 1024, freeGB: 256, isOnline: true }],
      },
    },
  );

test('the metrics say what the latest pass read: the server, each job and each repository', async () => {
  const w = estate();
  await w.monitor.check();
  const [reading] = w.monitor.readings();
  const text = metricsText(w.monitor.readings(), w.monitor.status, ZONE);
  const lines = new Set(text.split('\n'));
  const server = `server="${reading.name}"`;
  const exchange = `${server},job_name="OPS_Exchange",job_id="j1",job_type="Backup"`;
  const finhub = `${server},job_name="CUST_FINHUB",job_id="j2",job_type="VSphereReplica"`;
  const repo = `${server},repository="Repo01",repository_id="r1"`;

  for (const line of [
    `veeam_server_up{${server}} 1`,
    `veeam_server_authenticated{${server}} 1`,
    `veeam_job_last_result{${exchange}} 2`,
    // A run going clears the last result: -1, not success.
    `veeam_job_last_result{${finhub}} -1`,
    `veeam_job_running{${exchange}} 0`,
    `veeam_job_running{${finhub}} 1`,
    `veeam_job_disabled{${exchange}} 0`,
    `veeam_job_last_run_timestamp_seconds{${exchange}} ${at('2026-11-20T23:04:18+05:00')}`,
    `veeam_job_next_run_timestamp_seconds{${exchange}} ${at('2026-11-27T23:04:00+05:00')}`,
    `veeam_job_objects{${exchange}} 1`,
    `veeam_repository_capacity_bytes{${repo}} ${1024 * GIB}`,
    `veeam_repository_free_bytes{${repo}} ${256 * GIB}`,
    `veeam_repository_used_bytes{${repo}} ${768 * GIB}`,
    `veeam_repository_online{${repo}} 1`,
    'veeam_monitor_events_delivered_total 0',
    '# TYPE veeam_job_last_result gauge',
    '# TYPE veeam_monitor_events_delivered_total counter',
  ]) {
    assert.ok(lines.has(line), `missing: ${line}\n\n${text}`);
  }
  // Nothing schedules CUST_FINHUB, so there is no next run to say rather than a zero.
  assert.doesNotMatch(text, /veeam_job_next_run_timestamp_seconds\{[^}]*CUST_FINHUB/);
  // No configuration backup was read (the world turns it off), so nothing is said of one.
  assert.doesNotMatch(text, /veeam_config_backup/);
  assert.ok(text.endsWith('\n'));
});

test('a server that stopped answering has no jobs in the metrics, not the ones it had an hour ago', async () => {
  // Repeated, the last job list would chart an outage as a quiet night.
  const w = estate();
  await w.monitor.check();
  w.veeam.request = async () => {
    throw new Error('connect ETIMEDOUT 192.0.2.1:9419');
  };
  await w.monitor.check();

  const text = metricsText(w.monitor.readings(), w.monitor.status, ZONE);
  assert.match(text, /^veeam_server_up\{server="[^"]+"\} 0$/m);
  assert.doesNotMatch(text, /veeam_job_|veeam_repository_/);
});

test('a server nothing has asked yet says nothing, rather than down', () => {
  const text = metricsText([{ key: 'a', name: 'veeam01', reachable: null, authenticated: null }], { delivered: 3, undelivered: 1 }, ZONE);
  assert.equal(
    text,
    [
      '# HELP veeam_monitor_events_delivered_total Events that reached at least one chat since the monitor started.',
      '# TYPE veeam_monitor_events_delivered_total counter',
      'veeam_monitor_events_delivered_total 3',
      '# HELP veeam_monitor_events_undelivered_total Events attempted that reached no chat since the monitor started.',
      '# TYPE veeam_monitor_events_undelivered_total counter',
      'veeam_monitor_events_undelivered_total 1',
      '',
    ].join('\n'),
  );
});

test('the configuration backup is said as one state of five, and its last good run', () => {
  const good = Date.parse('2026-11-24T10:01:00+05:00');
  const text = metricsText(
    [{
      key: 'a', name: 'veeam01', reachable: true, authenticated: true,
      configBackup: {
        staleDays: 2,
        last: { at: Date.parse('2026-11-25T10:00:00+05:00'), result: 'failed' },
        good: { at: good, result: 'success' },
        problem: 'failed',
      },
    }],
    { delivered: 0, undelivered: 0 },
    ZONE,
  );
  const lines = new Set(text.split('\n'));
  assert.ok(lines.has('veeam_config_backup_last_result{server="veeam01"} 2'));
  assert.ok(lines.has(`veeam_config_backup_last_good_timestamp_seconds{server="veeam01"} ${Math.floor(good / 1000)}`));
  for (const [state, value] of [['ok', 0], ['never', 0], ['failed', 1], ['stale', 0], ['unencrypted', 0]]) {
    assert.ok(lines.has(`veeam_config_backup_state{server="veeam01",state="${state}"} ${value}`), state);
  }
});

test('a name with a quote, a backslash or a line break stays one label value', () => {
  const text = metricsText(
    [{
      key: 'a', name: 'veeam01', reachable: true, authenticated: true,
      jobs: [{ id: 'j1', name: 'OPS "Exchange"\\nightly\nweekly', type: 'Backup', status: 'Inactive', result: 'success' }],
    }],
    { delivered: 0, undelivered: 0 },
    ZONE,
  );
  assert.match(text, /^veeam_job_last_result\{server="veeam01",job_name="OPS \\"Exchange\\"\\\\nightly\\nweekly",job_id="j1",job_type="Backup"\} 0$/m);
});

test('/api/metrics is off without METRICS_TOKEN, and asks for it when on', () => {
  const statusOf = (scrape) => {
    try {
      scrape();
    } catch (error) {
      return error.getStatus();
    }
    return 200;
  };
  const off = new MetricsController(configService(appConfig()), idleMonitor());
  assert.equal(statusOf(() => off.scrape('Bearer anything')), 404);

  const token = 'metrics-token-for-tests-0123456789';
  const on = new MetricsController(configService(appConfig({ METRICS_TOKEN: token })), idleMonitor());
  assert.equal(statusOf(() => on.scrape(undefined)), 401);
  assert.equal(statusOf(() => on.scrape(token)), 401, 'the token alone, without the scheme');
  assert.equal(statusOf(() => on.scrape(`Bearer ${token.slice(1)}x`)), 401);
  assert.match(on.scrape(`Bearer ${token}`), /^veeam_monitor_events_delivered_total 0$/m);
  assert.match(on.scrape(`bearer  ${token}`), /veeam_monitor_events_delivered_total/, 'the scheme in any case, as RFC 7235 has it');
});

test('/api/metrics answers on the real service, in the media type Prometheus reads', () => {
  // The controller above is built by hand; this is Nest's route, the global
  // prefix and the header, which a hand-built controller cannot show. In a
  // child process, as the architecture test starts the application: no .env
  // of anybody's, no bot token, no timer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam-metrics-'));
  const token = 'metrics-token-for-tests-0123456789';
  const port = 20000 + Math.floor(Math.random() * 20000);
  const root = path.resolve(__dirname, '..');
  const script = `
    require(${JSON.stringify(path.join(root, 'node_modules/reflect-metadata'))});
    const { NestFactory } = require(${JSON.stringify(path.join(root, 'node_modules/@nestjs/core'))});
    const { AppModule } = require(${JSON.stringify(path.join(root, 'dist/app.module'))});
    (async () => {
      const app = await NestFactory.create(AppModule, { logger: false });
      app.setGlobalPrefix('api');
      await app.listen(${port}, '127.0.0.1');
      const url = 'http://127.0.0.1:${port}/api/metrics';
      const refused = await fetch(url);
      const answered = await fetch(url, { headers: { authorization: 'Bearer ${token}' } });
      const body = await answered.text();
      await app.close();
      process.stdout.write(JSON.stringify({ refused: refused.status, status: answered.status, type: answered.headers.get('content-type'), body }));
    })().catch((error) => { process.stderr.write(error.stack); process.exit(1); });
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TELEGRAM|VEEAM|METRICS)_/.test(key)));
  try {
    const out = JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        cwd: dir,
        env: {
          ...env,
          METRICS_TOKEN: token,
          TELEGRAM_BOT_TOKEN: '',
          TELEGRAM_MONITOR_INTERVAL_MS: '0',
          TELEGRAM_STATE_FILE: path.join(dir, 'state.json'),
          LOG_FILE: path.join(dir, 'backend.log'),
        },
        encoding: 'utf8',
        timeout: 60_000,
      }),
    );
    assert.equal(out.refused, 401);
    assert.equal(out.status, 200);
    // Express puts the charset first; the parameters are what Prometheus reads, in any order.
    const [type, ...parameters] = out.type.split(';').map((part) => part.trim());
    assert.deepEqual([type, parameters.sort()], [PROMETHEUS_TEXT.split(';')[0], ['charset=utf-8', 'version=0.0.4']]);
    assert.match(out.body, /^veeam_monitor_events_delivered_total 0$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

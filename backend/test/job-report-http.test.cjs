const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { SessionStore } = require('../dist/auth/session.store');
const { VeeamHttpService } = require('../dist/veeam/veeam-http.service');

test('report HTTP routes enforce authentication, validate period and export job/session reports', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(require('cookie-parser')());
  app.setGlobalPrefix('api');
  const now = new Date().toISOString();
  const run = { id: 'run', jobId: 'job', name: 'Backup', state: 'Stopped', creationTime: now, endTime: now, result: { result: 'Success' } };
  app.get(VeeamHttpService).request = async ({ path }) => {
    if (path === '/api/v1/jobs/states') return { data: [{ id: 'job', name: 'Backup' }] };
    if (path === '/api/v1/sessions') return { data: [run], pagination: { total: 1 } };
    if (path === '/api/v1/sessions/run') return run;
    if (path.endsWith('/taskSessions')) return { data: [], pagination: { total: 0 } };
    if (path.endsWith('/logs')) return { records: [], totalRecords: 0 };
    throw new Error(`Unexpected upstream request ${path}`);
  };
  const user = app.get(SessionStore).create({ username: 'test', accessToken: 'test-only', accessTokenExpiresAt: Date.now() + 3600000 });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api`;
  const cookieName = app.get(require('@nestjs/config').ConfigService).get('session').cookieName;
  const headers = { Cookie: `${cookieName}=${encodeURIComponent(user.id)}` };
  try {
    assert.equal((await fetch(`${base}/jobs/job/report`)).status, 401);
    assert.equal((await fetch(`${base}/jobs/job/report?days=abc`, { headers })).status, 400);
    const report = await fetch(`${base}/jobs/job/report?days=0`, { headers });
    assert.equal(report.status, 200);
    assert.equal((await report.json()).period.days, 1);
    const csv = await fetch(`${base}/jobs/job/report.csv?days=7`, { headers });
    assert.match(csv.headers.get('Content-Type'), /text\/csv/);
    assert.match(csv.headers.get('Content-Disposition'), /attachment/);
    assert.match(await csv.text(), /Backup/);
    const html = await fetch(`${base}/jobs/job/report.html?days=7`, { headers });
    assert.match(html.headers.get('Content-Type'), /text\/html/);
    assert.match(await html.text(), /История запусков/);
    const runReport = await fetch(`${base}/jobs/job/sessions/run/report`, { headers });
    assert.equal((await runReport.json()).session.id, 'run');
    const runHtml = await fetch(`${base}/jobs/job/sessions/run/report.html`, { headers });
    assert.match(await runHtml.text(), /Объекты запуска/);
    assert.equal((await fetch(`${base}/jobs/other/sessions/run/report`, { headers })).status, 404);
  } finally { await app.close(); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const spec = require('../../veeam-swagger.json');
const { VeeamClientService } = require('../dist/veeam/veeam-client.service');
const { VeeamApiError } = require('../dist/veeam/veeam-api.error');
const { JobsService } = require('../dist/jobs/jobs.service');
const { JobReportService } = require('../dist/jobs/job-report.service');
const { jobReportCsv, jobReportHtml, sessionReportHtml } = require('../dist/jobs/job-report.export');
const session = { id: 'test' };
function client(respond) {
  return new VeeamClientService({ request: async req => {
    const route = Object.entries(spec.paths).find(([path]) => new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(req.path));
    assert.ok(route?.[1].get, req.path);
    assert.match(route[1].get.description, /Veeam Restore Operator/);
    for (const key of Object.keys(req.params ?? {})) assert.ok(route[1].get.parameters.some(p => p.name === key), `${req.path}?${key}`);
    return respond(req);
  } }, { getAccessToken: async () => 'test' }, { getOrThrow: () => ({ cacheTtlMs: 0 }) });
}
const now = new Date().toISOString();
const run = { id: 'run', name: 'VM backup', jobId: 'job', state: 'Stopped', result: { result: 'Success' }, creationTime: now, endTime: now };

test('job period report pages through filtered sessions and excludes unrelated jobs', async () => {
  const skips = [];
  const veeam = client(async req => {
    if (req.path === '/api/v1/jobs/states') return { data: [{ id: 'job', name: '<script>alert(1)</script>', lastResult: 'Success' }] };
    assert.equal(req.params.jobIdFilter, 'job');
    assert.ok(req.params.createdAfterFilter && req.params.createdBeforeFilter);
    skips.push(req.params.skip);
    return { data: req.params.skip === 0 ? [run, { ...run, id: 'other', jobId: 'other' }] : [{ ...run, id: 'run2' }], pagination: { total: 3 } };
  });
  const report = await new JobReportService(veeam, new JobsService(veeam)).report(session, 'job', 7);
  assert.deepEqual(skips, [0, 2]);
  assert.equal(report.stats.totalRuns, 2);
  assert.equal(report.stats.successRate, 100);
  assert.equal(report.period.days, 7);
  assert.doesNotMatch(jobReportHtml(report), /<script>/);
  assert.match(jobReportHtml(report), /&lt;script&gt;/);
  assert.match(jobReportCsv(report), /run2/);
});

test('bounded per-job history fetch uses job filter and respects server page caps', async () => {
  const veeam = client(async ({ params }) => {
    assert.equal(params.jobIdFilter, 'job');
    return { data: [{ ...run, id: String(params.skip) }], pagination: { total: 5 } };
  });
  const rows = await new JobsService(veeam).sessionsOfJob(session, 'job', 3);
  assert.deepEqual(rows.map(item => item.id), ['0', '1', '2']);
});

test('running None sessions are counted; unfinished runs do not affect durations', () => {
  const jobs = new JobsService({});
  const stats = jobs.computeStats([
    { state: 'WaitingRepository', result: 'None', endTime: null, durationSeconds: 900 },
    { state: 'Working', result: 'None', endTime: null, durationSeconds: null },
    { state: 'Stopped', result: 'Success', endTime: now, creationTime: now, durationSeconds: 60 },
    { state: 'Stopped', result: 'Failed', endTime: now, creationTime: now, durationSeconds: 120 },
  ]);
  assert.equal(stats.running, 2);
  assert.equal(stats.successRate, 50);
  assert.equal(stats.avgDurationSeconds, 90);
});

test('run report maps task bytes including server legacy spelling and returns logs', async () => {
  const veeam = client(async req => {
    if (req.path.endsWith('/taskSessions')) return { data: [{ ...run, id: 'task', sessionId: 'run', progress: { processedSize: 100, readSize: 50, transferedSize: 20, bottleneck: 'Source' } }] };
    if (req.path.endsWith('/logs')) return { totalRecords: 1, records: [{ id: 1, title: '<img src=x onerror=alert(1)>', status: 'Warning' }] };
    return run;
  });
  const report = await new JobReportService(veeam, new JobsService(veeam)).sessionReport(session, 'job', 'run');
  assert.equal(report.tasks.items[0].transferredBytes, 20);
  assert.equal(report.tasks.items[0].bottleneck, 'Source');
  assert.equal(report.logs.items.length, 1);
  assert.doesNotMatch(sessionReportHtml(report), /<img/);
});

test('run and task ownership are checked before reading logs', async () => {
  const requests = [];
  const veeam = client(async req => { requests.push(req.path); return req.path.includes('taskSessions') ? { sessionId: 'other-run' } : run; });
  const reports = new JobReportService(veeam, new JobsService(veeam));
  await assert.rejects(reports.sessionReport(session, 'wrong-job', 'run'), e => e.getStatus() === 404);
  await assert.rejects(reports.taskLogs(session, 'job', 'run', 'task'), e => e.getStatus() === 404);
  assert.ok(!requests.some(path => path.endsWith('/logs')));
});

test('restricted task data does not remove accessible run details', async () => {
  const veeam = client(async req => {
    if (req.path.endsWith('/taskSessions') || req.path.endsWith('/logs')) throw new VeeamApiError({ status: 403, upstreamStatus: 403, message: 'Forbidden' });
    return run;
  });
  const report = await new JobReportService(veeam, new JobsService(veeam)).sessionReport(session, 'job', 'run');
  assert.equal(report.session.id, 'run');
  assert.equal(report.tasks.available, false);
  assert.equal(report.logs.available, false);
});

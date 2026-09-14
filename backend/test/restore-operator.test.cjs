const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { VeeamClientService } = require('../dist/veeam/veeam-client.service');
const { VeeamApiError } = require('../dist/veeam/veeam-api.error');
const { BackupsService } = require('../dist/backups/backups.service');
const { ReplicasService } = require('../dist/replicas/replicas.service');
const { ComplianceService } = require('../dist/compliance/compliance.service');
const { AccessController } = require('../dist/veeam/access.controller');
const { DashboardService } = require('../dist/dashboard/dashboard.service');
const spec = require('../../veeam-swagger.json');
const error = (status) => new VeeamApiError({ status, upstreamStatus: status, message: `HTTP ${status}` });
const session = { id: 'operator' };
function client(respond) {
  return new VeeamClientService({ request: respond }, { getAccessToken: async () => 'test' }, { getOrThrow: () => ({ cacheTtlMs: 0 }) });
}
function checkRequest({ path, params }) {
  const match = Object.entries(spec.paths).find(([template]) => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
  assert.ok(match?.[1].get, `Undocumented GET ${path}`);
  const allowed = (match[1].get.parameters ?? []).map(p => p.name);
  for (const key of Object.keys(params ?? {})) assert.ok(allowed.includes(key), `Undocumented query ${path}?${key}`);
}

test('backup details use scoped restore points without a nonexistent backupObjectId', async () => {
  const points = spec.components.examples.ObjectRestorePointsResultExample.value;
  const veeam = client(async req => {
    checkRequest(req);
    if (req.path.endsWith('/restorePoints')) return points;
    return { id: 'object-1', name: 'VM', platformName: 'VMware' };
  });
  const result = await new BackupsService(veeam).objectDetails(session, 'object-1');
  assert.equal(result.restorePoints.items.length, points.data.length);
  assert.ok(result.restorePoints.items.every(p => p.backupObjectId === 'object-1'));
});

test('replica details use documented scoped endpoint and calculate latest point/count', async () => {
  const points = spec.components.examples.ReplicaPointsResultExample.value;
  const id = points.data[0].replicaId;
  const result = await new ReplicasService(client(async req => {
    checkRequest(req);
    return req.path.endsWith('/replicaPoints') ? points : { id, name: 'replica' };
  })).details(session, id);
  assert.equal(result.replica.restorePointsCount, 2);
  assert.equal(result.replica.latestRestorePointTime, points.data[0].creationTime);
  assert.ok(result.replica.lagMinutes > 0);
});

test('403 on object details remains forbidden rather than a misleading 404', async () => {
  await assert.rejects(new BackupsService(client(async () => { throw error(403); })).objectDetails(session, 'object'), e => e.getStatus() === 403);
});

test('only optional 403/404 become unavailable; 400 and server failures remain errors', async () => {
  for (const status of [403, 404]) assert.equal(await client(async () => { throw error(status); }).getOptional(session, '/path'), null);
  for (const status of [400, 500, 502]) await assert.rejects(client(async () => { throw error(status); }).getOptional(session, '/path'), e => e.getStatus() === status);
});

test('collections read additional pages even when Veeam caps page size', async () => {
  const skips = [];
  const veeam = client(async ({ params }) => {
    skips.push(params.skip);
    return { data: [params.skip], pagination: { total: 3, count: 1, limit: 1 } };
  });
  assert.deepEqual(await veeam.collection(session, '/path'), [0, 1, 2]);
  assert.deepEqual(skips, [0, 1, 2]);
});

test('Restore Operator access hides license and security; all probe paths/queries exist', async () => {
  const access = await new AccessController(client(async req => { checkRequest(req); throw error(403); })).describe(session);
  assert.deepEqual(access, { license: false, security: false });
});

test('security reads items and license capacity reads workloads without paging parameters', async () => {
  const veeam = client(async req => {
    checkRequest(req);
    if (req.path.endsWith('/bestPractices')) return { items: [{ id: 'p', bestPractice: 'MFA', status: 'Suppressed', note: 'reason' }] };
    if (req.path.endsWith('/lastRun') || req.path === '/api/v1/license') return {};
    if (req.path.endsWith('/capacity')) return { workloads: [{ name: 'share', usedCapacityGb: 10 }] };
    return { data: [], pagination: { total: 0 } };
  });
  const compliance = new ComplianceService(veeam);
  const security = await compliance.security(session);
  assert.equal(security.analyzer.items[0].name, 'MFA');
  assert.equal(security.analyzer.items[0].suppressComment, 'reason');
  assert.equal((await compliance.license(session)).topWorkloads[0].name, 'share');
});

test('dashboard retains available sessions when jobs are forbidden', async () => {
  const dashboard = new DashboardService({ list: async () => { throw error(403); }, recentSessions: async () => [{ id: 's' }] },
    { getServerInfo: async () => null }, { overview: async () => ({ repositories: { items: [] }, scaleOutRepositories: { items: [] } }) });
  const result = await dashboard.summary(session);
  assert.deepEqual(result.available, { jobs: false, sessions: true });
  assert.equal(result.recentSessions[0].id, 's');
});

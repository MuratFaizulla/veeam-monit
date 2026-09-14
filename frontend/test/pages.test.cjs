const { test } = require('node:test');
// Exercise production rendering, without development-only SSR layout-effect warnings.
process.env.NODE_ENV = 'production';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText, filename);
};
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { BackupsPage } = require('../src/pages/BackupsPage.tsx');
const { DashboardPage } = require('../src/pages/DashboardPage.tsx');
const { Layout } = require('../src/components/Layout.tsx');
const { AuthProvider } = require('../src/auth/AuthContext.tsx');
const { ErrorBox } = require('../src/components/Panels.tsx');
const { JobReportPanel } = require('../src/components/JobReportPanel.tsx');
const { ApiError } = require('../src/api/client.ts');
const h = React.createElement;
function render(component, entries) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  for (const [key, data] of entries) client.setQueryData(Array.isArray(key) ? key : [key], data);
  const html = renderToStaticMarkup(h(QueryClientProvider, { client }, h(MemoryRouter, null, h(AuthProvider, null, h(component)))));
  client.clear();
  return html;
}
test('backup objects render while the independent backup collection is still loading', () => {
  const html = render(BackupsPage, [['backupObjects', { available: true, items: [{ id: 'vm', name: 'Visible VM', restorePointsCount: 2 }] }]]);
  assert.match(html, /Visible VM/);
  assert.match(html, /backups\/objects\/vm/);
  assert.match(html, /Загрузка/);
});
test('dashboard distinguishes forbidden jobs from zero jobs and retains sessions', () => {
  const html = render(DashboardPage, [['dashboard', {
    available: { jobs: false, sessions: true }, server: null, generatedAt: '2026-09-11T00:00:00Z',
    jobs: { total: 0, byStatus: {}, successRate: null }, attention: [], running: [], upcoming: [], repositories: [],
    recentSessions: [{ id: 'session', name: 'Visible session', state: 'Stopped', result: 'Success', creationTime: null, endTime: null }],
  }]]);
  assert.doesNotMatch(html, /Всего заданий/);
  assert.match(html, /Visible session/);
  assert.match(html, /недоступен/);
});
test('restricted navigation hides license and security but retains restore pages', () => {
  const html = render(Layout, [['access', { license: false, security: false }]]);
  assert.doesNotMatch(html, /href="\/(license|security)"/);
  assert.match(html, /href="\/replicas"/);
  assert.match(html, /href="\/backups"/);
});
test('403 has an explanatory state with no pointless retry action', () => {
  const html = renderToStaticMarkup(h(ErrorBox, { error: new ApiError(403, 'Forbidden'), onRetry() {} }));
  assert.match(html, /Текущая роль Veeam/);
  assert.doesNotMatch(html, /Повторить/);
});

test('per-job report renders period, exports, session statistics and VM details', () => {
  const item = { id: 'run', name: 'Nightly backup', state: 'Stopped', result: 'Success', creationTime: '2026-09-11T00:00:00Z', endTime: '2026-09-11T00:01:00Z', durationSeconds: 60, progressPercent: 100 };
  const html = render(() => h(JobReportPanel, { jobId: 'job' }), [
    [['jobReport', 'job', 7], { period: { from: item.creationTime, to: item.endTime, days: 7 }, sessions: [item], stats: { totalRuns: 1, success: 1, failed: 0, warning: 0, running: 0, successRate: 100, avgDurationSeconds: 60, maxDurationSeconds: 60 } }],
    [['sessionReport', 'job', 'run'], { session: item, tasks: { available: true, total: 1, items: [{ ...item, id: 'task', name: 'Database VM', readBytes: 1073741824, transferredBytes: 536870912, processedBytes: 2147483648, bottleneck: 'Source', processingRate: '53.7 MB', algorithm: 'Increment' }] }, logs: { available: true, total: 1, items: [{ id: 1, status: 'Succeeded', title: 'Backup completed', startTime: item.endTime }] } }],
  ]);
  assert.match(html, /100%/);
  assert.match(html, /Database VM/);
  assert.match(html, /Backup completed/);
  assert.match(html, /\/api\/jobs\/job\/report.csv\?days=7/);
  assert.match(html, /\/api\/jobs\/job\/sessions\/run\/report.html/);
  assert.match(html, /30 дней/);
  assert.match(html, /90 дней/);
});

test('empty report period has no invented successful run or selected run request', () => {
  const html = render(() => h(JobReportPanel, { jobId: 'empty' }), [
    [['jobReport', 'empty', 7], { period: { from: '2026-09-01', to: '2026-09-08', days: 7 }, sessions: [], stats: { totalRuns: 0, success: 0, failed: 0, warning: 0, running: 0, successRate: null, avgDurationSeconds: null, maxDurationSeconds: null } }],
  ]);
  assert.match(html, /За выбранный период запусков нет/);
  assert.doesNotMatch(html, /100%/);
  assert.doesNotMatch(html, /Отчёт запуска/);
});

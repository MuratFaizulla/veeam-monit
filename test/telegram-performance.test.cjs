const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregatePerformance,
  formatBytes,
  formatPerformanceDuration,
  formatRate,
  parseProcessingRate,
  renderPerformance,
  sortPerformanceJobs,
} = require('../dist/live/performance.js');

test('performance rate parser accepts KB/s, MB/s and GB/s safely', () => {
  assert.equal(parseProcessingRate('850 KB/s'), 850 * 1024);
  assert.equal(parseProcessingRate('14 MB/s'), 14 * 1024 ** 2);
  assert.equal(parseProcessingRate('1.2 GB/s'), 1.2 * 1024 ** 3);
  assert.equal(parseProcessingRate('unknown'), undefined);
  assert.equal(parseProcessingRate(null), undefined);
  assert.equal(formatRate(218 * 1024 ** 2), '218 MB/s');
});

test('performance jobs sort slowest first and missing rates last', () => {
  const sorted = sortPerformanceJobs([
    { id: 'none', name: 'No data' },
    { id: 'fast', name: 'Fast', rateBps: 100 },
    { id: 'slow', name: 'Slow', rateBps: 10 },
  ]);
  assert.deepEqual(sorted.map((job) => job.id), ['slow', 'fast', 'none']);
});

test('performance formats bytes and elapsed durations', () => {
  assert.equal(formatBytes(1.5 * 1024 ** 4), '1.5 TB');
  assert.equal(formatBytes(undefined), 'нет данных');
  const now = new Date('2026-09-14T12:00:00Z');
  assert.equal(formatPerformanceDuration('2026-09-14T08:40:00Z', now), '3 ч 20 мин');
  assert.equal(formatPerformanceDuration('2026-09-12T03:00:00Z', now), '2 д 9 ч');
});

test('task aggregation sums sizes and active rates, tolerating null values', () => {
  const job = aggregatePerformance(
    { id: 's1', name: 'Job <one>', creationTime: '2026-09-14T10:00:00Z', state: 'Working' },
    [
      { type: 'Backup', state: 'Working', progress: { processingRate: '14 MB/s', processedSize: 10, readSize: null, transferredSize: 3, bottleneck: 'Source' } },
      { type: 'Replica', state: 'Working', progress: { processingRate: '1.2 GB/s', processedSize: 20, readSize: 5, transferredSize: null, bottleneck: 'Source' } },
      { type: 'Backup', state: 'Stopped', progress: { processingRate: '999 MB/s', processedSize: 1, bottleneck: 'Target' } },
      { type: 'Other', state: 'Working', progress: { processingRate: '50 MB/s', processedSize: 100 } },
      { type: 'Backup', state: 'Working', progress: null },
    ],
  );
  assert.equal(job.processedSize, 31);
  assert.equal(job.readSize, 5);
  assert.equal(job.transferredSize, 3);
  assert.equal(job.rateBps, 14 * 1024 ** 2 + 1.2 * 1024 ** 3);
  assert.equal(job.bottleneck, 'Source');
});

test('performance renderer escapes names and never exceeds Telegram limit', () => {
  const jobs = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    name: `<job & ${index}> ${'x'.repeat(300)}`,
    rateBps: (index + 1) * 1024 ** 2,
    processedSize: 20 * 1024 ** 4,
    creationTime: '2026-09-12T03:00:00Z',
    bottleneck: 'Network',
  }));
  const text = renderPerformance(
    { jobs, activeCount: jobs.length, statisticsAvailable: true },
    { now: new Date('2026-09-14T12:00:00Z'), timezone: 'UTC' },
  );
  assert.ok(text.length <= 4096);
  assert.match(text, /&lt;job &amp; 0&gt;/);
  assert.doesNotMatch(text, /<job & 0>/);
});

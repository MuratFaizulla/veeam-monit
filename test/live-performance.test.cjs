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

const clock = { now: new Date('2026-09-30T05:52:00Z'), timezone: 'Asia/Qyzylorda' };

test('📈 counts job runs only, and names Veeam\'s own sessions apart', () => {
  // veeam02 had a malware scan going and nothing else: ▶️ said nothing
  // was running while 📈 said "Активных заданий: 1".
  const idle = renderPerformance(
    { jobs: [], activeCount: 0, statisticsAvailable: true, serviceSessions: ['Malware Detection'] },
    clock,
  );
  assert.match(idle, /Сейчас задания не выполняются/);
  assert.match(idle, /Служебные сессии Veeam: Malware Detection/);
  assert.doesNotMatch(idle, /VEEAM PERFORMANCE/);
});

test('📈 on a Veeam with no task sessions lists what runs and says why there is no rate', () => {
  const text = renderPerformance({
    jobs: [{ id: 's1', name: 'KTZH_SDOT_AST', creationTime: '2026-09-29T15:00:00Z', progressPercent: 40 }],
    activeCount: 1,
    statisticsAvailable: false,
    statisticsUnsupported: true,
  }, clock);
  assert.match(text, /REST API \(1\.1\)/, 'not "временно недоступны": it never will be');
  assert.match(text, /<b>KTZH_SDOT_AST<\/b>\nидёт 14 ч 52 мин/, 'the job is still listed, with no "нет данных" beside it');
  assert.match(text, /Прогресс: 40%/);
  assert.doesNotMatch(text, /временно|нет данных|Не определено/);
});

test('📈 says where a transfer is slow in words, and when a long one began', () => {
  const text = renderPerformance({
    jobs: [{
      id: 's1', name: 'CUST_Mining_vm', creationTime: '2026-09-26T18:11:00Z',
      rateBps: 5 * 1024 ** 2, bottleneck: 'Source',
    }],
    activeCount: 1,
    statisticsAvailable: true,
  }, clock);
  assert.match(text, /Узкое место: источник \(диски ВМ\)/);
  assert.match(text, /Узкие места:<\/b> источник \(диски ВМ\) — 1/);
  assert.match(text, /старт 26\.09 в 23:11/);
  assert.doesNotMatch(text, /Показаны самые медленные/, 'nothing was left out');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderRepositories } = require('../dist/live/repositories.js');
const { capacities } = require('../dist/estate/repository-capacity.js');

// The slot is the pair: what Veeam reports is turned into capacities once, and
// the formatter renders those. Feeding the wire shape straight to the renderer
// would test a combination that no longer happens.
const render = (repositories, clock) => renderRepositories(capacities(repositories), clock);

const clock = { now: new Date('2026-09-14T12:00:00Z'), timezone: 'UTC' };

test('repository live view renders usage, capacity, free space and online state', () => {
  const text = render([{
    id: 'r1',
    name: 'Repository <01>',
    capacityGB: 100 * 1024,
    freeGB: 18 * 1024,
    usedSpaceGB: 82 * 1024,
    isOnline: true,
  }], clock);
  assert.match(text, /Repository &lt;01&gt;/);
  assert.match(text, /82%/);
  assert.match(text, /100 TB/);
  assert.match(text, /18 TB/);
  assert.match(text, /🟢 Доступен/);
  assert.match(text, /1\. Repository/);
  assert.match(text, /Заполненность репозиториев/);
});

test('a repository whose state Veeam does not report says nothing about it', () => {
  // veeam02 (REST API 1.1) reports no state: every repository read
  // "⚪ Статус: UNKNOWN".
  const text = render([{ id: 'r1', name: 'SITE2_NAS_BACKUP', capacityGB: 40 * 1024, freeGB: 22 * 1024 }], clock);
  assert.doesNotMatch(text, /UNKNOWN|Статус|Доступен/);
});

test('repository live view tolerates unknown metrics and stays under Telegram limit', () => {
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    name: `Repository ${index} ${'x'.repeat(100)}`,
    isOnline: index % 2 === 0,
  }));
  const text = render(repositories, clock);
  assert.ok(text.length <= 4096);
  assert.match(text, /нет данных/);
  assert.match(text, /Доступен|Недоступен/);
});

test('repository usage prefers capacity minus free when Veeam usedSpaceGB is logical', () => {
  const text = render([{
    id: 'fas',
    name: 'FAS repository',
    capacityGB: 100 * 1024,
    freeGB: 31.8 * 1024,
    // Some storage integrations report logical data here, above capacity.
    usedSpaceGB: 140 * 1024,
    isOnline: true,
  }], clock);
  assert.match(text, /68%/);
  assert.doesNotMatch(text, /100%/);
});

test('repositories are numbered by natural name order with Default last', () => {
  const text = render([
    { id: '5', name: 'SITE1_NAS_BKP05' },
    { id: 'default', name: 'Default Backup Repository' },
    { id: '2', name: 'SITE1_NAS_BKP02' },
    { id: '1', name: 'SITE1_NAS_BKP01' },
  ], clock);
  assert.ok(text.indexOf('1. SITE1_NAS_BKP01') < text.indexOf('2. SITE1_NAS_BKP02'));
  assert.ok(text.indexOf('2. SITE1_NAS_BKP02') < text.indexOf('3. SITE1_NAS_BKP05'));
  assert.ok(text.indexOf('3. SITE1_NAS_BKP05') < text.indexOf('4. Default Backup Repository'));
});

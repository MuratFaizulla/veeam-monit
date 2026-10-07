const test = require('node:test');
const assert = require('node:assert/strict');
const { renderRepositories } = require('../dist/live/repositories.js');
const { capacities } = require('../dist/estate/repository-capacity.js');
const { bar } = require('../dist/live/format.js');

// The slot is the pair: what Veeam reports is turned into capacities once, and
// the formatter renders those. Feeding the wire shape straight to the renderer
// would test a combination that no longer happens.
const render = (repositories, clock) => renderRepositories(capacities(repositories), clock);

const clock = { now: new Date('2026-09-14T12:00:00Z'), timezone: 'UTC' };
const TB = 1024;

test('one line per repository, the fullest first, under a line that says where space runs out', () => {
  const text = render([
    { id: 'r1', name: 'SITE1_NAS_BKP01', capacityGB: 120 * TB, freeGB: 21.6 * TB, isOnline: true },
    { id: 'r2', name: 'SITE1_NAS_BKP02', capacityGB: 80 * TB, freeGB: 3.8 * TB, isOnline: true },
    { id: 'r3', name: 'SITE1_SSD_01', capacityGB: 20 * TB, freeGB: 8.2 * TB, isOnline: true },
    { id: 'r4', name: 'SITE2_NAS_BKP01', capacityGB: 200 * TB, freeGB: 110 * TB, isOnline: true },
  ], clock);

  const [headline, list, footer] = text.split('\n\n');
  assert.equal(headline, '🔴 <b>Репозитории: 1 почти заполнен, 1 заполняется</b>');
  // The bars line up in one column, so the repositories compare at a glance;
  // "Доступен" under every one of them is gone, since that is the usual case.
  assert.deepEqual(list.split('\n'), [
    `🔴 <code> 95% ${bar(95.25, 10)}</code> <b>SITE1_NAS_BKP02</b> · свободно 3.8 из 80 TB`,
    `🟠 <code> 82% ${bar(82, 10)}</code> <b>SITE1_NAS_BKP01</b> · свободно 21.6 из 120 TB`,
    `🟢 <code> 59% ${bar(59, 10)}</code> <b>SITE1_SSD_01</b> · свободно 8.2 из 20 TB`,
    `🟢 <code> 45% ${bar(45, 10)}</code> <b>SITE2_NAS_BKP01</b> · свободно 110 из 200 TB`,
  ]);
  assert.match(footer, /^<i>Обновлено /u);
});

test('a repository Veeam cannot reach goes on top, and one it gives no figures for goes last', () => {
  const text = render([
    { id: 'a', name: 'A_FULL', capacityGB: 10 * TB, freeGB: 0.5 * TB, isOnline: true },
    { id: 'b', name: 'B_GONE', capacityGB: 10 * TB, freeGB: 5 * TB, isOnline: false },
    { id: 'c', name: 'C_BLANK', isOnline: true },
  ], clock);

  const [headline, list] = text.split('\n\n');
  assert.equal(headline, '🔴 <b>Репозитории: 1 недоступен, 1 почти заполнен, нет данных по 1</b>');
  assert.deepEqual(list.split('\n').map((line) => line.replace(/<code>.*<\/code> /u, '')), [
    '🔴 <b>B_GONE</b> — недоступен',
    '🔴 <b>A_FULL</b> · свободно 512 GB из 10 TB',
    '⚪ <b>C_BLANK</b> — нет данных о месте',
  ]);
});

test('a repository whose state Veeam does not report is judged by its space alone', () => {
  // veeam02 (REST API 1.1) reports no state: every repository read
  // "⚪ Статус: UNKNOWN".
  const text = render([{ id: 'r1', name: 'SITE2_NAS_BACKUP', capacityGB: 40 * TB, freeGB: 22 * TB }], clock);
  assert.doesNotMatch(text, /UNKNOWN|Статус|оступен/u);
  assert.ok(text.startsWith('🟢 <b>Репозиторий в порядке</b>\n\n'), text);
});

test('when there is room everywhere, the first line says so', () => {
  const roomy = (name) => ({ id: name, name, capacityGB: 100, freeGB: 60, isOnline: true });
  const headline = (count) => render(Array.from({ length: count }, (_, i) => roomy(`R${i}`)), clock).split('\n')[0];
  assert.equal(headline(2), '🟢 <b>Оба репозитория в порядке</b>');
  assert.equal(headline(3), '🟢 <b>Все 3 репозитория в порядке</b>');
  assert.equal(headline(5), '🟢 <b>Все 5 репозиториев в порядке</b>');
  assert.equal(
    render([roomy('A'), { id: 'b', name: 'B', capacityGB: 100, freeGB: 15 }], clock).split('\n')[0],
    '🟠 <b>Репозитории: 1 заполняется</b>',
  );
});

test('repository live view tolerates unknown metrics and stays under Telegram limit', () => {
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    name: `Repository ${index} ${'x'.repeat(100)}`,
    // Few enough unreachable ones that the list, which puts them first, gets
    // past them to the ones with no figures before the message is full.
    isOnline: index % 10 !== 0,
  }));
  const text = render(repositories, clock);
  assert.ok(text.length <= 4096);
  assert.match(text, /— нет данных о месте/u);
  assert.match(text, /— недоступен/u);
  assert.match(text, /…и ещё \d+/u);
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
  assert.match(text, / 68% /u);
  assert.doesNotMatch(text, /100%/u);
});

test('a repository name is written as text, never as markup', () => {
  const text = render([{ id: 'r1', name: 'Repository <01>', capacityGB: 100, freeGB: 50 }], clock);
  assert.match(text, /<b>Repository &lt;01&gt;<\/b>/u);
});

test('repositories equally full keep the natural name order, Default last', () => {
  const half = (id, name) => ({ id, name, capacityGB: 100, freeGB: 50 });
  const text = render([
    half('5', 'SITE1_NAS_BKP05'),
    half('default', 'Default Backup Repository'),
    half('2', 'SITE1_NAS_BKP02'),
    half('1', 'SITE1_NAS_BKP01'),
  ], clock);
  const at = ['SITE1_NAS_BKP01', 'SITE1_NAS_BKP02', 'SITE1_NAS_BKP05', 'Default Backup Repository']
    .map((name) => text.indexOf(`<b>${name}</b>`));
  assert.ok(at.every((position) => position > 0), text);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

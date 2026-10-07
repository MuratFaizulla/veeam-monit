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

test('one line per repository, by name, under a line that says where space runs out', () => {
  const text = render([
    { id: 'r4', name: 'SITE2_NAS_BKP01', capacityGB: 200 * TB, freeGB: 110 * TB, isOnline: true },
    { id: 'r2', name: 'SITE1_NAS_BKP02', capacityGB: 80 * TB, freeGB: 3.8 * TB, isOnline: true },
    { id: 'r1', name: 'SITE1_NAS_BKP01', capacityGB: 120 * TB, freeGB: 21.6 * TB, isOnline: true },
    { id: 'r3', name: 'SITE1_SSD_01', capacityGB: 20 * TB, freeGB: 8.2 * TB, isOnline: true },
  ], clock);

  const [headline, list, footer] = text.split('\n\n');
  assert.equal(headline, '🔴 <b>Репозитории: 1 почти заполнен, 1 заполняется</b>');
  // BKP01 where it was yesterday, whichever is fullest today; the bars line
  // up in one column, so the repositories compare at a glance; "Доступен"
  // under every one of them is gone, since that is the usual case.
  assert.deepEqual(list.split('\n'), [
    `🟠 <code> 82% ${bar(82, 10)}</code> <b>SITE1_NAS_BKP01</b> · свободно 21.6 из 120 TB`,
    `🔴 <code> 95% ${bar(95.25, 10)}</code> <b>SITE1_NAS_BKP02</b> · свободно 3.8 из 80 TB`,
    `🟢 <code> 59% ${bar(59, 10)}</code> <b>SITE1_SSD_01</b> · свободно 8.2 из 20 TB`,
    `🟢 <code> 45% ${bar(45, 10)}</code> <b>SITE2_NAS_BKP01</b> · свободно 110 из 200 TB`,
  ]);
  assert.match(footer, /^<i>Обновлено /u);
});

test('a repository Veeam cannot reach, and one it gives no figures for, say so in their place', () => {
  const text = render([
    { id: 'c', name: 'C_BLANK', isOnline: true },
    { id: 'a', name: 'A_FULL', capacityGB: 10 * TB, freeGB: 0.5 * TB, isOnline: true },
    { id: 'b', name: 'B_GONE', capacityGB: 10 * TB, freeGB: 5 * TB, isOnline: false },
  ], clock);

  const [headline, list] = text.split('\n\n');
  assert.equal(headline, '🔴 <b>Репозитории: 1 недоступен, 1 почти заполнен, нет данных по 1</b>');
  assert.deepEqual(list.split('\n').map((line) => line.replace(/<code>.*<\/code> /u, '')), [
    '🔴 <b>A_FULL</b> · свободно 512 GB из 10 TB',
    '🔴 <b>B_GONE</b> — недоступен',
    '⚪ <b>C_BLANK</b> — нет данных о месте',
  ]);
});

test('when the repositories do not all fit, the ones left out are ones that are fine', () => {
  const repositories = Array.from({ length: 80 }, (_, index) => ({
    id: String(index),
    name: `SITE1_NAS_BKP${String(index + 1).padStart(2, '0')} ${'x'.repeat(40)}`,
    capacityGB: 100 * TB,
    // The two almost full are the last by name.
    freeGB: (index >= 78 ? 5 : 50) * TB,
    isOnline: true,
  }));
  const text = render(repositories, clock);

  assert.ok(text.length <= 4096, `message is ${text.length} characters`);
  assert.match(text, /^🔴 <b>Репозитории: 2 почти заполнены<\/b>/u);
  assert.match(text, /<b>SITE1_NAS_BKP79 x+<\/b>/u);
  assert.match(text, /<b>SITE1_NAS_BKP80 x+<\/b>/u);
  assert.match(text, /\n…и ещё \d+ в порядке\n/u);
  const shown = [...text.matchAll(/BKP(\d{2})/gu)].map((match) => Number(match[1]));
  assert.deepEqual([...shown].sort((a, b) => a - b), shown, 'the ones shown keep their order');
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

test('repositories go by name, BKP2 before BKP10 however full each is, and Default last', () => {
  const used = (id, name, percent) => ({ id, name, capacityGB: 100, freeGB: 100 - percent });
  const text = render([
    used('10', 'SITE1_NAS_BKP10', 79),
    used('default', 'Default Backup Repository', 54),
    used('2', 'SITE1_NAS_BKP2', 61),
    used('1', 'SITE1_NAS_BKP1', 72),
  ], clock);
  const at = ['SITE1_NAS_BKP1', 'SITE1_NAS_BKP2', 'SITE1_NAS_BKP10', 'Default Backup Repository']
    .map((name) => text.indexOf(`<b>${name}</b>`));
  assert.ok(at.every((position) => position > 0), text);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

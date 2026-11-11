const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rotate } = require('../dist/logging/file-logger');

/** A log in a folder of its own, and what each file beside it holds. */
const logIn = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam-monit-log-'));
  const file = path.join(dir, 'backend.log');
  for (const [suffix, text] of Object.entries(files)) fs.writeFileSync(file + suffix, text);
  const held = () =>
    Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
  return { file, held };
};

test('a log under the limit is left where it is', () => {
  const { file, held } = logIn({ '': 'now', '.1': 'before' });
  rotate(file, 10, 3);
  assert.deepEqual(held(), { 'backend.log': 'now', 'backend.log.1': 'before' });
});

test('a full log moves aside as .1 and the ones before it move one further', () => {
  const { file, held } = logIn({ '': 'a full log', '.1': 'one', '.2': 'two' });
  rotate(file, 5, 3);
  assert.deepEqual(held(), { 'backend.log.1': 'a full log', 'backend.log.2': 'one', 'backend.log.3': 'two' });
});

test('the file past the number kept is dropped', () => {
  const { file, held } = logIn({ '': 'a full log', '.1': 'one', '.2': 'two', '.3': 'three' });
  rotate(file, 5, 3);
  assert.deepEqual(held(), { 'backend.log.1': 'a full log', 'backend.log.2': 'one', 'backend.log.3': 'two' });
});

test('a log with nothing kept beside it yet rotates all the same', () => {
  const { file, held } = logIn({ '': 'a full log' });
  rotate(file, 5, 3);
  assert.deepEqual(held(), { 'backend.log.1': 'a full log' });
});

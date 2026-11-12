const test = require('node:test');
const assert = require('node:assert/strict');
const { rememberingLookup } = require('../dist/telegram/remembered-lookup.js');

test('a lookup that fails answers with the address the name last resolved to', () => {
  // The host's DNS went silent for a night; Telegram had not moved.
  let down = false;
  let address = '149.154.167.220';
  const resolver = (hostname, options, callback) =>
    down ? callback(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })) : callback(null, address, 4);
  const lookup = rememberingLookup(resolver);
  const ask = (hostname, options = {}) => {
    let said;
    lookup(hostname, options, (error, found, family) => (said = { error: error?.code, found, family }));
    return said;
  };

  down = true;
  assert.equal(ask('api.telegram.org').error, 'EAI_AGAIN', 'nothing remembered yet: the failure is said');
  down = false;
  assert.deepEqual(ask('api.telegram.org'), { error: undefined, found: '149.154.167.220', family: 4 });
  down = true;
  assert.deepEqual(ask('api.telegram.org'), { error: undefined, found: '149.154.167.220', family: 4 });
  assert.equal(ask('other.example').error, 'EAI_AGAIN', 'a name never resolved has nothing to fall back on');
  assert.equal(ask('api.telegram.org', { all: true }).error, 'EAI_AGAIN', 'an answer of another shape is not handed out');
  // The day the name moves, the first lookup that works moves with it.
  down = false;
  address = '149.154.167.99';
  assert.equal(ask('api.telegram.org').found, '149.154.167.99');
  down = true;
  assert.equal(ask('api.telegram.org').found, '149.154.167.99');
});

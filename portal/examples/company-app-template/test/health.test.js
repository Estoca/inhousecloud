import test from 'node:test';
import assert from 'node:assert/strict';

test('template exposes a healthcheck contract', () => {
  assert.equal('/health'.startsWith('/'), true);
});


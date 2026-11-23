import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvironment } from '../src/config/env.schema.js';

const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/app', COOKIE_SECRET: 'c'.repeat(32) };
const hash = '0123456789abcdef0123456789abcdef';

test('Telegram keys are optional outside production, and missing or empty keys mean the fake platform', () => {
  assert.equal(parseEnvironment(base).telegram, undefined);
  assert.equal(parseEnvironment({ ...base, NODE_ENV: 'test', TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '' }).telegram, undefined);
});

test('both Telegram keys give credentials', () => {
  assert.deepEqual(parseEnvironment({ ...base, TELEGRAM_API_ID: '123456', TELEGRAM_API_HASH: hash }).telegram, { apiId: 123456, apiHash: hash });
});

test('only one Telegram key is a startup error that names the variable, not the value', () => {
  assert.throws(() => parseEnvironment({ ...base, TELEGRAM_API_ID: '123456' }), (error: Error) =>
    /TELEGRAM_API_HASH: Set both/.test(error.message) && !error.message.includes('123456'));
  assert.throws(() => parseEnvironment({ ...base, TELEGRAM_API_HASH: hash }), (error: Error) =>
    /TELEGRAM_API_ID: Set both/.test(error.message) && !error.message.includes(hash));
});

test('production requires the Telegram keys', () => {
  assert.throws(() => parseEnvironment({ ...base, NODE_ENV: 'production' }), /TELEGRAM_API_ID: Required in production/);
  assert.ok(parseEnvironment({ ...base, NODE_ENV: 'production', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: hash }).telegram);
});

test('malformed Telegram keys are rejected', () => {
  assert.throws(() => parseEnvironment({ ...base, TELEGRAM_API_ID: 'abc', TELEGRAM_API_HASH: hash }), /TELEGRAM_API_ID/);
  assert.throws(() => parseEnvironment({ ...base, TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: hash }), /TELEGRAM_API_ID/);
  assert.throws(() => parseEnvironment({ ...base, TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'xyz' }), /TELEGRAM_API_HASH: Must be/);
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createLoginRateLimiter } from '../src/middleware/loginRateLimiter.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

async function fixture(options: Parameters<typeof createLoginRateLimiter>[0] = {}) {
  let time = Date.now();
  const app = express();
  app.use(express.json());
  // This test-only header simulates distinct remote IPs. The production app
  // never uses it and continues to ignore untrusted proxy headers.
  app.use((request, _response, next) => {
    Object.defineProperty(request, 'ip', { value: request.get('X-Test-IP') ?? '192.0.2.1' });
    next();
  });
  app.post('/auth/login', createLoginRateLimiter({...options, now: () => time}), (request, response) => {
    response.status(request.body.password === 'correct' ? 200 : 401).json({});
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    advance(ms: number) { time += ms; },
    post(email = 'user@example.com', password = 'wrong', ip = '192.0.2.1') {
      return fetch(`http://127.0.0.1:${address.port}/auth/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Test-IP': ip},
        body: JSON.stringify({email, password}),
      });
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('successful attempts do not consume any limit and reset the email-plus-IP failure counter', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 55; i++) assert.equal((await f.post(undefined, 'correct')).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await f.post()).status, 401);
    assert.equal((await f.post(undefined, 'correct')).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await f.post()).status, 401);
    assert.equal((await f.post(undefined, 'correct')).status, 200);
  } finally { await f.close(); }
});

test('five email-plus-IP failures block only that pair until the fixed window expires', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.post(' USER@EXAMPLE.COM ')).status, 401);
    const blocked = await f.post();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    assert.deepEqual(await blocked.json(), {message: 'too many attempts; try again in 15 minutes'});
    assert.equal((await f.post(undefined, 'correct', '192.0.2.2')).status, 200);
    assert.equal((await f.post('other@example.com', 'correct')).status, 200);
    f.advance(14 * 60 * 1000 + 1000);
    const nearlyExpired = await f.post();
    assert.equal(nearlyExpired.status, 429);
    assert.equal(nearlyExpired.headers.get('retry-after'), '59');
    assert.deepEqual(await nearlyExpired.json(), {message: 'too many attempts; try again in 1 minute'});
    f.advance(59 * 1000);
    assert.equal((await f.post(undefined, 'correct')).status, 200);
  } finally { await f.close(); }
});

test('IP limit remains 20 failed attempts across different emails', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal((await f.post(`user${i}@example.com`)).status, 401);
    }
    assert.equal((await f.post('new@example.com')).status, 429);
    assert.equal((await f.post('new@example.com', 'correct', '192.0.2.2')).status, 200);
  } finally { await f.close(); }
});

test('email-only limit blocks at 50 failed attempts across different IPs', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal((await f.post(' USER@EXAMPLE.COM ', 'wrong', `192.0.2.${i + 1}`)).status, 401);
    }
    assert.equal((await f.post(undefined, 'correct', '192.0.2.100')).status, 429);
    assert.equal((await f.post('other@example.com', 'correct', '192.0.2.100')).status, 200);
    f.advance(15 * 60 * 1000);
    assert.equal((await f.post(undefined, 'correct', '192.0.2.100')).status, 200);
  } finally { await f.close(); }
});

test('success resets only the pair counter, preserving IP and email-wide failure totals', async () => {
  const ip = await fixture({ipLimit: 2});
  try {
    assert.equal((await ip.post()).status, 401);
    assert.equal((await ip.post(undefined, 'correct')).status, 200);
    assert.equal((await ip.post()).status, 401);
    assert.equal((await ip.post('other@example.com', 'correct')).status, 429);
  } finally { await ip.close(); }
  const email = await fixture({emailLimit: 2});
  try {
    assert.equal((await email.post()).status, 401);
    assert.equal((await email.post(undefined, 'correct')).status, 200);
    assert.equal((await email.post(undefined, 'wrong', '192.0.2.2')).status, 401);
    assert.equal((await email.post(undefined, 'correct', '192.0.2.3')).status, 429);
  } finally { await email.close(); }
});

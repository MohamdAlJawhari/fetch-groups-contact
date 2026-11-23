import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlatformError } from '../src/platforms/platform.errors.js';
import { TelegramPlatform, type TelegramClientAdapter, type TelegramLoginCallbacks } from '../src/platforms/telegram/telegram.platform.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const rpc = (errorMessage: string) => Object.assign(new Error(errorMessage), { errorMessage });
const isCode = (code: string) => (error: unknown) => error instanceof PlatformError && error.code === code;

/** Scripted stand-in for GramJS: the test decides when the QR is scanned and what Telegram answers. */
class FakeTelegramClient implements TelegramClientAdapter {
  calls: string[] = [];
  callbacks?: TelegramLoginCallbacks;
  emitQrOnLogin = true;
  failLogout = false;
  private login?: { resolve(): void; reject(error: Error): void };
  async connect() { this.calls.push('connect'); }
  loginWithQr(callbacks: TelegramLoginCallbacks) {
    this.calls.push('login');
    this.callbacks = callbacks;
    return new Promise<void>((resolve, reject) => {
      this.login = { resolve, reject };
      if (this.emitQrOnLogin) callbacks.qrCode(Buffer.from('token-1')).catch(reject);
    });
  }
  async getDialogs() { return { chats: [] }; }
  async logOut() { this.calls.push('logOut'); if (this.failLogout) throw new Error('network down'); }
  async destroy() { this.calls.push('destroy'); }
  scan() { this.login!.resolve(); }
  fail(error: Error) { this.login!.reject(error); }
  /** Mimics GramJS's password loop: ask, check, report errors through onError, ask again. */
  async requirePassword(correct: string, hint?: string) {
    for (;;) {
      let password: string;
      try { password = await this.callbacks!.password(hint); }
      catch (error) {
        if (await this.callbacks!.onError(error as Error)) return this.login!.reject(new Error('AUTH_USER_CANCEL'));
        continue;
      }
      await tick();
      if (password === correct) return this.login!.resolve();
      if (await this.callbacks!.onError(rpc('PASSWORD_HASH_INVALID'))) return this.login!.reject(new Error('AUTH_USER_CANCEL'));
    }
  }
}

function setup(options: { connectTimeoutMs?: number } = {}) {
  const client = new FakeTelegramClient();
  const platform = new TelegramPlatform({ makeClient: () => client, connectTimeoutMs: options.connectTimeoutMs ?? 1_000, passwordTimeoutMs: 1_000 });
  return { client, platform };
}

test('connect resolves on the first QR token with a tg://login string, and a refreshed token changes the QR', async () => {
  const { client, platform } = setup();
  assert.deepEqual(await platform.getStatus(), { status: 'disconnected' });
  await platform.connect();
  assert.deepEqual(client.calls, ['connect', 'login']);
  assert.deepEqual(await platform.getStatus(), { status: 'waiting-for-scan', qr: `tg://login?token=${Buffer.from('token-1').toString('base64url')}` });
  await client.callbacks!.qrCode(Buffer.from([0xfb, 0xff, 0x01]));
  assert.deepEqual(await platform.getStatus(), { status: 'waiting-for-scan', qr: 'tg://login?token=-_8B' });
  client.scan();
  await tick();
  assert.deepEqual(await platform.getStatus(), { status: 'connected' });
});

test('connect without a QR token in time throws unavailable and destroys the client without logging out', async () => {
  const { client, platform } = setup({ connectTimeoutMs: 20 });
  client.emitQrOnLogin = false;
  await assert.rejects(platform.connect(), isCode('unavailable'));
  assert.deepEqual(client.calls, ['connect', 'login', 'destroy']);
  assert.deepEqual(await platform.getStatus(), { status: 'disconnected' });
});

test('2FA: password-required with the hint, a wrong password keeps it, the right one connects', async () => {
  const { client, platform } = setup();
  await platform.connect();
  const loop = client.requirePassword('right', 'my hint');
  await tick();
  assert.deepEqual(await platform.getStatus(), { status: 'password-required', passwordHint: 'my hint' });
  await assert.rejects(platform.submitPassword('wrong'), isCode('wrong_password'));
  assert.deepEqual(await platform.getStatus(), { status: 'password-required', passwordHint: 'my hint' });
  await platform.submitPassword('right');
  await loop;
  assert.deepEqual(await platform.getStatus(), { status: 'connected' });
});

test('2FA without a hint has no passwordHint field', async () => {
  const { client, platform } = setup();
  await platform.connect();
  void client.requirePassword('right');
  await tick();
  assert.deepEqual(await platform.getStatus(), { status: 'password-required' });
  await platform.disconnect();
});

test('a password check failing for another reason is unavailable and the password step stays', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, platform } = setup();
  await platform.connect();
  // GramJS asks for the password, receives it, and then reports a flood instead of an answer.
  const asked = client.callbacks!.password();
  const submitted = platform.submitPassword('right');
  assert.equal(await asked, 'right');
  assert.equal(await client.callbacks!.onError(Object.assign(rpc('FLOOD_WAIT'), { seconds: 120 })), false);
  await assert.rejects(submitted, isCode('unavailable'));
  assert.equal((await platform.getStatus()).status, 'password-required');
  // GramJS asks again; the user can retry.
  const askedAgain = client.callbacks!.password();
  const retried = platform.submitPassword('right');
  assert.equal(await askedAgain, 'right');
  client.scan();
  await retried;
  assert.equal((await platform.getStatus()).status, 'connected');
  await platform.disconnect();
});

test('an error in the password loop with no password in flight stops the login instead of looping', async () => {
  const { client, platform } = setup();
  await platform.connect();
  assert.equal(await client.callbacks!.onError(rpc('INTERNAL')), true);
  await platform.disconnect();
});

test('submitPassword outside the password step is refused', async () => {
  const { platform } = setup();
  await platform.connect();
  await assert.rejects(platform.submitPassword('x'), /not waiting for a password/);
  await platform.disconnect();
});

test('a login failing in the background turns the status disconnected and logs only the error code', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { client, platform } = setup();
  await platform.connect();
  client.fail(Object.assign(new Error('secret detail +12025550101'), { errorMessage: 'AUTH_TOKEN_EXPIRED' }));
  await tick(); await tick();
  assert.deepEqual(await platform.getStatus(), { status: 'disconnected' });
  assert.ok(client.calls.includes('destroy'));
  assert.ok(!client.calls.includes('logOut'));
  const logged = JSON.stringify(errors.mock.calls.map(call => call.arguments));
  assert.match(logged, /AUTH_TOKEN_EXPIRED/);
  assert.doesNotMatch(logged, /secret detail|12025550101|tg:\/\/login/);
});

test('disconnect logs out only when logged in, always destroys, and is idempotent', async () => {
  const waiting = setup();
  await waiting.platform.connect();
  await waiting.platform.disconnect();
  await waiting.platform.disconnect();
  assert.deepEqual(waiting.client.calls, ['connect', 'login', 'destroy']);
  assert.deepEqual(await waiting.platform.getStatus(), { status: 'disconnected' });

  const connected = setup();
  await connected.platform.connect();
  connected.client.scan();
  await tick();
  await connected.platform.disconnect();
  await connected.platform.disconnect();
  assert.deepEqual(connected.client.calls, ['connect', 'login', 'logOut', 'destroy']);
});

test('disconnect never throws when logout fails, still destroys the client, and logs no error message', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { client, platform } = setup();
  await platform.connect();
  client.scan();
  await tick();
  client.failLogout = true;
  await platform.disconnect();
  assert.deepEqual(client.calls.slice(-2), ['logOut', 'destroy']);
  const logged = JSON.stringify(errors.mock.calls.map(call => call.arguments));
  assert.match(logged, /Telegram logout failed/);
  assert.doesNotMatch(logged, /network down/);
});

test('disconnect during the password step stops the login loop without logging out', async () => {
  const { client, platform } = setup();
  await platform.connect();
  const loop = client.requirePassword('right');
  await tick();
  await platform.disconnect();
  await loop;
  await assert.rejects(platform.submitPassword('right'), /not waiting/);
  assert.deepEqual(await platform.getStatus(), { status: 'disconnected' });
  assert.ok(!client.calls.includes('logOut'));
});

import type { TelegramCredentials } from '../config/env.schema.js';
import { FakePlatform, type FakePlatformOptions } from './fake.platform.js';
import type { Platform, PlatformName } from './platform.types.js';
import { TelegramPlatform, gramJsClientMaker } from './telegram/telegram.platform.js';

export interface PlatformFactoryOptions extends FakePlatformOptions {
  /** Real Telegram when set; otherwise `telegram` uses FakePlatform (development and tests only, see env.schema.ts). */
  telegram?: TelegramCredentials;
}

export function createPlatform(name: PlatformName, options: PlatformFactoryOptions = {}): Platform {
  switch (name) {
    case 'telegram':
      if (options.telegram) return new TelegramPlatform({ makeClient: gramJsClientMaker(options.telegram) });
      return new FakePlatform(name, options);
    case 'whatsapp':
      return new FakePlatform(name, options);
    default:
      throw new Error('Unsupported platform');
  }
}

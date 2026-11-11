import { FakePlatform, type FakePlatformOptions } from './fake.platform.js';
import type { Platform, PlatformName } from './platform.types.js';

export function createPlatform(name: PlatformName, options: FakePlatformOptions = {}): Platform {
  switch (name) {
    case 'telegram':
    case 'whatsapp':
      return new FakePlatform(name, options);
    default:
      throw new Error('Unsupported platform');
  }
}

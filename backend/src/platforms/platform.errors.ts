/** Known platform failures. ConnectionsService maps the codes to HTTP errors (docs/specs/06-telegram.md 4.10). */
export type PlatformErrorCode = 'unavailable' | 'wrong_password' | 'members_hidden';

export class PlatformError extends Error {
  constructor(readonly code: PlatformErrorCode, readonly groupIds?: readonly string[]) {
    super(`Platform error: ${code}`);
  }
}

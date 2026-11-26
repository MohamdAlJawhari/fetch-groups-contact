import { strings } from './strings';

/** A failed API call. `status` 0 means the server could not be reached (or a download broke off). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly groupIds?: readonly string[]) {
    super(message);
  }
}

export const PASSWORD_CHANGE_REQUIRED = 'password change required';
export const ADMIN_ACCESS_REQUIRED = 'admin access required';

interface CallOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Apply the navigation rules (401 → login, 403 password change → change password). Off for login itself. */
  redirect?: boolean;
}

/** docs/specs/07-frontend.md 3: the navigation rules, shared by every call. */
function followNavigationRules(error: ApiError) {
  const path = window.location.pathname;
  if (error.status === 401 && path !== '/login') window.location.assign('/login');
  else if (error.status === 403 && error.message === PASSWORD_CHANGE_REQUIRED && path !== '/change-password') {
    window.location.assign('/change-password');
  }
}

async function toApiError(response: Response) {
  const data: unknown = await response.json().catch(() => undefined);
  const record = (data ?? {}) as { message?: unknown; groupIds?: unknown };
  const message = typeof record.message === 'string' ? record.message : strings.errors.unexpected;
  const groupIds = Array.isArray(record.groupIds) ? record.groupIds.filter((id): id is string => typeof id === 'string') : undefined;
  return new ApiError(response.status, message, groupIds);
}

async function send(path: string, { method = 'GET', body }: CallOptions) {
  try {
    return await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, strings.errors.network);
  }
}

/** One JSON call to the backend through /api. Throws ApiError with the server's message on any non-2xx. */
export async function api<T>(path: string, options: CallOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  const error = await toApiError(response);
  if (options.redirect !== false) followNavigationRules(error);
  throw error;
}

/** POST that answers with a file: saves it through a temporary link and forgets it (spec 4.6). */
export async function apiDownload(path: string, body: unknown, fallbackName: string): Promise<void> {
  const response = await send(path, { method: 'POST', body });
  if (!response.ok) {
    const error = await toApiError(response);
    followNavigationRules(error);
    throw error;
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ApiError(0, strings.connect.downloadFailed);
  }
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFrom(response.headers.get('content-disposition')) ?? fallbackName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** Characters a file name must not have: Windows-reserved, control, and bidi controls (they can fake an extension). */
const UNSAFE_NAME = /[\u0000-\u001F\u007F"*/:<>?\\|‎‏‪-‮⁦-⁩]/g;

/**
 * The download name from `Content-Disposition` (spec 05, 4.6): the UTF-8 `filename*` (it may hold an Arabic group
 * title) when present, else the ASCII `filename`. Unsafe characters are removed again, as a second line of defence.
 */
export function filenameFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  let name: string | undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header);
  if (extended?.[1]) {
    try { name = decodeURIComponent(extended[1]); } catch { name = undefined; }
  }
  name ??= /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;\s]+)/i.exec(header)?.[1];
  const clean = name?.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim();
  return clean || undefined;
}

/** Fire-and-forget DELETE that survives the page closing (spec 4.2, "Leaving the page"). */
export function disconnectOnLeave(connectionId: string) {
  try {
    void fetch(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
  } catch {
    // The page is going away; the backend's idle reaper is the fallback.
  }
}

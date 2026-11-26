'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { SessionUser } from './types';

/**
 * Who is logged in (GET /auth/me). A 401 sends the browser to /login through the API wrapper.
 * With `allowTemporary` false, a user who still has a temporary password is sent to /change-password.
 */
export function useSession({ allowTemporary = false }: { allowTemporary?: boolean } = {}) {
  const [user, setUser] = useState<SessionUser | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  useEffect(() => {
    let active = true;
    api<{ user: SessionUser }>('/auth/me')
      .then(({ user: current }) => {
        if (!active) return;
        if (current.mustChangePassword && !allowTemporary) window.location.assign('/change-password');
        else setUser(current);
      })
      .catch((caught: unknown) => {
        if (active && caught instanceof ApiError && caught.status !== 401) setError(caught);
      });
    return () => { active = false; };
  }, [allowTemporary]);
  return { user, error };
}

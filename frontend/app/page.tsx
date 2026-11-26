'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { sentence, strings } from '@/lib/strings';
import type { SessionUser } from '@/lib/types';

/** `/`: ask who is logged in and route there (401 → login is handled by the API wrapper). */
export default function Home() {
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<{ user: SessionUser }>('/auth/me')
      .then(({ user }) => window.location.replace(user.mustChangePassword ? '/change-password' : '/connect'))
      .catch((caught: unknown) => { if (caught instanceof ApiError && caught.status !== 401) setError(sentence(caught.message)); });
  }, []);
  return (
    <main className="mx-auto max-w-sm px-6 pt-16">
      {error ? <p role="alert" className="text-red-700">{error}</p> : <p role="status" className="text-stone-600">{strings.loading}</p>}
    </main>
  );
}

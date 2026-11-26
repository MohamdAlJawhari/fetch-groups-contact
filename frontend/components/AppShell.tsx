'use client';

import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { sentence, strings } from '@/lib/strings';
import type { SessionUser } from '@/lib/types';
import { useSession } from '@/lib/useSession';
import { Button } from './Button';
import { Callout } from './Callout';
import { AppMark } from './Logos';

/** Every screen after login: the top bar and the centred content column. Children get the logged-in user. */
export function AppShell({ children }: { children: (user: SessionUser) => ReactNode }) {
  const { user, error } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logOut() {
    setLoggingOut(true);
    try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* the session is gone either way */ }
    window.location.assign('/login');
  }

  return (
    <div className="min-h-screen">
      {/* Design system "TopBar": flex with a spacer, so the two ends swap sides in right-to-left. */}
      <header className="flex h-12 items-center gap-4 border-b border-stone-200 bg-stone-50 px-4">
        <Link href="/connect" className="focus-ring flex items-center gap-2 rounded-md text-sm font-semibold">
          <AppMark size={20} />
          {strings.appName}
        </Link>
        <div className="flex-1" />
        {user && (
          <>
            <span dir="auto" className="hidden truncate text-stone-600 sm:inline">{user.email}</span>
            {user.role === 'admin' && (
              <Link href="/admin/users" className="focus-ring rounded-md text-sm font-medium text-blue-600 hover:underline">
                {strings.topBar.admin}
              </Link>
            )}
            <Button variant="ghost" size="sm" busy={loggingOut} busyLabel={strings.topBar.loggingOut} icon={<LogOut aria-hidden className="size-4" />} onClick={logOut}>
              {strings.topBar.logOut}
            </Button>
          </>
        )}
      </header>
      <main className="mx-auto max-w-3xl px-6 pt-12 pb-16">
        {error ? <Callout tone="error">{sentence(error.message)}</Callout>
          : user ? children(user)
          : <p role="status" className="text-stone-600">{strings.loading}</p>}
      </main>
    </div>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { Field } from '@/components/Field';
import { api, ApiError } from '@/lib/api';
import { sentence, strings } from '@/lib/strings';
import type { SessionUser } from '@/lib/types';

/** M1. The server's message is shown as is ("wrong email or password", or the 429 "too many attempts…"). */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { user } = await api<{ user: SessionUser }>('/auth/login', { method: 'POST', body: { email, password }, redirect: false });
      setPassword('');
      window.location.replace(user.mustChangePassword ? '/change-password' : '/connect');
    } catch (caught) {
      setError(sentence(caught instanceof ApiError ? caught.message : strings.errors.unexpected));
      setBusy(false);
    }
  }

  return (
    <AuthCard title={strings.login.title}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <Callout tone="error">{error}</Callout>}
        <Field id="email" label={strings.login.email} type="email" autoComplete="username" required dir="auto"
          value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />
        <Field id="password" label={strings.login.password} type="password" autoComplete="current-password" required
          value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
        <Button type="submit" variant="primary" busy={busy} busyLabel={strings.login.busy} fullWidth disabled={!email || !password}>
          {strings.login.submit}
        </Button>
      </form>
    </AuthCard>
  );
}

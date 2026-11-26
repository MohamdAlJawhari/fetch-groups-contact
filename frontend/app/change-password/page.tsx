'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/AuthCard';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { Field } from '@/components/Field';
import { api, ApiError } from '@/lib/api';
import { sentence, strings } from '@/lib/strings';
import { useSession } from '@/lib/useSession';

/** M2. Allowed with a temporary password; on success the server ends every session, so the user logs in again. */
export default function ChangePasswordPage() {
  const { user } = useSession({ allowTemporary: true });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || done) return;
    setError(undefined);
    if (next !== confirm) { setMismatch(true); return; }
    setMismatch(false);
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
      setTimeout(() => window.location.replace('/login'), 1_500);
    } catch (caught) {
      setError(sentence(caught instanceof ApiError ? caught.message : strings.errors.unexpected));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return <main className="mx-auto max-w-sm px-6 pt-16"><p role="status" className="text-stone-600">{strings.loading}</p></main>;

  const t = strings.changePassword;
  return (
    <AuthCard title={t.title} intro={user.mustChangePassword ? t.intro : t.introVoluntary}>
      {done ? (
        <Callout tone="success">{t.done}</Callout>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {error && <Callout tone="error">{error}</Callout>}
          <input type="email" autoComplete="username" value={user.email} readOnly hidden />
          <Field id="current" label={t.current} type="password" autoComplete="current-password" required
            value={current} onChange={event => setCurrent(event.target.value)} disabled={busy} />
          <Field id="new" label={t.next} type="password" autoComplete="new-password" required hint={t.hint}
            value={next} onChange={event => setNext(event.target.value)} disabled={busy} />
          <Field id="confirm" label={t.confirm} type="password" autoComplete="new-password" required
            error={mismatch ? t.mismatch : undefined}
            value={confirm} onChange={event => { setConfirm(event.target.value); setMismatch(false); }} disabled={busy} />
          <Button type="submit" variant="primary" busy={busy} busyLabel={t.busy} fullWidth disabled={!current || !next || !confirm}>
            {t.submit}
          </Button>
          {!user.mustChangePassword && (
            <Link href="/connect" className="focus-ring self-center rounded text-sm text-stone-600 underline underline-offset-2">{t.cancel}</Link>
          )}
        </form>
      )}
    </AuthCard>
  );
}

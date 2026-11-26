'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Field } from '@/components/Field';
import { TempPasswordBox } from '@/components/TempPasswordBox';
import { ADMIN_ACCESS_REQUIRED, api, ApiError } from '@/lib/api';
import { sentence, strings } from '@/lib/strings';
import type { AdminUser, SessionUser, UserWithTemporaryPassword } from '@/lib/types';

export default function AdminUsersPage() {
  return <AppShell>{user => <AdminUsers me={user} />}</AppShell>;
}

type Pending = { kind: 'reset' | 'disable' | 'delete'; user: AdminUser };
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatDate = (value: string | null) => (value ? dateFormat.format(new Date(value)) : strings.admin.never);
const t = strings.admin;

/** M3–M7: list, create (temporary password shown once), reset, disable, enable; T52: delete (history is kept). */
function AdminUsers({ me }: { me: SessionUser }) {
  const [users, setUsers] = useState<AdminUser[]>();
  const [forbidden, setForbidden] = useState(me.role !== 'admin');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [temporary, setTemporary] = useState<{ email: string; password: string }>();
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [pending, setPending] = useState<Pending>();
  const [acting, setActing] = useState<string>();

  const fail = useCallback((caught: unknown) => {
    if (caught instanceof ApiError && caught.status === 403 && caught.message === ADMIN_ACCESS_REQUIRED) setForbidden(true);
    else setMessage({ tone: 'error', text: sentence(caught instanceof ApiError ? caught.message : strings.errors.unexpected) });
  }, []);

  useEffect(() => {
    if (forbidden) return;
    api<{ users: AdminUser[] }>('/admin/users').then(({ users: list }) => setUsers(list), fail);
  }, [forbidden, fail]);

  const replace = (updated: AdminUser) => setUsers(list => list?.map(user => (user.id === updated.id ? updated : user)));

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true); setCreateError(undefined); setMessage(undefined);
    try {
      const result = await api<UserWithTemporaryPassword>('/admin/users', { method: 'POST', body: { email } });
      setUsers(list => [result.user, ...(list ?? [])]);
      setTemporary({ email: result.user.email, password: result.temporaryPassword });
      setEmail('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) fail(caught);
      else setCreateError(sentence(caught instanceof ApiError ? caught.message : strings.errors.unexpected));
    } finally {
      setCreating(false);
    }
  }

  async function run(kind: 'reset' | 'disable' | 'enable' | 'delete', user: AdminUser) {
    setActing(user.id); setMessage(undefined);
    try {
      if (kind === 'delete') {
        await api(`/admin/users/${user.id}`, { method: 'DELETE' });
        setUsers(list => list?.filter(entry => entry.id !== user.id));
        setMessage({ tone: 'success', text: t.deletedDone(user.email) });
      } else if (kind === 'reset') {
        const result = await api<UserWithTemporaryPassword>(`/admin/users/${user.id}/reset-password`, { method: 'POST' });
        replace(result.user);
        setTemporary({ email: result.user.email, password: result.temporaryPassword });
      } else {
        const result = await api<{ user: AdminUser }>(`/admin/users/${user.id}/${kind}`, { method: 'POST' });
        replace(result.user);
        setMessage({ tone: 'success', text: kind === 'enable' ? t.enabled(result.user.email) : t.disabledDone(result.user.email) });
      }
    } catch (caught) {
      fail(caught);
    } finally {
      setActing(undefined); setPending(undefined);
    }
  }

  if (forbidden) {
    return (
      <Callout tone="info" action={<Link href="/connect" className="focus-ring rounded text-sm font-medium text-blue-600 hover:underline">{t.backToConnect}</Link>}>
        {t.notAllowed}
      </Callout>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="text-stone-600">{t.intro}</p>
      </div>

      {temporary && <TempPasswordBox email={temporary.email} password={temporary.password} onDismiss={() => setTemporary(undefined)} />}
      {message && <Callout tone={message.tone}>{message.text}</Callout>}

      <form onSubmit={create} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
        <Field id="new-user-email" className="flex-1" label={t.createLabel} type="email" placeholder={t.createPlaceholder} dir="auto"
          autoComplete="off" value={email} onChange={event => { setEmail(event.target.value); setCreateError(undefined); }}
          error={createError} disabled={creating} />
        <Button type="submit" variant="primary" className="sm:mt-7" busy={creating} busyLabel={t.creating} disabled={!email.trim()}>{t.create}</Button>
      </form>

      {!users ? (
        <p role="status" className="text-stone-600">{strings.loading}</p>
      ) : users.length === 0 ? (
        <p className="text-stone-600">{t.noUsers}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full text-start text-sm">
            <thead className="bg-stone-50 text-xs text-stone-600">
              <tr>
                {[t.columns.email, t.columns.status, t.columns.password, t.columns.created, t.columns.lastLogin, t.columns.actions].map(column => (
                  <th key={column} scope="col" className="px-3 py-2 text-start font-medium">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(user => {
                const isMe = user.id === me.id;
                return (
                  <tr key={user.id} className="border-t border-stone-200 align-middle">
                    <td className="px-3 py-2.5"><bdi>{user.email}</bdi>{isMe && <span className="ms-1 text-stone-500">{t.you}</span>}</td>
                    <td className="px-3 py-2.5">{user.isActive ? t.active : <span className="text-red-700">{t.disabled}</span>}</td>
                    <td className="px-3 py-2.5 text-stone-600">{user.mustChangePassword ? t.temporary : t.set}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-stone-600">{formatDate(user.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-stone-600">{formatDate(user.lastLoginAt)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={!!acting} onClick={() => setPending({ kind: 'reset', user })}>{t.resetPassword}</Button>
                        {user.isActive
                          ? !isMe && <Button size="sm" variant="danger-quiet" disabled={!!acting} onClick={() => setPending({ kind: 'disable', user })}>{t.disable}</Button>
                          : <Button size="sm" disabled={!!acting} busy={acting === user.id} onClick={() => run('enable', user)}>{t.enable}</Button>}
                        {!isMe && <Button size="sm" variant="danger-quiet" disabled={!!acting} onClick={() => setPending({ kind: 'delete', user })}>{t.delete}</Button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        title={!pending ? '' : pending.kind === 'reset' ? t.confirmReset(pending.user.email)
          : pending.kind === 'delete' ? t.confirmDelete(pending.user.email) : t.confirmDisable(pending.user.email)}
        body={pending?.kind === 'disable' ? t.confirmDisableBody : pending?.kind === 'delete' ? t.confirmDeleteBody : t.confirmResetBody}
        confirmLabel={pending?.kind === 'disable' ? t.disable : pending?.kind === 'delete' ? t.delete : t.resetPassword}
        confirmVariant={pending?.kind === 'reset' ? 'primary' : 'danger'}
        busy={!!pending && acting === pending.user.id}
        onCancel={() => setPending(undefined)}
        onConfirm={() => { if (pending) void run(pending.kind, pending.user); }}
      />
    </div>
  );
}

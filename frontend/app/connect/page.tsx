'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/Button';
import { Callout } from '@/components/Callout';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Field } from '@/components/Field';
import { GroupPicker } from '@/components/GroupPicker';
import { PlatformCard } from '@/components/PlatformCard';
import { QrPanel } from '@/components/QrPanel';
import { StepIndicator } from '@/components/StepIndicator';
import { api, apiDownload, ApiError, disconnectOnLeave } from '@/lib/api';
import { sentence, strings } from '@/lib/strings';
import type { ConnectionView, ExportFiles, Group, PlatformName } from '@/lib/types';

export default function ConnectPage() {
  return <AppShell>{() => <ConnectFlow />}</AppShell>;
}

type Step = 'choose' | 'scan' | 'failed' | 'groups';
interface Notice { tone: 'error' | 'info' | 'success'; text: string; retryGroups?: boolean }
const c = strings.connect;
const POLL_MS = 2_000;
const messageOf = (caught: unknown) => sentence(caught instanceof ApiError ? caught.message : strings.errors.unexpected);

/** docs/specs/07-frontend.md 4.2: choose a platform → scan (→ Telegram password) → pick groups → download (repeatable) → Disconnect. */
function ConnectFlow() {
  const [step, setStep] = useState<Step>('choose');
  const [connection, setConnection] = useState<ConnectionView>();
  /** The live connection's id, for the leave-the-page DELETE (state isn't readable from a pagehide handler). */
  const liveId = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice>();
  const [starting, setStarting] = useState<PlatformName>();
  const [cancelling, setCancelling] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [groups, setGroups] = useState<Group[]>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [files, setFiles] = useState<ExportFiles>('merged');
  const [confirmContacts, setConfirmContacts] = useState(false);
  const [exportingContacts, setExportingContacts] = useState(false);
  const busy = exporting || exportingContacts;
  /** At least one file downloaded on this connection: the step indicator then shows every step done. */
  const [downloaded, setDownloaded] = useState(false);

  function track(view: ConnectionView | undefined) {
    liveId.current = view?.id;
    setConnection(view);
  }

  function reset(next?: Notice) {
    track(undefined);
    setStep('choose');
    setGroups(undefined);
    setSelected(new Set());
    setHidden(new Set());
    setFiles('merged');
    setConfirmContacts(false);
    setDownloaded(false);
    setPassword('');
    setPasswordError(undefined);
    setNotice(next);
  }

  // Leaving the page (tab closed, reload, navigation) ends the platform session; the 10-minute reaper is the fallback.
  useEffect(() => {
    const leave = () => { if (liveId.current) { disconnectOnLeave(liveId.current); liveId.current = undefined; } };
    const back = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', back);
    return () => {
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', back);
      leave();
    };
  }, []);

  async function loadGroups(id: string) {
    setGroups(undefined);
    setNotice(undefined);
    try {
      const result = await api<{ groups: Group[] }>(`/connections/${id}/groups`);
      setGroups(result.groups);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) reset({ tone: 'error', text: c.connectionEnded });
      else setNotice({ tone: 'error', text: messageOf(caught), retryGroups: true });
    }
  }

  function apply(view: ConnectionView) {
    track(view);
    if (view.status === 'connected') {
      setStep('groups');
      void loadGroups(view.id);
    } else if (view.status === 'disconnected') {
      // The login failed in the background; remove the dead connection and offer a fresh start.
      void api(`/connections/${view.id}`, { method: 'DELETE' }).catch(() => {});
      track(undefined);
      setStep('failed');
    } else {
      setStep('scan');
    }
  }

  // Poll every 2 s while waiting for the scan (not during the password form: only our submit changes it).
  useEffect(() => {
    if (step !== 'scan' || !connection || connection.status !== 'waiting-for-scan') return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const view = await api<ConnectionView>(`/connections/${connection.id}`);
        if (!stopped) apply(view);
      } catch (caught) {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 404) reset({ tone: 'error', text: c.connectionEnded });
        else setConnection(current => (current ? { ...current } : current)); // transient: poll again
      }
    }, POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
    // Re-armed by each new connection object (every poll result is a new object).
  }, [step, connection]);

  async function start(platform: PlatformName) {
    if (starting) return;
    setStarting(platform);
    setNotice(undefined);
    try {
      apply(await api<ConnectionView>('/connections', { method: 'POST', body: { platform } }));
    } catch (caught) {
      setNotice({ tone: 'error', text: messageOf(caught) });
    } finally {
      setStarting(undefined);
    }
  }

  /** Cancel during the scan, or Disconnect on the groups page: either way back to the first page. */
  async function disconnect(next?: Notice) {
    const id = connection?.id;
    setCancelling(true);
    try { if (id) await api(`/connections/${id}`, { method: 'DELETE' }); } catch { /* already gone */ }
    setCancelling(false);
    reset(next);
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!connection || checking) return;
    setChecking(true);
    setPasswordError(undefined);
    setNotice(undefined);
    try {
      const view = await api<ConnectionView>(`/connections/${connection.id}/password`, { method: 'POST', body: { password } });
      setPassword('');
      apply(view);
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : undefined;
      if (error?.status === 404) reset({ tone: 'error', text: c.connectionEnded });
      else if (error?.message.startsWith('too many wrong passwords')) reset({ tone: 'error', text: sentence(error.message) }); // the server ended it
      else if (error?.status === 400) setPasswordError(sentence(error.message));
      else setNotice({ tone: 'error', text: messageOf(caught) });
    } finally {
      setChecking(false);
    }
  }

  /** Spec 09: its own file; the server keeps the connection, so groups can still be exported afterwards. */
  async function exportContacts() {
    setConfirmContacts(false);
    if (!connection || busy) return;
    setExportingContacts(true);
    setNotice(undefined);
    try {
      await apiDownload(`/connections/${connection.id}/export-contacts`, {}, `phone-contacts-${connection.platform}.xlsx`);
      setDownloaded(true);
      setNotice({ tone: 'success', text: c.contactsDone });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : undefined;
      if (error?.status === 404) reset({ tone: 'error', text: c.connectionEnded });
      else if (error?.status === 0 && error.message === c.downloadFailed) reset({ tone: 'error', text: c.downloadFailed });
      else setNotice({ tone: 'error', text: messageOf(caught) }); // 502 etc.: the connection is kept, try again
    } finally {
      setExportingContacts(false);
    }
  }

  async function exportFile() {
    if (!connection || busy || selected.size === 0) return;
    setExporting(true);
    setNotice(undefined);
    // Spec 05, 4.6: the server names the file; "separate" only matters for two or more groups.
    const zip = files === 'separate' && selected.size > 1;
    try {
      await apiDownload(`/connections/${connection.id}/export`, { groupIds: [...selected], files },
        `contacts-${connection.platform}.${zip ? 'zip' : 'xlsx'}`);
      // The server keeps the connection (spec 05, 4.4): stay here for more exports until Disconnect.
      setSelected(new Set());
      setDownloaded(true);
      setNotice({ tone: 'success', text: c.exported });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : undefined;
      if (error?.status === 400 && error.groupIds?.length) {
        const hiddenIds = error.groupIds;
        setHidden(current => new Set([...current, ...hiddenIds]));
        setSelected(current => new Set([...current].filter(id => !hiddenIds.includes(id))));
        setNotice({ tone: 'error', text: sentence(error.message) });
      } else if (error?.status === 404) {
        reset({ tone: 'error', text: c.connectionEnded });
      } else if (error?.status === 0 && error.message === c.downloadFailed) {
        reset({ tone: 'error', text: c.downloadFailed }); // the stream broke off; the server ended the connection
      } else {
        setNotice({ tone: 'error', text: messageOf(caught) }); // 502 etc.: the connection is kept, try again
      }
    } finally {
      setExporting(false);
    }
  }

  // 5 = all four steps done: after a download the user stays on the groups page (T53), but "Download" is ticked.
  const current = step === 'choose' ? 1 : step === 'scan' || step === 'failed' ? 2 : busy ? 4 : downloaded ? 5 : 3;
  const noticeBox = notice && (
    <Callout tone={notice.tone} action={notice.retryGroups && connection
      ? <Button size="sm" onClick={() => void loadGroups(connection.id)}>{c.retry}</Button> : undefined}>
      <span dir="auto">{notice.text}</span>
    </Callout>
  );

  return (
    <div className="flex flex-col gap-8">
      <StepIndicator current={current} />

      {step === 'choose' && (
        <section className="flex flex-col gap-6">
          <Heading title={c.chooseTitle} intro={c.chooseIntro} />
          {noticeBox}
          <div className="grid gap-6 sm:grid-cols-2">
            {(['telegram', 'whatsapp'] as const).map(platform => (
              <div key={platform} className="flex flex-col gap-3">
                <PlatformCard platform={platform} busy={starting === platform} disabled={!!starting} onChoose={() => void start(platform)} />
                {platform === 'whatsapp' && <Callout tone="warning" size="sm">{c.whatsappNote}</Callout>}
              </div>
            ))}
          </div>
        </section>
      )}

      {step === 'scan' && connection && (
        <section className="flex flex-col gap-6">
          {connection.status === 'password-required' ? (
            <>
              <Heading title={c.passwordTitle} intro={c.passwordIntro} />
              {noticeBox}
              <form onSubmit={submitPassword} className="flex max-w-sm flex-col gap-4" noValidate>
                <Field id="two-step" label={c.passwordLabel} type="password" autoComplete="off" required autoFocus
                  hint={connection.passwordHint ? c.passwordHint(connection.passwordHint) : undefined}
                  error={passwordError} value={password} onChange={event => setPassword(event.target.value)} disabled={checking} />
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" busy={checking} busyLabel={c.passwordBusy} disabled={!password}>{c.passwordSubmit}</Button>
                  <Button onClick={() => void disconnect()} busy={cancelling} disabled={checking}>{c.cancel}</Button>
                </div>
              </form>
            </>
          ) : (
            <>
              <Heading title={c.scanTitle} />
              {noticeBox}
              <QrPanel platform={connection.platform} qr={connection.qr} cancelling={cancelling} onCancel={() => void disconnect()} />
            </>
          )}
        </section>
      )}

      {step === 'failed' && (
        <Callout tone="error" action={<Button size="sm" onClick={() => reset()}>{c.startAgain}</Button>}>{c.loginFailed}</Callout>
      )}

      {step === 'groups' && connection && (
        <section className="flex flex-col gap-6">
          <Heading title={c.groupsTitle} intro={c.groupsIntro} />
          {noticeBox}
          {groups ? (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-stone-200 px-4 py-3">
                <div className="flex min-w-60 flex-1 flex-col gap-0.5">
                  <span className="font-medium">{c.contactsTitle}</span>
                  <span className="text-xs text-stone-600">{c.contactsIntro}</span>
                </div>
                <Button busy={exportingContacts} busyLabel={c.contactsExporting} disabled={exporting}
                  onClick={() => setConfirmContacts(true)}>{c.contactsExport}</Button>
              </div>
              <GroupPicker groups={groups} selected={selected} hidden={hidden} disabled={busy} onChange={setSelected} />
              {/* Measured 2026-11-26: a 481-subscriber channel gave 201 rows (spec 06b, 3). */}
              {groups.some(group => group.kind === 'channel') && <Callout tone="warning" size="sm">{c.channelLimit}</Callout>}
              {selected.size > 1 && <FilesChoice value={files} count={selected.size} disabled={busy} onChange={setFiles} />}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" busy={exporting} busyLabel={c.exporting} disabled={selected.size === 0 || exportingContacts} onClick={() => void exportFile()}>{c.export}</Button>
                <Button onClick={() => void disconnect({ tone: 'info', text: c.disconnected })} busy={cancelling} disabled={busy}>{c.disconnect}</Button>
              </div>
              <ConfirmDialog open={confirmContacts} title={c.contactsConfirmTitle} body={c.contactsConfirmBody}
                confirmLabel={c.contactsExport} confirmVariant="primary"
                onConfirm={() => void exportContacts()} onCancel={() => setConfirmContacts(false)} />
            </>
          ) : (
            !notice && <p role="status" className="text-stone-600">{c.groupsLoading}</p>
          )}
        </section>
      )}

    </div>
  );
}

/** Shown only when two or more groups are ticked: one merged workbook, or a zip of one workbook per group. */
function FilesChoice({ value, count, disabled, onChange }: {
  value: ExportFiles; count: number; disabled: boolean; onChange(next: ExportFiles): void;
}) {
  const options: Array<{ value: ExportFiles; label: string; hint: string }> = [
    { value: 'merged', label: c.filesMerged, hint: c.filesMergedHint(count) },
    { value: 'separate', label: c.filesSeparate, hint: c.filesSeparateHint },
  ];
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{c.filesLegend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map(option => (
          <label key={option.value} className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 ${value === option.value
            ? 'border-stone-900 bg-stone-50' : 'border-stone-200 hover:bg-stone-50'} ${disabled ? 'cursor-not-allowed' : ''}`}>
            <input type="radio" name="export-files" className="focus-ring mt-0.5 size-4 shrink-0 accent-stone-900"
              checked={value === option.value} onChange={() => onChange(option.value)} />
            <span className="flex flex-col gap-0.5 text-start">
              <span className="font-medium">{option.label}</span>
              <span className="text-xs text-stone-600">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Heading({ title, intro }: { title: string; intro?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-bold">{title}</h1>
      {intro && <p className="text-stone-600">{intro}</p>}
    </div>
  );
}

'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { strings } from '@/lib/strings';
import { Button, type ButtonVariant } from './Button';

// Design system "ConfirmDialog": the native <dialog> gives the focus trap, Esc to cancel, and focus return.
export function ConfirmDialog({ open, title, body, confirmLabel, confirmVariant, busy, onConfirm, onCancel }: {
  open: boolean; title: ReactNode; body: string; confirmLabel: string; confirmVariant: Extract<ButtonVariant, 'primary' | 'danger'>;
  busy?: boolean; onConfirm(): void; onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
      onClick={(event) => { if (event.target === dialog.current && !busy) onCancel(); }}
      className="m-auto w-[min(400px,calc(100vw-2rem))] rounded-xl border border-stone-200 bg-white p-0 text-stone-900 shadow-lg"
    >
      {open && (
        <div className="flex flex-col gap-4 p-6">
          <h2 id="confirm-title" dir="auto" className="text-start text-base font-semibold">{title}</h2>
          <p className="text-stone-600">{body}</p>
          <div className="flex justify-end gap-2">
            {/* Cancel is focused first. */}
            <Button autoFocus onClick={onCancel} disabled={busy}>{strings.admin.cancel}</Button>
            <Button variant={confirmVariant} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

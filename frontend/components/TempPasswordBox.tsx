'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { strings } from '@/lib/strings';
import { Button } from './Button';

// Design system "TempPasswordBox": the only amber thing in the app. Shown once; never stored in the browser.
export function TempPasswordBox({ email, password, onDismiss }: { email: string; password: string; onDismiss(): void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try { await navigator.clipboard.writeText(password); setCopied(true); } catch { /* the field is selectable as a fallback */ }
  }

  return (
    <div role="status" className="flex max-w-[520px] flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm">
        {strings.admin.tempPasswordFor} <bdi className="font-medium">{email}</bdi>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code dir="ltr" className="flex-1 select-all rounded-md border border-stone-300 bg-white px-3 py-1.5 font-mono text-base font-medium">{password}</code>
        <Button onClick={copy} icon={copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}>
          {copied ? strings.admin.copied : strings.admin.copy}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-amber-800">{strings.admin.tempPasswordNote}</p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>{strings.admin.dismiss}</Button>
      </div>
    </div>
  );
}

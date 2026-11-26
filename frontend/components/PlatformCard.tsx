'use client';

import { ArrowRight, LoaderCircle } from 'lucide-react';
import { strings } from '@/lib/strings';
import type { PlatformName } from '@/lib/types';
import { PlatformMark } from './Logos';

// Design system "PlatformCard": the whole card is a button. The arrow flips in right-to-left; the logo never does.
export function PlatformCard({ platform, busy, disabled, onChoose }: { platform: PlatformName; busy: boolean; disabled: boolean; onChoose(): void }) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      aria-busy={busy || undefined}
      className="focus-ring flex w-full flex-col items-start gap-3 rounded-xl border border-stone-200 bg-white p-6 text-start hover:border-stone-300 hover:bg-stone-50 disabled:cursor-not-allowed disabled:hover:border-stone-200 disabled:hover:bg-white"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-stone-100">
        <PlatformMark platform={platform} />
      </span>
      <span className="text-base font-semibold">{strings.platformNames[platform]}</span>
      <span className="text-stone-600">{strings.connect.cardDescription[platform]}</span>
      <span className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium">
        {busy ? (
          <><LoaderCircle aria-hidden className="size-3.5 animate-spin" />{strings.connect.cardStarting}</>
        ) : (
          <>{strings.connect.cardContinue}<ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" /></>
        )}
      </span>
    </button>
  );
}

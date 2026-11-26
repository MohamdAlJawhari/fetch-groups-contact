'use client';

import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ReactNode } from 'react';

// Design system "Callout": always an icon and words, so colour is never the only signal.
export type CalloutTone = 'info' | 'error' | 'success';

const tones: Record<CalloutTone, { box: string; icon: ReactNode; role?: 'alert' | 'status' }> = {
  info: { box: 'bg-stone-100 text-stone-900', icon: <Info aria-hidden className="size-5 shrink-0 text-stone-600" /> },
  error: { box: 'border border-red-200 bg-red-50 text-red-700', icon: <CircleAlert aria-hidden className="size-5 shrink-0" />, role: 'alert' },
  success: { box: 'border border-green-200 bg-green-50 text-green-700', icon: <CircleCheck aria-hidden className="size-5 shrink-0" />, role: 'status' },
};

export function Callout({ tone, children, action, className = '' }: { tone: CalloutTone; children: ReactNode; action?: ReactNode; className?: string }) {
  const style = tones[tone];
  return (
    <div role={style.role} className={`flex gap-2.5 rounded-lg px-3.5 py-3 text-sm ${style.box} ${className}`}>
      {style.icon}
      <div className="flex flex-1 flex-col items-start gap-3">
        <div className="text-start">{children}</div>
        {action}
      </div>
    </div>
  );
}

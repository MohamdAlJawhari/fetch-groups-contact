'use client';

import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

// Design system "Callout": always an icon and words, so colour is never the only signal.
export type CalloutTone = 'info' | 'error' | 'success' | 'warning';

const tones: Record<CalloutTone, { box: string; Icon: LucideIcon; iconColor?: string; role?: 'alert' | 'status' }> = {
  info: { box: 'bg-stone-100 text-stone-900', Icon: Info, iconColor: 'text-stone-600' },
  error: { box: 'border border-red-200 bg-red-50 text-red-700', Icon: CircleAlert, role: 'alert' },
  success: { box: 'border border-green-200 bg-green-50 text-green-700', Icon: CircleCheck, role: 'status' },
  warning: { box: 'border border-amber-200 bg-amber-50 text-amber-800', Icon: TriangleAlert, iconColor: 'text-amber-600' },
};

/** `size="sm"`: a smaller box and text, for a short side note such as a warning under a card. */
export function Callout({ tone, children, action, size = 'md', className = '' }: {
  tone: CalloutTone; children: ReactNode; action?: ReactNode; size?: 'md' | 'sm'; className?: string;
}) {
  const { box, Icon, iconColor = '', role } = tones[tone];
  const small = size === 'sm';
  return (
    <div role={role} className={`flex rounded-lg ${small ? 'gap-2 px-2.5 py-2 text-xs' : 'gap-2.5 px-3.5 py-3 text-sm'} ${box} ${className}`}>
      <Icon aria-hidden className={`${small ? 'size-4' : 'size-5'} shrink-0 ${iconColor}`} />
      <div className="flex flex-1 flex-col items-start gap-3">
        <div className="text-start">{children}</div>
        {action}
      </div>
    </div>
  );
}

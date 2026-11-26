'use client';

import { Check } from 'lucide-react';
import { Fragment } from 'react';
import { strings } from '@/lib/strings';

// Design system "StepIndicator": Platform · Scan · Groups · Download. Flex gaps, so it mirrors in right-to-left.
export function StepIndicator({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Progress">
      {strings.steps.map((label, index) => {
        const step = index + 1;
        const state = step < current ? 'done' : step === current ? 'current' : 'upcoming';
        return (
          <Fragment key={label}>
            {index > 0 && <li aria-hidden className="h-px w-6 bg-stone-300" />}
            <li className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
              <span
                className={[
                  'flex size-6 items-center justify-center rounded-full text-xs font-medium',
                  state === 'current' ? 'bg-stone-900 text-white' : '',
                  state === 'done' ? 'bg-stone-100 text-stone-600' : '',
                  state === 'upcoming' ? 'border border-stone-500 text-stone-500' : '',
                ].join(' ')}
              >
                {state === 'done' ? <Check aria-hidden className="size-3.5" /> : step}
              </span>
              <span className={state === 'current' ? 'font-medium text-stone-900' : state === 'done' ? 'text-stone-600' : 'text-stone-500'}>
                {label}
                {state === 'done' && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

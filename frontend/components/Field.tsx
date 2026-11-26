'use client';

import { CircleAlert } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';

// Design system "Input": visible label above, hint or error under it, linked with aria-describedby.
interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}

export const inputClass =
  'focus-ring h-9 w-full rounded-md border border-stone-500 bg-white px-2.5 text-start text-sm text-stone-900 placeholder:text-stone-500 focus-visible:border-blue-600 aria-[invalid=true]:border-red-600 disabled:bg-stone-100 disabled:text-stone-400';

export function Field({ id, label, hint, error, className = '', ...input }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-stone-900">{label}</label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={inputClass} {...input} />
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1 text-xs text-red-700">
          <CircleAlert aria-hidden className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-stone-600">{hint}</p>
      ) : null}
    </div>
  );
}

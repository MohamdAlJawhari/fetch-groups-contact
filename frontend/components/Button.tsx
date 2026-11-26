'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

// Design system "Button": one primary per screen; danger only inside the confirm dialog; danger-quiet for row actions.
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-quiet' | 'ghost';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-stone-900 text-white hover:bg-stone-800',
  secondary: 'border border-stone-300 bg-white text-stone-900 hover:bg-stone-100',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  'danger-quiet': 'border border-stone-300 bg-white text-red-700 hover:bg-stone-100',
  ghost: 'text-stone-600 hover:bg-stone-100 hover:text-stone-900',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Busy: spinner + busy label + aria-busy. The button keeps its look; clicks are ignored. */
  busy?: boolean;
  busyLabel?: ReactNode;
  icon?: ReactNode;
  fullWidth?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', busy = false, busyLabel, icon, fullWidth, className = '', children, disabled, onClick, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={busy ? (event) => event.preventDefault() : onClick}
      className={[
        'focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
        size === 'md' ? 'h-9 px-3.5 text-sm' : 'h-7 px-2.5 text-sm',
        disabled ? 'cursor-not-allowed border-transparent bg-stone-100 text-stone-400' : variants[variant],
        busy ? 'cursor-progress' : '',
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {busy ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : icon}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

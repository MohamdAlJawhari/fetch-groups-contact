import type { ReactNode } from 'react';
import { strings } from '@/lib/strings';
import { AppMark } from './Logos';

/** Login and change password: the mark, the app name, and a centred card of auth-width (384px). */
export function AuthCard({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-8 px-6 pt-16 pb-16">
      <div className="flex flex-col items-start gap-3">
        <AppMark size={40} />
        <p className="text-4xl font-bold tracking-tight">{strings.appName}</p>
        <p className="text-stone-600">{strings.tagline}</p>
      </div>
      <section className="flex flex-col gap-6 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">{title}</h1>
          {intro && <p className="text-stone-600">{intro}</p>}
        </div>
        {children}
      </section>
    </main>
  );
}

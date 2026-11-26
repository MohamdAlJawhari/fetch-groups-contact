import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { strings } from '@/lib/strings';

export const metadata: Metadata = {
  title: strings.appName,
  description: strings.tagline,
  icons: { icon: '/contact-export-mark.svg' },
  robots: { index: false, follow: false },
};

// English interface, left-to-right (spec 07, 4.4). User text inside sets its own direction with dir="auto".
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      {/* Browser extensions (e.g. Grammarly) add attributes to <body> before React loads; ignore those (this element only). */}
      <body suppressHydrationWarning className="min-h-screen bg-white font-sans text-sm text-stone-900 antialiased">{children}</body>
    </html>
  );
}

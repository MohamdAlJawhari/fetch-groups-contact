'use client';

import { LoaderCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { strings } from '@/lib/strings';
import type { PlatformName } from '@/lib/types';
import { Button } from './Button';

// Design system "QRPanel": the code on pure white in a bordered frame, instructions beside it, a live status line.
export function QrPanel({ platform, qr, onCancel, cancelling }: { platform: PlatformName; qr?: string; onCancel(): void; cancelling: boolean }) {
  const [first, second, third] = strings.connect.scanSteps[platform];
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
      <div className="flex size-[290px] shrink-0 items-center justify-center rounded-lg border border-stone-200 bg-white p-4">
        {qr ? (
          // Never tinted, rounded, or flipped (it stays the same in right-to-left).
          <QRCodeSVG value={qr} size={256} marginSize={0} level="L" bgColor="#ffffff" fgColor="#000000" title={strings.connect.qrLabel} />
        ) : (
          <LoaderCircle aria-hidden className="size-6 animate-spin text-stone-500" />
        )}
      </div>
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">{strings.connect.scanWith[platform]}</h2>
        <ol className="flex list-decimal flex-col gap-1.5 ps-5">
          <li>{first}</li>
          <li><strong className="font-semibold">{second}</strong></li>
          <li>{third}</li>
        </ol>
        <p role="status" className="flex items-center gap-2 text-stone-600">
          {qr ? (
            <><span aria-hidden className="size-2 rounded-full bg-stone-500" />{strings.connect.waiting}</>
          ) : (
            <><LoaderCircle aria-hidden className="size-3.5 animate-spin" />{strings.connect.linking}</>
          )}
        </p>
        <div>
          <Button onClick={onCancel} busy={cancelling}>{strings.connect.cancel}</Button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { strings } from '@/lib/strings';
import { MAX_GROUPS, type Group } from '@/lib/types';
import { inputClass } from './Field';

// Design system "CheckboxRow" inside a bordered list box with a counter bar on top.
export function GroupPicker({ groups, selected, hidden, disabled, onChange }: {
  groups: readonly Group[]; selected: ReadonlySet<string>; hidden: ReadonlySet<string>; disabled: boolean;
  onChange(next: Set<string>): void;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? groups.filter(group => group.title.toLocaleLowerCase().includes(needle)) : groups;
  }, [groups, query]);
  const full = selected.size >= MAX_GROUPS;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (!full) next.add(id);
    onChange(next);
  }
  function selectAllShown() {
    const next = new Set(selected);
    for (const group of shown) {
      if (next.size >= MAX_GROUPS) break;
      if (!hidden.has(group.id)) next.add(group.id);
    }
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">{strings.connect.search}</label>
        <Search aria-hidden className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-500" />
        <input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder={strings.connect.searchPlaceholder} className={`${inputClass} ps-8`} dir="auto" />
      </div>
      <div className="overflow-hidden rounded-lg border border-stone-200">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-stone-200 bg-stone-50 px-3 py-2 text-xs">
          <span aria-live="polite" className="flex-1 text-stone-600">{strings.connect.selected(selected.size, MAX_GROUPS)}</span>
          <button type="button" className="focus-ring rounded underline underline-offset-2 disabled:text-stone-400" disabled={disabled || full} onClick={selectAllShown}>
            {strings.connect.selectAllShown}
          </button>
          <button type="button" className="focus-ring rounded underline underline-offset-2 disabled:text-stone-400" disabled={disabled || selected.size === 0} onClick={() => onChange(new Set())}>
            {strings.connect.clear}
          </button>
        </div>
        {shown.length === 0 ? (
          <p className="px-3 py-8 text-center text-stone-600">{groups.length ? strings.connect.noMatch : strings.connect.noGroups}</p>
        ) : (
          <ul className="max-h-[28rem] overflow-y-auto">
            {shown.map(group => {
              const isHidden = hidden.has(group.id);
              const checked = selected.has(group.id);
              const tagId = `${searchId}-hidden-${group.id}`;
              return (
                <li key={group.id} className="border-b border-stone-200 last:border-b-0">
                  <label className={`flex min-h-11 items-center gap-3 px-3 py-2 ${isHidden || disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-stone-100'}`}>
                    <input type="checkbox" className="focus-ring size-4 shrink-0 accent-stone-900" checked={checked}
                      disabled={disabled || isHidden || (!checked && full)} onChange={() => toggle(group.id)}
                      aria-describedby={isHidden ? tagId : undefined} />
                    {/* dir="auto" + plaintext bidi: Arabic titles read right-to-left, English left-to-right, in one list. */}
                    <span dir="auto" className={`flex-1 text-start text-base break-words [unicode-bidi:plaintext] ${isHidden ? 'text-stone-500' : ''}`}>{group.title}</span>
                    {group.memberCount !== undefined && (
                      <span className="shrink-0 text-xs text-stone-500 tabular-nums">{strings.connect.memberCount(group.memberCount)}</span>
                    )}
                    {isHidden && <span id={tagId} className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">{strings.connect.hiddenTag}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

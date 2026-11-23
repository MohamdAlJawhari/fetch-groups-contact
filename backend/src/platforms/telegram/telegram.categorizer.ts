import type { CategorizedContacts, Contact } from '../platform.types.js';

/**
 * A group member copied out of a GramJS `User` (no GramJS import here). Absent Telegram fields may be `null`.
 * docs/specs/06-telegram.md 4.7.
 */
export interface TelegramMember {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Digits without `+`, present only when the member's privacy settings let this account see it. */
  phone?: string | null;
  username?: string | null;
  usernames?: ReadonlyArray<{ username: string; active?: boolean | null }> | null;
  /** In the scanned account's Telegram contacts. */
  contact?: boolean | null;
  self?: boolean | null;
  deleted?: boolean | null;
  bot?: boolean | null;
}

const text = (value: string | null | undefined) => (typeof value === 'string' ? value.trim() : '');

/** Pure: always returns the three Telegram categories, in order, even when empty. */
export function categorizeTelegramMembers(members: readonly TelegramMember[]): CategorizedContacts {
  const saved: Contact[] = [];
  const reachable: Contact[] = [];
  const unreachable: Contact[] = [];
  for (const member of members) {
    if (member.self || member.deleted || member.bot) continue;
    const name = [text(member.firstName), text(member.lastName)].filter(Boolean).join(' ');
    const digits = text(member.phone).replace(/^\+/, '');
    const username = text(member.username) || text(member.usernames?.find(entry => entry.active)?.username);
    const contact: Contact = { id: member.id, name };
    if (digits) contact.phoneNumber = `+${digits}`;
    if (username) contact.username = username;
    if (member.contact) saved.push(contact);
    else if (digits || username) reachable.push(contact);
    else unreachable.push(contact);
  }
  return [
    { category: 'saved', contacts: saved },
    { category: 'unsaved_reachable', contacts: reachable },
    { category: 'unsaved_unreachable', contacts: unreachable },
  ];
}

import type { CategorizedContacts, Contact } from '../platform.types.js';

/**
 * A group member as WhatsAppPlatform resolved it (docs/specs/08-whatsapp.md 4.5). No Baileys import here.
 * The linked account itself is already excluded.
 */
export interface WhatsAppMember {
  /** `pn:<digits>` when the phone is known, otherwise `lid:<lid>`; used only for deduplication. */
  id: string;
  /** Digits, without `+`; absent when WhatsApp hides the number. */
  phone?: string;
  /** Name from the phone's address book (synced contacts); present only for saved contacts. */
  savedName?: string;
  /** The name the person chose for themselves, if WhatsApp sent it. */
  pushName?: string;
  username?: string;
}

const text = (value: string | null | undefined) => (typeof value === 'string' ? value.trim() : '');

/** Pure: always returns the three categories, in order, even when empty (spec 08, 4.6). */
export function categorizeWhatsAppMembers(members: readonly WhatsAppMember[]): CategorizedContacts {
  const saved: Contact[] = [];
  const reachable: Contact[] = [];
  const unreachable: Contact[] = [];
  for (const member of members) {
    const savedName = text(member.savedName);
    const digits = text(member.phone).replace(/^\+/, '');
    const username = text(member.username).replace(/^@/, '');
    const contact: Contact = { id: member.id, name: savedName || text(member.pushName) };
    if (digits) contact.phoneNumber = `+${digits}`;
    if (username) contact.username = username;
    if (savedName) saved.push(contact);
    else if (digits || username) reachable.push(contact);
    else unreachable.push(contact);
  }
  return [
    { category: 'saved', contacts: saved },
    { category: 'unsaved_reachable', contacts: reachable },
    { category: 'unsaved_unreachable', contacts: unreachable },
  ];
}

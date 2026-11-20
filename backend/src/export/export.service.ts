import type { Writable } from 'node:stream';
import type { CategorizedContacts, Contact, Platform } from '../platforms/platform.types.js';
import { ExcelWriter } from './excel.writer.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

function compareText(a: string | undefined, b: string | undefined) {
  const left = a?.trim() ?? '';
  const right = b?.trim() ?? '';
  if (!left || !right) return left ? -1 : right ? 1 : 0; // empty values sort last
  return collator.compare(left, right);
}

function compareContacts(a: Contact, b: Contact) {
  return compareText(a.name, b.name) || compareText(a.phoneNumber, b.phoneNumber) || compareText(a.username, b.username);
}

/**
 * Builds an export from any platform (docs/specs/05-export.md section 4.2). Knows no platform names.
 * `prepare` and `write` are separate so the caller can still answer with an error before streaming starts.
 */
export class ExportService {
  constructor(private readonly writer: ExcelWriter = new ExcelWriter()) {}

  /** Fetches the selected groups' members, deduplicated by contact id across categories and sorted by name. */
  async prepare(platform: Platform, groupIds: readonly string[]): Promise<CategorizedContacts> {
    const categorized = await platform.listContacts(groupIds);
    const seen = new Set<string>();
    return categorized.map(({ category, contacts }) => ({
      category,
      contacts: contacts
        .filter(contact => !seen.has(contact.id) && Boolean(seen.add(contact.id)))
        .sort(compareContacts),
    }));
  }

  write(contacts: CategorizedContacts, stream: Writable): Promise<void> {
    return this.writer.write(contacts, stream);
  }
}

import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { CategorizedContacts, Contact, ContactCategory } from '../platforms/platform.types.js';

/** Sheet names from docs/specs/05-export.md section 4.1. */
const sheetNames: Record<ContactCategory, string> = {
  saved: 'Saved',
  unsaved_reachable: 'Unsaved reachable',
  unsaved_unreachable: 'Unsaved unreachable',
  unsaved: 'Unsaved',
};
const usernameCategories: readonly ContactCategory[] = ['unsaved_reachable', 'unsaved_unreachable'];

// Characters that are not allowed in XML 1.0 and would corrupt the .xlsx.
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function text(value: string | undefined, prefix = ''): string | null {
  const clean = value?.replace(invalidXml, '').trim();
  return clean ? prefix + clean : null;
}

/**
 * Streams one sheet per category (in the given order, empty ones included) into `stream`.
 * Knows no platform names and never touches the disk. Sorting and deduplication are the caller's job.
 */
export class ExcelWriter {
  async write(contacts: CategorizedContacts, stream: Writable): Promise<void> {
    const withUsername = contacts.some(group => usernameCategories.includes(group.category));
    const columns = [
      { header: 'Name', key: 'name', width: 32 },
      { header: 'Phone', key: 'phone', width: 18 },
      ...(withUsername ? [{ header: 'Username', key: 'username', width: 24 }] : []),
    ];
    const row = (contact: Contact) => {
      const values = [text(contact.name), text(contact.phoneNumber)];
      if (withUsername) values.push(text(contact.username?.replace(/^@+/, ''), '@'));
      return values;
    };

    let detach = () => {};
    const streamFailed = new Promise<never>((_resolve, reject) => {
      let finished = false;
      const onFinish = () => { finished = true; };
      const onError = (error: Error) => reject(error);
      const onClose = () => { if (!finished) reject(new Error('Output stream closed before the workbook was written')); };
      stream.on('finish', onFinish).on('error', onError).on('close', onClose);
      detach = () => { stream.off('finish', onFinish).off('error', onError).off('close', onClose); };
    });
    streamFailed.catch(() => {});

    const build = async () => {
      if (stream.destroyed || stream.writableEnded) throw new Error('Output stream is not writable');
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
      for (const group of contacts) {
        const sheet = workbook.addWorksheet(sheetNames[group.category], { views: [{ state: 'frozen', ySplit: 1 }] });
        sheet.columns = columns;
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).commit();
        for (const contact of group.contacts) sheet.addRow(row(contact)).commit();
        sheet.commit();
      }
      await workbook.commit();
    };

    try {
      await Promise.race([build(), streamFailed]);
    } finally {
      detach();
    }
  }
}

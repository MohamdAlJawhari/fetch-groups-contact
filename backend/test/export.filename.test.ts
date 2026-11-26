import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { contentDisposition, exportFilename, safeTitle, zipEntryNames } from '../src/export/export.filename.js';
import { ZipWriter } from '../src/export/zip.writer.js';
import type { CategorizedContacts } from '../src/platforms/platform.types.js';

test('safeTitle keeps Arabic and other scripts, and removes what Windows or a spoofed extension could misuse', () => {
  assert.equal(safeTitle('عائلة محمد'), 'عائلة محمد');
  assert.equal(safeTitle('Team: A/B <2026>?'), 'Team A B 2026');
  assert.equal(safeTitle('a‮xcod.exe'), 'a xcod.exe'); // right-to-left override removed
  assert.equal(safeTitle('  lots   of\tspace  '), 'lots of space');
  assert.equal(safeTitle('ends with dots...'), 'ends with dots');
  assert.equal(safeTitle('???'), 'Group');
  assert.equal(safeTitle(''), 'Group');
  assert.equal([...safeTitle('ع'.repeat(200))].length, 80);
  assert.equal(safeTitle('😀'.repeat(100)), '😀'.repeat(80)); // cut by characters, never inside an emoji
});

test('exportFilename: the group name for one group, a count for several', () => {
  assert.equal(exportFilename(['Family Group'], '2026-11-26', 'merged'), 'Family Group - 2026-11-26.xlsx');
  assert.equal(exportFilename(['Family Group'], '2026-11-26', 'separate'), 'Family Group - 2026-11-26.xlsx');
  assert.equal(exportFilename(['A', 'B', 'C'], '2026-11-26', 'merged'), '3 groups - 2026-11-26.xlsx');
  assert.equal(exportFilename(['A', 'B', 'C', 'D', 'E'], '2026-11-26', 'separate'), '5 groups - 2026-11-26.zip');
});

test('zipEntryNames numbers repeated titles, ignoring case', () => {
  assert.deepEqual(zipEntryNames(['Team', 'team', 'Other', 'TEAM'], '2026-11-26'), [
    'Team - 2026-11-26.xlsx', 'team - 2026-11-26 (2).xlsx', 'Other - 2026-11-26.xlsx', 'TEAM - 2026-11-26 (3).xlsx',
  ]);
});

test('contentDisposition sends an ASCII fallback and the UTF-8 name', () => {
  assert.equal(contentDisposition('عائلة - 2026-11-26.xlsx', 'contacts-telegram-2026-11-26.xlsx'),
    `attachment; filename="contacts-telegram-2026-11-26.xlsx"; filename*=UTF-8''${encodeURIComponent('عائلة')}%20-%202026-11-26.xlsx`);
  assert.match(contentDisposition("it's (1)*.xlsx", 'x.xlsx'), /filename\*=UTF-8''it%27s%20%281%29%2A\.xlsx$/);
});

const contacts = (name: string): CategorizedContacts => [
  { category: 'saved', contacts: [{ id: '1', name, phoneNumber: '+12025550101' }] },
  { category: 'unsaved_reachable', contacts: [] },
  { category: 'unsaved_unreachable', contacts: [] },
];

test('ZipWriter writes one readable workbook per entry, with UTF-8 names', async () => {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', chunk => chunks.push(chunk));
  await new ZipWriter().write([{ name: 'عائلة - 2026-11-26.xlsx', contacts: contacts('First') }, { name: 'B.xlsx', contacts: contacts('Second') }], out);
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(zip.files), ['عائلة - 2026-11-26.xlsx', 'B.xlsx']);
  const names: string[] = [];
  for (const entry of Object.values(zip.files)) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await entry.async('arraybuffer'));
    names.push(String(workbook.getWorksheet('Saved')!.getRow(2).getCell(1).value));
  }
  assert.deepEqual(names, ['First', 'Second']);
});

test('ZipWriter rejects when the output closes early', async () => {
  const out = new PassThrough();
  out.destroy();
  await assert.rejects(new ZipWriter().write([{ name: 'a.xlsx', contacts: contacts('x') }], out));
  const closing = new PassThrough();
  closing.on('data', () => closing.destroy());
  await assert.rejects(new ZipWriter().write([{ name: 'a.xlsx', contacts: contacts('x') }], closing));
});

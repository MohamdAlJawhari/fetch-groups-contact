import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { ExcelWriter } from '../src/export/excel.writer.js';
import type { CategorizedContacts } from '../src/platforms/platform.types.js';

async function writeToBuffer(contacts: CategorizedContacts) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new ExcelWriter().write(contacts, stream);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  return workbook;
}

function rows(sheet: ExcelJS.Worksheet) {
  const result: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    result.push(Array.from({ length: sheet.columnCount }, (_, index) => row.getCell(index + 1).value ?? null));
  });
  return result;
}

const telegram: CategorizedContacts = [
  { category: 'saved', contacts: [
    { id: 'tg-1', name: 'Alice Saved', phoneNumber: '+12025550101', username: 'alice' },
    { id: 'tg-2', name: 'Bob Saved', phoneNumber: '+0012025550102' },
  ] },
  { category: 'unsaved_reachable', contacts: [{ id: 'tg-3', name: 'Carol Reachable', username: '@carol' }] },
  { category: 'unsaved_unreachable', contacts: [{ id: 'tg-4', name: 'Dan Unreachable' }] },
];

const whatsapp: CategorizedContacts = [
  { category: 'saved', contacts: [{ id: 'wa-1', name: 'Eve Saved', phoneNumber: '+12025550103' }] },
  { category: 'unsaved', contacts: [{ id: 'wa-2', name: '', phoneNumber: '+12025550104' }] },
];

test('3-category input writes 3 named sheets with Name, Phone, Username and the rows', async () => {
  const workbook = await writeToBuffer(telegram);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Saved', 'Unsaved reachable', 'Unsaved unreachable']);
  const [saved, reachable, unreachable] = workbook.worksheets;
  assert.deepEqual(rows(saved!), [
    ['Name', 'Phone', 'Username'],
    ['Alice Saved', '+12025550101', '@alice'],
    ['Bob Saved', '+0012025550102', null],
  ]);
  assert.deepEqual(rows(reachable!), [['Name', 'Phone', 'Username'], ['Carol Reachable', null, '@carol']]);
  assert.deepEqual(rows(unreachable!), [['Name', 'Phone', 'Username'], ['Dan Unreachable', null, null]]);
});

test('2-category input writes 2 named sheets with Name and Phone only', async () => {
  const workbook = await writeToBuffer(whatsapp);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Saved', 'Unsaved']);
  assert.deepEqual(rows(workbook.worksheets[0]!), [['Name', 'Phone'], ['Eve Saved', '+12025550103']]);
  assert.deepEqual(rows(workbook.worksheets[1]!), [['Name', 'Phone'], [null, '+12025550104']]);
});

test('empty categories still get a sheet with the header row only', async () => {
  const workbook = await writeToBuffer([
    { category: 'saved', contacts: [] },
    { category: 'unsaved_reachable', contacts: [] },
    { category: 'unsaved_unreachable', contacts: [] },
  ]);
  assert.equal(workbook.worksheets.length, 3);
  for (const sheet of workbook.worksheets) assert.deepEqual(rows(sheet), [['Name', 'Phone', 'Username']]);
});

test('header row is bold and frozen, and column widths are fixed', async () => {
  const sheet = (await writeToBuffer(telegram)).worksheets[0]!;
  assert.equal(sheet.getRow(1).getCell(1).font?.bold, true);
  assert.equal(sheet.views[0]?.state, 'frozen');
  assert.equal(sheet.views[0]?.ySplit, 1);
  assert.deepEqual(sheet.columns.map(column => column.width), [32, 18, 24]);
});

test('phones and formula-looking names are read back as text, never numbers or formulas', async () => {
  const workbook = await writeToBuffer([
    { category: 'saved', contacts: [{ id: 'x-1', name: '=HYPERLINK("http://evil","x")', phoneNumber: '+0012025550199' }] },
    { category: 'unsaved', contacts: [{ id: 'x-2', name: '+1 is a name', phoneNumber: '0012025550100' }] },
  ]);
  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => row.eachCell(cell => assert.equal(cell.type, ExcelJS.ValueType.String)));
  }
  assert.deepEqual(rows(workbook.worksheets[0]!)[1], ['=HYPERLINK("http://evil","x")', '+0012025550199']);
  assert.deepEqual(rows(workbook.worksheets[1]!)[1], ['+1 is a name', '0012025550100']);
});

test('no contact id is written anywhere in the workbook', async () => {
  const workbook = await writeToBuffer(telegram);
  const ids = new Set(telegram.flatMap(group => group.contacts.map(contact => contact.id)));
  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => row.eachCell(cell => assert.ok(!ids.has(String(cell.value)), `id leaked: ${cell.value}`)));
  }
});

test('characters invalid in XML are stripped so the file still opens', async () => {
  const workbook = await writeToBuffer([{ category: 'saved', contacts: [{ id: 'c', name: 'Zoe\u0000\u0007 Ctrl\uD800', phoneNumber: '+1202555\u000B0105' }] }]);
  assert.deepEqual(rows(workbook.worksheets[0]!)[1], ['Zoe Ctrl', '+12025550105']);
});

test('rejects when the output stream fails mid-write', async () => {
  let written = 0;
  const failing = new Writable({
    write(_chunk, _encoding, callback) { written += 1; callback(written > 1 ? new Error('socket gone') : null); },
  });
  const many = [{ category: 'saved' as const, contacts: Array.from({ length: 5_000 }, (_, i) => ({ id: `${i}`, name: `Person ${i}`, phoneNumber: `+1202555${i}` })) }];
  await assert.rejects(new ExcelWriter().write(many, failing));
});

test('rejects when the output stream was already destroyed', async () => {
  const stream = new PassThrough();
  stream.destroy();
  await assert.rejects(new ExcelWriter().write(telegram, stream), /not writable/);
});

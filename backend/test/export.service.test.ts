import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ExcelWriter } from '../src/export/excel.writer.js';
import { ExportService } from '../src/export/export.service.js';
import { FakePlatform } from '../src/platforms/fake.platform.js';
import type { CategorizedContacts, Platform } from '../src/platforms/platform.types.js';

function stubPlatform(result: CategorizedContacts | Error, calls: string[][] = []): Platform {
  return {
    connect: async () => {},
    getStatus: async () => ({ status: 'connected' }),
    listGroups: async () => [],
    listContacts: async groupIds => {
      calls.push([...groupIds]);
      if (result instanceof Error) throw result;
      return result;
    },
    disconnect: async () => {},
  };
}

const names = (contacts: CategorizedContacts) => contacts.map(group => [group.category, group.contacts.map(contact => contact.id)]);

test('passes the selected group ids to listContacts in one call', async () => {
  const calls: string[][] = [];
  await new ExportService().prepare(stubPlatform([], calls), ['g1', 'g2']);
  assert.deepEqual(calls, [['g1', 'g2']]);
});

test('the same member in two groups appears once (first occurrence wins)', async () => {
  const result = await new ExportService().prepare(stubPlatform([
    { category: 'saved', contacts: [
      { id: 'a', name: 'Ann', phoneNumber: '+1' },
      { id: 'b', name: 'Ben' },
      { id: 'a', name: 'Ann (other group)', phoneNumber: '+2' },
    ] },
  ]), ['g1', 'g2']);
  assert.deepEqual(result, [{ category: 'saved', contacts: [{ id: 'a', name: 'Ann', phoneNumber: '+1' }, { id: 'b', name: 'Ben' }] }]);
});

test('deduplicates across categories in category order and keeps emptied categories', async () => {
  const result = await new ExportService().prepare(stubPlatform([
    { category: 'saved', contacts: [{ id: 'x', name: 'Xia' }] },
    { category: 'unsaved_reachable', contacts: [{ id: 'x', name: 'Xia' }, { id: 'y', name: 'Yan', username: 'yan' }] },
    { category: 'unsaved_unreachable', contacts: [{ id: 'y', name: 'Yan' }] },
  ]), ['g1']);
  assert.deepEqual(names(result), [['saved', ['x']], ['unsaved_reachable', ['y']], ['unsaved_unreachable', []]]);
});

test('sorts by name ignoring case and accents, empty names last, then phone, then username', async () => {
  const result = await new ExportService().prepare(stubPlatform([
    { category: 'unsaved', contacts: [
      { id: 'empty', name: '' },
      { id: 'blank', name: '   ', phoneNumber: '+1' },
      { id: 'zed', name: 'zed' },
      { id: 'emile', name: 'Émile' },
      { id: 'bob-2', name: 'bob', phoneNumber: '+2' },
      { id: 'bob-1', name: 'Bob', phoneNumber: '+1' },
      { id: 'bob-none', name: 'BOB' },
      { id: 'amy-u2', name: 'Amy', username: 'b_amy' },
      { id: 'amy-u1', name: 'Amy', username: 'a_amy' },
    ] },
  ]), ['g1']);
  assert.deepEqual(names(result), [['unsaved', ['amy-u1', 'amy-u2', 'bob-1', 'bob-2', 'bob-none', 'emile', 'zed', 'blank', 'empty']]]);
});

test('does not modify the platform result', async () => {
  const input: CategorizedContacts = [{ category: 'saved', contacts: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }];
  const before = structuredClone(input);
  await new ExportService().prepare(stubPlatform(input), ['g1']);
  assert.deepEqual(input, before);
});

test('both fakes give the 3 categories in order (WhatsApp too, since spec 08)', async () => {
  for (const [name, expected] of [
    ['telegram', ['saved', 'unsaved_reachable', 'unsaved_unreachable']],
    ['whatsapp', ['saved', 'unsaved_reachable', 'unsaved_unreachable']],
  ] as const) {
    const platform = new FakePlatform(name, { scanDelayMs: 0 });
    await platform.connect();
    const result = await new ExportService().prepare(platform, ['sample-group-1', 'sample-group-2']);
    assert.deepEqual(result.map(group => group.category), expected);
    assert.ok(result.every(group => group.contacts.length === 1));
  }
});

test('a platform error is passed on unchanged', async () => {
  const failure = new Error('FLOOD_WAIT');
  await assert.rejects(new ExportService().prepare(stubPlatform(failure), ['g1']), error => error === failure);
  const disconnected = new FakePlatform('telegram', { scanDelayMs: 0 });
  await assert.rejects(new ExportService().prepare(disconnected, ['sample-group-1']), /not connected/);
});

test('write hands the prepared contacts and the stream to the ExcelWriter', async () => {
  const seen: unknown[] = [];
  const writer = new ExcelWriter();
  writer.write = async (contacts, stream) => { seen.push(contacts, stream); };
  const contacts: CategorizedContacts = [{ category: 'saved', contacts: [] }];
  const stream = new PassThrough();
  await new ExportService(writer).write(contacts, stream);
  assert.deepEqual(seen, [contacts, stream]);
  assert.equal(seen[1], stream);
});

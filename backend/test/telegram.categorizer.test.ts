import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categorizeTelegramMembers, type TelegramMember } from '../src/platforms/telegram/telegram.categorizer.js';

const byCategory = (members: TelegramMember[]) =>
  Object.fromEntries(categorizeTelegramMembers(members).map(({ category, contacts }) => [category, contacts]));

test('always returns the three categories in order, even when empty', () => {
  assert.deepEqual(categorizeTelegramMembers([]), [
    { category: 'saved', contacts: [] },
    { category: 'unsaved_reachable', contacts: [] },
    { category: 'unsaved_unreachable', contacts: [] },
  ]);
});

test('saved wins over reachability; unsaved splits on a visible phone or a username', () => {
  const result = byCategory([
    { id: '1', firstName: 'Saved', lastName: 'NoPhone', contact: true },
    { id: '2', firstName: 'Saved', phone: '12025550101', username: 'saved_user', contact: true },
    { id: '3', firstName: 'Phone', phone: '12025550102' },
    { id: '4', firstName: 'User', username: 'just_username' },
    { id: '5', firstName: 'Nobody' },
  ]);
  assert.deepEqual(result.saved, [
    { id: '1', name: 'Saved NoPhone' },
    { id: '2', name: 'Saved', phoneNumber: '+12025550101', username: 'saved_user' },
  ]);
  assert.deepEqual(result.unsaved_reachable, [
    { id: '3', name: 'Phone', phoneNumber: '+12025550102' },
    { id: '4', name: 'User', username: 'just_username' },
  ]);
  assert.deepEqual(result.unsaved_unreachable, [{ id: '5', name: 'Nobody' }]);
});

test('the scanned account itself, deleted accounts, and bots are excluded', () => {
  const result = byCategory([
    { id: '1', firstName: 'Me', self: true, phone: '1' },
    { id: '2', deleted: true },
    { id: '3', firstName: 'Helper', username: 'helper_bot', bot: true },
    { id: '4', firstName: 'Kept' },
  ]);
  assert.deepEqual(Object.values(result).flat().map(contact => contact.id), ['4']);
});

test('names are joined and trimmed; nulls (as Telegram sends absent fields) are treated as missing', () => {
  const result = byCategory([
    { id: '1', firstName: '  Ali ', lastName: ' Hassan  ', phone: null, username: null, usernames: null, contact: null, self: null, deleted: null, bot: null },
    { id: '2', firstName: null, lastName: 'OnlyLast' },
    { id: '3', firstName: '   ', lastName: null },
    { id: '4', firstName: 'علي', lastName: 'الرضا' },
  ]);
  assert.deepEqual(result.unsaved_unreachable!.map(contact => contact.name), ['Ali Hassan', 'OnlyLast', '', 'علي الرضا']);
});

test('phones get one leading +; an empty phone is not visible', () => {
  const result = byCategory([
    { id: '1', phone: '9613123456' },
    { id: '2', phone: '+9613123456' },
    { id: '3', phone: '' },
  ]);
  assert.deepEqual(result.unsaved_reachable!.map(contact => contact.phoneNumber), ['+9613123456', '+9613123456']);
  assert.deepEqual(result.unsaved_unreachable!.map(contact => contact.id), ['3']);
});

test('the username falls back to the first active entry of usernames, without adding @', () => {
  const result = byCategory([
    { id: '1', usernames: [{ username: 'old_name', active: false }, { username: 'collectible', active: true }] },
    { id: '2', usernames: [{ username: 'inactive_only', active: false }] },
    { id: '3', username: 'primary', usernames: [{ username: 'collectible', active: true }] },
  ]);
  assert.deepEqual(result.unsaved_reachable!.map(contact => contact.username), ['collectible', 'primary']);
  assert.deepEqual(result.unsaved_unreachable!.map(contact => contact.id), ['2']);
  assert.doesNotMatch(JSON.stringify(result), /@/);
});

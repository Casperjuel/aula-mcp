import { describe, expect, test } from 'bun:test';
import { asArray, stableId } from './notifications.ts';

describe('asArray — shape tolerance', () => {
  test('top-level array', () => {
    expect(asArray([{ a: 1 }, { a: 2 }])).toHaveLength(2);
  });

  test('{ data: [...] } (Aula default)', () => {
    expect(asArray({ data: [{ a: 1 }], status: { code: 0 } })).toHaveLength(1);
  });

  test('{ data: { notifications: [...] } }', () => {
    expect(asArray({ data: { notifications: [{ a: 1 }, { a: 2 }] } })).toHaveLength(2);
  });

  test('{ notifications: [...] }', () => {
    expect(asArray({ notifications: [{ a: 1 }] })).toHaveLength(1);
  });

  test('unexpected shapes degrade to empty', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray({})).toEqual([]);
    expect(asArray('nope')).toEqual([]);
    expect(asArray({ data: 'not-an-array' })).toEqual([]);
  });
});

describe('stableId — dedup key', () => {
  test('prefers notificationId string', () => {
    expect(stableId({ notificationId: 'abc-123', triggered: 't1' })).toBe('abc-123');
  });

  test('falls back to id', () => {
    expect(stableId({ id: 'xyz' })).toBe('xyz');
    expect(stableId({ id: 42 })).toBe('42');
  });

  test('hashes the record when no identifier present', () => {
    const id = stableId({ notificationArea: 'Posts', triggered: 't1' });
    expect(id).toMatch(/^sha:[0-9a-f]{16}$/);
  });

  test('hash is stable across key order', () => {
    expect(stableId({ a: 1, b: 2 })).toBe(stableId({ b: 2, a: 1 }));
  });

  test('hash differs for different records', () => {
    expect(stableId({ notificationArea: 'Posts', triggered: 't1' })).not.toBe(
      stableId({ notificationArea: 'Posts', triggered: 't2' }),
    );
  });
});

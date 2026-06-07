import { describe, expect, test } from 'bun:test';
import { canonicalItem, normaliseItems } from './ugeplan.ts';

describe('canonicalItem — defined string fields in fixed order', () => {
  test('keeps defined fields in the canonical key order', () => {
    const item = canonicalItem({
      url: 'https://x',
      content: 'c',
      childName: 'Theo',
      subject: 'Matematik',
    });
    expect(Object.keys(item)).toEqual(['childName', 'subject', 'content', 'url']);
  });

  test('drops omitted and empty-string fields', () => {
    // `title` omitted entirely; `subject` present but empty — both gone.
    const item = canonicalItem({ childName: 'Theo', subject: '', content: 'c' });
    expect(item).toEqual({ childName: 'Theo', content: 'c' });
  });

  test('drops non-string values defensively', () => {
    // Upstream is typed as strings, but tolerate drift rather than emit junk.
    const item = canonicalItem({ subject: 42 as unknown as string, content: 'c' });
    expect(item).toEqual({ content: 'c' });
  });
});

describe('normaliseItems — stable ordering for diffing', () => {
  test('same items in different upstream order serialize identically', () => {
    const a = normaliseItems([
      { childName: 'Theo', date: 'mandag', subject: 'Dansk' },
      { childName: 'Samuel', date: 'tirsdag', subject: 'Idræt' },
    ]);
    const b = normaliseItems([
      { childName: 'Samuel', date: 'tirsdag', subject: 'Idræt' },
      { childName: 'Theo', date: 'mandag', subject: 'Dansk' },
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('a genuine content change produces a different serialization', () => {
    const before = normaliseItems([{ childName: 'Theo', subject: 'Dansk' }]);
    const after = normaliseItems([{ childName: 'Theo', subject: 'Matematik' }]);
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });

  test('empty input → empty array', () => {
    expect(normaliseItems([])).toEqual([]);
  });
});

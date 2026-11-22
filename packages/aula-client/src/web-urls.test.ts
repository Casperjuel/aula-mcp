import { describe, expect, test } from 'bun:test';
import { postWebUrl, threadWebUrl } from './web-urls.ts';

describe('web urls', () => {
  test('thread and post routes of the Aula web portal', () => {
    expect(threadWebUrl(1001)).toBe('https://www.aula.dk/portal/#/beskeder/1001');
    expect(postWebUrl(2001)).toBe('https://www.aula.dk/portal/#/overblik/2001');
  });
});

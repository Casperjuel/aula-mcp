/** Aula's own reason on a failed call goes into the error message, short and plain. */

import { describe, expect, test } from 'bun:test';
import { aulaReason } from './errors.ts';

describe('aulaReason', () => {
  test('reads message and subCode from the envelope status', () => {
    const body = JSON.stringify({
      status: { code: 400, subCode: 17, message: 'Invalid argument <script>' },
      data: null,
    });
    expect(aulaReason(body)).toBe('Invalid argument script, subCode 17');
  });

  test('is empty for anything else', () => {
    expect(aulaReason(undefined)).toBe('');
    expect(aulaReason('<html>Bad Request</html>')).toBe('');
    expect(aulaReason('{"data":1}')).toBe('');
  });

  test('cuts a long message short', () => {
    expect(aulaReason(JSON.stringify({ status: { message: 'x'.repeat(500) } }))).toHaveLength(120);
  });
});

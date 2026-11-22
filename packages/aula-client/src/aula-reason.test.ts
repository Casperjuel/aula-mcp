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

  test('names the shape, never the values, when Aula gives no message', () => {
    expect(aulaReason(undefined)).toBe('empty body');
    expect(aulaReason('<html>Bad Request</html>')).toBe('not JSON, 24 characters');
    expect(aulaReason('{"data":"secret"}')).toBe('no status; fields data');
    expect(aulaReason(JSON.stringify({ status: { code: 4, message: null }, data: 'secret' }))).toBe(
      'no message; code 4; status fields code message; fields status data',
    );
  });

  test('cuts a long message short', () => {
    expect(aulaReason(JSON.stringify({ status: { message: 'x'.repeat(500) } }))).toHaveLength(120);
  });
});

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from './version.ts';

/**
 * release-please rewrites the annotated line in version.ts alongside the
 * root package.json on every release. If that ever stops working, the MCP
 * handshake silently starts advertising a stale version to every client —
 * which is exactly how it sat on "0.0.0" unnoticed. Pin the two together.
 */
describe('VERSION', () => {
  test('matches the version release-please writes to package.json', async () => {
    const root = join(import.meta.dir, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(await readFile(root, 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  test('is a real version, not a placeholder', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe('0.0.0');
  });
});

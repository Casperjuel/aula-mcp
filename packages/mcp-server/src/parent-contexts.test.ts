import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@aula-mcp/aula-auth';
import { callerId } from './oidc.ts';
import { ParentContexts, parentDirectory } from './parent-contexts.ts';

const ISSUER = 'https://id.example.com/realms/home';
const parentA = { issuer: ISSUER, sub: 'parent-a' };
const parentB = { issuer: ISSUER, sub: 'parent-b' };

let contexts: ParentContexts | undefined;
let dir: string | undefined;

afterEach(async () => {
  contexts?.dispose();
  contexts = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function setup(): Promise<ParentContexts> {
  dir = await mkdtemp(join(tmpdir(), 'aula-parents-'));
  contexts = new ParentContexts({ logger: silentLogger, baseDir: dir });
  return contexts;
}

describe('ParentContexts', () => {
  test('each parent gets their own context, reused across sessions', async () => {
    const parents = await setup();
    const a = parents.get(parentA);
    expect(parents.get({ ...parentA })).toBe(a);
    expect(parents.get(parentB)).not.toBe(a);
  });

  test("a parent's tokens live in their own directory", async () => {
    const parents = await setup();
    const store = (parents.get(parentA) as unknown as { store: { filePath: string } }).store;
    expect(store.filePath).toBe(join(dir as string, 'parents', callerId(parentA), 'tokens.json'));
    expect(parentDirectory(dir as string, parentA)).not.toBe(
      parentDirectory(dir as string, parentB),
    );
  });

  test('a parent with no login has no tokens, not the single-parent ones', async () => {
    const parents = await setup();
    await expect(parents.get(parentA).getClient()).rejects.toThrow(/No tokens/);
  });
});

/**
 * One AulaContext per parent in multi-parent mode. Each parent's Aula tokens
 * live in their own directory, so a tool call can only ever use the tokens
 * of the parent who made it.
 *
 *   <AULA_MCP_DIR>/parents/<callerId>/tokens.json
 *   <AULA_MCP_DIR>/parents/<callerId>/.key
 *
 * The layout inside a parent's directory matches the single-parent one, so
 * `AULA_MCP_NO_KEYCHAIN=1 AULA_MCP_DIR=<that dir> aula login` logs a parent
 * in. The single-parent `tokens.json` is never read here.
 *
 * Always the file backend, never the macOS Keychain: the Keychain store has
 * one entry per machine, which every parent would share.
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore, type Logger } from '@aula-mcp/aula-auth';
import { AulaContext } from './aula-context.ts';
import { type Caller, callerId } from './oidc.ts';

export function parentDirectory(baseDir: string, caller: Caller): string {
  return join(baseDir, 'parents', callerId(caller));
}

/** The parent's own token store; the setup UI's MitID login writes to it. */
export function parentStore(baseDir: string, caller: Caller): EncryptedFileTokenStore {
  const dir = parentDirectory(baseDir, caller);
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}

export interface ParentContextsOptions {
  logger: Logger;
  /** Defaults to AULA_MCP_DIR, then ~/.config/aula-mcp. */
  baseDir?: string;
  /** Passed to each parent's AulaContext. */
  loginHint?: string;
}

export class ParentContexts {
  private readonly logger: Logger;
  private readonly baseDir: string;
  private readonly loginHint: string | undefined;
  private readonly contexts = new Map<string, AulaContext>();

  constructor(options: ParentContextsOptions) {
    this.logger = options.logger;
    this.baseDir =
      options.baseDir ?? process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
    this.loginHint = options.loginHint;
  }

  /** The caller's own context, created on first use. */
  get(caller: Caller): AulaContext {
    return this.forDirectory(callerId(caller));
  }

  store(caller: Caller): EncryptedFileTokenStore {
    return parentStore(this.baseDir, caller);
  }

  /** The context of every parent who has a directory, for the keep-alive. */
  async all(): Promise<AulaContext[]> {
    return (await this.entries()).map((entry) => entry.context);
  }

  /** Every parent who has a directory, with their callerId, for sync. */
  async entries(): Promise<Array<{ id: string; context: AulaContext }>> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(this.baseDir, 'parents'), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, context: this.forDirectory(entry.name) }));
  }

  /** `id` is a callerId, which is also the parent's directory name. */
  private forDirectory(id: string): AulaContext {
    let context = this.contexts.get(id);
    if (!context) {
      const dir = join(this.baseDir, 'parents', id);
      context = new AulaContext({
        logger: this.logger,
        store: new EncryptedFileTokenStore({
          filePath: join(dir, 'tokens.json'),
          keyFilePath: join(dir, '.key'),
        }),
        ...(this.loginHint ? { loginHint: this.loginHint } : {}),
      });
      this.contexts.set(id, context);
      this.logger.info('aula-mcp.parent_context_created', { parent: id });
    }
    return context;
  }

  /** Drop the caller's cached client, so the next call reads their tokens again. */
  invalidate(caller: Caller): void {
    this.contexts.get(callerId(caller))?.invalidate();
  }

  dispose(): void {
    for (const context of this.contexts.values()) context.dispose();
    this.contexts.clear();
  }
}

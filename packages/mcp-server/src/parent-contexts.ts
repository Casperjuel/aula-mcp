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

import { homedir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore, type Logger } from '@aula-mcp/aula-auth';
import { AulaContext } from './aula-context.ts';
import { type Caller, callerId } from './oidc.ts';

export function parentDirectory(baseDir: string, caller: Caller): string {
  return join(baseDir, 'parents', callerId(caller));
}

export interface ParentContextsOptions {
  logger: Logger;
  /** Defaults to AULA_MCP_DIR, then ~/.config/aula-mcp. */
  baseDir?: string;
}

export class ParentContexts {
  private readonly logger: Logger;
  private readonly baseDir: string;
  private readonly contexts = new Map<string, AulaContext>();

  constructor(options: ParentContextsOptions) {
    this.logger = options.logger;
    this.baseDir =
      options.baseDir ?? process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  }

  /** The caller's own context, created on first use. */
  get(caller: Caller): AulaContext {
    const id = callerId(caller);
    let context = this.contexts.get(id);
    if (!context) {
      const dir = parentDirectory(this.baseDir, caller);
      context = new AulaContext({
        logger: this.logger,
        store: new EncryptedFileTokenStore({
          filePath: join(dir, 'tokens.json'),
          keyFilePath: join(dir, '.key'),
        }),
      });
      this.contexts.set(id, context);
      this.logger.info('aula-mcp.parent_context_created', { parent: id });
    }
    return context;
  }

  dispose(): void {
    for (const context of this.contexts.values()) context.dispose();
    this.contexts.clear();
  }
}

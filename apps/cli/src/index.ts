#!/usr/bin/env bun
/**
 * `aula` — CLI entry point. Tiny dispatcher; each subcommand lives in its
 * own file under ./commands/.
 *
 * Usage:
 *   aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug] [--transcript <file>]
 *   aula refresh-stepup [--json]
 *   aula status [--json]
 *   aula whoami [--json]
 *   aula doctor [--json] [--verbose]
 *   aula transcript view <file> [--json]
 *   aula transcript list [--json]
 *   aula transcript prune [--keep N] [--dry-run]
 *   aula logout
 *   aula --help
 */

import { runDoctor } from './commands/doctor.ts';
import { runLog } from './commands/log.ts';
import { runLogin } from './commands/login.ts';
import { runLogout } from './commands/logout.ts';
import { runRefreshStepup } from './commands/refresh-stepup.ts';
import { runStatus } from './commands/status.ts';
import { runThreadFetch, runThreadsListIds } from './commands/threads.ts';
import { runTokensExport, runTokensImport } from './commands/tokens.ts';
import { runTranscriptList, runTranscriptPrune, runTranscriptView } from './commands/transcript.ts';
import { runWhoami } from './commands/whoami.ts';
import { fmt } from './io.ts';
import { parseArgs } from './parse-args.ts';

const HELP = `${fmt.bold('aula')} — MCP-friendly Aula client

${fmt.bold('Usage')}:
  aula login [--username <user>] [--method APP|CODE_TOKEN] [--debug]
             [--transcript <file>]
  aula refresh-stepup [--json]
  aula status [--json]
  aula whoami [--json]
  aula doctor [--json] [--verbose]
  aula log [--last N] [--json]
  aula tokens export <dir>
  aula tokens import <dir>
  aula threads list-ids [--page-size N] [--json]
  aula thread fetch <id> [--page N]
  aula transcript list [--json]
  aula transcript view <file> [--json]
  aula transcript prune [--keep N] [--dry-run]
  aula logout
  aula --help

${fmt.bold('Notes')}:
  • On macOS, tokens are stored in the system Keychain by default
    (set AULA_MCP_NO_KEYCHAIN=1 to fall back to the encrypted file at
    ~/.config/aula-mcp/tokens.json). On other platforms only the file
    backend is available.
  • Set AULA_MCP_KEY (hex or passphrase) for stronger file-backend key
    handling than the auto-generated .key file.
  • --debug captures a sanitised wire transcript to JSONL — safe to share
    when reporting issues.
  • aula doctor walks every read endpoint and reports per-call status.
  • aula log shows recent login attempts (success/failure + timestamps).
  • aula refresh-stepup attempts a silent OIDC re-authorize using cookies
    persisted by the last login. Succeeds without MitID prompt when the
    broker session is still alive; falls back to "run aula login" when
    not. Manual recovery tool — rarely needed since the plain
    refresh_token grant preserves sensitive scope.
  • aula tokens export <dir>  — write tokens.json + .key into <dir> for
    transfer (always re-encrypts with a fresh AES-GCM key). Pair with
    aula tokens import <dir> on the other machine, or scp the two files
    into a server's AULA_MCP_DIR. Use to move from macOS Keychain to a
    self-hosted Linux box.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args.command ?? (args.flags.help || args.flags.h ? 'help' : 'help');

  switch (cmd) {
    case 'login': {
      const username = typeof args.flags.username === 'string' ? args.flags.username : undefined;
      const methodRaw = args.flags.method;
      const method = methodRaw === 'CODE_TOKEN' || methodRaw === 'APP' ? methodRaw : undefined;
      const debug = args.flags.debug === true;
      const transcript =
        typeof args.flags.transcript === 'string' ? args.flags.transcript : undefined;
      await runLogin({
        ...(username ? { username } : {}),
        ...(method ? { method } : {}),
        ...(debug ? { debug: true } : {}),
        ...(transcript ? { transcript } : {}),
      });
      break;
    }
    case 'status':
      await runStatus({ json: args.flags.json === true });
      break;
    case 'whoami':
      await runWhoami({ json: args.flags.json === true });
      break;
    case 'doctor':
      await runDoctor({
        json: args.flags.json === true,
        verbose: args.flags.verbose === true,
      });
      break;
    case 'log': {
      const lastRaw = args.flags.last;
      const last = typeof lastRaw === 'string' ? Number.parseInt(lastRaw, 10) : undefined;
      await runLog({
        ...(typeof last === 'number' && Number.isFinite(last) ? { last } : {}),
        json: args.flags.json === true,
      });
      break;
    }
    case 'tokens': {
      const sub = args.positional[0];
      const dir = args.positional[1];
      switch (sub) {
        case 'export':
          if (!dir) {
            process.stderr.write('Usage: aula tokens export <dir>\n');
            process.exit(2);
          }
          await runTokensExport({ outDir: dir });
          break;
        case 'import':
          if (!dir) {
            process.stderr.write('Usage: aula tokens import <dir>\n');
            process.exit(2);
          }
          await runTokensImport({ inDir: dir });
          break;
        default:
          process.stderr.write(`Unknown tokens subcommand: ${sub ?? '<missing>'}\n`);
          process.stderr.write('Try: aula tokens {export <dir>|import <dir>}\n');
          process.exit(2);
      }
      break;
    }
    case 'threads': {
      const sub = args.positional[0];
      switch (sub) {
        case 'list-ids': {
          const pageSizeRaw = args.flags.pageSize ?? args.flags['page-size'];
          const pageSize =
            typeof pageSizeRaw === 'string' ? Number.parseInt(pageSizeRaw, 10) : undefined;
          await runThreadsListIds({
            ...(typeof pageSize === 'number' && Number.isFinite(pageSize) ? { pageSize } : {}),
          });
          break;
        }
        default:
          process.stderr.write(`Unknown threads subcommand: ${sub ?? '<missing>'}\n`);
          process.stderr.write('Try: aula threads list-ids [--page-size N]\n');
          process.exit(2);
      }
      break;
    }
    case 'thread': {
      const sub = args.positional[0];
      switch (sub) {
        case 'fetch': {
          const idRaw = args.positional[1];
          const threadId = idRaw ? Number.parseInt(idRaw, 10) : NaN;
          if (!Number.isFinite(threadId) || threadId <= 0) {
            process.stderr.write('Usage: aula thread fetch <id> [--page N]\n');
            process.exit(2);
          }
          const pageRaw = args.flags.page;
          const page = typeof pageRaw === 'string' ? Number.parseInt(pageRaw, 10) : undefined;
          await runThreadFetch({
            threadId,
            ...(typeof page === 'number' && Number.isFinite(page) ? { page } : {}),
          });
          break;
        }
        default:
          process.stderr.write(`Unknown thread subcommand: ${sub ?? '<missing>'}\n`);
          process.stderr.write('Try: aula thread fetch <id> [--page N]\n');
          process.exit(2);
      }
      break;
    }
    case 'transcript': {
      const sub = args.positional[0];
      switch (sub) {
        case 'view': {
          const file = args.positional[1];
          if (!file) {
            process.stderr.write('Usage: aula transcript view <file>\n');
            process.exit(2);
          }
          await runTranscriptView({ file, json: args.flags.json === true });
          break;
        }
        case 'list':
          await runTranscriptList({ json: args.flags.json === true });
          break;
        case 'prune': {
          const keepRaw = args.flags.keep;
          const keep = typeof keepRaw === 'string' ? Number.parseInt(keepRaw, 10) : undefined;
          await runTranscriptPrune({
            ...(typeof keep === 'number' && Number.isFinite(keep) ? { keep } : {}),
            ...(args.flags['dry-run'] === true ? { dryRun: true } : {}),
          });
          break;
        }
        default:
          process.stderr.write(`Unknown transcript subcommand: ${sub ?? '<missing>'}\n`);
          process.stderr.write('Try: aula transcript {list|view <file>|prune}\n');
          process.exit(2);
      }
      break;
    }
    case 'refresh-stepup':
      await runRefreshStepup({ json: args.flags.json === true });
      break;
    case 'logout':
      await runLogout();
      break;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

await main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});

/**
 * `aula login` — runs the full MitID login and persists tokens.
 *
 * Pass `--debug` to also tee a sanitised wire transcript to a JSONL file
 * under `~/.config/aula-mcp/transcripts/`. The transcript redacts secrets
 * (cookies, MitID auth code, SAML response, OAuth tokens, etc.) so it's
 * safe to paste into a GitHub issue when something fails.
 */

import { chown, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AulaHttpClient,
  AulaLoginClient,
  CompositeTracer,
  consoleLogger,
  formatTraceText,
  type IdentityOption,
  InMemoryTracer,
  JsonlFileTracer,
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type WireTracer,
} from '@aula-mcp/aula-auth';
import qrcode from 'qrcode-terminal';
import { fail, fmt, info, ok, prompt, promptSecret, rule, selectFromList, warn } from '../io.ts';
import { appendLoginLog } from '../login-log.ts';
import { aulaMcpDir, cookiesFile, defaultStore, transcriptPath } from '../store.ts';

export interface LoginCommandArgs {
  username?: string;
  method?: 'APP' | 'CODE_TOKEN';
  debug?: boolean;
  /** Override the file path the wire transcript is written to. */
  transcript?: string;
}

export async function runLogin(args: LoginCommandArgs): Promise<void> {
  const username = args.username ?? (await prompt('MitID username:'));
  if (!username) {
    fail('Username is required.');
    process.exit(1);
  }
  const method = args.method ?? 'APP';

  // Wire tracing.
  const memTracer = args.debug ? new InMemoryTracer() : null;
  let fileTracer: JsonlFileTracer | null = null;
  let transcriptFile: string | null = null;
  if (args.debug) {
    transcriptFile = args.transcript ?? transcriptPath();
    await mkdir(dirname(transcriptFile), { recursive: true });
    fileTracer = new JsonlFileTracer(transcriptFile);
    info(`Debug mode: capturing wire transcript to ${fmt.dim(transcriptFile)}`);
  }
  const tracer: WireTracer | undefined =
    memTracer && fileTracer
      ? new CompositeTracer([memTracer, fileTracer])
      : (memTracer ?? fileTracer ?? undefined);

  const logger: Logger = args.debug ? consoleLogger('aula') : silentLogger;
  const http = new AulaHttpClient({ logger, ...(tracer ? { tracer } : {}) });
  const client = new AulaLoginClient({ http, logger });

  let identityIndex: number | undefined;
  let identityName: string | undefined;
  let lastShownQrUpdate = -1;

  info(`Starting MitID login for ${fmt.bold(username)} (${method})`);

  let codeTokenPassword: string | undefined;
  let promptForCodeToken: (() => Promise<string>) | undefined;
  if (method === 'CODE_TOKEN') {
    codeTokenPassword = await promptSecret('MitID password:');
    promptForCodeToken = async () => prompt('6 digits from your kodeviser:');
  }

  try {
    const tokens = await client.login({
      username,
      method,
      ...(codeTokenPassword ? { password: codeTokenPassword } : {}),
      ...(promptForCodeToken ? { promptForCodeToken } : {}),
      selectIdentity: async (options: IdentityOption[]) => {
        const choice = await selectFromList(
          'Pick the identity to log in as:',
          options.map((o) => ({ label: o.name })),
        );
        identityIndex = choice;
        identityName = options.find((o) => o.index === choice)?.name;
        return choice;
      },
      appCallbacks: {
        onOtp(otp) {
          info(`Enter this OTP in your MitID app: ${fmt.bold(otp)}`);
        },
        onQr(qr) {
          if (qr.updateCount === lastShownQrUpdate) return;
          lastShownQrUpdate = qr.updateCount;
          info(
            `Scan one of these QR codes with the MitID app (alternate display, refresh #${qr.updateCount}):`,
          );
          qrcode.generate(qr.qr1Json, { small: true });
          qrcode.generate(qr.qr2Json, { small: true });
        },
        onVerified() {
          info('Channel verified. Approve the login in your MitID app.');
        },
      },
    });

    const record: StoredTokenRecord = {
      version: 1,
      username,
      tokens,
      saved_at: Math.floor(Date.now() / 1000),
      ...(identityIndex ? { identityIndex } : {}),
      ...(identityName ? { identityName } : {}),
    };
    await defaultStore().save(record);

    // Persist the cookie jar so `aula refresh-stepup` can attempt silent
    // SSO against the broker (unilogin) without dragging the user through
    // MitID every time the assurance level drops.
    try {
      await mkdir(aulaMcpDir(), { recursive: true });
      const serialized = await http.jar.serialize();
      await writeFile(cookiesFile(), serialized, { mode: 0o600 });
      // When AULA_MCP_DIR is owned by a service account (e.g. openclaw
      // on the gateway VM) but `aula login` is being run as root, a
      // freshly-created cookies.json lands root-owned and the
      // service-account-run refresh-stepup timer can't read it. Match
      // the directory's ownership.
      try {
        const dirStat = await stat(aulaMcpDir());
        if (dirStat.uid !== process.getuid?.()) {
          await chown(cookiesFile(), dirStat.uid, dirStat.gid);
        }
      } catch {
        // chown is best-effort — non-root can't, and that's fine when
        // the running user already owns the dir.
      }
    } catch (e) {
      warn(`Could not persist cookies: ${(e as Error).message}`);
    }

    ok(`Login successful. Tokens saved to ${fmt.dim(defaultStore().path)}`);
    info(
      `Access token expires in ${Math.max(0, tokens.expires_at - Math.floor(Date.now() / 1000))} s`,
    );
    await appendLoginLog({
      ts: new Date().toISOString(),
      username,
      method,
      success: true,
      ...(identityName ? { identityName } : {}),
    }).catch(() => {
      // Don't let log-append failures clobber a successful login.
    });
  } catch (err) {
    const error = err as Error;
    fail(`Login failed: ${error.message}`);
    await appendLoginLog({
      ts: new Date().toISOString(),
      username,
      method,
      success: false,
      errorKind: error.name ?? 'Error',
      errorMessage: error.message,
    }).catch(() => {});

    // Friendly hint for the most common transient failure: MitID's
    // parallel-session detector. Doesn't help to dump a transcript here —
    // the user just needs to wait + retry.
    if (error.name === 'MitidParallelSessionError' || /parallel/i.test(error.message)) {
      info(`${fmt.bold('Hint:')} this is MitID's "parallel sessions" detector.`);
      info('  Close any open Aula browser tabs, dismiss any pending MitID-app prompts,');
      info('  and wait ~60 seconds before retrying.');
      info(`History: ${fmt.dim('aula log --last 5')}`);
      process.exit(1);
    }

    if (memTracer && memTracer.entries.length > 0) {
      rule('wire transcript');
      process.stderr.write(formatTraceText(memTracer.entries));
      if (transcriptFile) {
        warn(`Full transcript also written to ${transcriptFile}`);
      }
    } else if (transcriptFile) {
      warn(`Full transcript written to ${transcriptFile}`);
    } else {
      warn('Re-run with --debug to capture a sanitised wire transcript.');
    }
    info(`History: ${fmt.dim('aula log --last 5')}`);
    process.exit(1);
  }
}

/**
 * `aula refresh-stepup` — attempt a non-interactive re-authorize that
 * picks up a fresh MitID step-up assurance from a still-alive broker
 * session. The OAuth refresh-token grant keeps the base access token
 * alive but doesn't restore step-up; this command walks the OIDC
 * authorize chain again with the cookies persisted by `aula login`
 * and, if the broker silent-SSOs us, exchanges the resulting code for
 * fresh tokens — no MitID prompt.
 *
 * Falls back with a clear hint when silent SSO is impossible (broker
 * session gone, no persisted cookies, etc.). Run `aula login` then.
 */

import { chown, readFile, stat, writeFile } from 'node:fs/promises';
import {
  AulaCookieJar,
  AulaHttpClient,
  AulaLoginClient,
  AulaSilentSsoFailedError,
  type StoredTokenRecord,
  silentLogger,
} from '@aula-mcp/aula-auth';
import { fail, fmt, info, ok, printJson, warn } from '../io.ts';
import { aulaMcpDir, cookiesFile, defaultStore } from '../store.ts';

export interface RefreshStepupCommandArgs {
  json?: boolean;
}

export async function runRefreshStepup(args: RefreshStepupCommandArgs = {}): Promise<void> {
  const store = defaultStore();
  const record = await store.load();
  if (!record) {
    if (args.json) {
      printJson({ ok: false, error: 'no_tokens' });
      process.exit(1);
    }
    fail(`No tokens saved. Run ${fmt.bold('aula login')} to authenticate.`);
    process.exit(1);
  }

  let serialized: string;
  try {
    serialized = await readFile(cookiesFile(), 'utf8');
  } catch {
    if (args.json) {
      printJson({ ok: false, error: 'no_cookies', hint: 'run `aula login`' });
      process.exit(1);
    }
    fail(`No persisted cookies at ${fmt.dim(cookiesFile())}.`);
    info(
      `Cookies are written on every ${fmt.bold('aula login')}. If you logged in before this feature shipped, log in once more — then ${fmt.bold('aula refresh-stepup')} will be available.`,
    );
    process.exit(1);
  }

  const jar = await AulaCookieJar.deserialize(serialized);
  const http = new AulaHttpClient({ logger: silentLogger, jar });
  const client = new AulaLoginClient({ http, logger: silentLogger });

  try {
    const tokens = await client.attemptSilentReauthorize();
    const fresh: StoredTokenRecord = {
      version: 1,
      username: record.username,
      tokens,
      saved_at: Math.floor(Date.now() / 1000),
      ...(record.identityIndex ? { identityIndex: record.identityIndex } : {}),
      ...(record.identityName ? { identityName: record.identityName } : {}),
    };
    await store.save(fresh);
    // Re-persist the cookie jar — the chain hop set fresh broker cookies
    // and saving them keeps the next silent re-auth viable.
    try {
      await writeFile(cookiesFile(), await jar.serialize(), { mode: 0o600 });
      try {
        const dirStat = await stat(aulaMcpDir());
        if (dirStat.uid !== process.getuid?.()) {
          await chown(cookiesFile(), dirStat.uid, dirStat.gid);
        }
      } catch {
        // chown is best-effort; non-root can't, and that's fine when
        // the running user already owns the dir.
      }
    } catch (e) {
      warn(`Could not re-persist cookies: ${(e as Error).message}`);
    }
    if (args.json) {
      printJson({ ok: true, expires_at: tokens.expires_at });
      return;
    }
    ok(`Silent step-up succeeded — fresh tokens saved.`);
    info(
      `Access token expires in ${Math.max(0, tokens.expires_at - Math.floor(Date.now() / 1000))} s`,
    );
  } catch (e) {
    if (e instanceof AulaSilentSsoFailedError) {
      if (args.json) {
        printJson({ ok: false, error: 'silent_sso_failed', message: e.message });
        process.exit(2);
      }
      fail(e.message);
      info(`Run ${fmt.bold('aula login')} to re-authenticate.`);
      process.exit(2);
    }
    const err = e as Error;
    if (args.json) {
      printJson({ ok: false, error: err.name, message: err.message });
      process.exit(1);
    }
    fail(`Silent re-authorize failed: ${err.message}`);
    process.exit(1);
  }
}

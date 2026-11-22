/**
 * `aula whoami` — loads stored tokens, refreshes if needed, calls
 * `profiles.getProfilesByLogin` and `profiles.getProfileContext`. Prints the
 * user, their kids, and the active guardian user-id.
 *
 * Richer than just profile-fetch — also shows the API version probe result
 * and the current identity name from the token store. Useful as a 5-second
 * "is the whole pipeline alive?" check.
 *
 * `--json` for scripts.
 */

import { AulaHttpClient, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient } from '@aula-mcp/aula-client';
import { collectChildSightings } from '../child-sources.ts';
import { fail, fmt, info, ok, printJson } from '../io.ts';
import { defaultStore } from '../store.ts';

export interface WhoamiCommandArgs {
  json?: boolean;
}

export async function runWhoami(args: WhoamiCommandArgs = {}): Promise<void> {
  const store = defaultStore();
  const http = new AulaHttpClient();
  let record: Awaited<ReturnType<typeof withFreshTokens>>;
  try {
    record = await withFreshTokens({ store, http });
  } catch (e) {
    if (args.json) {
      printJson({ ok: false, error: 'token_load_failed', message: (e as Error).message });
      process.exit(1);
    }
    fail(`Could not load tokens: ${(e as Error).message}`);
    process.exit(1);
  }

  const client = new AulaClient({ tokens: record.tokens, http });
  try {
    const [profilesData, contextData, consents] = await Promise.all([
      client.getProfilesByLogin(),
      client.getProfileContext('guardian').catch((e: unknown) => {
        return { _error: (e as Error).message } as const;
      }),
      // Only for the per-source child check below (#150); never fatal.
      client
        .rawRequest('consents.getConsentResponses', { returnOnlyPendingConsentResponses: 'false' })
        .catch(() => undefined),
    ]);
    const guardianUserIdRaw =
      typeof contextData === 'object' && contextData !== null && '_error' in contextData
        ? null
        : (contextData.userId ?? null);
    const guardianUserId = guardianUserIdRaw == null ? null : String(guardianUserIdRaw);
    const sightings = collectChildSightings(
      profilesData,
      '_error' in contextData ? undefined : contextData,
      consents,
    );
    // Only worth showing when the endpoints disagree about who the children are.
    const sourcesDisagree = sightings.some((c) => !c.sources.includes('profilesByLogin'));

    if (args.json) {
      printJson({
        ok: true,
        username: record.username,
        identityName: record.identityName ?? null,
        apiVersion: client.currentApiVersion,
        guardianUserId,
        profiles: profilesData.profiles ?? [],
        profileContextError:
          typeof contextData === 'object' && contextData !== null && '_error' in contextData
            ? contextData._error
            : null,
        childSightings: sightings,
      });
      return;
    }

    ok(`Logged in as ${fmt.bold(record.username)} — Aula API v${client.currentApiVersion}`);
    if (record.identityName) info(`Active identity: ${record.identityName}`);
    if (guardianUserId !== null) {
      info(`Guardian user-id (used by integrations): ${guardianUserId}`);
    }
    for (const profile of profilesData.profiles ?? []) {
      info(`Profile: ${fmt.bold(profile.displayName)} (id ${profile.profileId})`);
      for (const child of profile.children ?? []) {
        const inst = child.institutionProfile?.institutionName ?? '?';
        const code = child.institutionProfile?.institutionCode ?? '?';
        info(`  Child: ${child.name} (id ${child.id}) at ${inst} [${code}]`);
      }
    }
    if (sourcesDisagree) {
      info('');
      info(
        fmt.bold('Some children are listed by other Aula endpoints but not by getProfilesByLogin'),
      );
      info('(aula.discover only uses getProfilesByLogin, see issue #150):');
      for (const c of sightings) {
        info(
          `  ${c.name ?? '?'} (id ${c.id})${c.institution ? ` at ${c.institution}` : ''}: ${c.sources.join(', ')}`,
        );
      }
    }
  } catch (e) {
    if (args.json) {
      printJson({ ok: false, error: 'api_call_failed', message: (e as Error).message });
      process.exit(1);
    }
    fail(`API call failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

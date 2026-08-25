/**
 * `aula doctor` — walk every read endpoint and report per-call status with
 * timing. The single most useful command for "is this thing actually working?"
 *
 * Each check is independent: a failing presence call doesn't stop the
 * messages check. Output is a tabular summary by default, `--json` for
 * scripts. Exit code 0 if every check passed; 1 if any failed.
 */

import { AulaHttpClient, InMemoryTracer, withFreshTokens } from '@aula-mcp/aula-auth';
import { AulaClient, isoDate } from '@aula-mcp/aula-client';
import { fail, fmt, ok, printJson, rule, warn } from '../io.ts';
import { defaultStore } from '../store.ts';

export interface DoctorCommandArgs {
  json?: boolean;
  verbose?: boolean;
}

interface CheckResult {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
  errorMessage?: string;
}

export async function runDoctor(args: DoctorCommandArgs = {}): Promise<void> {
  const store = defaultStore();
  const tracer = new InMemoryTracer();
  const http = new AulaHttpClient({ tracer });
  let record: Awaited<ReturnType<typeof withFreshTokens>>;

  try {
    record = await withFreshTokens({ store, http });
  } catch (e) {
    const result: CheckResult = {
      name: 'tokens',
      ok: false,
      durationMs: 0,
      detail: 'Could not load + refresh stored tokens',
      errorMessage: (e as Error).message,
    };
    if (args.json) {
      printJson({ ok: false, checks: [result] });
    } else {
      fail(result.detail);
      fail(`  ${result.errorMessage}`);
    }
    process.exit(1);
  }

  const client = new AulaClient({ tokens: record.tokens, http });
  const checks: CheckResult[] = [
    {
      name: 'tokens',
      ok: true,
      durationMs: 0,
      detail: `Loaded for ${record.username} (expires in ${Math.floor((record.tokens.expires_at - Math.floor(Date.now() / 1000)) / 60)} min)`,
    },
  ];

  await runCheck(checks, 'profiles.getProfilesByLogin', async () => {
    const data = await client.getProfilesByLogin();
    const childCount = (data.profiles ?? []).flatMap((p) => p.children ?? []).length;
    return `${data.profiles?.length ?? 0} profile(s), ${childCount} child(ren)`;
  });

  let guardianUserId: string | null = null;
  let childIds: number[] = [];
  let detectedWidgets: string[] = [];

  await runCheck(checks, 'profiles.getProfileContext', async () => {
    const data = await client.getProfileContext('guardian');
    guardianUserId = data.userId == null ? null : String(data.userId);
    detectedWidgets = (data.pageConfiguration?.widgetConfigurations ?? [])
      .map((w) => w.widget?.widgetId ?? w.widgetId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return `userId=${guardianUserId ?? 'missing'}, widgets=[${detectedWidgets.join(',') || 'none'}]`;
  });

  await runCheck(checks, 'collect child IDs', async () => {
    const data = await client.getProfilesByLogin();
    childIds = (data.profiles ?? [])
      .flatMap((p) => p.children ?? [])
      .map((c) => c.id)
      .filter((id): id is number => typeof id === 'number');
    return `${childIds.length} child id(s) collected`;
  });

  await runCheck(checks, 'presence.getDailyOverview', async () => {
    if (childIds.length === 0) return 'skipped — no child ids';
    const data = await client.getDailyOverview(childIds);
    return `${data.length} entry/entries`;
  });

  await runCheck(checks, 'presence.getPresenceTemplates', async () => {
    if (childIds.length === 0) return 'skipped — no child ids';
    const today = new Date();
    const weekLater = new Date(today.getTime() + 7 * 86_400_000);
    const data = await client.getPresenceTemplates({
      institutionProfileIds: childIds,
      fromDate: isoDate(today),
      toDate: isoDate(weekLater),
    });
    return `${data.presenceWeekTemplates?.length ?? 0} template(s)`;
  });

  await runCheck(checks, 'messaging.getThreads', async () => {
    const data = await client.getThreads({ pageSize: 5 });
    const unread = data.filter((t) => !t.read).length;
    return `${data.length} thread(s), ${unread} unread`;
  });

  await runCheck(checks, 'notifications.getNotificationsForActiveProfile', async () => {
    const data = await client.getNotifications();
    return `received (${typeof data}; ${JSON.stringify(data).length} chars)`;
  });

  await runCheck(checks, 'posts.getAllPosts', async () => {
    const data = await client.getPosts({ limit: 5 });
    return `received (${typeof data}; ${JSON.stringify(data).length} chars)`;
  });

  // Ask for a token for a widget this profile actually has. Hardcoding
  // 0001 (EasyIQ) made doctor report a failure on every school that uses a
  // different vendor: Aula answers 400 for a widget you were never granted,
  // which is correct behaviour, not a fault worth flagging.
  await runCheck(checks, 'aulaToken.getAulaToken', async () => {
    const widgetId = detectedWidgets[0];
    if (!widgetId) return 'skipped — no widgets on this profile';
    const t = await client.getWidgetToken(widgetId);
    return `widget ${widgetId}: token issued (${t.length} chars)`;
  });

  // ---- output -----------------------------------------------------------------

  const allOk = checks.every((c) => c.ok);

  if (args.json) {
    printJson({
      ok: allOk,
      apiVersion: client.currentApiVersion,
      guardianUserId,
      checks,
    });
    process.exit(allOk ? 0 : 1);
  }

  rule('aula doctor');
  for (const c of checks) {
    const tag = c.ok ? fmt.green('PASS') : fmt.red('FAIL');
    const time = c.durationMs ? fmt.dim(`(${c.durationMs} ms)`) : '';
    process.stdout.write(`  [${tag}] ${c.name.padEnd(46)} ${c.detail} ${time}\n`);
    if (!c.ok && c.errorMessage) {
      process.stdout.write(`         ${fmt.dim(c.errorMessage)}\n`);
    }
  }
  rule('summary');
  if (allOk) {
    ok(`All ${checks.length} checks passed (Aula API v${client.currentApiVersion}).`);
  } else {
    const failed = checks.filter((c) => !c.ok).length;
    fail(`${failed}/${checks.length} checks failed.`);
    if (args.verbose && tracer.entries.length > 0) {
      rule('wire transcript');
      const { formatTraceText } = await import('@aula-mcp/aula-auth');
      process.stdout.write(formatTraceText(tracer.entries));
    } else {
      warn('Re-run with --verbose to dump the wire transcript inline.');
    }
    process.exit(1);
  }
}

async function runCheck(
  results: CheckResult[],
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, durationMs: Date.now() - start, detail });
  } catch (e) {
    results.push({
      name,
      ok: false,
      durationMs: Date.now() - start,
      detail: 'failed',
      errorMessage: (e as Error).message,
    });
  }
}

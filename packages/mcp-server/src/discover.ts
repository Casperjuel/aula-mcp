/**
 * The `aula.discover` tool — the central thing this MCP server exists for.
 *
 * One call returns a typed manifest of the user's children, institutions,
 * available capabilities, and which subordinate tools the agent can call. The
 * agent uses this to dynamically pick what to query next without us having to
 * hard-code a fixed tool tree.
 *
 * Per-institution provider detection (Q2 fix): we read
 * `pageConfiguration.widgetConfigurations` from `getProfileContext` and map
 * widget IDs to provider names. The capabilities block then lists the right
 * tool first for the schools you're enrolled in.
 */

import type { AulaContext } from './aula-context.ts';

/** A single child the user can act on behalf of. */
export interface DiscoveredChild {
  id: number;
  name: string;
  /** The Aula institution-profile id used by API methods like getDailyOverview.
   *  Aula returns this as either a number or an opaque string token. */
  userId?: string | number;
  institution?: {
    id: number;
    name?: string;
    code?: string;
  };
}

/** Capability description for one functional area. */
export interface DiscoveredCapability {
  /** Human description for the agent. */
  summary: string;
  /** MCP tool names the agent can call to use this capability. */
  tools: string[];
  /** Optional notes specific to this user's institutions. */
  notes?: string;
}

export interface DiscoverManifest {
  user: {
    name: string;
    /** MitID username (for diagnostic display). */
    username: string;
    /** Currently-selected identity name, when known. */
    identityName?: string;
  };
  children: DiscoveredChild[];
  apiVersion: number;
  tokens: {
    /** Unix epoch seconds. */
    expires_at: number;
    /** Seconds remaining (negative if expired). */
    seconds_remaining: number;
  };
  capabilities: Record<string, DiscoveredCapability>;
  /** Widget IDs the schools surfaced in pageConfiguration. Useful when
   *  diagnosing "the agent can't find my kid's ugeplan". */
  detectedWidgets: string[];
  /** True when AULA_MCP_RAW=1 — the aula.raw_request escape hatch is callable. */
  rawRequestEnabled: boolean;
  /** Inline hints repeating server `instructions` so the agent has the
   *  workflow next to the data it just read. Cheaper to ground on this
   *  than to re-fetch context — keep tight. */
  usage: {
    cache: string;
    nameResolution: string;
    pickOne: string;
    timeWindows: string;
    language: string;
  };
}

/**
 * Aula widget IDs map to which third-party provider serves which capability.
 * Source: scaarup/aula client.py + the helmstedt API blog posts.
 */
const WIDGET_PROVIDER_MAP: Readonly<
  Record<string, { capability: string; provider: string; tool: string }>
> = Object.freeze({
  '0001': { capability: 'ugeplan', provider: 'easyiq', tool: 'aula.ugeplan.easyiq' },
  '0004': { capability: 'ugeplan', provider: 'meebook', tool: 'aula.ugeplan.meebook' },
  '0029': { capability: 'ugebrev', provider: 'minuddannelse', tool: 'aula.ugebrev.minuddannelse' },
  '0030': { capability: 'opgaver', provider: 'minuddannelse', tool: 'aula.opgaver.minuddannelse' },
  '0062': {
    capability: 'huskelisten',
    provider: 'systematic',
    tool: 'aula.huskelisten.systematic',
  },
  '0128': {
    capability: 'ugeplan',
    provider: 'easyiq_skoleportal',
    tool: 'aula.ugeplan.easyiq_skoleportal',
  },
  '0142': {
    capability: 'lektier',
    provider: 'easyiq_lektier',
    tool: 'aula.lektier.easyiq',
  },
});

export async function buildDiscoverManifest(context: AulaContext): Promise<DiscoverManifest> {
  const client = await context.getClient();
  const record = context.record;
  if (!record) throw new Error('AulaContext: record missing after getClient()');

  const [profilesData, contextData] = await Promise.all([
    client.getProfilesByLogin(),
    client.getProfileContext('guardian').catch(() => undefined),
  ]);

  const children: DiscoveredChild[] = [];
  for (const profile of profilesData.profiles ?? []) {
    for (const child of profile.children ?? []) {
      const inst = child.institutionProfile;
      const item: DiscoveredChild = { id: child.id, name: child.name };
      if (child.userId !== undefined) item.userId = child.userId;
      if (inst) {
        const institution: DiscoveredChild['institution'] = { id: inst.id };
        if (inst.institutionName !== undefined) institution.name = inst.institutionName;
        if (inst.institutionCode !== undefined) institution.code = inst.institutionCode;
        item.institution = institution;
      }
      children.push(item);
    }
  }

  // Capability detection from widget configs.
  // Aula nests the widget id under `widget.widgetId` in the live API; older
  // shape was flat (`w.widgetId`). Support both — Python does too.
  const detectedWidgets = Array.from(
    new Set(
      (contextData?.pageConfiguration?.widgetConfigurations ?? [])
        .map((w) => w.widget?.widgetId ?? w.widgetId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ).sort();

  const now = Math.floor(Date.now() / 1000);
  const manifest: DiscoverManifest = {
    user: {
      name: profilesData.profiles?.[0]?.name ?? record.username,
      username: record.username,
      ...(record.identityName ? { identityName: record.identityName } : {}),
    },
    children,
    apiVersion: client.currentApiVersion,
    tokens: {
      expires_at: record.tokens.expires_at,
      seconds_remaining: record.tokens.expires_at - now,
    },
    capabilities: buildCapabilities(detectedWidgets),
    detectedWidgets,
    rawRequestEnabled: process.env.AULA_MCP_RAW === '1',
    usage: {
      cache:
        'Reuse this manifest for the rest of the session. Do not call aula.discover again unless a tool reports unknown children/widgets.',
      nameResolution:
        'Match kid names from the user prompt against children[].name (case-insensitive, partial). E.g. "luk" matches "Lukas". Use the matched child.id for childIds and child.userId for profileIds.',
      pickOne:
        'For ugeplan/ugebrev/opgaver/huskelisten, call only capabilities[area].tools[0] — that is the provider this user actually has. Skip alternates unless the first errors.',
      timeWindows:
        'For calendar/ugeplan: "denne uge"→range:"this_week", "næste uge"→"next_week", "i dag"→"today", "i morgen"→"tomorrow". Times are Europe/Copenhagen.',
      language:
        'Reply in the user\'s language. Format dates as "mandag 12. maj" for Danish output.',
    },
  };
  return manifest;
}

/**
 * Build the capabilities block, prefixing the per-school detected providers
 * to each tool list so the agent picks the actually-configured one first.
 */
function buildCapabilities(detectedWidgets: string[]): Record<string, DiscoveredCapability> {
  const detectedByCapability = new Map<string, { provider: string; tool: string }[]>();
  for (const id of detectedWidgets) {
    const entry = WIDGET_PROVIDER_MAP[id];
    if (!entry) continue;
    const arr = detectedByCapability.get(entry.capability) ?? [];
    arr.push({ provider: entry.provider, tool: entry.tool });
    detectedByCapability.set(entry.capability, arr);
  }

  const ugeplanDetected = detectedByCapability.get('ugeplan') ?? [];
  const opgaverDetected = detectedByCapability.get('opgaver') ?? [];
  const ugebrevDetected = detectedByCapability.get('ugebrev') ?? [];
  const huskelistenDetected = detectedByCapability.get('huskelisten') ?? [];
  const lektierDetected = detectedByCapability.get('lektier') ?? [];

  // When detection picked a provider for a third-party capability, expose
  // ONLY that tool. Listing alternates as fallbacks invites Claude to fan
  // out and call all three "just to be sure", which is wasteful and noisy
  // — `pickOne` in usage tells it not to, but a one-element array is more
  // load-bearing than a hint.
  const ugeplanCanonical = [
    'aula.ugeplan.meebook',
    'aula.ugeplan.easyiq',
    'aula.ugeplan.easyiq_skoleportal',
  ];
  const ugeplanTools =
    ugeplanDetected.length > 0 ? dedupe(ugeplanDetected.map((d) => d.tool)) : ugeplanCanonical;

  return {
    profiles: {
      summary: 'Read profile and child information for the logged-in guardian.',
      tools: ['aula.profiles.list'],
    },
    presence: {
      summary: 'Daily presence for one or more children: arrived/sick/picked up etc.',
      tools: ['aula.presence.today'],
    },
    calendar: {
      summary:
        'School-schedule lessons (skoleskema). Pass `range: "this_week"` for the simplest call.',
      tools: ['aula.calendar.events'],
    },
    messages: {
      summary: 'Aula messaging threads. Sensitive threads require MitID step-up.',
      tools: ['aula.messages.list_threads', 'aula.messages.get_thread'],
    },
    notifications: {
      summary: 'Unread items + activity badge counts for the active guardian.',
      tools: ['aula.notifications.list'],
    },
    posts: {
      summary: 'Class-level news / posts feed (teacher updates).',
      tools: ['aula.posts.list'],
    },
    ugeplan: {
      summary:
        ugeplanDetected.length > 0
          ? `Weekly plans. Detected provider${ugeplanDetected.length > 1 ? 's' : ''}: ${ugeplanDetected
              .map((d) => d.provider)
              .join(', ')}.`
          : 'Weekly plans. No provider widget detected — try in order and surface the first that returns data.',
      tools: ugeplanTools,
      notes: ugeplanProviderNotes(ugeplanDetected.map((d) => d.provider)),
    },
    opgaver: {
      summary: 'Homework / task list from Min Uddannelse.',
      tools: ['aula.opgaver.minuddannelse'],
      ...(opgaverDetected.length === 0
        ? {
            notes:
              'Min Uddannelse opgaver widget (0030) not detected — call may return empty. Skip if user did not specifically ask for opgaver.',
          }
        : {}),
    },
    ugebrev: {
      summary: 'Weekly newsletter from Min Uddannelse.',
      tools: ['aula.ugebrev.minuddannelse'],
      ...(ugebrevDetected.length === 0
        ? {
            notes:
              'Min Uddannelse ugebrev widget (0029) not detected — call may return empty. Skip if user did not specifically ask for ugebrev.',
          }
        : {}),
    },
    huskelisten: {
      summary: 'Homework reminders from Systematic.',
      tools: ['aula.huskelisten.systematic'],
      ...(huskelistenDetected.length === 0
        ? {
            notes:
              'Systematic widget (0062) not detected — call may return empty. Skip if user did not specifically ask for huskelisten.',
          }
        : {}),
    },
    lektier: {
      summary: 'Homework items from EasyIQ Lektier (widget 0142).',
      tools: ['aula.lektier.easyiq'],
      ...(lektierDetected.length === 0
        ? {
            notes:
              'EasyIQ Lektier widget (0142) not detected — call may return empty. Skip if user did not specifically ask for lektier.',
          }
        : {}),
    },
  };
}

/** Vendor-specific gotchas for ugeplan. Surface real prerequisites so the
 *  agent can tell the user up-front instead of after a failed call. */
function ugeplanProviderNotes(providers: string[]): string {
  if (providers.includes('meebook')) {
    return (
      'Meebook requires a one-time browser SSO from app.aula.dk → click any ' +
      'Meebook widget once — before programmatic access works. If the call ' +
      'returns "first time you use this function with unilogin … log in to ' +
      'Meebook first", relay that instruction verbatim and stop.'
    );
  }
  if (providers.includes('easyiq')) {
    return 'EasyIQ Ugeplan (widget 0001) — uses Aula widget tokens; no extra setup.';
  }
  return '';
}

function dedupe(arr: readonly string[]): string[] {
  return Array.from(new Set(arr));
}

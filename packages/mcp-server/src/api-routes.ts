/**
 * The routes of the aula-mcp API (/api/v1) and how they map onto the
 * dashboard's own paths. Shared by the API (api.ts), which serves them, and
 * by the dashboard server (ui-app.ts), which forwards the page's calls to it.
 * Kept free of other imports so the dashboard server stays small.
 *
 *   /api/v1/aula/status, /api/v1/aula/login/*, /api/v1/aula/logout
 *                                  ↔ /status, /login/*, /logout
 *   /api/v1/feed/:token/calendar.ics ↔ /feed/:token/calendar.ics
 *   /api/v1/<anything else>        ↔ /data/<anything else>
 */

export const API_BASE = '/api/v1';

const AULA = /^\/(status|login\/[a-z]+|logout)$/;

/** The API path for a dashboard path, or null when the API has no such route. */
export function toApiPath(path: string): string | null {
  if (AULA.test(path)) return `${API_BASE}/aula${path}`;
  if (path.startsWith('/feed/')) return `${API_BASE}${path}`;
  if (path.startsWith('/data/')) return `${API_BASE}${path.slice('/data'.length)}`;
  return null;
}

/** The dashboard path an API path is served by, or null for an unknown one. */
export function fromApiPath(path: string): string | null {
  if (!path.startsWith(`${API_BASE}/`)) return null;
  const rest = path.slice(API_BASE.length);
  if (rest.startsWith('/aula/')) {
    const aula = rest.slice('/aula'.length);
    return AULA.test(aula) ? aula : null;
  }
  if (rest.startsWith('/feed/')) return rest;
  return `/data${rest}`;
}

/**
 * Routes only the dashboard may call: the secret calendar feed (its link and
 * the feed itself) and sharing with another parent. Both are a parent's own
 * decision in the page, so the API answers them only to the dashboard server,
 * which proves itself with the shared UI key. Dashboard paths.
 */
const UI_ONLY = /^\/(data\/(calendar-feed|shares)(\/|$)|feed\/)/;

export function isUiOnly(dashboardPath: string): boolean {
  return UI_ONLY.test(dashboardPath);
}

/** A request that only reads. Every other method changes something. */
export function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

interface Route {
  method: 'get' | 'post';
  /** OpenAPI path under /api/v1. */
  path: string;
  summary: string;
  /** Also answers `?owner=<parent id>` with what that parent shares. */
  shared?: boolean;
  /** Query parameters, all optional strings. */
  query?: string[];
  /** Server-sent events instead of JSON. */
  events?: boolean;
  /** A file instead of JSON. */
  file?: boolean;
}

/** Every route of the API but the UI-only ones, for the OpenAPI document. */
export const API_ROUTES: Route[] = [
  {
    method: 'get',
    path: '/aula/status',
    summary: 'Whether you are logged in to Aula, and until when',
  },
  {
    method: 'post',
    path: '/aula/login/start',
    summary: 'Start a MitID app login to Aula: { username }, returns { sessionId }',
  },
  {
    method: 'get',
    path: '/aula/login/events',
    summary: 'Progress of a login: qr, otp, verified, identity, success, error',
    query: ['sessionId'],
    events: true,
  },
  {
    method: 'post',
    path: '/aula/login/identity',
    summary: 'Pick the MitID identity of a login: { index }',
    query: ['sessionId'],
  },
  { method: 'post', path: '/aula/logout', summary: 'Forget your Aula login' },
  { method: 'get', path: '/summary', summary: 'What aula-mcp keeps about you' },
  { method: 'get', path: '/tools', summary: 'The MCP tools this server offers' },
  { method: 'get', path: '/stats', summary: 'Stored items per kind', shared: true },
  { method: 'get', path: '/live', summary: 'Who and what Aula shows you, read live' },
  { method: 'get', path: '/children', summary: 'Your children today, live from Aula' },
  {
    method: 'get',
    path: '/children/plan',
    summary: "A child's komme/gå plan, live from Aula",
    query: ['child', 'from', 'to'],
  },
  {
    method: 'post',
    path: '/children/sick',
    summary: 'Report children sick today (writes to Aula)',
  },
  {
    method: 'post',
    path: '/children/plan',
    summary: 'Change a komme/gå plan (writes to Aula)',
  },
  { method: 'post', path: '/children/vacation', summary: 'Announce a vacation (writes to Aula)' },
  { method: 'get', path: '/children/vacations', summary: 'Announced vacations, live from Aula' },
  {
    method: 'post',
    path: '/children/vacations/delete',
    summary: 'Delete an announced vacation (writes to Aula)',
  },
  {
    method: 'get',
    path: '/children/vacation-requests',
    summary: 'Ferie requests from the school, live from Aula',
  },
  {
    method: 'post',
    path: '/children/vacation-requests/answer',
    summary: 'Answer a ferie request (writes to Aula)',
  },
  {
    method: 'get',
    path: '/items',
    summary: 'Stored items, newest first, a page at a time',
    shared: true,
    query: ['kind', 'q', 'role', 'flag', 'since', 'until', 'limit', 'offset'],
  },
  {
    method: 'get',
    path: '/items/{kind}/{id}',
    summary: 'One stored item',
    shared: true,
  },
  {
    method: 'get',
    path: '/activity',
    summary: 'Stored items per day',
    shared: true,
    query: ['since', 'until'],
  },
  {
    method: 'get',
    path: '/messages/roles',
    summary: 'Stored messages per sender role',
    shared: true,
  },
  {
    method: 'post',
    path: '/messages/{id}/read',
    summary: 'Mark a thread read (writes to Aula)',
  },
  {
    method: 'post',
    path: '/messages/{id}/unread',
    summary: 'Mark a thread unread (writes to Aula)',
  },
  {
    method: 'post',
    path: '/messages/{id}/marked',
    summary: 'Pin or unpin a thread: { marked } (writes to Aula)',
  },
  {
    method: 'post',
    path: '/messages/{id}/reply',
    summary: 'Reply in a thread: { text } (sends in Aula, cannot be recalled)',
  },
  { method: 'get', path: '/messages/contacts', summary: 'Who you can write to' },
  {
    method: 'get',
    path: '/messages/recipients',
    summary: 'Search Aula for recipients',
    query: ['q'],
  },
  {
    method: 'post',
    path: '/messages/new',
    summary: 'Start a new thread (sends in Aula, cannot be recalled)',
  },
  { method: 'get', path: '/sync', summary: 'The sync jobs and how they last went' },
  { method: 'post', path: '/sync/run', summary: 'Run sync jobs now: { jobs }' },
  {
    method: 'get',
    path: '/audit',
    summary: 'Your audit log, newest first',
    query: ['category', 'ok', 'before', 'limit', 'offset'],
  },
  { method: 'post', path: '/delete', summary: 'Delete stored data: { kinds }' },
  {
    method: 'get',
    path: '/gallery',
    summary: 'Stored gallery albums',
    shared: true,
    query: ['child', 'year'],
  },
  {
    method: 'get',
    path: '/gallery/albums/{albumId}',
    summary: 'One stored album',
    shared: true,
  },
  {
    method: 'get',
    path: '/gallery/{variant}/{albumId}/{mediaId}',
    summary: 'A downloaded picture or video (variant file or thumb)',
    shared: true,
    query: ['download'],
    file: true,
  },
  {
    method: 'get',
    path: '/attachments/{kind}/{id}/{index}',
    summary: 'A stored attachment (kind post or message)',
    shared: true,
    query: ['download'],
    file: true,
  },
  { method: 'post', path: '/gallery/delete', summary: 'Delete downloaded gallery files' },
];

/** OpenAPI 3.1 for the API, on `serverUrl` (its public origin) when known. */
export function openApiDocument(version: string, writeScope: string | null, serverUrl?: string) {
  const json = { 'application/json': { schema: { type: 'object' } } };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of API_ROUTES) {
    const params = [
      ...[...route.path.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      ...(route.query ?? []).map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
      ...(route.shared
        ? [
            {
              name: 'owner',
              in: 'query',
              description: 'Read what this parent shares with you instead of your own data.',
              schema: { type: 'string' },
            },
          ]
        : []),
    ];
    const ok = route.events
      ? { description: 'Server-sent events', content: { 'text/event-stream': {} } }
      : route.file
        ? { description: 'The file', content: { '*/*': {} } }
        : { description: 'OK', content: json };
    paths[`${API_BASE}${route.path}`] = {
      ...paths[`${API_BASE}${route.path}`],
      [route.method]: {
        summary: route.summary,
        ...(params.length ? { parameters: params } : {}),
        ...(route.method === 'post' ? { requestBody: { required: false, content: json } } : {}),
        security: [{ bearer: route.method === 'post' && writeScope ? [writeScope] : [] }],
        responses: {
          '200': ok,
          '401': { description: 'No valid bearer token' },
          '403': { description: 'The token lacks the write scope, or the request is refused' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'aula-mcp API',
      version,
      description:
        'Your own Aula data as stored by aula-mcp, and changes in Aula on your behalf. ' +
        'Every call needs an OIDC access token for this API; the parent is the token subject. ' +
        (writeScope
          ? `Reads need any valid token; every POST also needs the ${writeScope} scope and is audited.`
          : 'Every POST is audited.'),
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    paths,
  };
}

/**
 * Links into the Aula web portal. These are hash routes of the single-page app
 * at www.aula.dk/portal, not API URLs: they open in a browser that has a
 * logged-in Aula session (not in the native app), and Aula can change them.
 *
 * The host is fixed on purpose. `AulaClientOptions.apiBaseHost` overrides where
 * the API lives; it says nothing about where the portal does.
 */
const PORTAL = 'https://www.aula.dk/portal/#';

export function threadWebUrl(threadId: number): string {
  return `${PORTAL}/beskeder/${threadId}`;
}

export function postWebUrl(postId: number): string {
  return `${PORTAL}/overblik/${postId}`;
}

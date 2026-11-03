// Shared AniList GraphQL endpoint resolution.
//
// Every catalog router resolves the upstream through this module so a single,
// validated value is used across search, browse, catalog, series, manga and
// recommendations. server.js calls resolveAnilistGraphqlUrl() at startup so a
// malformed override fails fast instead of surfacing on the first request, and
// the override keeps working for tests and outage drills that point the live
// catalog at a local mock.

const DEFAULT_ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';

/**
 * Validate and normalise an ANILIST_GRAPHQL_URL override.
 * @param {string|undefined} value
 * @returns {string} the endpoint origin (plus path, when one was configured)
 * @throws {Error} on a malformed URL, embedded credentials, or plaintext HTTP
 *   in production, which would send catalog traffic over an insecure hop.
 */
function resolveAnilistGraphqlUrl(value) {
  if (!value) return DEFAULT_ANILIST_GRAPHQL_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ANILIST_GRAPHQL_URL must be a valid http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('ANILIST_GRAPHQL_URL must be an http(s) URL without credentials.');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ANILIST_GRAPHQL_URL must use HTTPS in production.');
  }
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

/**
 * Resolve the endpoint for the current process environment.
 * Deliberately not memoised: routes must observe the same value the server
 * validated, and test harnesses spawn the server with their own override.
 * @returns {string}
 */
function getAniListUrl() {
  return resolveAnilistGraphqlUrl(process.env.ANILIST_GRAPHQL_URL);
}

module.exports = {
  DEFAULT_ANILIST_GRAPHQL_URL,
  resolveAnilistGraphqlUrl,
  getAniListUrl
};

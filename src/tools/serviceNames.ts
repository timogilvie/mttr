/**
 * Shared service-name normalisation for discovery tools. A service name like
 * "data-pipeline-api" is searched both as a whole and as its distinctive
 * tokens, so resources named after any part of the service can be found.
 */
export const GENERIC_SERVICE_TOKENS = new Set([
  'app',
  'application',
  'backend',
  'data',
  'development',
  'pipeline',
  'prod',
  'production',
  'service',
]);

export function serviceSearchTerms(serviceName: string): string[] {
  const normalized = serviceName.toLowerCase();
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !GENERIC_SERVICE_TOKENS.has(token));
  return [...new Set([normalized, ...tokens])];
}

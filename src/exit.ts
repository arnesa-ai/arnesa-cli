/** Exit codes shared by every command (design decision on stable codes). */
export const EXIT = { ok: 0, failure: 1, usage: 2, confirmation: 3, refused: 4, rateLimited: 5 };

/** Error codes of the server that mean "refused by policy" (exit 4). */
const POLICY_CODES = new Set(['NOT_INSTALLABLE', 'PAID_HARNESS', 'CONTENT_CHANGED', 'TOO_LARGE']);

export function exitForApiError(code: string, status: number): number {
  if (code === 'RATE_LIMITED' || status === 429) return EXIT.rateLimited;
  return POLICY_CODES.has(code) ? EXIT.refused : EXIT.failure;
}

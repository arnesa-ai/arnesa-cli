/* eslint-disable no-control-regex */
export const REDACTED = '[redacted]';

const TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/([?&](?:token|code|state|csrfToken|access_token|id_token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, `$1${REDACTED}@`],
  [/([?&]X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  // R0-19: Arnesa keys and device tokens
  [/(?:ak|ad)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, REDACTED],
  [/\barnesa_[A-Za-z0-9_-]+/g, REDACTED],
];

/**
 * Single redaction function that masks credential and secret patterns.
 * Applied to every outgoing string or data structure.
 */
export function redact<T>(value: T): T;
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return TEXT_PATTERNS.reduce((out, [re, to]) => out.replace(re, to), value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown): unknown => redact(v));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redact(v);
  }
  return out;
}

// ANSI escape sequences
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// Bidirectional overrides and isolate formatting characters
const BIDI_PATTERN = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

// Control characters (excluding standard whitespace \t, \n, \r)
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Strips control, ANSI and bidirectional characters.
 * If max is specified and the cleaned text exceeds max, throws an error
 * (per spec: a command too long to show in full SHALL be refused, not shortened).
 */
export function sanitizeForDisplay(text: string, max?: number): string {
  const cleaned = text
    .replace(ANSI_PATTERN, '')
    .replace(BIDI_PATTERN, '')
    .replace(CONTROL_PATTERN, '');

  if (typeof max === 'number' && max > 0 && cleaned.length > max) {
    throw new Error(`Text exceeds display limit of ${max} characters (${cleaned.length} chars)`);
  }
  return cleaned;
}

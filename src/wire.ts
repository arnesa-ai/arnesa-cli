import { z } from 'zod';

/**
 * Every request and response of the Arnesa API this client uses. The CLI owns these schemas (it may
 * not import server code); `test/contract.test.ts` parses real server output with them and the
 * CLI's requests with the server's schemas, so a rename on either side fails a test.
 *
 * Responses are parsed, never trusted: file items are strict (an unknown field or mode is refused),
 * the rest tolerates fields a newer server adds.
 */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Kind = z.string().min(1).max(32);
const Gate = z.strictObject({ id: z.string().min(1), commands: z.array(z.string()).min(1) });
const Base = {
  kind: Kind,
  component: z.string().nullable(),
  path: z.string().min(1).max(240),
  sha256: Sha256,
  gate: Gate.optional(),
};

export const WireItemSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...Base,
    mode: z.literal('create'),
    executable: z.boolean(),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string(),
  }),
  z.strictObject({
    ...Base,
    mode: z.literal('block'),
    blockId: z.string().min(1),
    comment: z.enum(['html', 'hash']),
    text: z.string(),
  }),
  z.strictObject({
    ...Base,
    mode: z.literal('merge-json'),
    key: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
  }),
]);
export type WireItem = z.infer<typeof WireItemSchema>;

export const WireNoticeSchema = z.object({
  kind: Kind,
  component: z.string().nullable(),
  code: z.string().max(64),
  message: z.string().max(500),
});

export const ScanBlockSchema = z.object({
  status: z.enum(['passed', 'warned']),
  contentHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  scannerVersion: z.string().nullable(),
  completedAt: z.string().nullable(),
});

// ── compile ────────────────────────────────────────────────────────────────────────────────────
export const CompileRequestSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  runtime: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  cliVersion: z.string().max(32).optional(),
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

export const CompileResponseSchema = z.object({
  harness: z.object({
    slug: z.string(),
    name: z.string(),
    version: z.string(),
    commit: z.string(),
    contentHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    license: z.string().nullable(),
    sourceUrl: z.string().max(300),
    author: z.string().max(100),
  }),
  scan: ScanBlockSchema,
  runtime: z.string(),
  adapterVersion: z.number().int().min(1),
  verifiedVersion: z.string().nullable(),
  manifestHash: Sha256,
  files: z.array(WireItemSchema),
  notices: z.array(WireNoticeSchema),
});
export type CompileResponse = z.infer<typeof CompileResponseSchema>;

// ── recommend ──────────────────────────────────────────────────────────────────────────────────
/** The request body is built by `profileRequest` (profile + profileHash + cliVersion); it is a JSON string. */
export const RecommendResponseSchema = z.object({
  results: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      summary: z.string().nullable(),
      scanLevel: z.enum(['passed', 'warned']),
      license: z.string().nullable(),
      benchmarked: z.boolean(),
      bench: z
        .object({
          n: z.number(),
          passRate: z.number(),
          wilsonLow: z.number(),
          wilsonHigh: z.number(),
          epoch: z.number(),
          model: z.string(),
        })
        .nullable(),
      matched: z.array(z.string()),
      links: z.object({
        harness: z.string().url(),
        replay: z.string().url().optional(),
        compare: z.string().url().optional(),
      }),
    }),
  ),
  model: z.string().nullable(),
});
export type RecommendResponse = z.infer<typeof RecommendResponseSchema>;

// ── device login (RFC 8628) ─────────────────────────────────────────────────────────────────────
export const DeviceCodeRequestSchema = z.strictObject({
  deviceLabel: z.string().max(80).optional(),
  cliVersion: z.string().max(32).optional(),
});
export const DeviceCodeResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().url(),
  verificationUriComplete: z.string().url(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

export const DeviceTokenRequestSchema = z.strictObject({ deviceCode: z.string().min(1) });
/** `/device/token` answers in the RFC 8628 shape, not in the `{success, data}` envelope. */
export const DeviceTokenResponseSchema = z.object({
  accessToken: z.string().regex(/^ad_[A-Za-z0-9_-]{43}$/),
  tokenType: z.literal('Bearer'),
  expiresIn: z.null(),
});
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

// ── settings and setups ────────────────────────────────────────────────────────────────────────
export const SettingsResponseSchema = z.object({
  metadataSharing: z.boolean(),
  decided: z.boolean().optional(),
  consentVersion: z.number().int(),
  decidedAt: z.string().nullable().optional(),
});
export const SettingsRequestSchema = z.strictObject({
  metadataSharing: z.boolean(),
  consentVersion: z.number().int().optional(),
});

export const SetupPutRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(128),
  harnessSlug: z.string().min(1),
  versionLabel: z.string().min(1),
  runtime: z.string().min(1),
  model: z.string().optional(),
});
export const SetupPutResponseSchema = z.object({
  setup: z.object({ projectId: z.string(), harnessSlug: z.string() }).passthrough(),
  countRecorded: z.boolean(),
});
export const SetupDeleteRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(128),
  harnessSlug: z.string().min(1),
});
export const SetupDeleteResponseSchema = z.object({ removed: z.boolean() });

// ── doctor (files uploaded from the project) ───────────────────────────────────────────────────
export const DoctorUploadRequestSchema = z.strictObject({
  files: z
    .array(z.strictObject({ path: z.string().min(1).max(240), content: z.string() }))
    .min(1)
    .max(200),
});
export const DoctorStartResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  reportUrl: z.string().url(),
});
export const DoctorStatusResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  reason: z.string().nullable(),
  filesScanned: z.number().nullable(),
  counts: z.object({ critical: z.number(), warning: z.number(), info: z.number() }),
  reportUrl: z.string().url(),
});

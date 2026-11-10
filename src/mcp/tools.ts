import { z } from 'zod';
import { ProfileSchema } from '../wire';

export interface ToolHandlerExtra {
  elicit?: (message: string) => Promise<boolean>;
  canElicit?: () => boolean;
  appOrigin?: string;
  [key: string]: unknown;
}

export type ToolHandler<TArgs = any, TResult = any> = (
  args: TArgs,
  extra: ToolHandlerExtra,
) => Promise<TResult>;

export interface McpTool<TArgs = any, TResult = any> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  inputSchema: Record<string, unknown>;
  handler?: ToolHandler<TArgs, TResult>;
}

// ── Input Schemas (strict objects, no confirm or path arguments) ───────────────

export const ProfileProjectInputSchema = z.strictObject({});
export type ProfileProjectInput = z.infer<typeof ProfileProjectInputSchema>;

export const RecommendHarnessesInputSchema = ProfileSchema;
export type RecommendHarnessesInput = z.infer<typeof RecommendHarnessesInputSchema>;

export const InstallHarnessInputSchema = z.strictObject({
  harness: z.string().min(1),
  mode: z.enum(['install', 'try']).optional(),
  item: z.string().optional(),
});
export type InstallHarnessInput = z.infer<typeof InstallHarnessInputSchema>;

export const DoctorScanInputSchema = z.strictObject({});
export type DoctorScanInput = z.infer<typeof DoctorScanInputSchema>;

export const GetRankInputSchema = z.strictObject({
  /** The model whose board is read. Omitted means the default board the Rank page shows. */
  model: z.string().min(1).max(64).optional(),
  /** The display group: every task, or only the coding ones. */
  track: z.enum(['all', 'coding']).optional(),
  /** The task category, when the board is filtered by one. */
  category: z.string().min(1).max(64).optional(),
  harnesses: z.array(z.string().min(1)).max(5).optional(),
});
export type GetRankInput = z.infer<typeof GetRankInputSchema>;

export const OpenOnWebInputSchema = z.strictObject({
  kind: z.enum(['harness', 'model', 'compare', 'rank', 'replay', 'methodology', 'agent']),
  id: z
    .string()
    .max(128)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'id must be an alphanumeric identifier, slug, or UUID without spaces or special characters',
    )
    .optional(),
  locale: z.enum(['en', 'vi']).optional(),
});
export type OpenOnWebInput = z.infer<typeof OpenOnWebInputSchema>;

// ── Web URL helper ─────────────────────────────────────────────────────────────

/**
 * Builds an allow-listed URL for the Arnesa web application.
 * Rejects any host or scheme in input; percent-encodes any id parameter.
 */
export function buildWebUrl(origin: string, input: OpenOnWebInput): string {
  if (!origin) throw new Error('No app origin is configured.');

  if (input.id) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(input.id) ||
      input.id.includes('..') ||
      input.id.toLowerCase().includes('%2e%2e')
    ) {
      throw new Error('Invalid identifier');
    }
  }

  const baseOrigin = origin.replace(/\/+$/, '');
  const encodedId = input.id ? encodeURIComponent(input.id) : '';

  let path = '';
  switch (input.kind) {
    case 'harness':
      path = encodedId ? `/harness/${encodedId}` : '/catalog';
      break;
    case 'model':
      path = encodedId ? `/models/${encodedId}` : '/models';
      break;
    case 'compare':
      path = '/compare';
      break;
    case 'rank':
      path = '/rank';
      break;
    case 'replay':
      path = encodedId ? `/runs/${encodedId}` : '/runs';
      break;
    case 'methodology':
      path = '/methodology';
      break;
    case 'agent':
      path = '/agent';
      break;
    default:
      throw new Error(`Unsupported kind: ${(input as any).kind}`);
  }

  const prefix = input.locale ? `/${input.locale}` : '';
  const fullPath = `${prefix}${path}`;

  const url = new URL(fullPath, baseOrigin);
  const parsedBase = new URL(baseOrigin);
  if (url.origin !== parsedBase.origin) {
    throw new Error('Constructed URL does not match origin');
  }

  return url.toString();
}

// ── Tool Definitions ──────────────────────────────────────────────────────────

export const profileProjectTool: McpTool<ProfileProjectInput> = {
  name: 'profile_project',
  description:
    'Builds local project profile (languages, frameworks, runtimes). No network request.',
  schema: ProfileProjectInputSchema,
  inputSchema: z.toJSONSchema(ProfileProjectInputSchema) as Record<string, unknown>,
};

export const recommendHarnessesTool: McpTool<RecommendHarnessesInput> = {
  name: 'recommend_harnesses',
  description: 'Recommends verified, scanned harnesses matching the project profile.',
  schema: RecommendHarnessesInputSchema,
  inputSchema: z.toJSONSchema(RecommendHarnessesInputSchema) as Record<string, unknown>,
};

export const installHarnessTool: McpTool<InstallHarnessInput> = {
  name: 'install_harness',
  description: 'Installs a harness or previews its skills and rules in try mode.',
  schema: InstallHarnessInputSchema,
  inputSchema: z.toJSONSchema(InstallHarnessInputSchema) as Record<string, unknown>,
};

export const doctorScanTool: McpTool<DoctorScanInput> = {
  name: 'doctor_scan',
  description: 'Uploads agent configuration files from project root to scan for issues.',
  schema: DoctorScanInputSchema,
  inputSchema: z.toJSONSchema(DoctorScanInputSchema) as Record<string, unknown>,
};

export const getRankTool: McpTool<GetRankInput> = {
  name: 'get_rank',
  description: 'Returns verified harness rankings.',
  schema: GetRankInputSchema,
  inputSchema: z.toJSONSchema(GetRankInputSchema) as Record<string, unknown>,
};

export const openOnWebTool: McpTool<OpenOnWebInput, { url: string }> = {
  name: 'open_on_web',
  description: 'Returns an allow-listed URL on the Arnesa web application.',
  schema: OpenOnWebInputSchema,
  inputSchema: z.toJSONSchema(OpenOnWebInputSchema) as Record<string, unknown>,
  handler: (args, extra) => {
    const origin = extra?.appOrigin ?? '';
    return Promise.resolve({ url: buildWebUrl(origin, args) });
  },
};

/** The five tools available over stdio (AC-40.1, D48). */
export const STDIO_TOOLS: readonly McpTool[] = [
  profileProjectTool,
  recommendHarnessesTool,
  installHarnessTool,
  doctorScanTool,
  openOnWebTool,
];

/** The three tools available over HTTP (AC-34.3, D48). */
export const HTTP_TOOLS: readonly McpTool[] = [recommendHarnessesTool, getRankTool, openOnWebTool];

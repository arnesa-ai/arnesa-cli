import { z } from 'zod';
import { EXIT, exitForApiError } from './exit';
import { messages } from './messages';

export const DEFAULT_TIMEOUT_MS = 30_000;
/** A compile answer is at most 1 MiB of files, base64 and JSON framing included. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly code: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RequestOptions<T> {
  body?: unknown;
  token?: string | null;
  /** The RFC 8628 token endpoint answers outside the `{success, data}` envelope. */
  raw?: boolean;
  /** Overrides the client's timeout for this request (a compile can fetch from GitHub). */
  timeoutMs?: number;
  schema: z.ZodType<T>;
}

const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().max(64),
    message: z.string().max(500),
    details: z.unknown().optional(),
  }),
});
const RfcError = z.object({
  error: z.string().max(64),
  error_description: z.string().max(500).optional(),
  interval: z.number().int().positive().optional(),
});
const OkEnvelope = z.object({ data: z.unknown() });

const tooLarge = () => new ApiError(messages.tooLarge, EXIT.failure, 'RESPONSE_TOO_LARGE');

/** Reads at most `max` bytes; the body is never buffered beyond the cap. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpClient(options: HttpOptions) {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new ApiError(messages.badApiUrl, EXIT.usage, 'BAD_API_URL');
  }
  // Plain http only to this machine: a token sent over http to anything else travels in the clear.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new ApiError(messages.badApiUrl, EXIT.usage, 'BAD_API_URL');
  }
  const origin = base.origin;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  return {
    origin,
    /**
     * Every request carries `Origin` equal to the API base: the server's mutating routes refuse any
     * other value and the CLI has no browser to add one. The answer is parsed with `schema`; nothing
     * else from the body is used.
     */
    async request<T>(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      o: RequestOptions<T>,
    ): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        o.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      try {
        const headers: Record<string, string> = { accept: 'application/json', origin };
        if (o.body !== undefined) headers['content-type'] = 'application/json';
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        let res: Response;
        try {
          res = await doFetch(new URL(path, origin).toString(), {
            method,
            headers,
            body: o.body === undefined ? undefined : JSON.stringify(o.body),
            signal: controller.signal,
            redirect: 'error',
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new ApiError(messages.timeout, EXIT.failure, 'TIMEOUT');
          }
          const reason = error instanceof Error ? error.message : 'unknown error';
          throw new ApiError(messages.network(reason), EXIT.failure, 'NETWORK');
        }

        const text = await readCapped(res, options.maxBytes ?? MAX_RESPONSE_BYTES);
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // handled below as a bad response
        }

        if (o.raw) {
          if (!res.ok) {
            const rfc = RfcError.safeParse(json);
            if (!rfc.success) {
              throw new ApiError(messages.httpFailure(res.status), EXIT.failure, 'HTTP_ERROR');
            }
            throw new ApiError(
              rfc.data.error_description ?? rfc.data.error,
              EXIT.failure,
              rfc.data.error,
              { interval: rfc.data.interval ?? null },
            );
          }
          const body = o.schema.safeParse(json);
          if (!body.success) throw new ApiError(messages.badResponse, EXIT.failure, 'BAD_RESPONSE');
          return body.data;
        }

        if (!res.ok) {
          const err = ErrorEnvelope.safeParse(json);
          if (res.status === 429 || (err.success && err.data.error.code === 'RATE_LIMITED')) {
            const retry = Number(res.headers.get('retry-after'));
            throw new ApiError(
              messages.rateLimited(Number.isFinite(retry) && retry > 0 ? retry : null),
              EXIT.rateLimited,
              'RATE_LIMITED',
            );
          }
          if (!err.success) {
            throw new ApiError(messages.httpFailure(res.status), EXIT.failure, 'HTTP_ERROR');
          }
          const { code, message, details } = err.data.error;
          throw new ApiError(message, exitForApiError(code, res.status), code, details ?? null);
        }

        const ok = OkEnvelope.safeParse(json);
        const data = ok.success ? o.schema.safeParse(ok.data.data) : null;
        if (!data?.success) throw new ApiError(messages.badResponse, EXIT.failure, 'BAD_RESPONSE');
        return data.data;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

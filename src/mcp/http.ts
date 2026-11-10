import { createServer, type JsonRpcResponse, type McpServer } from './protocol';
import type { McpTool, ToolHandlerExtra } from './tools';

/**
 * The stateless Streamable HTTP handler of the hosted endpoint (R0-20 task 5.1, design
 * decisions 2 and 8).
 *
 * One POST carries one JSON-RPC message and gets one `application/json` response. The
 * endpoint keeps no state at all: every POST builds a fresh server, so a client may call
 * `tools/list` or `tools/call` without a prior `initialize`, and no `Mcp-Session-Id` is
 * ever issued or read. That is what lets the endpoint run on a serverless instance that
 * has no memory of the previous request.
 *
 * The transport is deliberately narrow, because this endpoint is public:
 *
 * - `POST` only; `GET` and `DELETE` answer 405 with `Allow: POST`.
 * - A batch (a JSON array) is refused, because one POST is one message.
 * - The 64 KB cap is enforced *while reading*: the reader stops the moment the body
 *   crosses the limit and answers 413, so a stream that never ends cannot hold the
 *   function open and a lying `Content-Length` buys nothing.
 * - A notification (no `id`) answers 202 with no body; a request answers 200 with one
 *   JSON-RPC response.
 * - Nothing here reads a cookie, an `Authorization` header or the request body's origin,
 *   and nothing logs a body.
 *
 * The caller supplies the tools, the `onCall` implementation and the origin; this module
 * has no knowledge of the database, the network or the web app.
 */

/** The body cap of the hosted endpoint (spec: 64 KB, enforced on the stream). */
export const MCP_HTTP_BODY_CAP_BYTES = 64 * 1024;

export interface McpHttpOptions {
  /** The tools this transport serves: the three read-only ones on the hosted endpoint. */
  tools: readonly McpTool[];
  /** Runs one tool call. The hosted tools never elicit, so `extra.elicit` is absent. */
  onCall: (
    name: string,
    args: Record<string, unknown>,
    extra: ToolHandlerExtra,
  ) => Promise<unknown>;
  /** The origin `open_on_web` builds its URL from; never a literal in this module. */
  appOrigin: string;
  /** The name and version reported in `initialize`; the web app passes the pinned CLI version. */
  info?: { name: string; version: string };
  /** Called once per answered `tools/call`, after the response is built. Never given a body. */
  onToolCall?: (toolName: string) => void;
}

/** A JSON-RPC error response with the given HTTP status. */
function errorResponse(status: number, code: number, message: string, extraHeaders = {}): Response {
  const body: JsonRpcResponse = { jsonrpc: '2.0', id: null, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/** The 405 answer for a method this endpoint does not serve. */
export function methodNotAllowed(allow = 'POST'): Response {
  return errorResponse(405, -32600, 'Method not allowed: use POST.', { Allow: allow });
}

/** The 413 answer for a body that crossed the cap. */
export function bodyTooLarge(): Response {
  return errorResponse(413, -32600, 'Request body is larger than 64 KB.');
}

/**
 * Reads the request body with a hard byte cap, enforced as the stream arrives.
 *
 * `Content-Length` is not trusted: a chunked body, or a header that understates the real
 * size, must not get past the cap. The reader is cancelled and the function returns as
 * soon as the running total crosses `cap`, so an endless stream is cut off rather than
 * buffered.
 */
export async function readBodyWithCap(
  request: Request,
  cap: number = MCP_HTTP_BODY_CAP_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' }> {
  const body = request.body;
  if (!body) return { ok: true, text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        // Stop reading immediately: the rest of the stream is never pulled.
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/** Whether a parsed message is a notification (a method and no `id`). */
function isNotification(message: unknown): boolean {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const msg = message as Record<string, unknown>;
  return typeof msg.method === 'string' && msg.id === undefined;
}

/** Whether a parsed message is a request or response that expects a JSON-RPC reply. */
function expectsReply(message: unknown): boolean {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const msg = message as Record<string, unknown>;
  // A response to a server-initiated request (elicitation) gets no reply; this endpoint
  // never sends one, so such a message is simply answered with 202.
  if (msg.method === undefined) return false;
  return msg.id !== undefined;
}

/**
 * The handler. `POST` is the only method that does work; `GET` and `DELETE` answer 405.
 */
export async function handleMcpHttp(request: Request, options: McpHttpOptions): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'POST') return methodNotAllowed('POST');

  const read = await readBodyWithCap(request);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? bodyTooLarge()
      : errorResponse(400, -32700, 'The request body could not be read.');
  }

  // Parse here so a batch is refused before a server is built or a tool could run.
  let parsed: unknown;
  try {
    parsed = read.text.trim() === '' ? null : JSON.parse(read.text);
  } catch {
    return errorResponse(400, -32700, 'Parse error');
  }

  if (Array.isArray(parsed)) {
    // One POST is one message: a batch is refused, and no tool runs.
    return errorResponse(400, -32600, 'Invalid Request: batch not supported');
  }
  if (parsed === null || typeof parsed !== 'object') {
    return errorResponse(400, -32600, 'Invalid Request');
  }

  // A fresh server per POST: no session state, no agreed version carried between calls.
  const server: McpServer = createServer({
    tools: options.tools,
    onCall: options.onCall,
    appOrigin: options.appOrigin,
    ...(options.info ? { info: options.info } : {}),
  });

  const response = await server.handle(parsed);

  if (response === null) {
    // A notification (or a stray response) is accepted and answered with no body.
    return new Response(null, {
      status: 202,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  // A hit is counted for an answered tool call, never for a list or an error.
  if (options.onToolCall) {
    const msg = parsed as Record<string, unknown>;
    if (msg.method === 'tools/call' && !response.error) {
      const name = (msg.params as Record<string, unknown> | undefined)?.name;
      if (typeof name === 'string') options.onToolCall(name);
    }
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Re-exported so a caller can tell a notification from a request without importing protocol. */
export { isNotification, expectsReply };

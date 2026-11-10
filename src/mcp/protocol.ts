import { z } from 'zod';
import { redact, sanitizeForDisplay } from './redact';
import type { McpTool, ToolHandlerExtra } from './tools';

/**
 * MCP Protocol versions supported by this server.
 *
 * Current MCP specification pages read on 2026-11-10:
 * - Versioning: https://modelcontextprotocol.io/specification/versioning
 * - Lifecycle (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
 * - Tools (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/server/tools
 * - Elicitation (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
 *
 * Decided: Legacy era only (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05).
 * Modern era (2026-07-28) uses server/discover which is refused with -32601 to trigger
 * dual-era client fallback to initialize (docs/runbooks/arnesa-local.md section 1.4).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

// ── JSON-RPC 2.0 Types ────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ServerOptions {
  tools?: readonly McpTool[];
  info?: ServerInfo;
  onCall?: (
    name: string,
    args: Record<string, unknown>,
    extra: ToolHandlerExtra,
  ) => Promise<unknown>;
  send?: (message: JsonRpcRequest) => void | Promise<void>;
  appOrigin?: string;
}

export interface McpServer {
  handle: (raw: unknown) => Promise<JsonRpcResponse | null>;
  elicit: (message: string) => Promise<boolean>;
  canElicit: () => boolean;
  getProtocolVersion: () => string | null;
  getTools: () => readonly McpTool[];
}

function formatValidationError(error: z.ZodError, schema: z.ZodTypeAny): string {
  const parts: string[] = [];
  const allowedKeys = schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];

  for (const issue of error.issues) {
    const field = issue.path.join('.');
    const prefix = field ? `${field}: ` : '';

    if ('keys' in issue && Array.isArray((issue as { keys: unknown[] }).keys)) {
      const keys = (issue as { keys: unknown[] }).keys.map(String).join(', ');
      parts.push(
        `unrecognized property "${keys}"${allowedKeys.length ? `; allowed: ${allowedKeys.join(', ')}` : ''}`,
      );
    } else if ('values' in issue && Array.isArray((issue as { values: unknown[] }).values)) {
      const vals = (issue as { values: unknown[] }).values.map(String).join(', ');
      parts.push(`${prefix}invalid value, allowed: ${vals}`);
    } else {
      parts.push(
        `${prefix}${issue.message}${allowedKeys.length ? `; allowed: ${allowedKeys.join(', ')}` : ''}`,
      );
    }
  }
  return `Invalid arguments: ${parts.join('; ')}`;
}

/**
 * Creates a pure, transport-free MCP server.
 */
export function createServer(options: ServerOptions = {}): McpServer {
  const tools = options.tools ?? [];
  const info = options.info ?? { name: 'arnesa', version: '0.0.0-dev' };
  let agreedVersion: string | null = null;
  let hasElicitation = false;
  let elicitationCounter = 0;

  const pendingElicitations = new Map<string | number, (yes: boolean) => void>();

  const canElicit = (): boolean => hasElicitation;
  const getProtocolVersion = (): string | null => agreedVersion;
  const getTools = (): readonly McpTool[] => tools;

  const elicit = async (message: string): Promise<boolean> => {
    if (!hasElicitation) {
      return false;
    }

    let cleanMessage: string;
    try {
      cleanMessage = redact(sanitizeForDisplay(message, 4000));
    } catch {
      return false;
    }

    const reqId = ++elicitationCounter;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: reqId,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: cleanMessage,
        requestedSchema: {
          type: 'object',
          properties: {
            accept: {
              type: 'boolean',
              default: false,
            },
          },
          required: ['accept'],
          additionalProperties: false,
        },
      },
    };

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: boolean) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        pendingElicitations.delete(reqId);
        resolve(result);
      };

      timer = setTimeout(() => {
        if (options.send) {
          try {
            void options.send({
              jsonrpc: '2.0',
              method: 'notifications/cancelled',
              params: {
                requestId: reqId,
                reason: 'timeout',
              },
            });
          } catch {
            // ignore send error on timeout cancellation
          }
        }
        finish(false);
      }, 120_000);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      pendingElicitations.set(reqId, finish);

      if (options.send) {
        try {
          void options.send(request);
        } catch {
          finish(false);
        }
      }
    });
  };

  const handle = async (raw: unknown): Promise<JsonRpcResponse | null> => {
    let msg: any = raw;
    try {
      if (typeof raw === 'string') {
        try {
          msg = JSON.parse(raw);
        } catch {
          return redact({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          });
        }
      }

      // Refuse JSON-RPC batches
      if (Array.isArray(msg)) {
        return redact({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request: batch not supported' },
        });
      }

      if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return redact({
          jsonrpc: '2.0',
          id: msg?.id ?? null,
          error: { code: -32600, message: 'Invalid Request' },
        });
      }

      // Check if this is a response from the client (e.g. to elicitation/create)
      if (msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const id = msg.id;
        if (id !== undefined && id !== null && pendingElicitations.has(id)) {
          const resolver = pendingElicitations.get(id)!;
          if (msg.error) {
            resolver(false);
          } else if (msg.result && typeof msg.result === 'object') {
            const res = msg.result as Record<string, unknown>;
            const content = res.content as Record<string, unknown> | undefined;
            if (
              res.action === 'accept' &&
              content &&
              typeof content === 'object' &&
              content.accept === true &&
              Object.keys(content).length === 1
            ) {
              resolver(true);
            } else {
              resolver(false);
            }
          } else {
            resolver(false);
          }
        }
        // Responses receive no JSON-RPC reply (and unknown/wrong ids are ignored)
        return null;
      }

      if (typeof msg.method !== 'string') {
        return redact({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32600, message: 'Invalid Request: method is required' },
        });
      }

      const id = msg.id ?? null;
      const method = msg.method;
      const params = msg.params as Record<string, unknown> | undefined;

      // Handle notifications/initialized: notification has no response
      if (method === 'notifications/initialized') {
        return null;
      }

      // Handle initialize
      if (method === 'initialize') {
        const requestedVersion =
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
        const isSupported = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
          requestedVersion,
        );
        agreedVersion = isSupported ? requestedVersion : DEFAULT_PROTOCOL_VERSION;

        // Record whether client declared elicitation AND client version is 2025-06-18 or newer
        const declaredElicitation = Boolean(
          params?.capabilities &&
            typeof params.capabilities === 'object' &&
            (params.capabilities as Record<string, unknown>).elicitation,
        );
        const versionEligible = isSupported
          ? requestedVersion >= '2025-06-18'
          : agreedVersion >= '2025-06-18';
        hasElicitation = declaredElicitation && versionEligible;

        return redact({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: agreedVersion,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: info.name,
              version: info.version,
            },
          },
        });
      }

      // Handle ping
      if (method === 'ping') {
        return redact({
          jsonrpc: '2.0',
          id,
          result: {},
        });
      }

      // Handle tools/list
      if (method === 'tools/list') {
        return redact({
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });
      }

      // Handle tools/call
      if (method === 'tools/call') {
        const toolName = typeof params?.name === 'string' ? params.name : '';
        const tool = tools.find((t) => t.name === toolName);

        if (!tool) {
          return redact({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${toolName}`,
            },
          });
        }

        const rawArgs = (
          params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
        ) as Record<string, unknown>;

        const validation = tool.schema.safeParse(rawArgs);
        if (!validation.success) {
          return redact({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: formatValidationError(validation.error, tool.schema),
                },
              ],
              isError: true,
            },
          });
        }

        const extra: ToolHandlerExtra = {
          elicit: (m: string) => (server ? server.elicit(m) : elicit(m)),
          canElicit: () => (server ? server.canElicit() : canElicit()),
          appOrigin: options.appOrigin,
        };

        let result: unknown;
        if (options.onCall) {
          result = await options.onCall(
            tool.name,
            validation.data as Record<string, unknown>,
            extra,
          );
        } else if (tool.handler) {
          result = await tool.handler(validation.data, extra);
        } else {
          result = { content: [{ type: 'text', text: `Tool ${tool.name} executed` }] };
        }

        const content =
          result && typeof result === 'object' && Array.isArray((result as any).content)
            ? (result as any).content
            : [
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result),
                },
              ];

        const isError = Boolean(result && typeof result === 'object' && (result as any).isError);

        return redact({
          jsonrpc: '2.0',
          id,
          result: {
            content,
            ...(isError ? { isError: true } : {}),
          },
        });
      }

      // A notification (no id) never gets a reply, known or not (JSON-RPC 2.0 section 4.1).
      if (msg.id === undefined) {
        return null;
      }

      // Unknown method, including server/discover
      return redact({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    } catch (err) {
      // Never throw out of handle
      const message = err instanceof Error ? err.message : 'Internal error';
      const requestId =
        msg && typeof msg === 'object' && 'id' in msg && msg.id !== undefined ? msg.id : null;
      return redact({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32603,
          message,
        },
      });
    }
  };

  const server: McpServer = {
    handle,
    elicit,
    canElicit,
    getProtocolVersion,
    getTools,
  };
  return server;
}

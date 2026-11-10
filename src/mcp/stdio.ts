import { EXIT } from '../exit';
import { messages } from '../messages';
import { canonicalJson, detectProfile, profileRequest } from '../profile';
import type { Ctx } from '../types';
import { credential } from '../commands/auth';
import type { Profile } from '../wire';
import { RecommendResponseSchema } from '../wire';
import { createServer, type JsonRpcResponse } from './protocol';
import { redact } from './redact';
import {
  buildWebUrl,
  STDIO_TOOLS,
  type OpenOnWebInput,
  type ToolHandlerExtra,
  type InstallHarnessInput,
} from './tools';
import { handleInstallMode } from './install';
import { handleTryMode } from './try';
import { handleDoctorScan } from './doctor';
import {
  PROJECT_MARKERS,
  isHomeDir,
  isDriveOrFsRoot,
  hasProjectMarker,
  validateProjectRoot,
  type ProjectRootResult,
  type RootRefusalReason,
} from './project-root';

export {
  PROJECT_MARKERS,
  isHomeDir,
  isDriveOrFsRoot,
  hasProjectMarker,
  validateProjectRoot,
  type ProjectRootResult,
  type RootRefusalReason,
};

export interface StdioStreams {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: (line: string) => void;
}

const MAX_LINE_BYTES = 1024 * 1024; // 1 MB

/** Maximum output characters for recommend_harnesses response. */
const MAX_RECOMMEND_OUTPUT_CHARS = 4000;

/**
 * `arnesa mcp`: Starts an MCP server on standard input and output over stdio.
 */
export async function runMcp(
  _args: readonly string[],
  ctx: Ctx,
  streams?: StdioStreams,
): Promise<number> {
  const cwd = ctx.io.cwd || process.cwd();
  const rootCheck = validateProjectRoot(cwd, ctx.io.env);

  if (!rootCheck.valid) {
    const refusalMsg = redact(rootCheck.message ?? 'Refused: not inside a project.');
    if (streams?.stderr) {
      streams.stderr(refusalMsg);
    } else {
      ctx.io.err(refusalMsg);
    }
    return EXIT.usage;
  }

  const projectRoot = rootCheck.root;

  const stdin = streams?.stdin ?? process.stdin;
  const stdout = streams?.stdout ?? process.stdout;

  const writeStdout = (msg: string) => {
    stdout.write(`${msg}\n`);
  };

  const logErr = (line: string) => {
    const redacted = redact(line);
    if (streams?.stderr) {
      streams.stderr(redacted);
    } else {
      ctx.io.err(redacted);
    }
  };

  const getAppOrigin = (): string => {
    const origin = ctx.client().origin;
    if (!origin) throw new Error(messages.apiMissing);
    return origin;
  };

  const handleProfileProject = () => {
    try {
      const profile = detectProfile(projectRoot, {
        runtime: ctx.options.runtime,
        model: ctx.options.model ?? ctx.io.env.ARNESA_MODEL ?? null,
      });
      return {
        content: [
          {
            type: 'text',
            text: canonicalJson(profile),
          },
          {
            type: 'text',
            text: 'This profile is what recommend_harnesses sends.',
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redact(message);
      logErr(redacted);
      return {
        content: [{ type: 'text', text: redacted }],
        isError: true,
      };
    }
  };

  const handleRecommendHarnesses = async (
    args: Record<string, unknown>,
    extra: ToolHandlerExtra,
  ) => {
    try {
      let profile: Profile;
      if (args && typeof args === 'object' && 'version' in args) {
        profile = args as Profile;
      } else {
        profile = detectProfile(projectRoot, {
          runtime: ctx.options.runtime,
          model: ctx.options.model ?? ctx.io.env.ARNESA_MODEL ?? null,
        });
      }

      const reqBody = profileRequest(profile, ctx.io.version);

      let client;
      try {
        client = ctx.client();
      } catch (clientError) {
        const message = clientError instanceof Error ? clientError.message : String(clientError);
        const redacted = redact(message);
        logErr(redacted);
        return {
          content: [{ type: 'text', text: redacted }],
          isError: true,
        };
      }

      let token: string | null = null;
      try {
        token = await credential(ctx);
      } catch {
        // Continue without stored token
      }

      const data = await client.request('POST', '/api/v1/local/recommend', {
        token: token ?? undefined,
        body: JSON.parse(reqBody),
        schema: RecommendResponseSchema,
      });

      const targetOrigin = extra?.appOrigin ?? client.origin ?? getAppOrigin();

      if (data.results.length === 0) {
        return {
          content: [{ type: 'text', text: messages.noResults }],
        };
      }

      const formattedItems: string[] = [];
      let currentLength = 0;

      for (const r of data.results) {
        const lines: string[] = [`${r.name} (${r.slug})`];
        if (r.summary) {
          lines.push(`  ${r.summary}`);
        }
        lines.push(
          `  scan: ${r.scanLevel}  licence: ${r.license ?? 'none declared'}`,
          r.bench
            ? `  ${messages.benchmarked(
                r.bench.model,
                r.bench.passRate,
                r.bench.wilsonLow,
                r.bench.wilsonHigh,
                r.bench.n,
                r.bench.epoch,
              )}`
            : `  ${messages.notBenchmarked}`,
          `  ${buildWebUrl(targetOrigin, { kind: 'harness', id: r.slug })}`,
        );
        if (r.links.replay) lines.push(`  replay:  ${r.links.replay}`);
        if (r.links.compare) lines.push(`  compare: ${r.links.compare}`);
        lines.push(`  install: arnesa install ${r.slug}`);

        const itemText = lines.join('\n');
        const addedLength = formattedItems.length === 0 ? itemText.length : itemText.length + 2;

        if (currentLength + addedLength <= MAX_RECOMMEND_OUTPUT_CHARS) {
          formattedItems.push(itemText);
          currentLength += addedLength;
        } else {
          break;
        }
      }

      const resultText = formattedItems.join('\n\n');
      return {
        content: [{ type: 'text', text: redact(resultText) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redact(message);
      logErr(redacted);
      return {
        content: [{ type: 'text', text: redacted }],
        isError: true,
      };
    }
  };

  const handleOpenOnWeb = (args: OpenOnWebInput, extra: ToolHandlerExtra) => {
    try {
      const targetOrigin = extra?.appOrigin ?? getAppOrigin();
      const url = buildWebUrl(targetOrigin, args);
      return {
        content: [{ type: 'text', text: redact(url) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redact(message);
      logErr(redacted);
      return {
        content: [{ type: 'text', text: redacted }],
        isError: true,
      };
    }
  };

  const handleInstallHarness = async (
    callArgs: Record<string, unknown>,
    extra: ToolHandlerExtra,
  ) => {
    try {
      const mode = (callArgs.mode as string | undefined) ?? 'install';
      if (mode === 'try') {
        return await handleTryMode(
          callArgs as unknown as InstallHarnessInput,
          ctx,
          extra,
          projectRoot,
        );
      }
      return await handleInstallMode(
        callArgs as unknown as InstallHarnessInput,
        ctx,
        extra,
        projectRoot,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redact(message);
      logErr(redacted);
      return {
        content: [{ type: 'text', text: redacted }],
        isError: true,
      };
    }
  };

  const server = createServer({
    info: { name: 'arnesa', version: ctx.io.version },
    tools: STDIO_TOOLS,
    send: (message) => {
      writeStdout(JSON.stringify(redact(message)));
    },
    onCall: async (name, callArgs, extra) => {
      try {
        switch (name) {
          case 'profile_project':
            return handleProfileProject();
          case 'recommend_harnesses':
            return await handleRecommendHarnesses(callArgs, extra);
          case 'open_on_web':
            return handleOpenOnWeb(callArgs as OpenOnWebInput, extra);
          case 'install_harness':
            return await handleInstallHarness(callArgs, extra);
          case 'doctor_scan':
            return await handleDoctorScan(ctx, extra, projectRoot);
          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const oneLine = message.split(/\r?\n/)[0] ?? message;
        const redacted = redact(oneLine);
        logErr(redacted);
        return {
          content: [{ type: 'text', text: redacted }],
          isError: true,
        };
      }
    },
  });

  let buffer = '';
  let discardUntilNewline = false;
  const pendingHandles = new Set<Promise<void>>();

  const handleLineTooLarge = () => {
    const reply: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid Request: line exceeds 1 MB limit',
      },
    };
    writeStdout(JSON.stringify(redact(reply)));
  };

  const processLine = (line: string) => {
    const p = (async () => {
      try {
        const response = await server.handle(line);
        if (response !== null) {
          writeStdout(JSON.stringify(response));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeStdout(
          JSON.stringify(
            redact({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: msg },
            }),
          ),
        );
      }
    })();
    pendingHandles.add(p);
    void p.finally(() => pendingHandles.delete(p));
  };

  const onData = (chunk: Buffer | string) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    buffer += str;

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (discardUntilNewline) {
        discardUntilNewline = false;
        handleLineTooLarge();
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        handleLineTooLarge();
        continue;
      }
      if (line.trim().length > 0) {
        processLine(line);
      }
    }

    if (buffer.length > MAX_LINE_BYTES) {
      discardUntilNewline = true;
      buffer = '';
      handleLineTooLarge();
    }
  };

  return new Promise<number>((resolvePromise) => {
    let resolved = false;
    const finish = async () => {
      if (resolved) return;
      resolved = true;
      if (buffer.trim().length > 0 && !discardUntilNewline) {
        let line = buffer;
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          handleLineTooLarge();
        } else if (line.trim().length > 0) {
          processLine(line);
        }
      }
      await Promise.all(Array.from(pendingHandles));
      resolvePromise(EXIT.ok);
    };

    stdin.on('data', onData);
    stdin.on('end', () => {
      void finish();
    });
    stdin.on('close', () => {
      void finish();
    });
    if ('resume' in stdin && typeof (stdin as any).resume === 'function') {
      (stdin as any).resume();
    }
  });
}

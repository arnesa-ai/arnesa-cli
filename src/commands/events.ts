import { z } from 'zod';
import { messages } from '../messages';
import type { Ctx } from '../types';
import { SettingsResponseSchema, SetupDeleteResponseSchema, SetupPutResponseSchema } from '../wire';

/**
 * Tells the account that a harness was installed or removed, so `/me/setups` can list it. Sent only
 * for a signed-in device (an anonymous run has nothing to record and nothing to consent to) and
 * only while metadata sharing is on. It never fails the command: a problem here is one line on
 * standard error.
 */
export async function reportSetup(
  ctx: Ctx,
  event:
    | {
        kind: 'install';
        projectId: string;
        harnessSlug: string;
        versionLabel: string;
        runtime: string;
      }
    | { kind: 'remove'; projectId: string; harnessSlug: string },
): Promise<void> {
  try {
    // A key cannot write setups (the route takes a device token or a session), so an environment
    // key means "no event", exactly like being signed out.
    if (ctx.io.env.ARNESA_API_KEY?.trim()) return;
    const token = (await ctx.keychain()).get();
    if (!token) return;

    const http = ctx.client();
    const settings = await http.request('GET', '/api/v1/local/settings', {
      token,
      schema: SettingsResponseSchema,
    });
    if (!settings.metadataSharing) return;

    if (event.kind === 'install') {
      const { kind: _kind, ...fields } = event;
      const model = ctx.options.model ?? ctx.io.env.ARNESA_MODEL;
      await http.request('PUT', '/api/v1/local/setups', {
        token,
        body: { ...fields, ...(model ? { model } : {}) },
        schema: SetupPutResponseSchema,
      });
    } else {
      await http.request('DELETE', '/api/v1/local/setups', {
        token,
        body: { projectId: event.projectId, harnessSlug: event.harnessSlug },
        schema: SetupDeleteResponseSchema,
      });
    }
  } catch (error) {
    // A setup that was never recorded (404 on remove) is not worth a warning.
    const code = z.object({ code: z.string() }).safeParse(error);
    if (!(code.success && code.data.code === 'NOT_FOUND')) ctx.io.err(messages.eventFailed);
  }
}

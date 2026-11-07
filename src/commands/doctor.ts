import { DOCTOR_CAPS, selectDoctorFiles } from '../doctor/files';
import { EXIT } from '../exit';
import { ApiError } from '../http';
import { messages } from '../messages';
import { confirm } from '../prompt';
import type { Ctx } from '../types';
import { DoctorStartResponseSchema, DoctorStatusResponseSchema } from '../wire';

const POLL_MS = 3000;
const MAX_POLLS = 100;
const RUNNING = new Set(['queued', 'fetching', 'scanning']);

/**
 * `arnesa doctor`: lists the agent configuration files it would send, uploads them only after a
 * yes, then waits for the scan and prints the counts and the link to the private report. It needs
 * a signed-in device (`arnesa login`); an API key does not open Doctor.
 */
export async function runDoctor(_args: readonly string[], ctx: Ctx): Promise<number> {
  const { io } = ctx;
  const selection = selectDoctorFiles(io.cwd);
  const { files, bytes, skipped } = selection;

  if (files.length === 0) {
    ctx.emit({ uploaded: false, reason: 'no files' }, [messages.doctorNoFiles]);
    return EXIT.ok;
  }
  if (files.length > DOCTOR_CAPS.maxFiles || bytes > DOCTOR_CAPS.maxTotalBytes) {
    throw new ApiError(messages.doctorTooBig(files.length, bytes), EXIT.failure, 'TOO_LARGE');
  }

  io.err(messages.doctorIntro(files.length, bytes));
  for (const f of files) io.err(`  ${f.path}`);
  for (const s of skipped) io.err(`  skipped ${s.path}: ${s.reason}`);

  if (!ctx.yes) {
    const answer = await confirm(messages.doctorQuestion, io.isTty);
    if (answer === null) {
      throw new ApiError(messages.confirmationRequired, EXIT.confirmation, 'CONFIRMATION_REQUIRED');
    }
    if (!answer) throw new ApiError(messages.notConfirmed, EXIT.confirmation, 'NOT_CONFIRMED');
  }

  // Only a device token opens Doctor; the environment key is deliberately not used here.
  const token = (await ctx.keychain()).get();
  if (!token) throw new ApiError(messages.doctorLogin, EXIT.failure, 'UNAUTHENTICATED');

  const http = ctx.client();
  const started = await http.request('POST', '/api/v1/local/doctor', {
    token,
    body: { files },
    schema: DoctorStartResponseSchema,
  });
  io.err(messages.doctorQueued(started.reportUrl));

  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    const status = await http.request(
      'GET',
      `/api/v1/local/doctor/${encodeURIComponent(started.id)}`,
      { token, schema: DoctorStatusResponseSchema },
    );
    if (RUNNING.has(status.status)) continue;
    ctx.emit({ uploaded: true, ...status }, [
      messages.doctorDone(
        status.status,
        status.counts.critical,
        status.counts.warning,
        status.counts.info,
      ),
      status.reportUrl,
    ]);
    return EXIT.ok;
  }
  throw new ApiError(messages.doctorStillRunning(started.reportUrl), EXIT.failure, 'TIMEOUT');
}

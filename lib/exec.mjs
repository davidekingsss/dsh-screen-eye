/**
 * Bounded child-process execution.
 *
 * Every capture shells out to a system binary, so one helper owns spawning,
 * output capture, cancellation and timeouts. A cancelled call must actually
 * kill its child: an interactive `screencapture` left running would keep a
 * crosshair on the user's screen after the tool call is gone.
 * @module dsh-screen-eye/exec
 */

import { spawn } from 'node:child_process';

/**
 * Run one command to completion.
 * @param command - absolute path of the executable.
 * @param args - argument vector, passed without a shell.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the exit code plus decoded stdout/stderr; `code` is null when the
 *   process was killed by a signal.
 */
export function run(command, args, options = {}) {
  const { signal, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      fail(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error(`${command} exceeded its ${timeoutMs}ms budget`));
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** The error a cancelled call settles with, matching the platform convention. */
function abortError() {
  const error = new Error('the operation was aborted');
  error.name = 'AbortError';
  return error;
}

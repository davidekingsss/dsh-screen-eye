/**
 * The macOS resident capture engine, and the build step it needs.
 *
 * `darwin.mjs` captures through `/usr/sbin/screencapture`, which is the engine of
 * record: it is part of macOS, it has no build step, and calling it cannot
 * invalidate anything. What it cannot do is start quickly. Measured on a 4K
 * panel, one call costs about 45ms of process start plus the encoding, so a
 * change check costs 56-90ms and a burst cannot take its first frame until
 * 150-200ms into an animation — two thirds of a 300ms transition gone before the
 * picture is looked at.
 *
 * So there is a second engine, and it is an optimisation with a lifecycle rather
 * than a replacement. `engine.swift` is compiled once into a cache directory,
 * started once, kept resident while it is being used, and dropped when it is not.
 * Every failure path in this file ends the same way — with the caller falling
 * back to `screencapture` — so the worst case is the speed the plugin had before
 * the engine existed, never a capture that does not happen.
 *
 * ## Why the source is compiled here rather than shipped as a binary
 *
 * Apple provides no interpreter for ScreenCaptureKit: `CGDisplayCreateImage` is
 * obsoleted in macOS 15, so the framework is the only supported way to read the
 * screen, and it can only be reached from a compiled program. The alternatives
 * were a prebuilt binary in the repository — which pins the plugin to the SDK it
 * was built against, on a platform whose capture API has already been obsoleted
 * once — or compiling from source on the machine that will run it.
 *
 * Compiling is the honest option, and it is cheap: a second or two, once, on the
 * first capture. It happens *after* the first capture has already been served by
 * `screencapture`, in the background, so no call ever waits for it. A machine
 * without the developer tools simply never gets a helper and keeps using
 * `screencapture`, which is why the fallback is not an error path but the
 * baseline.
 *
 * ## What it does not do
 *
 * The helper knows how to read a rectangle and how to fingerprint one. It does
 * not know about modes, flags, validation, retention or when a burst should
 * stop; all of that stays in the JavaScript, so there is exactly one place each
 * of those lives and the two engines cannot drift apart in what they mean.
 *
 * @module dsh-screen-eye/platform/darwin/engine
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CaptureError } from '../../capture-error.mjs';

/**
 * The helper's source, as a filesystem path.
 *
 * `fileURLToPath` rather than `URL.pathname`: the latter leaves the URL's
 * percent-encoding in place, so a checkout in a directory with a space in its
 * name — which is where this was developed — handed `swiftc` a path containing
 * `%20` and it reported the file missing. The failure is invisible on a checkout
 * with no spaces in its path, which is exactly the kind of bug that reaches a
 * user before it reaches a test.
 */
const ENGINE_SOURCE_PATH = fileURLToPath(new URL('./engine.swift', import.meta.url));

/** The `kind` a failure carries when the engine could not run at all. */
export const ENGINE_UNAVAILABLE = 'engine-unavailable';

/** How long an idle engine is kept before it is let go. */
const ENGINE_IDLE_MS = 120000;

/** How long to wait for a freshly started engine to announce itself. */
const ENGINE_START_TIMEOUT_MS = 20000;

/** How long to wait for a reply before deciding the engine has wedged. */
const ENGINE_REQUEST_TIMEOUT_MS = 120000;

/** How long the compile is given before it is abandoned as too slow. */
const COMPILE_TIMEOUT_MS = 120000;

/** The compiled helper's own source, read once. */
let sourceCache = null;

/**
 * The helper's Swift source.
 * @returns the source text.
 */
export async function engineSource() {
  sourceCache ??= await readFile(new URL('./engine.swift', import.meta.url), 'utf8');
  return sourceCache;
}

/**
 * Where the compiled helper for a given source lives.
 *
 * The name carries a hash of the source, so a changed helper is a different file
 * rather than one that overwrites a binary another process may be running — and
 * so a stale build can never be mistaken for a current one.
 * @param source - the Swift source it will be built from.
 * @returns the absolute path.
 */
export function engineBinaryPath(source) {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return join(tmpdir(), 'dsh-screen-eye-engine', `engine-${digest}`);
}

/**
 * The compiler, or `null` where there is none.
 *
 * `xcrun` is preferred over a bare `swiftc` because it resolves the toolchain
 * the active developer directory selects, which is what a machine with more than
 * one Xcode installed expects. A Command Line Tools install satisfies it too,
 * which matters: the full Xcode is not needed to build this.
 * @returns the command to run, or `null`.
 */
export function compilerCommand() {
  for (const candidate of ['/usr/bin/xcrun', '/usr/bin/swiftc']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the helper if it is not already built.
 *
 * Returns `null` rather than throwing when the helper cannot be built, because
 * every caller treats that as "use `screencapture`" and none of them has
 * anything better to do about it. The reason is kept for `screen_permission`,
 * which is where a user would look.
 *
 * @returns the binary's path, or `null`.
 */
export async function buildEngine() {
  const source = await engineSource();
  const binary = engineBinaryPath(source);
  if (existsSync(binary)) return binary;

  const compiler = compilerCommand();
  if (compiler === null) return null;

  await mkdir(dirname(binary), { recursive: true });
  // Compiled to a temporary name and moved into place, so two processes racing
  // to build the same helper cannot leave a half-written binary where a working
  // one belongs. `rename` within a directory is atomic, which is the whole point.
  const staging = `${binary}.${process.pid}.building`;
  const args = compiler.endsWith('xcrun')
    ? ['swiftc', '-O', '-o', staging, ENGINE_SOURCE_PATH]
    : ['-O', '-o', staging, ENGINE_SOURCE_PATH];

  await new Promise((resolve, reject) => {
    const child = spawn(compiler, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`the helper did not compile within ${COMPILE_TIMEOUT_MS}ms`));
    }, COMPILE_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().slice(0, 500) || `swiftc exited with code ${code}`));
    });
  });

  const { rename } = await import('node:fs/promises');
  await rename(staging, binary);
  return binary;
}

/** The engine record for the process, or `null` when none is running. */
let engine = null;

/**
 * Start the engine, or return the one already running.
 *
 * Concurrent callers share one start, and a failed start is not cached: the
 * reason for a failure is usually a moment rather than a condition, and giving
 * up permanently would turn one bad start into a plugin that never uses the
 * helper again for the life of the process.
 *
 * @returns the engine record once it has announced its readiness.
 */
function ensureEngine() {
  if (engine !== null && engine.ready && engine.child.exitCode === null && !engine.child.killed) {
    return Promise.resolve(engine);
  }
  if (engine?.starting !== undefined) return engine.starting;
  const record = { child: null, pending: new Map(), buffer: '', nextId: 1, idleTimer: null, ready: false, starting: null, info: null, stderr: '' };
  engine = record;
  record.starting = (async () => {
    const binary = await buildEngine();
    if (binary === null) {
      throw new CaptureError('the macOS capture helper could not be built: no Swift compiler on this machine', {
        kind: ENGINE_UNAVAILABLE,
      });
    }
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    record.child = child;
    // Unreferenced, all three streams. A resident process that held the event
    // loop open would keep the *harness* alive, and a harness that will not exit
    // is a worse bug than a slow capture. Letting go costs nothing: when this
    // process ends the engine's stdin closes and it exits by itself, which is
    // the shutdown protocol it was written with.
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
    child.stdout.on('data', (chunk) => { consumeEngineOutput(record, chunk); });
    child.stderr.on('data', (chunk) => { record.stderr += chunk; });
    child.on('exit', (code) => {
      const error = new CaptureError(`the macOS engine exited with code ${code}`, {
        kind: ENGINE_UNAVAILABLE,
        detail: record.stderr.trim().slice(0, 500),
      });
      for (const waiter of record.pending.values()) waiter.reject(error);
      record.pending.clear();
      record.ready = false;
      if (engine === record) engine = null;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CaptureError(`the macOS engine did not start within ${ENGINE_START_TIMEOUT_MS}ms`, { kind: ENGINE_UNAVAILABLE, detail: record.stderr.trim().slice(0, 500) })), ENGINE_START_TIMEOUT_MS);
      record.onReady = () => { clearTimeout(timer); resolve(); };
      record.onFailed = (error) => { clearTimeout(timer); reject(error); };
    });
    return record;
  })().catch((error) => {
    if (engine === record) engine = null;
    try { record.child?.kill(); } catch { /* already gone */ }
    throw error;
  });
  return record.starting;
}

/**
 * Take one line of engine output: the readiness announcement, or a reply.
 * @param record - the engine record.
 * @param chunk - bytes from the engine's stdout.
 */
function consumeEngineOutput(record, chunk) {
  record.buffer += chunk;
  let index;
  while ((index = record.buffer.indexOf('\n')) >= 0) {
    const line = record.buffer.slice(0, index).trim();
    record.buffer = record.buffer.slice(index + 1);
    if (line === '') continue;
    let payload;
    try { payload = JSON.parse(line); } catch { continue; }
    if (payload.ready === true) {
      record.ready = true;
      record.info = payload;
      record.onReady?.();
      continue;
    }
    if (payload.ok === false && payload.id === undefined) {
      // The engine saying it could not set itself up. Nothing is waiting on a
      // reply yet, so this has to reach the start's own promise.
      record.onFailed?.(new CaptureError(payload.detail ?? 'the macOS engine could not start', {
        kind: payload.kind ?? ENGINE_UNAVAILABLE,
        detail: payload.detail ?? '',
      }));
      continue;
    }
    const waiter = record.pending.get(payload.id);
    if (waiter === undefined) continue;
    record.pending.delete(payload.id);
    clearTimeout(waiter.timer);
    waiter.resolve(payload);
  }
}

/**
 * Send one request to the engine and wait for its reply.
 * @param request - the request body; an id is added here.
 * @param options - cancellation signal and budget.
 * @returns the decoded reply.
 */
async function engineRequest(request, options = {}) {
  const record = await ensureEngine();
  const id = record.nextId;
  record.nextId += 1;
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      record.pending.delete(id);
      options.signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => settle(reject, new CaptureError('the engine request was aborted', { kind: 'capture-failed' }));
    if (options.signal?.aborted === true) { onAbort(); return; }
    const timer = setTimeout(() => {
      settle(reject, new CaptureError(`the macOS engine did not answer request ${id} within ${ENGINE_REQUEST_TIMEOUT_MS}ms`, { kind: ENGINE_UNAVAILABLE }));
    }, options.timeoutMs ?? ENGINE_REQUEST_TIMEOUT_MS);
    record.pending.set(id, { resolve: (payload) => settle(resolve, payload), reject: (error) => settle(reject, error), timer });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    record.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    scheduleEngineIdle(record);
  });
}

/**
 * Keep the engine for a while after its last request, then let it go.
 * @param record - the engine record.
 */
function scheduleEngineIdle(record) {
  clearTimeout(record.idleTimer);
  record.idleTimer = setTimeout(() => { if (engine === record) stopEngine(); }, ENGINE_IDLE_MS);
  record.idleTimer.unref?.();
}

/**
 * Whether a resident engine is answering right now.
 *
 * The distinction the callers need is "warm or not", never "does this platform
 * have an engine": a cold engine must not delay a capture, and asking the
 * question must not start one.
 * @returns whether the engine is ready.
 */
export function engineIsWarm() {
  return engine !== null && engine.ready && engine.child.exitCode === null && !engine.child.killed;
}

/**
 * Start the engine without waiting for it, for the call after this one.
 *
 * This is what makes the compile invisible. The first capture is served by
 * `screencapture` — already running, no worse than the plugin has ever been —
 * and the helper is built and started behind it, so the second capture has an
 * engine. A build that fails is recorded and never retried in a way that could
 * cost a call anything.
 */
export function warmEngine() {
  if (engineIsWarm()) return;
  ensureEngine().catch(() => { /* the fallback is the plan, not a failure */ });
}

/**
 * Shut the engine down, waiting briefly for it to leave of its own accord.
 */
export function stopEngine() {
  const record = engine;
  if (record === null) return;
  engine = null;
  clearTimeout(record.idleTimer);
  const error = new CaptureError('the macOS engine was shut down', { kind: ENGINE_UNAVAILABLE });
  for (const waiter of record.pending.values()) waiter.reject(error);
  record.pending.clear();
  // A record exists as soon as a start begins, and a start that never got as far
  // as spawning — a build that failed, or is still running — has no child. That
  // is the state a shutdown during the first capture finds, so it has to be a
  // case rather than a crash.
  if (record.child === null) return;
  try { record.child.stdin.end(); } catch { /* already closed */ }
  const killer = setTimeout(() => { try { record.child.kill(); } catch { /* already gone */ } }, 1000);
  killer.unref?.();
  record.child.once('exit', () => clearTimeout(killer));
}

// A harness that exits takes its engine with it; the engine would also notice on
// its own, because its stdin closes, but this makes it immediate.
process.once('exit', () => {
  try { engine?.child?.kill(); } catch { /* nothing to kill */ }
});

/**
 * Ask the running engine to capture one frame.
 *
 * The rectangle arrives already resolved, as the fields the engine's protocol
 * takes. It is deliberately not resolved here from a plan: the mapping from a
 * plan onto a screen rectangle is the one thing both engines must agree on, so
 * it lives in exactly one function — `engineTarget` in `darwin.mjs` — and is
 * asserted there. Resolving it a second time in this file is how the two would
 * come to disagree, which is the failure this tool can least afford: a plausible
 * picture of the wrong place. An earlier revision did resolve it here, from
 * `plan.origin` and `plan.size`, which a capture plan does not have — every
 * field read `undefined`, every capture took the whole screen, and a region
 * silently returned a 4K image of the entire desktop.
 *
 * @param target - the resolved `{ display, x, y, width, height, cursor }`.
 * @param outputPath - the resolved absolute output path.
 * @param options - cancellation signal and budget.
 * @returns the written PNG's path and byte length.
 * @throws a `CaptureError` when the engine could not answer.
 */
export async function engineCapture(target, outputPath, options = {}) {
  const reply = await engineRequest({ ...target, op: 'capture', path: outputPath }, options);
  if (reply.ok !== true) {
    throw new CaptureError(reply.detail ?? 'the macOS engine refused the capture', {
      kind: reply.kind ?? 'capture-failed',
      detail: reply.detail ?? '',
    });
  }
  let size;
  try {
    size = (await stat(outputPath)).size;
  } catch {
    throw new CaptureError('the engine reported a capture but wrote no file', { kind: 'capture-failed' });
  }
  if (size === 0) throw new CaptureError('the engine wrote an empty file', { kind: 'capture-failed' });
  return { outputPath, bytes: size };
}

/**
 * Fingerprint a rectangle through the running engine.
 *
 * The comparison a wait needs is answered from a 64x64 reduction of the region
 * rather than from a PNG, which is what makes it about 23ms instead of 56ms.
 * @param target - the resolved `{ display, x, y, width, height }`.
 * @param options - cancellation signal.
 * @returns the fingerprint as a string.
 * @throws a `CaptureError` when the engine could not answer.
 */
export async function engineFingerprint(target, options = {}) {
  const reply = await engineRequest({ ...target, op: 'poll' }, options);
  if (reply.ok !== true) {
    throw new CaptureError(reply.detail ?? 'the macOS engine refused the check', {
      kind: reply.kind ?? 'capture-failed',
      detail: reply.detail ?? '',
    });
  }
  return String(reply.hash);
}

/** Reset the module's cached source, for tests that change it. */
export function forgetEngineSource() {
  sourceCache = null;
}

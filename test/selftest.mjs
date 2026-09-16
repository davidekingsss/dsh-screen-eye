/**
 * Self-test for dsh-screen-eye.
 *
 * Runs without a harness: the modules that carry the logic are imported
 * directly, and the tool definitions are exercised through a stubbed context.
 * The live capture test runs only when this machine already has Screen
 * Recording permission, so the suite stays green on a machine that has not
 * granted it yet.
 *
 *   node test/selftest.mjs
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Config, apply } from '../index.mjs';
import { buildCaptureName, captureStamp, isCaptureName } from '../lib/capture-name.mjs';
import {
  CAPTURE_MODES,
  CaptureError,
  DEFAULT_BURST_FRAMES,
  DEFAULT_BURST_INTERVAL_MS,
  INTERACTIVE_MODES,
  MAX_BURST_FRAMES,
  captureScreen,
  planCapture,
} from '../lib/capture.mjs';
import { describeCaptureFailure, isSupportedPlatform, platformFor, supportedPlatforms } from '../lib/platform.mjs';
import { darwin, screencaptureArgs } from '../lib/platform/darwin.mjs';
import {
  BLACK_FRAME_PERMILLE,
  NO_SESSION,
  RESULT_MARKER,
  burstScript,
  captureScript,
  displaysFromScreens,
  displaysScript,
  notesForFrame,
  parseScriptResult,
  powershellArgs,
  powershellPath,
  shimCachePath,
  win32,
} from '../lib/platform/win32.mjs';
import { run } from '../lib/exec.mjs';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';

import { displaysFromProfiler } from '../lib/displays.mjs';
import { formatBurstOutput, imageContent } from '../lib/image.mjs';
import { pngDimensions, stripDescriptiveChunks } from '../lib/png.mjs';
import {
  DENIED,
  OTHER,
  classifyFailure,
  guidance,
  grantTargetPath,
  probeScreenRecording,
} from '../lib/permission.mjs';
import { screenPermissionTool } from '../lib/permission-tool.mjs';
import { capturesToRemove, pruneCaptures } from '../lib/retention.mjs';
import { captureFailureError, screenshotTool } from '../lib/screenshot-tool.mjs';
import { resolveOutputPath, resolveSettings } from '../lib/settings.mjs';

/**
 * The macOS permission model, named rather than looked up.
 *
 * The macOS-specific cases below are about what that model does, not about
 * which machine is running them: the classification, the onboarding text and
 * the permission tool all have to be assertable from a Windows checkout and
 * from CI. Where a case is genuinely about *this* machine — a live probe, a
 * real capture — it says so and skips itself instead.
 */
const MACOS = darwin.permission;

/** Whether this checkout is being tested on the system it is running on. */
const ON_MACOS = process.platform === 'darwin';
const ON_WINDOWS = process.platform === 'win32';

let passed = 0;
const failures = [];
const skipped = [];

/** Thrown by a case's `skip` callback; never a failure. */
const SKIPPED = Symbol('skipped');

/** Run one named case, recording rather than throwing so the suite reports all. */
async function test(name, body) {
  try {
    await body((reason) => {
      skipped.push({ name, reason });
      const marker = 'skip';
      process.stdout.write(`  ${marker} ${name} — ${reason}\n`);
      throw SKIPPED;
    });
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    if (error === SKIPPED) return;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`);
  }
}

/** A minimal attachment store that records what it was asked to save. */
function stubAttachments() {
  const saved = [];
  return {
    saved,
    async saveImage({ data, mediaType, name }) {
      saved.push({ bytes: data.length, mediaType, name });
      return {
        attachmentId: 'stub-attachment-id',
        mediaType,
        bytes: data.length,
        width: 3840,
        height: 2160,
        name,
      };
    },
  };
}

/** A tool-execution context with a cancellation signal and an optional agent. */
function stubExec(agent) {
  return { signal: new AbortController().signal, agent };
}

/** A context exposing only the services a case asks for. */
function stubCtx({ attachments, llm } = {}) {
  return {
    logger: { info() {}, warn() {} },
    get(service) {
      if (service === 'attachments') return attachments;
      if (service === 'llm') return llm;
      return undefined;
    },
  };
}

process.stdout.write('dsh-screen-eye self-test\n\nargument planning\n');

await test('defaults to a full-screen capture', () => {
  const plan = planCapture({});
  assert.equal(plan.mode, 'screen');
  assert.equal(plan.region, undefined);
  assert.equal(plan.display, undefined);
  assert.equal(plan.includeCursor, false);
});

await test('rejects an unknown mode', () => {
  assert.throws(() => planCapture({ mode: 'everything' }), /unknown mode/u);
});

await test('rejects malformed regions instead of repairing them', () => {
  for (const region of ['0,0,800', 'a,b,c,d', '0, 0, 800, 600', '', '0,0,800,600,1', '0,0,800,', ',0,800,600']) {
    assert.throws(
      () => planCapture({ mode: 'region', region }),
      /region/u,
      `expected ${JSON.stringify(region)} to be rejected`,
    );
  }
  // A rectangle needs a positive size; the origin is the part that may be
  // negative, so these are the cases where a sign must not be waved through.
  for (const region of ['0,0,0,600', '0,0,800,0', '0,0,-800,600']) {
    assert.throws(() => planCapture({ mode: 'region', region }), /region/u);
  }
});

await test('accepts a negative region origin for a display left of the main one', () => {
  // screencapture takes negative coordinates; they are how a monitor placed to
  // the left of or above the main one is addressed, and rejecting them would
  // put those displays out of reach.
  assert.equal(planCapture({ mode: 'region', region: '-1920,0,800,600' }).region, '-1920,0,800,600');
  assert.equal(planCapture({ mode: 'region', region: '0,-1080,800,600' }).region, '0,-1080,800,600');
  assert.equal(planCapture({ mode: 'region', region: ' 10,20,300,400 ' }).region, '10,20,300,400');
});

await test('requires region exactly when the mode is region', () => {
  assert.throws(() => planCapture({ mode: 'region' }), /region/u);
  assert.throws(() => planCapture({ mode: 'screen', region: '0,0,10,10' }), /only meaningful/u);
});

await test('requires display exactly when the mode is display', () => {
  assert.throws(() => planCapture({ mode: 'screen', display: 2 }), /only meaningful/u);
  assert.equal(planCapture({ mode: 'display', display: 2 }).display, 2);
});

await test('rejects non-positive and fractional display indexes', () => {
  for (const display of [0, -1, 1.5]) {
    assert.throws(() => planCapture({ mode: 'display', display }), /positive integer/u);
  }
});

await test('accepts a well-formed region and display', () => {
  const plan = planCapture({ mode: 'region', region: ' 10,20,300,400 ' });
  assert.equal(plan.region, '10,20,300,400');
  assert.equal(planCapture({ mode: 'display', display: 2 }).display, 2);
});

process.stdout.write('\nargument mapping\n');

await test('maps each mode onto screencapture flags', () => {
  const out = '/tmp/x.png';
  const argv = (args) => screencaptureArgs(planCapture(args), out);

  // `-m` is what keeps one call to one file: screencapture otherwise writes
  // "1 file per screen", and this pipeline resolves and reads a single path.
  assert.deepEqual(argv({}), ['-x', '-t', 'png', '-m', out]);
  assert.deepEqual(argv({ mode: 'display', display: 3 }), ['-x', '-t', 'png', '-D', '3', out]);
  assert.deepEqual(argv({ mode: 'region', region: '1,2,3,4' }), ['-x', '-t', 'png', '-R', '1,2,3,4', out]);
  assert.deepEqual(argv({ mode: 'region', region: '-1920,0,3,4' }), ['-x', '-t', 'png', '-R', '-1920,0,3,4', out]);
  assert.deepEqual(argv({ mode: 'window' }), ['-x', '-t', 'png', '-o', '-w', out]);
  assert.deepEqual(argv({ mode: 'select' }), ['-x', '-t', 'png', '-i', out]);
  assert.deepEqual(argv({ include_cursor: true }), ['-x', '-t', 'png', '-C', '-m', out]);
});

await test('always writes PNG so the declared media type is true', () => {
  for (const mode of CAPTURE_MODES) {
    const args = mode === 'region'
      ? { mode, region: '0,0,1,1' }
      : mode === 'display' ? { mode, display: 1 } : { mode };
    assert.ok(screencaptureArgs(planCapture(args), '/tmp/x.png').includes('png'));
  }
});

await test('marks window and select as interactive', () => {
  assert.deepEqual([...INTERACTIVE_MODES].sort(), ['select', 'window']);
});

process.stdout.write('\nsettings and output paths\n');

await test('applies documented defaults', () => {
  const settings = resolveSettings({});
  assert.ok(settings.outputDir.endsWith('screen-eye'));
  assert.equal(settings.locale, 'en');
  assert.equal(settings.requireImageCapableModel, true);
  assert.equal(settings.deleteAfterCommit, false);
});

await test('honours overrides but ignores unknown keys', () => {
  const settings = resolveSettings({ locale: 'zh', timeoutMs: 5000, nonsense: true });
  assert.equal(settings.locale, 'zh');
  assert.equal(settings.timeoutMs, 5000);
  assert.equal(Object.hasOwn(settings, 'nonsense'), false);
});

await test('rejects relative and non-PNG output paths', () => {
  assert.throws(() => resolveOutputPath('shots/a.png', '/tmp'), /must be absolute/u);
  assert.throws(() => resolveOutputPath('/tmp/a.jpg', '/tmp'), /must name a \.png/u);
});

await test('generates unique names for captures in the same second', () => {
  const names = new Set();
  for (let index = 0; index < 200; index += 1) {
    names.add(resolveOutputPath(undefined, '/tmp/shots'));
  }
  assert.equal(names.size, 200);
});

process.stdout.write('\ncapture names and retention\n');

await test('a generated name always matches the pattern retention uses', () => {
  // These two are the write side and the delete side of the same format. If
  // they drift, retention either stops working or starts matching files it did
  // not create, so every generated name is checked against the matcher.
  for (let index = 0; index < 500; index += 1) {
    const name = buildCaptureName(new Date(), Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'));
    assert.ok(isCaptureName(name), `generated name did not match: ${name}`);
  }
  // The disambiguator is real entropy, not a base-36 slice of Math.random(),
  // which renders as fewer than six characters when the draw is small.
  assert.match(basename(resolveOutputPath(undefined, '/tmp/shots')), /-[0-9a-f]{6}\.png$/u);
});

await test('the matcher rejects names this plugin did not write', () => {
  for (const name of [
    'shot-2026-09-15_15-25-18-abcde.png',   // five-character suffix
    'shot-2026-09-15_15-25-18-ABCDEF.png',  // upper case
    'shot-2026-9-15_15-25-18-abcdef.png',   // unpadded month
    'screenshot-2026-09-15_15-25-18-abcdef.png',
    'shot-2026-09-15_15-25-18-abcdef.png.bak',
    'shot-2026-09-15_15-25-18-abcdef.jpg',
    'notes.txt',
    'shot-2026-09-15_15-25-18-abcdef',
  ]) {
    assert.equal(isCaptureName(name), false, `${name} must not be treated as a capture`);
  }
  assert.ok(isCaptureName('shot-2026-09-15_15-25-18-abcdef.png'));
});

await test('capture stamps are fixed width so name order is time order', () => {
  const early = captureStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  const late = captureStamp(new Date(Date.UTC(2026, 10, 12, 13, 14, 15)));
  assert.equal(early.length, late.length);
  assert.ok(early < late);
});

await test('retention keeps the newest and is disabled by zero', () => {
  const names = [
    'shot-2020-01-01_00-00-00-aaaaaa.png',
    'shot-2020-01-01_00-00-01-bbbbbb.png',
    'shot-2020-01-01_00-00-02-cccccc.png',
    'unrelated.png',
  ];
  assert.deepEqual(capturesToRemove(names, 2), ['shot-2020-01-01_00-00-00-aaaaaa.png']);
  assert.deepEqual(capturesToRemove(names, 4), []);
  assert.deepEqual(capturesToRemove(names, 0), [], 'zero disables retention');
  assert.deepEqual(capturesToRemove(names, -1), []);
  // A file this plugin did not write is never a candidate, whatever the cap.
  assert.ok(!capturesToRemove(names, 1).includes('unrelated.png'));
});

await test('retention never removes the capture it was asked to protect', () => {
  const newest = 'shot-2020-01-01_00-00-02-cccccc.png';
  const names = [newest, 'shot-2020-01-01_00-00-01-bbbbbb.png', 'shot-2020-01-01_00-00-00-aaaaaa.png'];
  // Even with a cap that would otherwise drop it, the protected name survives:
  // within one second the order is the random suffix, not time, so "the newest
  // N" cannot be trusted to include the capture just taken.
  const doomed = capturesToRemove(names, 1, newest);
  assert.deepEqual(doomed, ['shot-2020-01-01_00-00-00-aaaaaa.png', 'shot-2020-01-01_00-00-01-bbbbbb.png']);
});

await test('pruning reports what it removed and survives a missing directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-retention-'));
  try {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(dir, buildCaptureName(new Date(Date.UTC(2020, 0, 1, 0, 0, index)), 'abcdef')), 'x');
    }
    await writeFile(join(dir, 'keep-me.png'), 'x');
    const removed = await pruneCaptures(dir, 2, undefined);
    assert.equal(removed, 3);
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [
      'keep-me.png',
      buildCaptureName(new Date(Date.UTC(2020, 0, 1, 0, 0, 3)), 'abcdef'),
      buildCaptureName(new Date(Date.UTC(2020, 0, 1, 0, 0, 4)), 'abcdef'),
    ]);
    assert.equal(await pruneCaptures(join(dir, 'does-not-exist'), 2), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('the schemastery defaults agree with the module fallbacks', () => {
  // These two are applied on different paths — the schema when the loader
  // normalises config, the module when it is called directly — so a silent
  // drift between them would make behaviour depend on how the plugin loaded.
  const fromSchema = Config({});
  const fromModule = resolveSettings({});
  for (const key of ['locale', 'timeoutMs', 'keepRecent', 'maxDimension', 'requireImageCapableModel', 'deleteAfterCommit']) {
    assert.deepEqual(fromSchema[key], fromModule[key], `default for "${key}" drifted`);
  }
  // outputDir depends on DSH_HOME, so it is resolved at runtime, not in schema.
  assert.equal(fromSchema.outputDir, undefined);
});

process.stdout.write('\nimage content\n');

await test('returns a text envelope beside a real image block', () => {
  const blocks = imageContent({
    path: '/tmp/shots/a.png',
    mode: 'screen',
    capturedAt: '2026-09-15T23:00:00.000Z',
    image: {
      attachmentId: 'abc',
      mediaType: 'image/png',
      bytes: 1234,
      width: 100,
      height: 50,
      name: 'a.png',
    },
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /<path>\/tmp\/shots\/a\.png<\/path>/u);
  assert.match(blocks[0].text, /mode=screen/u);
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].attachment.attachmentId, 'abc');
  assert.equal(blocks[1].attachment.mediaType, 'image/png');
});

await test('reports the downscale multiplier when the store resized', () => {
  const [text] = imageContent({
    path: '/tmp/a.png',
    mode: 'screen',
    capturedAt: 'now',
    image: {
      attachmentId: 'a',
      mediaType: 'image/png',
      bytes: 1,
      width: 100,
      height: 50,
      originalDimensions: { width: 200, height: 100 },
    },
  });
  assert.match(text.text, /multiply coordinates by 2\.00/u);
});

process.stdout.write('\nPNG header\n');

/**
 * A complete IHDR chunk for the given size: signature, then the chunk's length,
 * type, 13 bytes of header data and CRC.
 *
 * The full chunk rather than just its first 24 bytes, because the chunk walker
 * steps by length and a short fixture would send it out of alignment — which is
 * exactly what it did before this was fixed.
 */
function pngHeader(width, height, chunk = 'IHDR') {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write(chunk, 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

await test('reads a PNG size from the header alone', () => {
  // The header, not a decode: a full-screen PNG is megabytes and the check
  // must not cost anything.
  assert.deepEqual(pngDimensions(pngHeader(3840, 2160)), { width: 3840, height: 2160 });
  assert.deepEqual(pngDimensions(pngHeader(1, 1)), { width: 1, height: 1 });
});

await test('rejects bytes that are not a PNG', () => {
  // Long enough to reach the signature check — a shorter buffer is rejected
  // for its length, which would make this case pass for the wrong reason.
  assert.throws(() => pngDimensions(Buffer.alloc(32, 0x78)), /signature/u);
  assert.throws(() => pngDimensions(Buffer.alloc(8)), /fewer than 24 bytes/u);
  assert.throws(() => pngDimensions(Buffer.alloc(0)), /fewer than 24 bytes/u);
  assert.throws(() => pngDimensions('a string, not bytes'), /fewer than 24 bytes/u);
  assert.throws(() => pngDimensions(pngHeader(10, 10, 'IDAT')), /IHDR/u);
});

await test('rejects a zero dimension instead of reporting it', () => {
  assert.throws(() => pngDimensions(pngHeader(0, 100)), /malformed PNG/u);
  assert.throws(() => pngDimensions(pngHeader(100, 0)), /malformed PNG/u);
});

process.stdout.write('\nburst\n');

await test('rejects frame counts outside what one call may take', () => {
  for (const frames of [0, -1, 1.5, 'three']) {
    assert.throws(() => planCapture({ frames }), /positive integer/u, `frames=${frames}`);
  }
  assert.throws(() => planCapture({ frames: MAX_BURST_FRAMES + 1 }), /above the 10/u);
  assert.equal(planCapture({ frames: MAX_BURST_FRAMES }).frames, MAX_BURST_FRAMES);
  assert.equal(planCapture({}).frames, 1, 'a plain capture is one frame');
});

await test('refuses to repeat an interactive mode automatically', () => {
  // "select" waits for a person to drag a rectangle; repeating it unattended
  // would ask that person to do it once per frame.
  assert.throws(() => planCapture({ mode: 'select', frames: 3 }), /waits for the user/u);
  assert.throws(() => planCapture({ mode: 'window', frames: 2 }), /waits for the user/u);
  assert.equal(planCapture({ mode: 'select' }).frames, 1);
});

await test('validates the burst interval and defaults it', () => {
  assert.throws(() => planCapture({ frames: 2, interval_ms: 0 }), /interval_ms/u);
  assert.throws(() => planCapture({ frames: 2, interval_ms: 1.5 }), /interval_ms/u);
  assert.equal(planCapture({ frames: 2 }).intervalMs, DEFAULT_BURST_INTERVAL_MS);
  assert.equal(planCapture({ frames: 2, interval_ms: 500 }).intervalMs, 500);
});

await test('renders a burst as one envelope and one image block per frame', () => {
  const frame = (n) => ({
    path: `/tmp/shot-${n}.png`,
    capturedAt: '2026-09-15T00:00:00.000Z',
    image: { attachmentId: `id${n}`, mediaType: 'image/png', bytes: 100 + n, width: 800, height: 600 },
  });
  const blocks = imageContent({
    mode: 'region',
    path: '/tmp/shot-1.png',
    capturedAt: '2026-09-15T00:00:00.000Z',
    frames: [frame(1), frame(2), frame(3)],
    spacingMs: 200,
  });
  assert.equal(blocks.length, 4, 'one envelope plus three images');
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /frames=3/u);
  assert.match(blocks[0].text, /about 200ms apart/u);
  assert.match(blocks[0].text, /1\. \/tmp\/shot-1\.png/u);
  assert.match(blocks[0].text, /3\. \/tmp\/shot-3\.png/u);
  assert.deepEqual(
    blocks.slice(1).map((block) => block.attachment.attachmentId),
    ['id1', 'id2', 'id3'],
  );
  assert.ok(blocks.slice(1).every((block) => block.type === 'image'));
});

await test('says when the requested interval could not be met', () => {
  // The gap between asked-for and achieved is the feedback that lets the next
  // call ask for something achievable — usually by watching a smaller region,
  // which is captured faster.
  const frame = (n) => ({
    path: `/tmp/f${n}.png`,
    capturedAt: '2026-09-15T00:00:00.000Z',
    image: { attachmentId: `i${n}`, mediaType: 'image/png', bytes: 1, width: 10, height: 10 },
  });
  const met = formatBurstOutput({
    mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2)], spacingMs: 200, intervalMs: 200,
  });
  assert.match(met, /about 200ms apart/u);
  assert.doesNotMatch(met, /cannot meet/u, 'a met interval must not be reported as missed');

  const missed = formatBurstOutput({
    mode: 'screen', capturedAt: 'now', frames: [frame(1), frame(2)], spacingMs: 155, intervalMs: 40,
  });
  assert.match(missed, /asked for 40ms/u);
  assert.match(missed, /a smaller region is captured faster/u);
});

await test('a burst that met its target is not accused of missing it', () => {
  // The loop sleeps the remainder of the interval and then starts the frame, so
  // a burst that met its target still lands a few milliseconds over — which the
  // first revision reported as "cannot meet", with advice about the frame cost.
  // Measured on Windows: 200ms asked, 211ms achieved; 150ms asked, 163ms
  // achieved. Both are the target being met, and the model must be told that.
  const frame = (n) => ({
    path: `/tmp/f${n}.png`,
    capturedAt: 'now',
    image: { attachmentId: `i${n}`, mediaType: 'image/png', bytes: 1, width: 10, height: 10 },
  });
  const cases = [[200, 211], [150, 163], [300, 311], [400, 412], [667, 677], [1000, 1012]];
  for (const [intervalMs, spacingMs] of cases) {
    const envelope = formatBurstOutput({
      mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2)], spacingMs, intervalMs,
    });
    assert.doesNotMatch(
      envelope,
      /cannot meet/u,
      `${intervalMs}ms asked and ${spacingMs}ms achieved must not be reported as a miss`,
    );
    assert.match(envelope, new RegExp(`about ${spacingMs}ms apart`, 'u'));
  }
  // And the tolerance is a tolerance, not a mute button: a shortfall outside it
  // is still reported, because that is the feedback the next call needs.
  for (const [intervalMs, spacingMs] of [[150, 400], [200, 1000], [40, 155]]) {
    const envelope = formatBurstOutput({
      mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2)], spacingMs, intervalMs,
    });
    assert.match(envelope, /cannot meet/u, `${intervalMs}ms asked and ${spacingMs}ms achieved is a miss`);
  }
});

await test('a single capture keeps its original one-image shape', () => {
  const blocks = imageContent({
    path: '/tmp/a.png',
    mode: 'screen',
    capturedAt: 'now',
    image: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 10, height: 10 },
  });
  assert.equal(blocks.length, 2, 'burst support must not change the single-capture contract');
});

process.stdout.write('\ndisplays\n');

await test('orders displays the way -D numbers them', () => {
  // The payload is the one a real machine produced: a 4K monitor marked main
  // and an iPad in Sidecar. The ordering is the contract this mode exists for,
  // and it is checked here rather than only against a live inventory because
  // the CI machine reports no displays at all.
  const ordered = displaysFromProfiler({
    SPDisplaysDataType: [{
      spdisplays_ndrvs: [
        { _name: 'P27A6VP', _spdisplays_pixels: '3840 x 2160', spdisplays_main: 'spdisplays_yes', spdisplays_online: 'spdisplays_yes' },
        { _name: 'Sidecar Display', _spdisplays_pixels: '2388 x 1668', spdisplays_mirror: 'spdisplays_off' },
      ],
    }],
  });
  assert.deepEqual(ordered, [
    { index: 1, name: 'P27A6VP', width: 3840, height: 2160, main: true },
    { index: 2, name: 'Sidecar Display', width: 2388, height: 1668, main: false },
  ]);
});

await test('puts the main display first even when the system lists it later', () => {
  const ordered = displaysFromProfiler({
    SPDisplaysDataType: [{
      spdisplays_ndrvs: [
        { _name: 'Secondary', _spdisplays_pixels: '1920 x 1080' },
        { _name: 'Primary', _spdisplays_pixels: '2560 x 1440', spdisplays_main: 'spdisplays_yes' },
      ],
    }],
  });
  assert.deepEqual(ordered.map((display) => display.name), ['Primary', 'Secondary']);
  assert.deepEqual(ordered.map((display) => display.index), [1, 2]);
});

await test('survives a display with no reported size or name', () => {
  // A missing size must not become a zero-sized display, and a missing
  // spdisplays_online must not be read as offline: Sidecar displays omit it,
  // and treating it as offline would hide the second screen on exactly the
  // setup this mode exists to describe.
  const ordered = displaysFromProfiler({
    SPDisplaysDataType: [{ spdisplays_ndrvs: [{ spdisplays_main: 'spdisplays_yes' }] }],
  });
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].name, 'unknown display');
  assert.equal(ordered[0].width, undefined);
  assert.equal(ordered[0].main, true);
});

await test('treats an empty inventory as a failure, not as no screens', () => {
  // A Mac always has at least one display, so an empty list means the
  // inventory could not be read — saying "no displays" would be a claim about
  // the machine rather than about the reading.
  for (const payload of [{}, { SPDisplaysDataType: [] }, { SPDisplaysDataType: [{ spdisplays_ndrvs: [] }] }, undefined]) {
    assert.throws(() => displaysFromProfiler(payload), /listed no displays/u, JSON.stringify(payload));
  }
});

await test('the inventory mode refuses capture arguments', () => {
  // It reports and returns; silently ignoring a region or a frame count would
  // let a caller believe it had captured something.
  for (const args of [
    { mode: 'displays', region: '0,0,10,10' },
    { mode: 'displays', display: 2 },
    { mode: 'displays', frames: 3 },
    { mode: 'displays', interval_ms: 100 },
  ]) {
    assert.throws(() => planCapture(args), /captures nothing/u, JSON.stringify(args));
  }
  assert.equal(planCapture({ mode: 'displays' }).mode, 'displays');
});

process.stdout.write('\nduration and lossless storage\n');

await test('every pair of the three burst numbers determines the third', () => {
  // The contract in one case: frames, interval and window, any two of which
  // settle the third. The pair that matters most is the second — a fixed window
  // sampled at a chosen coarseness, which is how cost is controlled.
  const byFramesAndInterval = planCapture({ frames: 6, interval_ms: 200 });
  assert.equal(byFramesAndInterval.frames, 6);
  assert.equal(byFramesAndInterval.intervalMs, 200);

  const byFramesAndDuration = planCapture({ duration_ms: 2000, frames: 4 });
  assert.equal(byFramesAndDuration.frames, 4);
  assert.equal(byFramesAndDuration.intervalMs, 667, 'the interval is what divides the window');
  assert.ok((byFramesAndDuration.frames - 1) * byFramesAndDuration.intervalMs >= 1900);

  const byIntervalAndDuration = planCapture({ duration_ms: 400, interval_ms: 50 });
  assert.equal(byIntervalAndDuration.frames, 9);
  assert.equal(byIntervalAndDuration.intervalMs, 50);

  // A window alone is sampled at the ordinary frame count, not at the maximum:
  // the maximum is the most expensive answer and was not asked for.
  const byDuration = planCapture({ duration_ms: 300 });
  assert.equal(byDuration.frames, DEFAULT_BURST_FRAMES);
  assert.equal(byDuration.intervalMs, 60);
});

await test('raising the interval lowers the frame count, which is the cost lever', () => {
  // Why the interval is exposed at all: within one window, a coarser sample is
  // fewer images, and images are what cost. Holding the window fixed and raising
  // the interval must only ever reduce the frame count.
  const counts = [50, 100, 200, 400, 1000].map(
    (interval_ms) => planCapture({ duration_ms: 2000, interval_ms }).frames,
  );
  assert.deepEqual(counts, [MAX_BURST_FRAMES, MAX_BURST_FRAMES, MAX_BURST_FRAMES, 6, 3]);
  for (let index = 1; index < counts.length; index += 1) {
    assert.ok(
      counts[index] <= counts[index - 1],
      `frame count rose from ${counts[index - 1]} to ${counts[index]} as the interval grew`,
    );
  }
});

await test('refuses to over-determine the burst', () => {
  // All three at once is the one combination with no defensible reading.
  assert.throws(() => planCapture({ frames: 4, interval_ms: 100, duration_ms: 1000 }), /over-determine/u);
  assert.throws(() => planCapture({ duration_ms: 0 }), /positive integer/u);
  assert.throws(() => planCapture({ duration_ms: 1.5 }), /positive integer/u);
  assert.throws(() => planCapture({ duration_ms: 1000, frames: 1 }), /at least two frames/u);
});

await test('reports the window covered when one was asked for', () => {
  const frame = (n) => ({
    path: `/tmp/f${n}.png`,
    capturedAt: 'now',
    image: { attachmentId: `i${n}`, mediaType: 'image/png', bytes: 1, width: 10, height: 10 },
  });
  const text = formatBurstOutput({
    mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2), frame(3)],
    spacingMs: 222, intervalMs: 222, durationMs: 2000,
  });
  assert.match(text, /spanning about 444ms of the 2000ms asked for/u);
});

await test('strips the chunks that would force a lossy re-encode', () => {
  // macOS attaches an ICC profile, EXIF and iTXt to every capture, and the
  // store's pass-through test refuses anything carrying metadata — so a real
  // screenshot is always re-encoded, however small. Removing those chunks is
  // what lets the same pixels through untouched.
  const chunk = (type, payload) => {
    const out = Buffer.alloc(12 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    out.write(type, 4, 'latin1');
    payload.copy(out, 8);
    return out;
  };
  const withMetadata = Buffer.concat([
    pngHeader(600, 400),
    chunk('iCCP', Buffer.alloc(10)),
    chunk('eXIf', Buffer.alloc(4)),
    chunk('iTXt', Buffer.alloc(7)),
    chunk('IDAT', Buffer.from('image data')),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const stripped = stripDescriptiveChunks(withMetadata);
  const types = [];
  let offset = 8;
  while (offset + 12 <= stripped.length) {
    const length = stripped.readUInt32BE(offset);
    const type = stripped.subarray(offset + 4, offset + 8).toString('latin1');
    types.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND'], 'only the image data should remain');
  assert.deepEqual(pngDimensions(stripped), { width: 600, height: 400 });
});

await test('leaves bytes it cannot safely rewrite exactly as they were', () => {
  const notPng = Buffer.alloc(32, 0x78);
  assert.equal(stripDescriptiveChunks(notPng), notPng, 'a non-PNG must be returned unchanged');
  assert.equal(stripDescriptiveChunks('a string'), 'a string');

  // A file that never reaches IEND is left alone rather than truncated into
  // something corrupt — a half-rewritten PNG would fail later, less clearly.
  const unterminated = Buffer.concat([
    pngHeader(10, 10),
    (() => {
      const payload = Buffer.from('data');
      const out = Buffer.alloc(12 + payload.length);
      out.writeUInt32BE(payload.length, 0);
      out.write('IDAT', 4, 'latin1');
      payload.copy(out, 8);
      return out;
    })(),
  ]);
  assert.equal(stripDescriptiveChunks(unterminated), unterminated);
});

process.stdout.write('\nschema conformance\n');

/**
 * The schema the harness will hold a tool's returned value to.
 *
 * `defineTool` compiles the author-facing spec while building the definition,
 * so `output.schema` is already raw JSON Schema — compiling it again would
 * feed the DSL its own output and be rejected.
 * @param tool - a tool definition.
 * @returns the compiled JSON Schema.
 */
function compiledOutput(tool) {
  return tool.output.schema;
}

/** One stored attachment, as the serialisable image value carries it. */
const SAMPLE_IMAGE = Object.freeze({
  attachmentId: 'attachment-id', mediaType: 'image/png', bytes: 1024, width: 10, height: 10,
});

/** Every shape the screenshot tool can return. */
function screenshotShapes() {
  return {
    'one capture': {
      path: '/tmp/a.png', mode: 'screen', capturedAt: 'now', display: 1, image: SAMPLE_IMAGE,
    },
    'a burst': {
      path: '/tmp/a.png', mode: 'region', capturedAt: 'now',
      frames: [{ path: '/tmp/a.png', capturedAt: 'now', image: SAMPLE_IMAGE }],
      spacingMs: 200, intervalMs: 200, durationMs: 1000,
    },
    'a burst that under-delivered': {
      path: '/tmp/a.png', mode: 'screen', capturedAt: 'now',
      frames: [{ path: '/tmp/a.png', capturedAt: 'now', image: SAMPLE_IMAGE }],
      spacingMs: 155, intervalMs: 40,
    },
    'a display inventory': {
      mode: 'displays',
      displays: [{ index: 1, name: 'Main', width: 3840, height: 2160, main: true }],
    },
    'an inventory that could not read a size': { mode: 'displays', displays: [{ index: 2, name: 'Sidecar' }] },
  };
}

/** Every shape the permission tool can return. */
function permissionShapes() {
  return {
    granted: { platform: 'darwin', authorized: true, target: '/usr/local/bin/node' },
    refused: {
      platform: 'darwin', authorized: false, reason: 'screen-recording-denied',
      detail: 'could not create image from display', target: '/usr/local/bin/node',
      guidance: ['a step'],
    },
    'guided to fix it': {
      platform: 'darwin', authorized: false, target: '/usr/local/bin/node',
      settingsOpened: true, guidance: [], reason: 'screen-recording-denied',
    },
    'guided when nothing needed fixing': {
      platform: 'darwin', authorized: true, target: '/usr/local/bin/node', settingsOpened: false,
    },
    'with a mount issue': {
      platform: 'darwin', authorized: true, target: '/usr/local/bin/node',
      issues: ['the screenshot tool is unavailable'],
    },
  };
}

await test('every shape the screenshot tool returns satisfies its own schema', () => {
  // The harness validates each returned value against the schema the tool
  // declared and refuses the result when it does not fit, so a mismatch turns a
  // working tool into one that reports "returned invalid output" at runtime.
  // That is exactly what happened when the inventory mode was added while the
  // declaration still required an image: only a live call revealed it.
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  for (const [name, value] of Object.entries(screenshotShapes())) {
    const problems = validateJsonSchemaValue(compiledOutput(tool), value);
    assert.deepEqual(problems, [], `${name} does not satisfy the declared schema: ${problems.join('; ')}`);
  }
});

await test('every shape the permission tool returns satisfies its own schema', () => {
  const tool = screenPermissionTool(MACOS, resolveSettings({}));
  for (const [name, value] of Object.entries(permissionShapes())) {
    const problems = validateJsonSchemaValue(compiledOutput(tool), value);
    assert.deepEqual(problems, [], `${name} does not satisfy the declared schema: ${problems.join('; ')}`);
  }
});

await test('every shape projects to lossless presentation metadata', () => {
  // The harness snapshots this projection and refuses the whole call when it is
  // not lossless JSON — a property holding `undefined` is enough to fail it.
  // That is the second way the inventory mode failed live, after the schema was
  // already fixed, so it is checked here with the harness's own predicate
  // rather than a re-implementation of it.
  const tools = {
    screenshot: [screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({})), screenshotShapes()],
    screen_permission: [screenPermissionTool(MACOS, resolveSettings({})), permissionShapes()],
  };
  for (const [toolName, [tool, shapes]] of Object.entries(tools)) {
    for (const [name, value] of Object.entries(shapes)) {
      const meta = tool.output.presentationMeta?.({}, value);
      if (meta === undefined) continue;
      assert.notEqual(
        snapshotJsonValue(meta),
        undefined,
        `${toolName} / ${name}: presentationMeta is not lossless JSON`,
      );
    }
  }
});

await test('every shape renders to content blocks the harness knows', () => {
  // render() is what the model actually receives, so a shape that renders
  // nothing — or renders something without a type tag — is a shape that fails
  // silently rather than loudly.
  const tools = {
    screenshot: [screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({})), screenshotShapes()],
    screen_permission: [screenPermissionTool(MACOS, resolveSettings({})), permissionShapes()],
  };
  for (const [toolName, [tool, shapes]] of Object.entries(tools)) {
    for (const [name, value] of Object.entries(shapes)) {
      const blocks = tool.output.render({}, value);
      assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} / ${name}: rendered nothing`);
      for (const block of blocks) {
        assert.ok(typeof block?.type === 'string', `${toolName} / ${name}: a block has no type`);
        assert.ok(['text', 'image'].includes(block.type), `${toolName} / ${name}: unknown block type ${block.type}`);
      }
      assert.equal(blocks[0].type, 'text', `${toolName} / ${name}: the first block should be the text envelope`);
    }
  }
});

process.stdout.write('\nchild process execution\n');

/**
 * A child that runs JavaScript, whichever system the suite is on.
 *
 * These cases are about `run()` — that it captures both streams, reports the
 * exit code, and actually kills what it started — so the child has to be
 * something every platform has. The Node binary running the suite is the one
 * thing that is always there, and it makes the marker files that prove a kill
 * work identically on Windows and on macOS, where `/bin/sh` would not.
 *
 * @param source - the script to evaluate in the child.
 * @returns the command and its argument vector.
 */
function nodeChild(source) {
  return [process.execPath, ['-e', source]];
}

await test('returns the exit code and both streams', async () => {
  const [command, args] = nodeChild(
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);',
  );
  const result = await run(command, args);
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
});

await test('does not spawn at all when the signal is already aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eye-exec-'));
  const marker = join(dir, 'ran');
  try {
    const controller = new AbortController();
    controller.abort();
    const [command, args] = nodeChild(
      `require('node:fs').writeFileSync(process.argv[1], 'ran')`,
    );
    await assert.rejects(
      () => run(command, [...args, marker], { signal: controller.signal }),
      (error) => error.name === 'AbortError',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(marker), false, 'an aborted call must not start its command');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('cancelling a call actually kills the child', async () => {
  // The claim in lib/exec.mjs is that cancellation kills the child, and it
  // matters because the failure is visible on the user's screen: an
  // interactive screencapture left running keeps its crosshair up after the
  // tool call is gone. The marker is written well after the abort, so its
  // absence proves the process died rather than merely being detached from a
  // promise nobody awaits any more.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eye-exec-'));
  const marker = join(dir, 'survived');
  try {
    const controller = new AbortController();
    const started = Date.now();
    const [command, args] = nodeChild(
      `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 2000)`,
    );
    const settled = run(command, [...args, marker], { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(() => settled, (error) => error.name === 'AbortError');
    assert.ok(Date.now() - started < 1500, 'a cancelled call must not wait for the child');
    await new Promise((resolve) => setTimeout(resolve, 2400));
    assert.equal(existsSync(marker), false, 'the child outlived the cancellation');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a capture that overruns its budget is killed, not abandoned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eye-exec-'));
  const marker = join(dir, 'survived');
  try {
    const [command, args] = nodeChild(
      `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 2000)`,
    );
    await assert.rejects(
      () => run(command, [...args, marker], { timeoutMs: 150 }),
      /exceeded its 150ms budget/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 2400));
    assert.equal(existsSync(marker), false, 'a timed-out child must not be left running');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a command that cannot be spawned rejects instead of hanging', async () => {
  const missing = join(tmpdir(), 'dsh-screen-eye-no-such-binary', 'not-here');
  await assert.rejects(
    () => run(missing, []),
    (error) => error.code === 'ENOENT',
  );
});

process.stdout.write('\npermission diagnosis\n');

await test('separates a TCC denial from every other failure', () => {
  assert.equal(classifyFailure('could not create image from display'), DENIED);
  assert.equal(classifyFailure('screencapture: cannot write file'), OTHER);
  assert.equal(classifyFailure(''), OTHER);
});

await test('guidance names the exact executable to grant', () => {
  const english = guidance({ locale: 'en' }).join('\n');
  const chinese = guidance({ locale: 'zh' }).join('\n');
  // The whole point of the onboarding is that the user is told the exact path
  // to add, computed from the running host rather than described generically.
  assert.ok(english.includes(grantTargetPath()));
  assert.ok(chinese.includes(grantTargetPath()));
  assert.match(chinese, /屏幕录制/u);
  assert.match(english, /Screen & System Audio Recording/u);
  assert.match(english, /No DSH restart is needed/u);
});

await test('guidance falls back to English for an unknown locale', () => {
  assert.deepEqual(guidance({ locale: 'fr' }), guidance({ locale: 'en' }));
  assert.deepEqual(guidance({}), guidance({ locale: 'en' }));
});

process.stdout.write('\ntool definitions\n');

await test('builds both tools with a model-facing description', () => {
  const screenshot = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  assert.equal(screenshot.name, 'screenshot');
  assert.ok(screenshot.description.length > 100);
  const permission = screenPermissionTool(MACOS, resolveSettings({}));
  assert.equal(permission.name, 'screen_permission');
});

await test('the description tells the model what this platform actually does', async () => {
  // The description is the only thing the model has to decide how to look, and
  // the two platforms answer differently: macOS gates capture behind a grant
  // the user must give, Windows has no such gate, offers no region picker and
  // pays a second of PowerShell per call. A description that described the
  // other platform would have the model waiting for a prompt that never comes.
  const observations = [];
  for (const platform of [darwin, win32]) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform.id, configurable: true });
    try {
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
      // The parameter help is compiled into JSON Schema, where a double quote
      // in the prose arrives escaped; comparing against the unescaped text
      // keeps the assertion about the words rather than about the encoding.
      const parameters = JSON.stringify(tool.parameters).replaceAll('\\"', '"');
      const haystack = `${tool.description}\n${parameters}`;
      for (const [field, text] of Object.entries(platform.briefing)) {
        assert.ok(haystack.includes(text), `${platform.id}: the ${field} briefing never reaches the model`);
      }
      observations.push({ description: tool.description, parameters });
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  }
  const [macos, windows] = observations;
  // The parts that are true everywhere, and the parts that must not leak
  // across: a Windows model must not be told to grant Screen Recording, and a
  // macOS model must not be told capture needs no consent.
  for (const { description } of observations) {
    assert.match(description, /return the picture itself/u);
    assert.match(description, /The image comes back in this call/u);
  }
  assert.match(macos.description, /Screen Recording permission/u);
  assert.doesNotMatch(windows.description, /Screen Recording/u);
  assert.match(windows.description, /no screen-recording permission to grant/u);
  assert.doesNotMatch(macos.description, /no screen-recording permission to grant/u);
  // And the macOS description is still the macOS one, word for word where it
  // states a measurement: the port is allowed to add a platform, not to change
  // what the other one promises. The 155ms and 56ms figures are the macOS
  // measurements, and a Windows one has no business carrying them.
  assert.match(macos.description, /^Capture this macOS screen and return the picture itself/u);
  assert.match(macos.parameters, /155ms for a full screen but 56ms for a 1200x800 region/u);
  assert.match(macos.parameters, /"window" and "select" are interactive/u);
  // The Windows briefing says what a burst can actually do there, which is the
  // one thing a model about to ask for a 100ms interval needs to know.
  assert.match(windows.parameters, /a burst runs in one engine process/u);
  assert.doesNotMatch(macos.parameters, /one engine process/u);
});

await test('refuses to capture for a model that cannot see images', async () => {
  const tool = screenshotTool(
    stubCtx({
      attachments: stubAttachments(),
      llm: { async resolveModelInfo() { return { inputModalities: ['text'] }; } },
    }),
    resolveSettings({}),
  );
  await assert.rejects(
    () => tool.execute({ mode: 'screen' }, stubExec({ options: { provider: 'p', model: 'text-only' } })),
    /does not declare image input/u,
  );
});

await test('validates arguments through the harness schema', async () => {
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  await assert.rejects(
    () => tool.execute({ mode: 'nonsense' }, stubExec()),
    /mode/u,
  );
});

await test('refuses a capture when the model route cannot be resolved', async () => {
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  // No agent on the execution context and no llm service: the route is
  // unknowable, and guessing would spend a capture on an unknown viewer.
  await assert.rejects(
    () => tool.execute({ mode: 'screen' }, stubExec()),
    /route could not be resolved/u,
  );
});

process.stdout.write('\nscreen_permission tool\n');

await test('reports the live permission state and how to fix it', async (skip) => {
  if (!ON_MACOS) {
    skip(`there is no Screen Recording model on ${process.platform}`);
    return;
  }
  const tool = screenPermissionTool(MACOS, resolveSettings({}));
  const value = await tool.execute({}, stubExec());
  assert.equal(value.platform, process.platform);
  assert.equal(typeof value.authorized, 'boolean');
  assert.equal(value.target, grantTargetPath());
  // This machine's state is not the assertion — that the tool reports it
  // truthfully is. Whichever way it comes out, the two shapes are fixed.
  if (value.authorized) {
    assert.equal(value.guidance, undefined, 'nothing to fix means nothing to explain');
    assert.equal(value.reason, undefined);
  } else {
    assert.ok(Array.isArray(value.guidance));
    assert.ok(value.guidance.join('\n').includes(grantTargetPath()));
  }
});

await test('defaults to action "check" when none is given', async () => {
  const tool = screenPermissionTool(MACOS, resolveSettings({}));
  const explicit = await tool.execute({ action: 'check' }, stubExec());
  assert.equal(typeof explicit.authorized, 'boolean');
  assert.equal(explicit.settingsOpened, undefined);
});

await test('renders both outcomes with the path the user must grant', () => {
  const tool = screenPermissionTool(MACOS, resolveSettings({}));
  const denied = tool.output.render({}, {
    platform: 'darwin',
    authorized: false,
    reason: 'screen-recording-denied',
    target: '/usr/local/bin/node',
    guidance: ['Open System Settings.', 'Add /usr/local/bin/node.'],
  });
  assert.equal(denied.length, 1);
  assert.equal(denied[0].type, 'text');
  assert.match(denied[0].text, /<authorized>false<\/authorized>/u);
  assert.match(denied[0].text, /<target>\/usr\/local\/bin\/node<\/target>/u);

  const granted = tool.output.render({}, {
    platform: 'darwin',
    authorized: true,
    target: '/usr/local/bin/node',
  });
  assert.match(granted[0].text, /<authorized>true<\/authorized>/u);
  assert.doesNotMatch(granted[0].text, /Tell the user exactly this/u);
});

await test('the guide never reports a state it did not observe', async (skip) => {
  // The previous revision returned authorized: false from the settings action
  // unconditionally, so asking for guidance on a machine that already had the
  // grant was told it did not. A guidance path that invents the problem it is
  // guiding you through is worse than no guidance.
  if (!ON_MACOS) {
    skip(`there is no Screen Recording model on ${process.platform}`);
    return;
  }
  const tool = screenPermissionTool(MACOS, resolveSettings({}));
  const value = await tool.execute({ action: 'guide' }, stubExec());
  assert.equal(typeof value.authorized, 'boolean');

  if (value.authorized) {
    assert.equal(value.settingsOpened, false, 'nothing needed fixing, so nothing should be opened');
    assert.equal(value.guidance, undefined, 'and there is nothing to explain');
    const [block] = tool.output.render({}, value);
    assert.doesNotMatch(block.text, /settings pane has been opened/u);
  } else {
    assert.equal(value.settingsOpened, true);
    assert.ok(Array.isArray(value.guidance) && value.guidance.length > 0);
    assert.ok(value.guidance.join('\n').includes(grantTargetPath()));
    const [block] = tool.output.render({}, value);
    assert.match(block.text, /call this tool with action "check" to confirm/u);
  }
});

await test('renders the settings-opened outcome without claiming authorisation', () => {
  const tool = screenPermissionTool(MACOS, resolveSettings({}));
  const [block] = tool.output.render({}, {
    platform: 'darwin',
    authorized: false,
    target: '/usr/local/bin/node',
    settingsOpened: true,
    guidance: ['Turn the switch on.'],
  });
  // Opening the pane does not grant anything, and the render must not imply
  // it did — that is the difference between guiding the user and misleading.
  assert.match(block.text, /<authorized>false<\/authorized>/u);
  assert.match(block.text, /settings pane has been opened/u);
});

process.stdout.write('\ncapture failure messages\n');

await test('a denied capture carries the onboarding steps, not the system string', () => {
  const denied = new CaptureError('could not create image from display', {
    kind: DENIED,
    detail: 'could not create image from display',
  });
  // Asked of the macOS model directly rather than of the host: this is a claim
  // about what macOS does with a TCC denial, and it has to hold whichever
  // machine runs the suite.
  const message = MACOS.describeFailure(denied, describeCaptureFailure, { locale: 'en' }).message;
  assert.match(message, /refused by macOS/u);
  assert.ok(message.includes(grantTargetPath()), 'the message must name what to grant');
  assert.match(message, /Screen & System Audio Recording/u);
  assert.match(message, /No DSH restart is needed/u);
  // The raw system string is replaced, not merely prefixed: it reads like a
  // bug and tells the user nothing they can act on.
  assert.doesNotMatch(message, /could not create image from display/u);

  const chinese = MACOS.describeFailure(denied, describeCaptureFailure, { locale: 'zh' }).message;
  assert.match(chinese, /屏幕录制/u);
  assert.ok(chinese.includes(grantTargetPath()));
});

await test('an ordinary capture failure keeps the system detail', () => {
  const failed = new CaptureError('screencapture exited with code 1', {
    kind: 'capture-failed',
    detail: 'rect (0, 0, 8, 8) does not intersect any displays',
  });
  const message = captureFailureError(failed, 'en').message;
  assert.match(message, /does not intersect any displays/u);
  assert.doesNotMatch(message, /Screen Recording/u, 'a non-TCC failure must not blame the grant');

  const bare = captureFailureError(new CaptureError('no output at all'), 'en').message;
  assert.equal(bare, 'no output at all');
});

await test('a refused capture names what refused it, on a platform that has no grant', () => {
  // Windows has nothing to grant, so a refusal there is the engine's own
  // diagnosis — an out-of-range display, a region off the desktop, a session
  // with no visible desktop — and the model needs that text intact rather than
  // translated into permission advice that does not apply.
  const refused = new CaptureError('display 99 does not exist: this machine reports 1 display(s)', {
    kind: 'no-such-display',
    detail: 'display 99 does not exist: this machine reports 1 display(s)',
  });
  assert.equal(win32.permission, null, 'Windows has no consent model to report');
  const message = describeCaptureFailure(refused).message;
  assert.match(message, /display 99 does not exist/u);
  assert.doesNotMatch(message, /Screen Recording/u);
});

await test('a failure the engine reported is not repeated twice', () => {
  // Both engines build their errors as `new CaptureError(detail, { detail })`,
  // so message and detail are the same string for every failure the engine
  // itself diagnosed. Appending one to the other produced
  // `display 99 does not exist: display 99 does not exist`, which reads like a
  // malfunction in the plugin rather than a fact about the screen.
  const engineSaid = new CaptureError('region -9000,-9000,100,100 does not overlap any display', {
    kind: 'region-outside-desktop',
    detail: 'region -9000,-9000,100,100 does not overlap any display',
  });
  const message = describeCaptureFailure(engineSaid).message;
  assert.equal(message, 'region -9000,-9000,100,100 does not overlap any display');
  assert.equal(message.match(/does not overlap/gu).length, 1);

  // A detail that adds something is still added: that is what makes the two
  // fields worth having separately.
  const withDetail = new CaptureError('the engine exited with code 1', {
    kind: 'capture-failed',
    detail: 'Access is denied',
  });
  assert.equal(describeCaptureFailure(withDetail).message, 'the engine exited with code 1: Access is denied');
});

await test('an error that is not a capture failure is passed through untouched', () => {
  const original = new Error('something else entirely');
  assert.equal(captureFailureError(original, 'en'), original);
});

process.stdout.write('\nlive capture\n');

// Every capture the suite takes goes here, never to the plugin's real output
// directory. A test that writes PNGs of the user's screen into their harness
// home is a test that leaves their data behind, and the default output
// directory is exactly that — so it is overridden, and the directory is
// removed again below.
const liveDir = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-test-'));
const liveSettings = { requireImageCapableModel: false, outputDir: liveDir };

/**
 * Whether this machine can actually look at its own screen right now.
 *
 * Two platforms, two very different reasons to say no, and the same rule for
 * both: ask the platform rather than guess. macOS answers with its consent
 * model; Windows, which has no consent to give, answers by listing displays,
 * which is the first thing that fails on a session with no visible desktop.
 * @returns whether live captures can run, and why not when they cannot.
 */
async function liveCaptureAvailable() {
  if (ON_MACOS) {
    const probe = await probeScreenRecording();
    return probe.authorized
      ? { ok: true }
      : { ok: false, reason: `Screen Recording not granted (${probe.reason})` };
  }
  try {
    await platformFor().listDisplays({});
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

const live = await liveCaptureAvailable();
if (!live.ok) {
  process.stdout.write(`  skip live capture — ${live.reason}\n`);
} else {
  await test('captures the real screen and commits an image attachment', async () => {
    const attachments = stubAttachments();
    const tool = screenshotTool(stubCtx({ attachments }), resolveSettings(liveSettings));
    const value = await tool.execute({ mode: 'screen' }, stubExec());
    assert.match(value.path, /\.png$/u);
    assert.ok(value.path.startsWith(liveDir), 'the capture must land in the test directory');
    assert.equal(value.mode, 'screen');
    assert.equal(attachments.saved.length, 1);
    assert.equal(attachments.saved[0].mediaType, 'image/png');
    assert.ok(attachments.saved[0].bytes > 1000, 'a real screen capture is not tiny');
    const blocks = tool.output.render({}, value);
    assert.equal(blocks[1].type, 'image');
  });

  await test('captures a region with mode=region', async () => {
    const attachments = stubAttachments();
    const tool = screenshotTool(stubCtx({ attachments }), resolveSettings(liveSettings));
    const value = await tool.execute({ mode: 'region', region: '0,0,320,240' }, stubExec());
    assert.equal(value.mode, 'region');
    assert.equal(attachments.saved.length, 1);
  });

  await test('prunes old captures on disk but never the one just taken', async () => {
    // Its own directory: the live captures the cases above already took are
    // newer than the seeds below, so sharing `liveDir` would make the
    // assertion depend on their names rather than on the rule being tested.
    const pruneDir = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-prune-'));
    try {
      for (let index = 0; index < 6; index += 1) {
        const when = new Date(Date.UTC(2020, 0, 1, 0, 0, index));
        await writeFile(join(pruneDir, buildCaptureName(when, `abcde${index}`)), 'x');
      }
      const settings = resolveSettings({ ...liveSettings, outputDir: pruneDir, keepRecent: 2 });
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), settings);
      const value = await tool.execute({ mode: 'region', region: '0,0,16,16' }, stubExec());

      const left = (await readdir(pruneDir)).filter(isCaptureName).sort();
      // The new capture is the newest file, so it is inside the kept window
      // rather than an extra survivor: the directory ends at the cap.
      assert.equal(left.length, 2, `expected the cap to hold, saw ${left.length}`);
      assert.ok(
        left.includes(basename(value.path)),
        'pruning must never delete the capture it just returned',
      );
      assert.equal(left[0], buildCaptureName(new Date(Date.UTC(2020, 0, 1, 0, 0, 5)), 'abcde5'));
    } finally {
      await rm(pruneDir, { recursive: true, force: true });
    }
  });

  await test('a capture directed elsewhere never prunes that directory', async () => {
    // A caller-supplied `path` may point at a directory the caller keeps for
    // other reasons. Retention is scoped to the configured output directory,
    // so nothing there may be touched even when the cap is exceeded — the
    // files below are capture-shaped on purpose, to prove the scope rather
    // than the name filter is what protects them.
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-elsewhere-'));
    try {
      for (let index = 0; index < 5; index += 1) {
        const when = new Date(Date.UTC(2020, 0, 1, 0, 0, index));
        await writeFile(join(elsewhere, buildCaptureName(when, 'fedcba')), 'x');
      }
      const tool = screenshotTool(
        stubCtx({ attachments: stubAttachments() }),
        resolveSettings({ ...liveSettings, keepRecent: 1 }),
      );
      const value = await tool.execute(
        { mode: 'region', region: '0,0,16,16', path: join(elsewhere, 'named-by-the-caller.png') },
        stubExec(),
      );
      assert.equal(value.path, join(elsewhere, 'named-by-the-caller.png'));
      const left = (await readdir(elsewhere)).sort();
      assert.equal(left.length, 6, `the target directory must be left alone, saw ${left.length}`);
      assert.ok(left.includes('named-by-the-caller.png'));
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  await test('refuses a capture whose longest side exceeds the maximum', async () => {
    // The guard has to be exercised or it is not a guard: the default cap is
    // unreachable on current hardware, so the case lowers it deliberately and
    // checks that the refusal names the real size, the cap, and the remedy.
    const tool = screenshotTool(
      stubCtx({ attachments: stubAttachments() }),
      resolveSettings({ ...liveSettings, maxDimension: 16 }),
    );
    await assert.rejects(
      () => tool.execute({ mode: 'region', region: '0,0,64,48' }, stubExec()),
      (error) => {
        assert.match(error.message, /64x48/u);
        assert.match(error.message, /16px limit/u);
        assert.match(error.message, /8192/u, 'the message must explain where the provider cap is');
        assert.match(error.message, /capture a region or a single display/u);
        return true;
      },
    );
  });

  await test('accepts a capture that fits the maximum', async () => {
    const settings = resolveSettings({ ...liveSettings, maxDimension: 4096 });
    const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), settings);
    const value = await tool.execute({ mode: 'region', region: '0,0,64,48' }, stubExec());
    assert.equal(value.mode, 'region');
  });

  await test('takes a real burst and returns every frame in one call', async () => {
    const attachments = stubAttachments();
    const tool = screenshotTool(
      stubCtx({ attachments }),
      resolveSettings({ ...liveSettings, keepRecent: 0 }),
    );
    const value = await tool.execute(
      { mode: 'region', region: '0,0,320,200', frames: 3, interval_ms: 200 },
      stubExec(),
    );

    assert.equal(value.frames.length, 3);
    assert.equal(value.image, undefined, 'a burst reports frames, not one image');
    assert.equal(attachments.saved.length, 3, 'every frame must be committed');
    assert.ok(Number.isInteger(value.spacingMs), 'the achieved spacing must be reported');

    // A capture costs about 170ms, so a 200ms target is meetable; the check is
    // loose enough not to flake on a loaded machine but tight enough to catch a
    // burst that ignored the interval or serialised far slower than measured.
    assert.ok(
      value.spacingMs >= 150 && value.spacingMs <= 1200,
      `achieved spacing was ${value.spacingMs}ms`,
    );
    if (ON_WINDOWS) {
      // The upper bound that matters here is much tighter than the one above:
      // a Windows capture costs about a second of PowerShell start, so a burst
      // spaced at anything near that would mean the frames were taken as
      // separate engine calls — which is exactly what captureBurst exists to
      // avoid, and what the interval this tool advertises cannot survive.
      assert.ok(
        value.spacingMs <= 700,
        `a burst must be one engine call on Windows; the spacing was ${value.spacingMs}ms`,
      );
    }

    const names = value.frames.map((frame) => basename(frame.path));
    assert.equal(new Set(names).size, 3, 'each frame needs its own file');
    assert.ok(
      names.every(isCaptureName),
      'frames must keep the shape retention recognises, or a burst would grow without bound',
    );

    const blocks = tool.output.render({}, value);
    assert.equal(blocks.length, 4, 'one text envelope and three images');

    // The shape a real burst produces, checked against the declaration the
    // harness will hold it to.
    assert.deepEqual(validateJsonSchemaValue(compiledOutput(tool), value), []);
  });

  await test('lists the connected displays in the order the capture index numbers them', async (skip) => {
    // Deliberately built with the default settings and an execution context
    // carrying no agent at all: the inventory returns no image, so it must not
    // be gated on the calling route being able to see one.
    const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
    let value;
    try {
      value = await tool.execute({ mode: 'displays' }, stubExec());
    } catch (error) {
      // A headless CI runner reports no displays at all, which is a fact about
      // the environment and not about the ordering under test — the pure cases
      // above already cover that.
      if (/listed no displays/u.test(error.message)) {
        skip(`this machine reports no display inventory (${error.message})`);
        return;
      }
      throw error;
    }

    assert.equal(value.mode, 'displays');
    assert.ok(Array.isArray(value.displays) && value.displays.length >= 1);
    // -D numbers the main display 1, so the list must lead with it and be
    // contiguous from 1 — that is the whole contract this mode exists for.
    assert.equal(value.displays[0].main, true, 'the first entry must be the main display');
    assert.deepEqual(
      value.displays.map((display) => display.index),
      value.displays.map((_, position) => position + 1),
    );
    assert.ok(value.displays.every((display) => typeof display.name === 'string' && display.name !== ''));

    const blocks = tool.output.render({}, value);
    assert.equal(blocks.length, 1, 'an inventory carries no image');
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /<displays count=\d+>/u);
  });

  await test('refuses a capture the engine cannot take, instead of writing an empty file', async () => {
    await assert.rejects(
      () => captureScreen(planCapture({ mode: 'display', display: 99 }), {
        outputPath: join(liveDir, 'should-not-exist.png'),
        signal: new AbortController().signal,
        timeoutMs: 20000,
      }),
      (error) => error instanceof CaptureError,
    );
  });

  if (ON_WINDOWS) {
    // The three cases below exist because Windows is the platform where the
    // engine's own claims are hardest to check from anywhere else: a
    // DPI-unaware process silently captures a downscaled copy of the screen,
    // the display index has to mean the same thing to the inventory and to the
    // capture, and the pointer is not in the pixels unless it is drawn there.
    const inventoryOf = async () => {
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
      return tool.execute({ mode: 'displays' }, stubExec());
    };

    await test('captures the desktop at its true pixel size, not a scaled copy', async () => {
      // The reason this is a case and not a comment: on a 3840x2160 panel at
      // 125% scaling, a DPI-unaware engine returns 3072x1728 and every text
      // measurement taken from the image is 25% wrong. Asserted against the
      // inventory rather than against a constant, so it holds on any machine.
      const inventory = await inventoryOf();
      const primary = inventory.displays[0];
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      const value = await tool.execute({ mode: 'screen' }, stubExec());

      const size = pngDimensions(await readFile(value.path));
      assert.equal(size.width, primary.width, 'the capture must match the desktop width');
      assert.equal(size.height, primary.height, 'the capture must match the desktop height');
      // A live desktop is not a black frame, and the engine's own check must
      // not cry wolf on one — a note here would be reported to the model as a
      // capture it cannot trust.
      assert.equal(value.note, undefined, 'a real desktop must not be reported as a black frame');
    });

    await test('captures the display whose index the inventory handed out', async () => {
      const inventory = await inventoryOf();
      const primary = inventory.displays[0];
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      const value = await tool.execute({ mode: 'display', display: primary.index }, stubExec());
      const size = pngDimensions(await readFile(value.path));
      assert.equal(size.width, primary.width);
      assert.equal(size.height, primary.height);

      // The other half of that contract: an index no display has is refused by
      // name, rather than capturing something else or nothing.
      await assert.rejects(
        () => tool.execute({ mode: 'display', display: 97 }, stubExec()),
        /display 97 does not exist/u,
      );
    });

    await test('captures only what the screen shows where the region asks', async () => {
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      const value = await tool.execute({ mode: 'region', region: '16,24,320,240' }, stubExec());
      assert.deepEqual(pngDimensions(await readFile(value.path)), { width: 320, height: 240 });

      // A region that covers no display is refused with the desktop it missed,
      // because CopyFromScreen does not fail there — it returns a black frame.
      await assert.rejects(
        () => tool.execute({ mode: 'region', region: '-9000,-9000,64,64' }, stubExec()),
        (error) => {
          assert.match(error.message, /does not overlap any display/u);
          assert.match(error.message, /this desktop spans/u);
          return true;
        },
      );
    });

    await test('says out loud when a frame is black almost everywhere', async () => {
      // A rectangle overlapping the desktop by a single pixel: the rest of it
      // is black, which is the same frame a locked or disconnected session
      // produces, and it is the only way to produce one deliberately — locking
      // the machine to exercise a diagnostic would be a worse idea than the
      // diagnostic is good. The point of the case is that the picture is still
      // returned rather than withheld, and that the model is told why it may be
      // looking at nothing.
      const inventory = await inventoryOf();
      const primary = inventory.displays[0];
      const region = `${primary.x + primary.width - 1},${primary.y + primary.height - 1},100,100`;
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      const value = await tool.execute({ mode: 'region', region }, stubExec());

      assert.match(value.note, /entirely black/u);
      // The picture is still returned, at the size that was asked for: a note
      // is an observation, not a refusal.
      assert.deepEqual(pngDimensions(await readFile(value.path)), { width: 100, height: 100 });
      const [envelope] = tool.output.render({}, value);
      assert.match(envelope.text, /<note>/u);
      assert.deepEqual(validateJsonSchemaValue(compiledOutput(tool), value), []);
    });

    await test('captures the window in the foreground, inside the desktop', async () => {
      const inventory = await inventoryOf();
      // The bound is the whole virtual desktop, not the primary display: with
      // two screens a foreground window may sit on the other one, straddle the
      // seam, or be wider than the main screen — all of which are captures of a
      // real window. What must never happen is a capture reaching outside the
      // desktop, because that is where the pixels stop being the screen.
      const displays = inventory.displays;
      const left = Math.min(...displays.map((display) => display.x));
      const top = Math.min(...displays.map((display) => display.y));
      const right = Math.max(...displays.map((display) => display.x + display.width));
      const bottom = Math.max(...displays.map((display) => display.y + display.height));

      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      const value = await tool.execute({ mode: 'window' }, stubExec());
      const size = pngDimensions(await readFile(value.path));
      // A maximised window reports a rectangle about eight pixels larger than
      // its screen on every side, so this is the clamp being checked: a capture
      // may be smaller than the desktop and must never be larger.
      assert.ok(
        size.width <= right - left && size.height <= bottom - top,
        `the window capture is ${size.width}x${size.height}, outside the ${right - left}x${bottom - top} desktop`,
      );
      assert.ok(size.width > 0 && size.height > 0);

      // Windows' `window` waits for nobody, so unlike macOS's it can be
      // repeated — and the rectangle is resolved once, before the loop, so every
      // frame of the burst covers the same window.
      const burst = await tool.execute({ mode: 'window', frames: 2, interval_ms: 300 }, stubExec());
      assert.equal(burst.frames.length, 2);
      for (const frame of burst.frames) {
        const size2 = pngDimensions(await readFile(frame.path));
        assert.ok(size2.width === size.width && size2.height === size.height);
      }
    });

    await test('draws the pointer when it was asked for, and says what it did', async () => {
      // `CopyFromScreen` never includes the cursor, so `include_cursor` is a
      // claim about this code path and nothing else. The engine reports the
      // result of the draw: 0 is DrawIconEx succeeding, -2 is a pointer that
      // Windows says is not showing, and the negative codes beyond that are
      // failures the tool turns into a note.
      //
      // -2 is a real answer rather than a failure, and it is the one this
      // machine gives while the pointer is parked and Windows reports it
      // hidden — observed as "showing=False at 2167,1984". So the case accepts
      // it and requires the note to match what was reported, rather than
      // assuming a visible pointer.
      const plan = planCapture({ mode: 'region', region: '0,0,240,180', include_cursor: true });
      const path = join(liveDir, 'cursor.png');
      const result = await run(powershellPath(), powershellArgs(captureScript(plan, path)));
      const parsed = parseScriptResult(result.stdout);
      assert.equal(parsed.ok, true, result.stderr.trim());
      assert.ok(
        parsed.cursorDrawn === 0 || parsed.cursorDrawn === -2,
        `the pointer draw reported ${parsed.cursorDrawn}`,
      );
      const notes = notesForFrame(parsed);
      assert.equal(
        notes.length,
        parsed.cursorDrawn === 0 ? 0 : 1,
        'a pointer that was drawn is not a note, and one that was not is',
      );

      // And the same capture without the pointer asked for reports nothing at
      // all, which is what tells the two branches apart.
      const without = planCapture({ mode: 'region', region: '0,0,240,180' });
      const plain = parseScriptResult((await run(
        powershellPath(),
        powershellArgs(captureScript(without, join(liveDir, 'no-cursor.png'))),
      )).stdout);
      assert.equal(plain.cursorDrawn, null);
      assert.deepEqual(notesForFrame(plain), []);
    });

    await test('captures every numbered display, including one left of the main', async (skip) => {
      // The multi-display path, which is the one part of the Windows engine a
      // single-screen machine cannot exercise — and the part macOS needed a
      // second screen to prove. When one is attached: every index the inventory
      // hands out captures that display at its own size, a region addressed with
      // a display's own origin lands on it (negative x when it sits left of the
      // main screen), and a rectangle off the desktop is refused.
      const inventory = await inventoryOf();
      if (inventory.displays.length < 2) {
        skip(`this machine reports ${inventory.displays.length} display(s)`);
        return;
      }
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      for (const display of inventory.displays) {
        const value = await tool.execute({ mode: 'display', display: display.index }, stubExec());
        const size = pngDimensions(await readFile(value.path));
        assert.deepEqual(
          size,
          { width: display.width, height: display.height },
          `display ${display.index} (${display.name}) captured as ${size.width}x${size.height}`,
        );
      }

      const second = inventory.displays[1];
      const region = `${second.x},${second.y},320,240`;
      const value = await tool.execute({ mode: 'region', region }, stubExec());
      assert.deepEqual(pngDimensions(await readFile(value.path)), { width: 320, height: 240 });

      // A rectangle a little further out than the whole desktop is refused, and
      // the message names the desktop's real span rather than the main
      // display's — which is how a caller learns where a second screen starts.
      await assert.rejects(
        () => tool.execute({ mode: 'region', region: `${second.x - 200},${second.y},64,64` }, stubExec()),
        (error) => {
          assert.match(error.message, /does not overlap any display/u);
          return true;
        },
      );
    });

    await test('refuses mode "select" by name rather than capturing something else', async () => {
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      await assert.rejects(
        () => tool.execute({ mode: 'select' }, stubExec()),
        (error) => {
          assert.match(error.message, /no Windows equivalent/u);
          assert.match(error.message, /mode "region"/u);
          return true;
        },
      );
    });
  }
}

process.stdout.write('\nplatform gate\n');

await test('serves darwin and win32, and nothing else', () => {
  assert.equal(isSupportedPlatform('darwin'), true);
  assert.equal(isSupportedPlatform('win32'), true);
  assert.equal(isSupportedPlatform('linux'), false);
  assert.equal(isSupportedPlatform('freebsd'), false);
  assert.deepEqual(supportedPlatforms().sort(), ['darwin', 'win32']);
});

await test('the manifest platform gate agrees with the engine registry', async () => {
  // The boundary is written where it cannot be derived: the patch's `!!js`
  // expression is evaluated by the loader, which has no access to the module,
  // and the engine registry lives in the module. Two hand-maintained copies of
  // one fact is how a plugin ends up enabled on a platform it cannot serve —
  // which is the failure this project has been careful about elsewhere. So the
  // expression is evaluated here and compared against the registry.
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const expression = /disabled:\s*!!js\s+(.+)$/mu.exec(patch);
  assert.ok(expression, 'the bundle patch must carry a platform gate');
  // Evaluating our own repository's expression: the only way to be sure of what
  // the loader will conclude from it is to ask it the same question.
  const disabledOn = new Function('process', `return Boolean(${expression[1].trim()})`);

  for (const platform of ['darwin', 'win32', 'linux', 'freebsd']) {
    assert.equal(
      disabledOn({ platform }),
      !isSupportedPlatform(platform),
      `the patch and the engine registry disagree about ${platform}`,
    );
  }
  assert.ok(
    ['darwin', 'win32', 'linux'].some((platform) => isSupportedPlatform(platform)),
    'a gate that never opens is not a gate',
  );
});

await test('the bundle patch gates the module on the platform', async () => {
  // The gate must sit in the patch, not only in apply(): that is what stops
  // the module being imported at all on a host with no engine.
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /disabled:\s*!!js\s+process\.platform\s*!==\s*'darwin'\s*&&\s*process\.platform\s*!==\s*'win32'/u);
  assert.match(patch, /name:\s*dsh-screen-eye/u);
});

await test('the package stays installable and publishable', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  // Declaring only `dsh.client` is the single most common reason a plugin is
  // rejected by the market: `dsh.bundle` is what makes it installable.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    // docs/ is in the list because both READMEs link into it: dropping it would
  // publish a package whose own documentation links point at nothing.
  for (const required of ['index.mjs', 'lib/', 'docs/', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(required), `${required} must ship in the tarball`);
  }
  assert.equal(manifest.main, 'index.mjs');
});

process.stdout.write('\nthe platform seam\n');

await test('no OS-specific module is reached from outside the seam', async () => {
  // A seam survives exactly until the next convenient import. Reading the
  // permission module from a tool is easier than threading the platform model
  // through it, and every such shortcut is one more place a port has to find —
  // which is the failure this refactor exists to prevent. So the real import
  // graph is walked rather than the rule being trusted.
  const osSpecific = ['permission.mjs', 'displays.mjs', 'platform/darwin.mjs', 'platform/win32.mjs'];
  const allowed = new Set(['lib/platform.mjs', 'lib/platform/darwin.mjs', 'lib/platform/win32.mjs']);

  const libDir = new URL('../lib/', import.meta.url);
  const platformDir = new URL('../lib/platform/', import.meta.url);
  const files = [
    'index.mjs',
    ...(await readdir(libDir)).filter((name) => name.endsWith('.mjs')).map((name) => `lib/${name}`),
    ...(await readdir(platformDir)).filter((name) => name.endsWith('.mjs')).map((name) => `lib/platform/${name}`),
  ];

  const offenders = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/gu)) {
      if (osSpecific.some((name) => specifier.endsWith(name))) {
        offenders.push(`${file} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `OS-specific modules are reachable from outside the seam:\n  ${offenders.join('\n  ')}`,
  );
});

await test('every registered platform implements the whole contract', () => {
  // A half-implemented platform is worse than an absent one: it passes the
  // gate and fails at the first call. The contract is described in
  // lib/platform.mjs; this is the part of it a machine can check.
  assert.ok(supportedPlatforms().length > 0, 'a registry with no platforms serves nobody');
  for (const id of supportedPlatforms()) {
    const platform = platformFor(id);
    assert.equal(platform.id, id, 'a platform must report the id it is registered under');
    for (const method of ['capture', 'listDisplays']) {
      assert.equal(typeof platform[method], 'function', `${id} does not implement ${method}()`);
    }
    // Optional by the contract: a platform that leaves it out is driven by the
    // frame-by-frame loop in lib/capture.mjs.
    if (platform.captureBurst !== undefined) {
      assert.equal(typeof platform.captureBurst, 'function', `${id} declares a captureBurst that is not one`);
    }
    assert.ok('permission' in platform, `${id} does not declare permission, not even as null`);
    if (platform.permission !== null) {
      for (const method of ['probe', 'openSettings', 'grantTarget', 'guidance', 'describeFailure']) {
        assert.equal(
          typeof platform.permission[method],
          'function',
          `${id} declares a permission but does not implement ${method}()`,
        );
      }
    }
    // The briefing is what the tool tells the model about this system. An
    // empty field is worse than absent: the description would read as if the
    // platform had nothing to say about its own permission model.
    for (const field of ['surface', 'consent', 'interactive', 'timing']) {
      assert.equal(
        typeof platform.briefing?.[field],
        'string',
        `${id} does not brief the model on ${field}`,
      );
      assert.ok(platform.briefing[field].trim().length > 0, `${id}'s ${field} briefing says nothing`);
    }
    // The timing briefing is a measurement, and it is what tells the model
    // whether an interval it is about to ask for is reachable at all.
    assert.match(platform.briefing.timing, /\d+\s?ms/u, `${id}'s timing briefing carries no measurement`);
    // Which modes wait for a person decides whether a burst is refused, so a
    // platform that forgot to say would get the other system's answer.
    assert.ok(platform.interactiveModes instanceof Set, `${id} does not say which modes are interactive`);
    for (const mode of platform.interactiveModes) {
      assert.ok(CAPTURE_MODES.includes(mode), `${id} calls "${mode}" interactive, which is not a mode`);
    }
  }
});

await test('the modes that wait for a person are the ones that really do', () => {
  // A mode that waits cannot be repeated unattended, so this set decides whether
  // a burst is refused — and the two systems answer differently: macOS's
  // `window` waits for a click, Windows' captures the window already in front.
  assert.deepEqual([...darwin.interactiveModes].sort(), ['select', 'window']);
  assert.deepEqual([...win32.interactiveModes], ['select']);
  // The default in lib/capture.mjs is macOS's set, which is what keeps a caller
  // that consults no platform on the conservative answer. Pinned here so the
  // hand-written copy in darwin.mjs cannot drift away from it.
  assert.deepEqual([...darwin.interactiveModes].sort(), [...INTERACTIVE_MODES].sort());

  // And it is planning that has to hear it: a window burst is refused with the
  // macOS set and allowed with the Windows one.
  assert.throws(
    () => planCapture({ mode: 'window', frames: 3 }),
    /waits for the user to choose/u,
  );
  assert.equal(
    planCapture({ mode: 'window', frames: 3 }, { interactiveModes: win32.interactiveModes }).frames,
    3,
  );
  // `select` is refused either way, because it waits on both.
  for (const interactiveModes of [INTERACTIVE_MODES, win32.interactiveModes]) {
    assert.throws(() => planCapture({ mode: 'select', frames: 3 }, { interactiveModes }), /waits/u);
  }
});

await test('asking for an unserved platform is a bug, and says so', () => {
  // The gate in index.mjs is supposed to make this unreachable, so the error
  // names what is served rather than being handled as a runtime condition.
  assert.throws(() => platformFor('plan9'), /no implementation for platform "plan9"/u);
  assert.match(
    (() => { try { platformFor('plan9'); } catch (error) { return error.message; } })(),
    new RegExp(supportedPlatforms().join('|'), 'u'),
  );
});

process.stdout.write('\nthe windows engine\n');

await test('maps each mode onto the rectangle Windows should read', () => {
  // The Windows counterpart of the `screencaptureArgs` case: the part of the
  // engine worth asserting without capturing anything. It runs on every
  // platform, which is the point — macOS CI checks the Windows mapping too.
  const screen = captureScript(planCapture({ mode: 'screen' }), 'C:\\shots\\a.png');
  assert.match(screen, /\$rect = \$primary\.Bounds/u);

  const display = captureScript(planCapture({ mode: 'display', display: 2 }), 'C:\\shots\\a.png');
  assert.match(display, /\$rect = \$ordered\[2 - 1\]\.Bounds/u);
  assert.match(display, /does not exist/u, 'an index no display has must be refused by name');

  const region = captureScript(planCapture({ mode: 'region', region: '-1920,0,800,600' }), 'C:\\shots\\a.png');
  assert.match(region, /New-Object System\.Drawing\.Rectangle -1920, 0, 800, 600/u);
  // A rectangle that misses every display is refused with the desktop it
  // missed, because CopyFromScreen returns a black frame rather than failing.
  assert.match(region, /does not overlap any display/u);

  const window = captureScript(planCapture({ mode: 'window' }), 'C:\\shots\\a.png');
  assert.match(window, /ForegroundWindowRect/u);
  assert.match(window, /Intersect/u, 'the window rectangle must be clamped to the desktop');
});

await test('refuses mode "select" instead of capturing something else', () => {
  const script = captureScript(planCapture({ mode: 'select' }), 'C:\\shots\\a.png');
  assert.match(script, /Fail 'unsupported-mode'/u);
  assert.match(script, /no Windows equivalent/u);
  // The remedy has to be in the message, or the model is told no without being
  // told what to do instead.
  assert.match(script, /mode "region"/u);
});

await test('the engine refuses a session with no visible desktop', () => {
  // The hazard the platform documentation names: a process that is not
  // attached to the interactive window station gets a black frame from
  // CopyFromScreen rather than an error, and a naive engine reports that as a
  // successful capture of a black screen.
  for (const script of [captureScript(planCapture({ mode: 'screen' }), 'C:\\a.png'), displaysScript()]) {
    assert.match(script, /WindowStationName/u);
    assert.match(script, /WinSta0/u);
    assert.match(script, new RegExp(NO_SESSION, 'u'));
  }
});

await test('declares DPI awareness before it asks Windows about the desktop', () => {
  // Order is the whole point: `Screen.AllScreens` caches on first touch, so an
  // engine that enumerated first and declared awareness afterwards would keep
  // reporting — and capturing — the virtualised size for the life of the
  // process. Measured on a 3840x2160 panel at 125%: 3072x1728 before, 3840x2160
  // after.
  const script = captureScript(planCapture({ mode: 'screen' }), 'C:\\a.png');
  const awareness = script.indexOf('MakeDpiAware');
  const enumeration = script.indexOf('System.Windows.Forms.Screen');
  assert.ok(awareness > 0 && enumeration > 0);
  assert.ok(awareness < enumeration, 'DPI awareness must be declared before the screens are read');
});

await test('quotes an output path that would otherwise break the script', () => {
  // A path is interpolated into PowerShell source, and PowerShell's own
  // single-quote rule is the only escaping that matters inside one. A capture
  // directory named `it's mine` must not turn the script into a syntax error.
  const script = captureScript(planCapture({ mode: 'screen' }), "C:\\shots\\it's mine\\a.png");
  assert.match(script, /Save-Frame \$rect 'C:\\shots\\it''s mine\\a\.png'/u);
});

await test('hands the script to PowerShell without a quoting rule to escape from', () => {
  const script = captureScript(planCapture({ mode: 'screen' }), 'C:\\a.png');
  const args = powershellArgs(script);
  assert.ok(args.includes('-NonInteractive'), 'the engine must never wait on a prompt');
  assert.equal(args.at(-2), '-EncodedCommand');
  // Base64 of UTF-16LE, which is what `-EncodedCommand` decodes: the check is
  // the round trip, not the encoding choice.
  const decoded = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.equal(decoded, script);
});

await test('a burst is one engine call with one path per frame', () => {
  const plan = planCapture({ mode: 'region', region: '0,0,64,48', frames: 3, interval_ms: 250 });
  const paths = ['C:\\shots\\a-1.png', 'C:\\shots\\a-2.png', 'C:\\shots\\a-3.png'];
  const script = burstScript(plan, paths);
  for (const path of paths) assert.ok(script.includes(`'${path}'`), `${path} is missing from the burst`);
  assert.match(script, /\$interval = 250/u);
  // One shim, one rectangle, one process: that is what makes the interval
  // reachable on a platform where a call costs about a second. The shim source
  // appears once however it is loaded — from the cache, compiled into it, or in
  // memory as the last resort.
  assert.equal(script.match(/\$nativeSource = @'/gu).length, 1);
  assert.equal(script.match(/Save-Frame \$rect \$path/gu).length, 1);
});

await test('reads the one marked result line, whatever else is on stdout', () => {
  const payload = { ok: true, blackPermille: 1 };
  assert.deepEqual(parseScriptResult(`${RESULT_MARKER} ${JSON.stringify(payload)}\r\n`), payload);
  // A warning printed first must not be mistaken for the answer, and the last
  // marked line is the answer if a script ever prints two.
  const noisy = `WARNING: something\n${RESULT_MARKER} {"ok":false,"kind":"x"}\n${RESULT_MARKER} ${JSON.stringify(payload)}`;
  assert.deepEqual(parseScriptResult(noisy), payload);
  // A script that died before printing one produced no answer, which is not
  // the same as an empty success.
  assert.equal(parseScriptResult(''), undefined);
  assert.equal(parseScriptResult('some error text\n'), undefined);
  assert.equal(parseScriptResult(`${RESULT_MARKER} {not json}`), undefined);
});

await test('orders displays the way the capture engine numbers them', () => {
  // Same rule as the macOS inventory, and the same reason for a pure case: the
  // ordering is what makes `display` usable, and a CI runner cannot show it.
  const ordered = displaysFromScreens({
    screens: [
      { device: '\\\\.\\DISPLAY2', primary: false, x: 3840, y: 0, width: 2560, height: 1440 },
      { device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, width: 3840, height: 2160 },
    ],
  });
  assert.deepEqual(ordered.map((display) => display.index), [1, 2]);
  assert.equal(ordered[0].name, '\\\\.\\DISPLAY1');
  assert.equal(ordered[0].main, true);
  // The origin is what makes a region on a second screen expressible, so it
  // has to survive the sort with its own display.
  assert.deepEqual(
    { x: ordered[1].x, y: ordered[1].y, width: ordered[1].width },
    { x: 3840, y: 0, width: 2560 },
  );
});

await test('reports a display Windows did not name, and refuses an empty inventory', () => {
  const [unnamed] = displaysFromScreens({ screens: [{ primary: true }] });
  assert.equal(unnamed.name, 'unknown display');
  assert.equal(unnamed.width, undefined, 'a size that was not reported must not be invented');
  // An empty inventory means the reading failed. Reporting "no displays" would
  // be the plugin asserting something it never observed.
  assert.throws(() => displaysFromScreens({ screens: [] }), /listed no displays/u);
  assert.throws(() => displaysFromScreens({}), /listed no displays/u);
});

await test('says when a captured frame is black, and says nothing otherwise', () => {
  // The black-frame report is the answer to the one hazard the platform
  // documentation names, so both directions are asserted: it fires on a frame
  // that is all black, and it stays quiet on a frame that is not — a false
  // positive would put a warning on every capture a user takes.
  const black = notesForFrame({ blackPermille: BLACK_FRAME_PERMILLE, dpiAware: true });
  assert.equal(black.length, 1);
  assert.match(black[0], /entirely black/u);
  assert.match(black[0], /locked/u, 'the message must name the likely causes');
  assert.match(black[0], /If the screen really is black/u, 'and must not claim more than it knows');

  assert.deepEqual(notesForFrame({ blackPermille: 4, dpiAware: true }), []);
  assert.deepEqual(notesForFrame({ blackPermille: BLACK_FRAME_PERMILLE - 1, dpiAware: true }), []);

  const scaled = notesForFrame({ blackPermille: 3, dpiAware: false });
  assert.equal(scaled.length, 1);
  assert.match(scaled[0], /scaled down/u);

  // A pointer that was asked for and refused is worth a note; one that was
  // never asked for is not.
  assert.deepEqual(notesForFrame({ blackPermille: 3, dpiAware: true, cursorDrawn: null }), []);
  assert.equal(notesForFrame({ blackPermille: 3, dpiAware: true, cursorDrawn: -3 }).length, 1);
});

await test('the engine path is the PowerShell every Windows install has', () => {
  // `powershell.exe` rather than `pwsh`: 5.1 is the one that is always there,
  // and it is STA by default, which is what the WinForms enumeration wants.
  // Asserted as a shape rather than as an absolute path, because the system
  // drive is a choice the installer made.
  assert.match(powershellPath(), /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/u);
  assert.ok(powershellPath().startsWith(process.env.SystemRoot ?? 'C:\\Windows'));
});

await test('the compiled shim is cached, and the cache can only ever help', () => {
  // Compiling the C# costs ~176ms of every engine call and loading it costs
  // ~20ms, measured; each capture is a fresh process, so without a cache a
  // burst pays the compile per frame. The cache is asserted as a shape: where
  // it lives, that its name follows its source, and — the part that matters —
  // that every failure path in the loader ends in the in-memory compile that
  // was the only path before the cache existed.
  const path = shimCachePath();
  assert.ok(path.startsWith(tmpdir()), 'a cache outside the temporary directory is not a cache');
  assert.match(path, /dsh-screen-eye-shim[\\/]native-[0-9a-f]{16}\.dll$/u);

  const script = captureScript(planCapture({ mode: 'screen' }), 'C:\\a.png');
  assert.ok(script.includes(`$shim = '${path}'`), 'the script must look in the cache it was told about');
  assert.match(script, /Add-Type -Path \$shim/u, 'the fast path loads the compiled assembly');
  assert.match(script, /-OutputAssembly \$staged/u, 'a miss compiles into the cache');
  assert.match(script, /Test-Path \$shim/u);
  // The guard that decides whether any of that worked, and the fallback behind
  // it: the type is looked up by name, and the old in-memory compile runs when
  // it is not there. Without that, a read-only or full temporary directory
  // would turn a working capture into a broken one.
  assert.match(script, /PSTypeName\]'DshScreenEye\.Native'\)\.Type/u);
  assert.match(script, /catch \{ Fail 'engine-unavailable'/u);
  // Two compiles of that one source, in this order: into the cache, and — if
  // none of that worked — in memory, which is what the engine did before there
  // was a cache at all.
  assert.equal(script.match(/-MemberDefinition \$nativeSource -OutputAssembly \$staged/gu)?.length, 1);
  assert.equal(script.match(/-MemberDefinition \$nativeSource -ErrorAction Stop/gu)?.length, 1);
  assert.ok(
    script.indexOf('-OutputAssembly $staged') < script.indexOf("PSTypeName]'DshScreenEye.Native'"),
    'the cache attempt must come before the check that decides whether it worked',
  );
  // The source travels in the cache name, so a changed shim cannot be served
  // from a stale assembly.
  assert.equal(shimCachePath(), path, 'the cache path is a function of the source alone');
});

await test('a platform says whether it can take a whole burst in one call', () => {
  // The optional half of the contract, asserted in both directions: Windows
  // pays about a second of process start per call and takes the burst in one
  // process, while macOS pays per frame and is driven by the frame-by-frame
  // loop — which is the baseline the loop exists to be.
  assert.equal(typeof win32.captureBurst, 'function');
  assert.equal(darwin.captureBurst, undefined);
});

await test('a frame with a note reaches the model beside its image', () => {
  // The note is not decoration: a platform's capture can succeed and still be
  // unusable, and the model has to be told which. It rides in the text
  // envelope, next to the image block, and a capture without one renders
  // exactly as it did before there was such a field.
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  const shape = screenshotShapes()['one capture'];
  const [plain] = tool.output.render({}, shape);
  assert.doesNotMatch(plain.text, /<note>/u);

  const [annotated] = tool.output.render({}, { ...shape, note: 'this capture came back entirely black.' });
  assert.match(annotated.text, /<note>this capture came back entirely black\.<\/note>/u);
  assert.deepEqual(
    validateJsonSchemaValue(compiledOutput(tool), { ...shape, note: 'anything at all' }),
    [],
    'a value carrying a note must still satisfy the declared schema',
  );

  const burst = screenshotShapes()['a burst'];
  const [envelope] = tool.output.render({}, { ...burst, note: 'every frame was black.' });
  assert.match(envelope.text, /<note>every frame was black\.<\/note>/u);
  assert.deepEqual(validateJsonSchemaValue(compiledOutput(tool), { ...burst, note: 'x' }), []);
});

await test('a display origin reaches the model when the platform reports one', () => {
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  const [macos] = tool.output.render({}, screenshotShapes()['a display inventory']);
  assert.doesNotMatch(macos.text, / at /u, 'macOS reports no origin, so none may appear');
  const [windows] = tool.output.render({}, {
    mode: 'displays',
    displays: [{ index: 2, name: '\\\\.\\DISPLAY2', width: 2560, height: 1440, x: 3840, y: 0 }],
  });
  assert.match(windows.text, /at 3840,0/u);
  assert.deepEqual(
    validateJsonSchemaValue(compiledOutput(tool), {
      mode: 'displays',
      displays: [{ index: 2, name: '\\\\.\\DISPLAY2', width: 2560, height: 1440, x: 3840, y: 0 }],
    }),
    [],
  );
});

process.stdout.write('\nplugin wiring\n');

/** A context that records tool registration and runs injected callbacks at once. */
function wiringCtx(options = {}) {
  const registered = [];
  const definitions = [];
  const errors = [];
  const logger = Object.assign(() => logger, {
    info() {},
    warn() {},
    error(format, ...args) {
      // Substitute like the real logger does, so a case asserts the message a
      // user would read rather than the raw format string.
      let index = 0;
      errors.push(String(format).replace(/%s/gu, () => String(args[index++])));
    },
  });
  const ctx = {
    logger: () => logger,
    tools: {
      register(definition) {
        if (options.collisions?.has(definition.name) === true) {
          throw new Error(`name "${definition.name}" is already registered`);
        }
        registered.push(definition.name);
        definitions.push(definition);
        return () => {};
      },
    },
    // The real loader waits for the service; the test provides it immediately.
    inject(_services, callback) {
      callback(ctx);
    },
  };
  return { ctx, registered, definitions, errors };
}

/**
 * Run a case as if the host were a different platform.
 *
 * `platformFor()` reads `process.platform` at call time — by design, so the
 * runtime gate and the engine registry cannot disagree — which means the
 * wiring decisions can be exercised for every platform from any machine,
 * instead of only the one the suite happens to be running on. That is what
 * keeps the Windows branch of `apply()` from being the untested half.
 *
 * @param platform - the `process.platform` value to pretend to be.
 * @param body - the case body.
 */
async function onPlatform(platform, body) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await body();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

await test('apply() registers both tools on macOS', async () => {
  await onPlatform('darwin', () => {
    const { ctx, registered } = wiringCtx();
    apply(ctx, {});
    assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot']);
  });
});

await test('apply() registers the screenshot tool alone on Windows', async () => {
  // Windows has no consent model, so there is no grant to report and the
  // permission tool is not registered at all: offering the model a question
  // with no answer is worse than not offering it.
  await onPlatform('win32', () => {
    const { ctx, registered } = wiringCtx();
    apply(ctx, {});
    assert.deepEqual(registered, ['screenshot']);
  });
});

await test('a tool-name collision is reported without taking the host down', async () => {
  // register() rejects duplicates, and a thrown apply aborts the whole boot:
  // "you have two screenshot plugins" must not become "your harness will not
  // start". The unaffected tool still registers.
  await onPlatform('darwin', () => {
    const { ctx, registered, errors } = wiringCtx({ collisions: new Set(['screen_permission']) });
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.deepEqual(registered, ['screenshot'], 'the unaffected tool must still register');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /screen_permission/u);
    assert.match(errors[0], /already registered/u);
  });
});

await test('a failed registration is discoverable through screen_permission', async () => {
  // Logging is not a channel here: the harness does not echo plugin log output
  // and keeps no log file. So the failure has to reach the agent some other
  // way, or a plugin doing less than it claims is indistinguishable from one
  // doing everything. screen_permission is the tool an agent reaches for when
  // the screen misbehaves, so it carries the report.
  await onPlatform('darwin', async () => {
    const { ctx, definitions } = wiringCtx({ collisions: new Set(['screenshot']) });
    apply(ctx, {});
    const permission = definitions.find((definition) => definition.name === 'screen_permission');
    assert.ok(permission, 'the permission tool must still mount when the other one cannot');

    const value = await permission.execute({}, stubExec());
    assert.ok(Array.isArray(value.issues), 'the failed tool must be reported');
    assert.match(value.issues[0], /screenshot tool is unavailable/u);
    assert.match(value.issues[0], /already registered/u);

    const [block] = permission.output.render({}, value);
    assert.match(block.text, /<mount_issues>/u);
    assert.match(block.text, /the screenshot tool is unavailable/u);

    // Whatever this machine's permission state is, the clean bill of health
    // must be gone when there are issues: the permission may be fine while the
    // plugin is still not working, and claiming otherwise would be the
    // plugin's own report contradicted by itself. Rendered from a fixed value,
    // because the live probe answers differently on a machine that has never
    // granted Screen Recording.
    const [healthy] = permission.output.render({}, {
      platform: 'darwin',
      authorized: true,
      target: '/usr/local/bin/node',
      issues: ['the screenshot tool is unavailable: already registered'],
    });
    assert.match(healthy.text, /did not mount/u);
    assert.doesNotMatch(healthy.text, /the screenshot tool will work/u);
    const [clean] = permission.output.render({}, {
      platform: 'darwin',
      authorized: true,
      target: '/usr/local/bin/node',
    });
    assert.match(clean.text, /the screenshot tool will work/u);
  });
});

await test('a healthy mount reports no issues at all', async () => {
  await onPlatform('darwin', async () => {
    const { ctx, definitions } = wiringCtx();
    apply(ctx, {});
    const permission = definitions.find((definition) => definition.name === 'screen_permission');
    const value = await permission.execute({}, stubExec());
    assert.equal(value.issues, undefined, 'no issues key when there is nothing to report');
    const [block] = permission.output.render({}, value);
    assert.doesNotMatch(block.text, /mount_issues/u);
  });
});

await test('apply() survives both tool names colliding', async () => {
  await onPlatform('darwin', () => {
    const { ctx, registered, errors } = wiringCtx({
      collisions: new Set(['screen_permission', 'screenshot']),
    });
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.deepEqual(registered, []);
    assert.equal(errors.length, 2);
  });
});

await test('apply() registers nothing on a host with no engine', async () => {
  await onPlatform('linux', () => {
    const { ctx, registered } = wiringCtx();
    apply(ctx, {});
    assert.deepEqual(registered, [], 'no capture tool may exist without a capture engine');
  });
});

// Remove every capture the suite took. Done unconditionally, so a failing
// case cannot leave PNGs of the user's screen in the temporary directory.
await rm(liveDir, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed`);
process.stdout.write(skipped.length === 0 ? '\n' : `, ${skipped.length} skipped\n`);
if (failures.length > 0) process.exitCode = 1;

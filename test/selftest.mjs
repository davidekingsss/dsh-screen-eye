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
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import vm from 'node:vm';

import { Config, SETTINGS_NAMESPACE, apply } from '../index.mjs';
import { buildCaptureName, captureStamp, isCaptureName } from '../lib/capture-name.mjs';
import {
  CAPTURE_MODES,
  CHANGE_CONFIRMATIONS,
  CHANGE_FRACTION,
  CaptureError,
  DEFAULT_BURST_FRAMES,
  DEFAULT_BURST_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  INTERACTIVE_MODES,
  MAX_BURST_FRAMES,
  STILL_HEADROOM_FRAMES,
  STILL_CONFIRMATIONS,
  captureScreen,
  planCapture,
} from '../lib/capture.mjs';
import { describeCaptureFailure, isSupportedPlatform, platformFor, supportedPlatforms } from '../lib/platform.mjs';
import { darwin, engineTarget, screencaptureArgs } from '../lib/platform/darwin.mjs';
import {
  buildEngine,
  compilerCommand,
  engineBinaryPath,
  engineIsWarm,
  engineSource,
  stopEngine,
} from '../lib/platform/darwin/engine.mjs';
import {
  BLACK_FRAME_PERMILLE,
  NO_SESSION,
  RESULT_MARKER,
  burstScript,
  captureScript,
  displaysFromScreens,
  displaysScript,
  engineScript,
  engineScriptPath,
  notesForFrame,
  parseScriptResult,
  runOneShot,
  runScriptPath,
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
import { screenPermissionTool as screenPermissionToolRaw } from '../lib/permission-tool.mjs';
import { capturesToRemove, pruneCaptures } from '../lib/retention.mjs';
import { captureFailureError, screenshotTool as screenshotToolRaw } from '../lib/screenshot-tool.mjs';
import { DEFAULT_TIMEOUT_MS, resolveOutputPath, resolveSettings } from '../lib/settings.mjs';

/**
 * Both tools take a *reader* for settings rather than a settings object, because
 * the values can change while the host runs — the settings page writes to a
 * document the plugin is a layer over. Almost every case here wants one fixed
 * configuration, so they keep constructing the tools the way they always did;
 * the cases about live settings call the raw constructors.
 *
 * @param factory - the real constructor.
 * @returns a constructor taking a settings object.
 */
const withFixedSettings = (factory) => (first, settings, third) => factory(first, () => settings, third);

const screenshotTool = withFixedSettings(screenshotToolRaw);
const screenPermissionTool = withFixedSettings(screenPermissionToolRaw);

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
  // Captures land with the user's pictures rather than inside the harness's
  // private home, in a folder of their own rather than loose among them.
  assert.equal(settings.outputDir, join(homedir(), 'Pictures', 'Screen Eye'));
  assert.equal(settings.locale, 'en');
  assert.equal(settings.requireImageCapableModel, true);
  assert.equal(settings.deleteAfterCommit, false);
  // 4096 is where the provider's per-image side limit lands once a request
  // carries fifteen or more images, and a burst can carry hundreds.
  assert.equal(settings.maxDimension, 4096);
  assert.equal(settings.keepRecent, 50);
  assert.equal(settings.timeoutMs, DEFAULT_TIMEOUT_MS);
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
  // What has to be true is that a name is a function of the timestamp *and* the
  // disambiguator, so that two captures in the same second land in two files.
  //
  // This case used to draw 200 names at random and assert all 200 differed,
  // which measured the birthday paradox rather than the naming: with a 48-bit
  // suffix that assertion fails about once in 850 runs — measured at 0.100%
  // against a theoretical 0.118% — and every one of those failures was a false
  // alarm. Determinism is what matters, so the suffixes are fixed here and the
  // entropy is asserted separately below.
  const suffixes = Array.from({ length: 200 }, (unused, index) => index.toString(16).padStart(6, '0'));
  const names = new Set(suffixes.map((suffix) => buildCaptureName(new Date(), suffix)));
  assert.equal(names.size, suffixes.length, 'distinct disambiguators must give distinct names');

  // And the same suffix at a different second must also differ, because the
  // stamp is in the name.
  const at = new Date('2026-09-16T10:00:00Z');
  const later = new Date('2026-09-16T10:00:01Z');
  assert.notEqual(buildCaptureName(at, 'abcdef'), buildCaptureName(later, 'abcdef'));

  // The entropy the caller actually supplies is 48 bits, which the flaky
  // version of this case never checked: it asserted a property of a sample
  // instead of the size of the space. A burst of 600 frames in one second is
  // the worst case the tool allows, and at that size a collision is still
  // unlikely — so the space is large enough, which is the claim worth making.
  const space = 16 ** 6;
  const worstCaseFrames = 600;
  const collisionChance = 1 - Math.exp(-(worstCaseFrames * (worstCaseFrames - 1)) / (2 * space));
  assert.ok(collisionChance < 0.02, `a full burst must be very unlikely to collide; measured ${collisionChance}`);
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

await test('names a reduced capture as reduced, and does not invite rescaling it', () => {
  // This envelope used to say "multiply coordinates by 2.00", which is
  // arithmetically right and was in practice the wrong instruction: it invites
  // measuring a feature on a reduced picture and scaling it back up, and the
  // result lands near the target rather than on it. The multiplier is still
  // reported — deriving it is pointless work — but the picture is now named as
  // what it is, and the mode that returns a one-to-one copy is named as the way
  // to get one.
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
  assert.match(text.text, /downscaled from 200x100 px by 2\.00x/u);
  assert.match(text.text, /reduced view of the screen rather than a one-to-one copy/u);
  assert.match(text.text, /capture type "region"/u, 'the one-to-one alternative is named');
  assert.match(text.text, /The multiplier is 2\.00\./u, 'the multiplier is still available');
  assert.doesNotMatch(text.text, /multiply coordinates by/u, 'the rescaling advice is gone');
});

await test('hands over the screen origin so a coordinate is an addition', () => {
  // The point of this field: turning a coordinate measured inside the picture
  // into a screen coordinate must be an addition, not an undo-the-downscale.
  const [text] = imageContent({
    path: '/tmp/a.png',
    mode: 'region',
    capturedAt: 'now',
    screenOrigin: { x: 1200, y: 650 },
    image: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 400, height: 300 },
  });
  assert.match(text.text, /<screen-origin x="1200" y="650">/u);
  assert.match(text.text, /\(1200 \+ px, 650 \+ py\) on screen/u);

  // Absent when the origin is not knowable, because a wrong origin would be
  // worse than none: it would make every derived coordinate look authoritative.
  const [without] = imageContent({
    path: '/tmp/a.png',
    mode: 'display',
    display: 2,
    capturedAt: 'now',
    image: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 400, height: 300 },
  });
  assert.doesNotMatch(without.text, /screen-origin/u);

  // And a burst carries one origin for all its frames, because a burst keeps
  // one rectangle.
  const [burst] = imageContent({
    path: '/tmp/b.png',
    mode: 'region',
    capturedAt: 'now',
    screenOrigin: { x: 10, y: 20 },
    frames: [
      { path: '/tmp/b-1.png', capturedAt: 'now', image: { attachmentId: 'b', mediaType: 'image/png', bytes: 1, width: 4, height: 3 } },
      { path: '/tmp/b-2.png', capturedAt: 'now', image: { attachmentId: 'c', mediaType: 'image/png', bytes: 1, width: 4, height: 3 } },
    ],
  });
  assert.match(burst.text, /<screen-origin x="10" y="20">/u);
  assert.match(burst.text, /every frame shares/u);
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
  // The ceiling is the provider's per-request image limit, not this plugin's
  // opinion: past it the adapter swaps the extra images for a placeholder, so
  // refusing is the difference between a refusal and frames nobody can see.
  assert.throws(() => planCapture({ frames: MAX_BURST_FRAMES + 1 }), /above the 600/u);
  assert.equal(planCapture({ frames: MAX_BURST_FRAMES }).frames, MAX_BURST_FRAMES);
  assert.equal(planCapture({}).frames, 1, 'a plain capture is one frame');
  // And the room above the ordinary default is real room, not a formality: the
  // cap the planner raises a self-terminating burst to is well below it.
  assert.ok(
    STILL_HEADROOM_FRAMES < MAX_BURST_FRAMES,
    'the headroom a burst carries is not the ceiling a request carries',
  );
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

await test('a burst says why it ended, and both endings are honest', () => {
  // The model has to be able to tell "this recording ends where the motion
  // ended" from "this recording was cut off in the middle of it" — they call for
  // opposite next steps, and the frames alone cannot say which happened.
  const frame = (n) => ({
    path: `/tmp/f${n}.png`,
    capturedAt: 'now',
    image: { attachmentId: `i${n}`, mediaType: 'image/png', bytes: 1, width: 10, height: 10 },
  });
  const settled = formatBurstOutput({
    mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2), frame(3)],
    spacingMs: 48, intervalMs: 40, endedBecause: 'still',
  });
  assert.match(settled, /stopped changing after 3 frames/u);
  assert.match(settled, /where it settled/u);

  const cut = formatBurstOutput({
    mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2)],
    spacingMs: 48, intervalMs: 40, endedBecause: 'frames',
  });
  assert.match(cut, /still changing when the 2-frame limit ran out/u);
  assert.match(cut, /smaller region/u, 'the fix is worth naming');

  // Nothing was watching for a stop, so there is nothing to explain: a plain
  // burst must not grow a sentence about an ending nobody asked about.
  const plain = formatBurstOutput({
    mode: 'region', capturedAt: 'now', frames: [frame(1), frame(2)], spacingMs: 48, intervalMs: 40,
  });
  assert.doesNotMatch(plain, /stopped changing|limit ran out/u);
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
  // Why the interval is the parameter to think in: within one window, a coarser
  // sample is fewer images, and images are what cost. Holding the window fixed
  // and raising the interval must only ever reduce the frame count.
  const counts = [50, 100, 200, 400, 1000].map(
    (interval_ms) => planCapture({ duration_ms: 2000, interval_ms }).frames,
  );
  // Two seconds at each spacing, so the cap is not what decides any of these:
  // 41, 21, 11, 6 and 3 frames are arithmetic, and only a request dense enough
  // to exceed the provider's 600-image limit would meet the ceiling instead.
  assert.deepEqual(counts, [41, 21, 11, 6, 3]);
  for (let index = 1; index < counts.length; index += 1) {
    assert.ok(
      counts[index] <= counts[index - 1],
      `frame count rose from ${counts[index - 1]} to ${counts[index]} as the interval grew`,
    );
  }
  // The same lever without a window: an interval alone fixes the spacing and
  // the count is then the model's to spend, up to the provider's ceiling.
  assert.equal(planCapture({ interval_ms: 500, frames: 120 }).frames, 120);
});

await test('refuses to over-determine the burst', () => {  // All three at once is the one combination with no defensible reading.
  assert.throws(() => planCapture({ frames: 4, interval_ms: 100, duration_ms: 1000 }), /over-determine/u);
  assert.throws(() => planCapture({ duration_ms: 0 }), /positive integer/u);
  assert.throws(() => planCapture({ duration_ms: 1.5 }), /positive integer/u);
  assert.throws(() => planCapture({ duration_ms: 1000, frames: 1 }), /at least two frames/u);
});

await test('waiting for the picture to change is planned, and only with its flag', () => {
  // A one-shot animation needs the burst to start on the animation, not on the
  // call — so the wait is an argument, and an argument with a default budget.
  const plain = planCapture({ mode: 'region', region: '0,0,10,10', frames: 4 });
  assert.equal(plain.waitForChange, undefined, 'nothing waits unless it was asked to');

  const waiting = planCapture({ mode: 'region', region: '0,0,10,10', frames: 4, wait_for_change: true });
  assert.deepEqual(waiting.waitForChange, { timeoutMs: DEFAULT_WAIT_TIMEOUT_MS });
  assert.equal(
    planCapture({ mode: 'region', region: '0,0,10,10', frames: 4, wait_for_change: true, wait_timeout_ms: 2500 })
      .waitForChange.timeoutMs,
    2500,
  );
  // A timeout on its own is a caller who believes something is waiting when
  // nothing is, which is worse than being told the argument was ignored.
  assert.throws(
    () => planCapture({ mode: 'region', region: '0,0,10,10', wait_timeout_ms: 500 }),
    /only meaningful with wait_for_change/u,
  );
  assert.throws(
    () => planCapture({ mode: 'region', region: '0,0,10,10', wait_for_change: true, wait_timeout_ms: 0 }),
    /positive integer/u,
  );
});

await test('a burst that waited for the motion ends when the motion does', () => {
  // The frame count cannot answer "is it over?" — a caller who asks for eight
  // frames of a 300ms transition gets three that show it and five that show a
  // stopped screen, and one who asks for three of a 900ms transition gets a
  // third of it. So a burst that waited for a change is a recording of that
  // change, and it stops when the picture settles: not a flag to remember, the
  // meaning of the call.
  const watching = planCapture({ mode: 'region', region: '0,0,10,10', frames: 4, wait_for_change: true });
  assert.equal(watching.untilStill, true, 'watching a transition ends with it');
  assert.equal(watching.stillConfirmations, STILL_CONFIRMATIONS);
  assert.equal(watching.stillFraction, CHANGE_FRACTION);

  // A photograph of the new state is not a recording and has nothing to end.
  assert.equal(planCapture({ mode: 'region', region: '0,0,10,10', wait_for_change: true }).untilStill, undefined);

  // A burst nobody waited for was asked for by window or by frame count, so the
  // caller has already said how long to look; the opt-out is for the caller who
  // meant a span rather than an event.
  assert.equal(planCapture({ mode: 'region', region: '0,0,10,10', frames: 4 }).untilStill, undefined);
  assert.equal(planCapture({ mode: 'region', region: '0,0,10,10', frames: 4, until_still: true }).untilStill, true);
  assert.equal(
    planCapture({ mode: 'region', region: '0,0,10,10', frames: 4, wait_for_change: true, until_still: false })
      .untilStill,
    undefined,
    'a fixed window asked for explicitly is left alone',
  );

  // With an ending the screen decides, the cap is headroom rather than a plan:
  // the frames taken are the ones the motion spans, so the larger cap costs
  // nothing on a short transition and is the difference between catching a
  // 700ms one and missing its second half.
  const headroom = planCapture({
    mode: 'region', region: '0,0,10,10', interval_ms: 40, wait_for_change: true,
  });
  assert.equal(headroom.frames, STILL_HEADROOM_FRAMES, 'the cap is not the plan');
  // A caller who named a count or a window has answered it and is left alone.
  assert.equal(
    planCapture({ mode: 'region', region: '0,0,10,10', frames: 4, wait_for_change: true }).frames,
    4,
  );
  assert.equal(
    planCapture({ mode: 'region', region: '0,0,10,10', duration_ms: 400, wait_for_change: true }).frames,
    DEFAULT_BURST_FRAMES,
  );
});

await test('the change check asks how much moved, not whether anything did', () => {
  // The first version waited for any difference at all and fired 461ms into a
  // call watching a still screen, because a cursor blinked. The thresholds are
  // what stop that, so they are asserted as numbers rather than trusted.
  assert.ok(CHANGE_CONFIRMATIONS >= 2, 'one threshold crossing is not evidence');
  // In the engine's own sampling: a 60px block crossing a 1300x600 region moved
  // about 0.8% of the points, and a cursor is worth about 0.1%. The threshold
  // has to sit between them, which is the whole design.
  const blockFraction = 0.008;
  const cursorFraction = 0.001;
  assert.ok(CHANGE_FRACTION < blockFraction, 'a real animation must clear the threshold');
  assert.ok(CHANGE_FRACTION > cursorFraction, 'and a blinking cursor must not');
});

await test('reports the window covered when one was asked for', () => {  const frame = (n) => ({
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

await test('a denied region capture is a denial too, not an ordinary failure', () => {
  // The wording depends on what was asked for, and this was measured with the
  // grant actually revoked on macOS 26.6.2: `-m` and `-D` produce
  // "could not create image from display", while `-R` produces
  // "could not create image from **rect**".
  //
  // Matching only the first meant a denied *region* capture was classified as an
  // ordinary failure — so instead of the onboarding steps, the user got a bare
  // "could not create image from rect", which names no remedy, for the one mode
  // the tool description recommends. Only the prefix is shared between the two
  // messages, so that is what is matched, and this case is what keeps the
  // distinction from being narrowed again by someone tidying the string.
  assert.equal(classifyFailure('could not create image from rect'), DENIED);
  assert.equal(classifyFailure('could not create image from display'), DENIED);
  // And the shared prefix must not swallow failures that are not denials, or a
  // real problem would be answered with instructions to grant a permission the
  // user already has.
  assert.equal(classifyFailure('Invalid display specified. Must be a number from 1-2'), OTHER);
  assert.equal(classifyFailure('screencapture: cannot write file'), OTHER);
});

await test('guidance names the entries worth trying, and says why there is more than one', () => {
  const english = guidance({ locale: 'en' }).join('\n');
  const chinese = guidance({ locale: 'zh' }).join('\n');
  assert.match(chinese, /屏幕录制/u);
  assert.match(english, /Screen & System Audio Recording/u);

  // The host executable's own name is the one entry this process can compute,
  // and it is the right one whenever the host is what macOS attributes the
  // request to. It is printed as part of a list rather than alone, because on
  // the machine this was measured on it was wrong in two of the three ways DSH
  // gets started:
  //
  //   started by the Shortcuts droplet → the entry is `运行 Deepseek Harness`
  //   started by a browser             → the entry is `Google Chrome`
  //   started by a terminal            → the entry is `Terminal` / `iTerm`
  //
  // So a single computed string sent readers to look for an entry that may not
  // exist. What is asserted is that both the computed name and the principle
  // are present, and that the alternatives are described by *how the harness
  // was started* rather than by guessing an app name that would be wrong on the
  // next machine.
  const hostName = grantTargetPath().slice(grantTargetPath().lastIndexOf('/') + 1);
  assert.ok(english.includes(hostName) && chinese.includes(hostName), 'the host executable is among the candidates');
  for (const text of [english, chinese]) {
    assert.match(text, /(started DSH with|启动 DSH 的那个 App)/u, 'the principle is stated: the entry follows the launcher');
    assert.match(text, /(Common ones|常见条目)/u, 'the alternatives are introduced as common cases');
  }
  // And it must not claim a path is what the user will see in the list, which is
  // what the guide said before: the list shows names.
  assert.doesNotMatch(chinese, /列表中的条目名: \//u, 'the guide does not print a path as the list entry');
});

await test('guidance walks the three states a user can actually be in', () => {
  // Measured on macOS 26.6.2 by producing each state, because they are not the
  // same state and the guide used to describe only one of them:
  //
  //   never requested        → a system prompt appears, and it adds the app to
  //                            the list itself, with the switch OFF
  //   granted, then off      → no prompt; the entry is there, switched off
  //   removed from the list  → a prompt appears again on the next request
  //
  // What the guide has to get across is the step in the middle, which is the one
  // nothing else can do: being in the list is not being granted, so a capture
  // attempted right after the prompt fails again and the user has to be told to
  // switch the entry on rather than to try again.
  const english = guidance({ locale: 'en' }).join('\n');
  const chinese = guidance({ locale: 'zh' }).join('\n');

  for (const text of [english, chinese]) {
    // The prompt is described as conditional, because it depends on whether the
    // host has an identity macOS can attribute the request to — a desktop app
    // gets one and a launchd-reparented host does not.
    assert.match(text, /(system dialog|系统对话框)/u, 'the guide mentions the system prompt');
    // And the manual step is stated as a step, not implied by "it is listed".
    assert.match(text, /(Turn it on|把它的开关打开)/u, 'the guide says the switch must be turned on');
    assert.match(text, /(off by default|默认是关闭的)/u, 'it says why that step is not automatic');
    // Retrying before the switch is on is the failure this wording prevents.
    assert.match(text, /(Do not retry|不要重试)/u);
  }
  // The candidates are introduced by the principle, and the host executable is
  // among them; a path is never printed as the thing to look for, because the
  // list shows names.
  assert.doesNotMatch(english, /: \//u, 'no path is presented as a list entry');
  assert.doesNotMatch(chinese, /: \//u, 'no path is presented as a list entry');
  // And no English may leak into the Chinese guide, which a hard-coded
  // "Look for …" sentence used to do.
  assert.doesNotMatch(chinese, /Look for/u, 'the Chinese guide is not partly English');
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
  // what the other one promises. The macOS figures are the macOS measurements,
  // and a Windows one has no business carrying them.
  assert.match(macos.description, /^Capture this macOS screen and return the picture itself/u);
  assert.match(macos.parameters, /a 1200x800 region costs about 56ms and a full screen about 155ms/u);
  assert.match(macos.parameters, /"window" and "select" are interactive/u);
  // macOS now has a resident helper too, and says so — but it says it in its own
  // words, because the claim is different: Windows takes a whole burst in one
  // engine process, while macOS keeps a helper warm and still drives its frames
  // through the shared loop.
  assert.match(macos.parameters, /resident helper warm/u);
  assert.doesNotMatch(macos.parameters, /a burst runs in one engine process/u);
  // The Windows briefing says what a burst can actually do there, which is the
  // one thing a model about to ask for a 100ms interval needs to know.
  assert.match(windows.parameters, /a burst runs in one engine process/u);
  assert.doesNotMatch(windows.parameters, /resident helper/u);
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

await test('the call budget is the caller\'s, inside the ceiling the tool declares', async () => {
  // The harness enforces `timeoutMs` on the tool declaration as a hard deadline
  // and discards the result when it fires, so a call asking for longer than the
  // ceiling must be refused here — where it can be explained — rather than
  // allowed to run into a deadline that throws the frames away.
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  for (const timeout_ms of [0, 999, 1.5, 'soon', 3600000]) {
    // A non-integer is refused by the harness's own argument validation before
    // this code sees it, and the rest by the range check here; both name the
    // parameter, which is the property worth holding.
    await assert.rejects(
      () => tool.execute({ mode: 'region', region: '0,0,8,8', timeout_ms }, stubExec()),
      /timeout_ms/u,
      `timeout_ms=${JSON.stringify(timeout_ms)}`,
    );
  }
  // And the ceiling is declared rather than implied: a caller may set a budget
  // far above the plugin's default, because watching a slow process is a job
  // the default was never sized for.
  assert.ok(tool.timeoutMs > resolveSettings({}).timeoutMs, 'the ceiling leaves room above the default');
  assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, 'and it is a number the harness accepts');
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

await test('the model is told how to read a screen, not only what this tool does', () => {
  // The plugin's whole job is one workflow, and until this text existed nothing
  // said so: the description covered what a capture is and when to reach for
  // one, and a caller that had never seen the plugin had no way to know that
  // reading a screen is done in passes. Measured, the model found the region
  // mode by trial — a first full-screen capture, then the crop it needed. The
  // cost is latency, not correctness, which is exactly why it is worth saying.
  //
  // Asserted as a shape rather than as a sentence, because the wording is
  // meant to stay editable: an overview, a one-to-one region, and the
  // admission that which one applies is the caller's judgement.
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  const description = tool.description;
  assert.match(description, /two passes/u, 'the two-pass shape is stated');
  assert.match(description, /overview/u, 'the overview pass is named');
  assert.match(description, /one image pixel per screen pixel/u, 'the region pass says what makes it readable');
  // It must not read as an order: the situation is visible to the caller and
  // not to this text, so the judgement stays with the model.
  assert.doesNotMatch(description, /you must|always|never/iu, 'the guidance is not an order');

  // And the mode help must not quietly push the overview: it used to call
  // "screen" the default, while saying nothing about what a region is for.
  // Read through `properties` because `defineTool` normalises the declaration
  // into a JSON Schema. Asserted on the mode text alone — other parameters
  // legitimately say what their own default is, and matching across all of
  // them would fail on those.
  const modeHelp = tool.parameters.properties.mode.description;
  assert.doesNotMatch(modeHelp, /and is the default/u, 'the overview is no longer advertised as the default');
  assert.match(modeHelp, /"region" captures exactly the rectangle/u);
  assert.match(modeHelp, /one image pixel per screen pixel/u, 'region says why it is the readable one');
  assert.match(tool.parameters.properties.region.description, /screen position of the region it took/u);
  // The half of the division of labour a measured session got wrong: an
  // overview is a picture to judge by eye, and reading a coordinate off it is
  // how a region lands on the row above the one intended. That session spent
  // three captures to read one line of text. Neither sentence is an order —
  // the reply names where the region landed, so the model can aim again rather
  // than being told to distrust its first estimate.
  assert.match(description, /the overview tells you where to look, and the region tells you what is there/u);
  assert.match(tool.parameters.properties.region.description, /not a ruler/u);
  assert.match(tool.parameters.properties.region.description, /aiming twice beats measuring once/u);
  assert.doesNotMatch(tool.parameters.properties.region.description, /you must|always|never/iu,
    'the region guidance is not an order either');
});

await test('the macOS engine is asked for the same rectangle screencapture is', () => {
  // The one thing both engines have to agree on, and the one thing whose
  // failure is silent: a request mapped onto the wrong rectangle returns a
  // perfectly plausible picture of the wrong place. An earlier revision read
  // `plan.origin` and `plan.size`, which a capture plan does not have, so every
  // field was `undefined` and a region returned a 4K image of the whole
  // desktop — which no assertion about a region's *existence* would have
  // caught. So this asserts the numbers, mode by mode, against the flags the
  // binary is handed for the same plan.
  const cases = [
    [{ mode: 'screen' }, { display: 1, x: 0, y: 0, width: 0, height: 0 }],
    [{ mode: 'display', display: 2 }, { display: 2, x: 0, y: 0, width: 0, height: 0 }],
    [{ mode: 'region', region: '200,200,400,300' }, { display: 1, x: 200, y: 200, width: 400, height: 300 }],
    // A negative origin is how a display left of the main one is addressed, and
    // it has to survive the mapping rather than be clamped to zero.
    [{ mode: 'region', region: '-1920,0,800,600' }, { display: 1, x: -1920, y: 0, width: 800, height: 600 }],
  ];
  for (const [args, expected] of cases) {
    const plan = planCapture(args);
    const target = engineTarget(plan);
    assert.deepEqual(
      { display: target.display, x: target.x, y: target.y, width: target.width, height: target.height },
      expected,
      `${args.mode}: the engine was asked for the wrong rectangle`,
    );
    // And the binary's own mapping has to describe the same rectangle, or the
    // fallback would capture something else than the engine it stands in for.
    const flags = screencaptureArgs(plan, '/tmp/x.png');
    if (expected.width > 0) {
      assert.ok(flags.includes(`${expected.x},${expected.y},${expected.width},${expected.height}`),
        `${args.mode}: screencapture is not asked for the same rectangle`);
    } else if (args.mode === 'display') {
      assert.deepEqual(flags.slice(flags.indexOf('-D'), flags.indexOf('-D') + 2), ['-D', '2']);
    } else {
      assert.ok(flags.includes('-m'), 'mode screen must pin screencapture to one display');
    }
  }
  // The cursor is a field the engine carries rather than a flag it appends.
  assert.equal(engineTarget(planCapture({ mode: 'region', region: '0,0,10,10', include_cursor: true })).cursor, true);
  assert.equal(engineTarget(planCapture({ mode: 'region', region: '0,0,10,10' })).cursor, false);

  // "displays" is the inventory: it captures nothing, so nothing about it may
  // reach a capture engine — and the inventory path must not be turned into a
  // request for a rectangle it never asked for.
  const inventory = planCapture({ mode: 'displays' });
  assert.equal(inventory.frames, 1);
  assert.equal(inventory.region, undefined);
  assert.equal(engineTarget(inventory).width, 0, 'the inventory asks the engine for no rectangle');
});

await test('the engine source obeys the protocol the host parses', async () => {
  // The helper is compiled from this file on the user's machine, so its source
  // has no compiler check between it and a user. Two things in it are contract
  // rather than implementation: the readiness line the host waits for, and the
  // fact that a reply carries the request's own id — without which two
  // outstanding requests cannot be told apart. The rectangles and the hashing
  // are asserted by the live cases above, which is the only place they can be.
  const source = await engineSource();
  assert.match(source, /"ready": true|"ready":true/u, 'the host waits for a ready line it must be able to recognise');
  assert.match(source, /"id": request\.id/u, 'every reply must carry the id it answers');
  assert.match(source, /readLine\(strippingNewline: true\)/u, 'the loop reads one request per line');
  // The reduction size is what makes a check cheap, and it is a decision two
  // files depend on: the engine draws into it, the docs describe it.
  assert.match(source, /size: 64|64 \* 64/u, 'the fingerprint is a 64x64 reduction');
  assert.match(source, /SCScreenshotManager\.captureImage/u, 'the capture goes through ScreenCaptureKit');
  assert.match(source, /showsCursor/u, 'the cursor is a field of the capture configuration');
  // `CGDisplayCreateImage` is obsoleted in macOS 15 and would not compile
  // against a current SDK; reaching for it again is the mistake this prevents.
  assert.doesNotMatch(source, /CGDisplayCreateImage/u, 'the obsoleted capture API is not coming back');

  // The scale factor, which is the difference between a correct capture and a
  // broken one on every display that is not 1x. `SCDisplay.width` is in points
  // and `SCStreamConfiguration` wants pixels, so an unscaled request asks for a
  // half-resolution copy — measured on a 2x Sidecar display, 1194x834 instead of
  // 2388x1668 — and pairing that with a region made the framework refuse the
  // call outright with `SCStreamErrorDomain Code=-3812`.
  //
  // Two specifics are asserted rather than the general idea, because both were
  // arrived at by measurement and both have an obvious-looking wrong answer:
  // the scale comes from the display *mode* (on this machine `CGDisplayPixelsWide`
  // reports the point width for the iPad, so the obvious ratio is 1 and leaves
  // the bug in place), and the source rectangle subtracts the display's frame
  // origin (the main display's is zero, which is why a single-screen machine
  // cannot tell the difference).
  assert.match(source, /func backingScale/u, 'there is one place that decides the scale');
  assert.match(source, /mode\.pixelWidth/u, 'the scale comes from the display mode, which is the only source that reports both numbers');
  assert.doesNotMatch(source, /CGDisplayPixelsWide\(display\.displayID\)\s*\)\s*\/\s*CGDisplayBounds/u,
    'the obvious pixels-over-bounds ratio reports 1 on this machine and is not used');
  assert.match(source, /config\.width = Int\(CGFloat\(display\.width\) \* scale\)/u, 'a whole display is captured at its native resolution');
  assert.match(source, /config\.width = Int\(CGFloat\(request\.width\) \* scale\)/u, 'a region output is scaled too');
  assert.match(source, /request\.x\) - display\.frame\.minX/u, 'the region is converted from desktop coordinates to the display\'s own');
  assert.match(source, /request\.y\) - display\.frame\.minY/u);
});

await test('the engine binary is cached by source, and a cold engine costs nothing', async (skip) => {
  // Two claims, both about the lifecycle rather than the capture. First, that
  // the helper is named after its own source, so a changed helper is a
  // different file and a stale build can never be mistaken for a current one.
  const source = await engineSource();
  const path = engineBinaryPath(source);
  assert.equal(engineBinaryPath(source), path, 'the same source must build to the same path');
  assert.notEqual(engineBinaryPath(`${source}\n// a change`), path, 'a changed helper gets its own file');
  assert.match(path, /dsh-screen-eye-engine[\\/]engine-[0-9a-f]{16}$/u);
  assert.ok(!path.includes('%20'), 'the path must not carry URL escaping, which is how the first build failed');

  // Second, that asking whether an engine is warm neither starts one nor
  // reports one. The compile is invisible to a caller by design: the first
  // capture is served by `screencapture` and the helper is built behind it.
  stopEngine();
  assert.equal(engineIsWarm(), false, 'a stopped engine is not warm');

  // The build step itself is only meaningful where there is a compiler, and on
  // a machine without one the plugin has to keep working — which is what the
  // `null` return means. Skipped where there is no toolchain rather than
  // asserted away, because the CI runner is exactly such a machine.
  if (compilerCommand() === null) {
    skip('no Swift toolchain on this machine, so there is no helper to build');
    return;
  }
  const built = await buildEngine();
  assert.ok(typeof built === 'string' && built.endsWith(path.split('/').at(-1)), `expected the helper at ${path}`);
  assert.equal(await buildEngine(), built, 'a second build reuses the first');
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
  // The host executable is named among the candidates rather than as the single
  // answer: which entry the list actually holds depends on how DSH was started,
  // and that is not knowable from in here.
  const hostName = grantTargetPath().slice(grantTargetPath().lastIndexOf('/') + 1);
  assert.ok(message.includes(hostName), 'the message names what to look for');
  assert.match(message, /Screen & System Audio Recording/u);
  // The raw system string is replaced, not merely prefixed: it reads like a
  // bug and tells the user nothing they can act on.
  assert.doesNotMatch(message, /could not create image from display/u);

  const chinese = MACOS.describeFailure(denied, describeCaptureFailure, { locale: 'zh' }).message;
  assert.match(chinese, /屏幕录制/u);
  assert.ok(chinese.includes(hostName), 'the Chinese message names what to look for too');
  assert.match(chinese, /启动 DSH 的那个 App/u, 'and states the principle behind the name');
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
//
// The sweep first, because the removal below only helps a run that reaches it.
// A run killed part-way — a timeout, an interrupt, an editor stopping the task
// — never gets there, and this suite has left five such directories behind
// while it was being written: screenshots of the user's screen, sitting in the
// system temporary folder with nothing left that knows they are garbage. So a
// dead run's directory is removed by the next run rather than by nothing.
//
// "Dead" is read from the lock file this run's predecessor wrote, and the test
// is the process, not the file. A lock that only asserted "a run made this"
// would protect the interrupted run forever, which is the same leak wearing a
// different hat — measured, not assumed: the first version of this sweep left
// the killed run's directory exactly where it was.
//
// Pid reuse is possible in principle and does not matter here: the worst case
// is a stale directory surviving one more run, which is the case this handles
// anyway. A lock naming a process that is no longer running is a dead run.
const STALE_LOCK = 'run.lock';
const holds = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
for (const entry of await readdir(tmpdir()).catch(() => [])) {
  if (!entry.startsWith('dsh-screen-eye-test-')) continue;
  const stale = join(tmpdir(), entry);
  const lock = await readFile(join(stale, STALE_LOCK), 'utf8').catch(() => undefined);
  if (lock !== undefined && holds(Number.parseInt(lock.trim(), 10))) continue;
  await rm(stale, { recursive: true, force: true }).catch(() => {});
}
const liveDir = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-test-'));
await writeFile(join(liveDir, STALE_LOCK), `${process.pid}\n`);
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

/**
 * The display inventory, or `null` when this machine has none to report.
 *
 * A headless CI runner is the case this exists for. `listDisplays` refuses an
 * empty inventory — the mode's whole answer would be "nothing" — so a live case
 * that needs a panel to say anything has to tell that refusal apart from a real
 * failure; asserting a panel exists would fail on the runner for a reason that
 * is a fact about the runner. macOS's job is the one that meets it: the runner
 * reports no displays, while a developer's Mac reports several and never sees
 * this path.
 *
 * @param skip - the calling case's own skip function.
 * @returns the displays, or `null` after skipping the case.
 */
async function inventoryOrSkip(skip) {
  try {
    return await platformFor().listDisplays({});
  } catch (error) {
    if (/listed no displays/u.test(error.message)) {
      skip(`this machine reports no display inventory (${error.message})`);
      return null;
    }
    throw error;
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

  await test('the screen origin reaches the tool value, and only when it is known', async () => {
    // The envelope cases assert the rendering; this asserts the value the tool
    // actually returns, because a field that never reached the value would
    // render as nothing and every envelope case would still pass. It needs a
    // real capture because it asks what the tool does with a real plan.
    const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));

    const region = await tool.execute({ mode: 'region', region: '200,150,400,300' }, stubExec());
    assert.deepEqual(region.screenOrigin, { x: 200, y: 150 }, 'a region reports its own origin');
    assert.match(tool.output.render({}, region)[0].text, /<screen-origin x="200" y="150">/u);

    const screen = await tool.execute({ mode: 'screen' }, stubExec());
    assert.deepEqual(screen.screenOrigin, { x: 0, y: 0 }, 'the main display begins at the origin of region coordinates');
    assert.match(tool.output.render({}, screen)[0].text, /<screen-origin x="0" y="0">/u);

    // `display` reports an origin when the platform's inventory knows where the
    // screen sits. macOS's `system_profiler` does not report one, but its
    // resident helper does, so on a machine with the helper this is present and
    // names where that display begins — which is what makes a coordinate read
    // off a second screen's picture convertible at all.
    const display = await tool.execute({ mode: 'display', display: 1 }, stubExec());
    if (display.screenOrigin === undefined) {
      // No helper running: absent rather than guessed, because a wrong origin
      // would make every derived coordinate look authoritative.
      assert.doesNotMatch(tool.output.render({}, display)[0].text, /screen-origin/u);
    } else {
      assert.ok(Number.isInteger(display.screenOrigin.x) && Number.isInteger(display.screenOrigin.y));
      // The main display is the origin of the coordinate space `region` uses,
      // so whatever the platform calls it, the value has to be the same one
      // `screen` mode reports.
      const screen = await tool.execute({ mode: 'screen' }, stubExec());
      assert.deepEqual(display.screenOrigin, screen.screenOrigin, 'the two modes must agree about where the main display starts');
      assert.match(tool.output.render({}, display)[0].text, /<screen-origin /u);
    }
  });

  await test('every display is captured at its native resolution, not its point size', async (skip) => {
    // The bug this pins was invisible on the machine it shipped from: the main
    // display is 1x, so an unscaled request is correct there and every case
    // passed. On a 2x panel the same request returns half the panel's
    // resolution — which looks like a capture, only a softer one — and a region
    // on it is refused outright.
    //
    // It is the macOS engine's bug specifically: it comes from ScreenCaptureKit
    // speaking in points while its output size is in pixels. Windows reports a
    // display's own resolution and has no such split, so asking it here would
    // assert a shape it does not have.
    if (!ON_MACOS) {
      skip(`the point-versus-pixel split is ScreenCaptureKit's, not ${process.platform}'s`);
      return;
    }
    //
    // Asked of every display the machine reports, against the size the
    // inventory gives for it, so a Retina panel is checked the moment one is
    // attached and a 1x-only machine simply asserts the case it can. The
    // inventory reports native pixels; a capture that comes back at exactly
    // half is the failure, which is why the sizes are compared rather than a
    // "looks right" threshold.
    const displays = await inventoryOrSkip(skip);
    if (displays === null) return;
    assert.ok(displays.length > 0, 'the inventory must describe the panels it lists');

    for (const display of displays) {
      if (display.width === undefined || display.height === undefined) continue;
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
      const value = await tool.execute({ mode: 'display', display: display.index }, stubExec());
      const size = pngDimensions(await readFile(value.path));
      assert.equal(size.width, display.width, `display ${display.index}: captured ${size.width}px wide for a ${display.width}px panel`);
      assert.equal(size.height, display.height, `display ${display.index}: captured ${size.height}px tall for a ${display.height}px panel`);
    }
  });

  await test('a region is honoured on every display, in desktop coordinates', async (skip) => {
    // A region request is in the desktop's global space and the engine converts
    // it into the display's own before handing it to the framework. On the main
    // display the two spaces coincide, so the conversion can be missing for the
    // whole life of a single-screen machine; with a second display it fails
    // outright — measured on a Sidecar panel,
    // `SCStreamErrorException Code=-3812`.
    //
    // What is asserted is the part that holds without knowing the arrangement:
    // the same region request succeeds for every display, comes back at the size
    // asked for scaled by that panel, and knows its own origin. The engine's
    // placement of a second screen is not asserted here, because macOS does not
    // report where a display sits and a test that guessed would encode the guess
    // as a fact.
    const displays = await inventoryOrSkip(skip);
    if (displays === null) return;
    assert.ok(displays.length > 0, 'the inventory must describe the panels it lists');
    const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
    for (const display of displays) {
      // Aimed at the top-left of each display in turn: for the main one that is
      // the desktop origin, and for the others the engine must still resolve it.
      const value = await tool.execute({ mode: 'region', region: '200,200,200,150' }, stubExec());
      assert.equal(value.mode, 'region');
      assert.deepEqual(value.screenOrigin, { x: 200, y: 200 }, 'a region reports the origin it was given');
      const size = pngDimensions(await readFile(value.path));
      assert.ok(size.width >= 200 && size.height >= 150, `display ${display.index}: region came back ${size.width}x${size.height}`);
    }
  });

  await test('a machine with no helper still captures, through screencapture', async () => {
    // The resident engine is an optimisation on top of `screencapture`, never a
    // dependency in place of it, and the machine it matters for is one with no
    // Swift toolchain — where `buildEngine` returns `null`. The claim to check
    // is that the plugin then degrades to exactly its old behaviour rather than
    // to a capture that does not happen, which is the whole difference between
    // an optimisation and a dependency.
    //
    // Driven with the engine genuinely stopped, so this exercises the real
    // fallback rather than a stubbed one: what proves the fallback works is a
    // capture taken while there is nothing resident to take it through.
    stopEngine();
    assert.equal(engineIsWarm(), false, 'this case is only meaningful with no engine running');

    const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings(liveSettings));
    const value = await tool.execute({ mode: 'region', region: '0,0,120,90' }, stubExec());
    assert.match(value.path, /\.png$/u);
    const size = pngDimensions(await readFile(value.path));
    assert.equal(size.width, 120, 'with no engine running the binary still honours the region');
    assert.equal(size.height, 90);
  });

  await test('prunes old captures before a call, so a burst never eats its own frames', async () => {
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
      // The directory is brought down to the cap *before* the capture is
      // written, so the call's own file is added on top of a pruned directory
      // rather than competing with it. Pruning per frame instead — which is
      // what a ten-frame cap made safe and a six-hundred-frame one does not —
      // would delete the beginning of the burst being taken, and the paths in
      // the reply would name files that no longer exist. The oldest seed is
      // gone and the newest survives, which is the rule.
      assert.equal(left.length, 3, `expected the cap plus this call's file, saw ${left.length}`);
      assert.ok(
        left.includes(basename(value.path)),
        'pruning must never delete the capture it just returned',
      );
      assert.ok(
        !left.includes(buildCaptureName(new Date(Date.UTC(2020, 0, 1, 0, 0, 0)), 'abcde0')),
        'the oldest capture goes first',
      );
      assert.ok(
        left.includes(buildCaptureName(new Date(Date.UTC(2020, 0, 1, 0, 0, 5)), 'abcde5')),
        'the newest seed is inside the kept window',
      );
    } finally {
      await rm(pruneDir, { recursive: true, force: true });
    }
  });

  await test('a burst longer than the retention cap keeps every frame it returns', async () => {
    // The case the per-frame version could not survive: more frames in one call
    // than retention keeps. Every frame is committed to the attachment store
    // before the next is written, so the pictures are safe either way — but the
    // paths are the model's way back to a frame it wants to look at again, and
    // a path to a file this same call deleted is a lie.
    const burstDir = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-burst-'));
    try {
      const settings = resolveSettings({ ...liveSettings, outputDir: burstDir, keepRecent: 2 });
      const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), settings);
      const value = await tool.execute(
        { mode: 'region', region: '0,0,16,16', frames: 5, interval_ms: 20 },
        stubExec(),
      );

      assert.equal(value.frames.length, 5);
      for (const frame of value.frames) {
        assert.ok(existsSync(frame.path), `frame path ${frame.path} must still exist`);
      }
    } finally {
      await rm(burstDir, { recursive: true, force: true });
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
      const parsed = await runOneShot(captureScript(plan, path));
      assert.equal(parsed.ok, true);
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
      const plain = await runOneShot(captureScript(without, join(liveDir, 'no-cursor.png')));
      assert.equal(plain.cursorDrawn, null);
      assert.deepEqual(notesForFrame(plain), []);
    });

    await test('a capture lands in a directory that is not ASCII', async () => {
      // The engine's request travels as JSON on stdin, and Windows PowerShell
      // decodes a redirected stdin as ANSI unless told otherwise — so this
      // failed with "GDI+ a generic error occurred" until the engine declared
      // its input encoding, for every user with a Chinese path or user name.
      const unicode = join(liveDir, '中文目录');
      await mkdir(unicode, { recursive: true });
      const tool = screenshotTool(
        stubCtx({ attachments: stubAttachments() }),
        resolveSettings({ ...liveSettings, outputDir: unicode }),
      );
      const value = await tool.execute({ mode: 'region', region: '0,0,64,48' }, stubExec());
      assert.ok(value.path.includes('中文目录'), `the capture should be where it was asked for: ${value.path}`);
      assert.deepEqual(pngDimensions(await readFile(value.path)), { width: 64, height: 48 });
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

    await test('a one-shot script a real PowerShell is handed actually runs', async () => {
      // The other half of the case above, and the half that needs this machine:
      // the file it writes is spelled right everywhere, and is only *executable*
      // where the engine it targets exists. Without this, a BOM or an encoding
      // mistake would leave a script whose file is perfect and which PowerShell
      // nevertheless refuses — which is exactly the class of failure the
      // `-EncodedCommand` removal was meant to end.
      //
      // The path is the suite's own directory, like every other capture here.
      // It was `C:\a.png` first, and a standard Windows account may create only
      // directories at the root of a drive — `C:\` grants Users read-and-execute
      // and Authenticated Users `CreateDirectories`, nothing that writes a file.
      // PowerShell then failed at `Save` with GDI+'s "a generic error occurred
      // in GDI+", which reads like an engine fault and is a refused path; the
      // same script against a writable directory answers ok=true. CI never saw
      // it, because GitHub's runners are administrators.
      const parsed = await runOneShot(captureScript(planCapture({ mode: 'screen' }), join(liveDir, 'one-shot.png')));
      assert.equal(parsed.ok, true, 'a one-shot script has to actually run');
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

await test('every module the browser half declares as a dependency exists', async (skip) => {
  // The failure this exists for is silent, and it shipped once: the browser half
  // declared `@deepseek-ai/dsh-client-ui-slots` among its `dsh.client.inject`
  // entries, and no such package exists in the deployment. The host, though, is
  // happy — it scans the profile, finds the bundle, serves it, and the module
  // even lands in the browser's graph. What does not happen is *materialisation*:
  // the loader waits for a dependency that will never arrive, so the factory
  // never runs, the settings section is never registered, and the page simply
  // has no row. Nothing errors, and nothing appears.
  //
  // `slots` is a cordis *service* provided by the runner and the settings shell.
  // It is reached through the plugin's own `inject: ['slots', ...]`, which is a
  // different mechanism from this list — this list names client *modules*.
  //
  // Resolution is asked of the packages the deployment actually installs, so a
  // module id that a newer harness has retired is caught here in the checkout
  // that still has the older one. CI installs only the three packages it pins,
  // so there it skips rather than failing on an environment it does not have.
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = manifest.dsh?.client?.inject ?? [];
  assert.ok(Array.isArray(declared), 'dsh.client.inject must be a list');

  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../package.json', import.meta.url));
  try {
    require.resolve('@deepseek-ai/dsh-client-modules/package.json');
  } catch {
    skip('the harness client packages are not installed here, so their module ids cannot be checked');
    return;
  }

  for (const spec of declared) {
    let resolved;
    try {
      resolved = require.resolve(`${spec}/package.json`);
    } catch {
      assert.fail(
        `dsh.client.inject names "${spec}", which is not an installed package. The browser half would `
        + 'never be materialised — the graph would carry it and the section would never register — so '
        + 'either the id is wrong or it belongs in the plugin\'s own inject list rather than this one.',
      );
    }
    assert.ok(resolved, `${spec} must resolve`);
  }
  // And the list has to be non-empty for a plugin that registers a page: an
  // empty one is how a bundle ends up claiming to depend on nothing and then
  // reaching for a service that was never brought up.
  assert.ok(declared.length > 0, 'a page-registering bundle declares the modules it needs');
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
    // The change check is how a burst catches an animation that runs once, so a
    // platform that cannot do it must say so — the wait refuses to run rather
    // than timing out in silence.
    for (const method of ['watch', 'changed']) {
      assert.equal(typeof platform[method], 'function', `${id} cannot ${method}() the screen`);
    }
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
  // The mode and its arguments travel as a request object, resolved at run time
  // by the one resolver all three callers share — the single capture, the burst
  // and the resident engine — so what is asserted here is that the request
  // carries the index and that the resolver honours it.
  assert.match(display, /mode = 'display'; display = 2/u);
  assert.match(display, /\$rect = \$ordered\[\$index - 1\]\.Bounds/u);
  assert.match(display, /does not exist/u, 'an index no display has must be refused by name');

  const region = captureScript(planCapture({ mode: 'region', region: '-1920,0,800,600' }), 'C:\\shots\\a.png');
  assert.match(region, /mode = 'region'; x = -1920; y = 0; w = 800; h = 600/u);
  assert.match(region, /New-Object System\.Drawing\.Rectangle \(\[int\]\$request\.x\), \(\[int\]\$request\.y\), \(\[int\]\$request\.w\), \(\[int\]\$request\.h\)/u);
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

await test('a one-shot script travels as a file, and the file is usable', async () => {
  // It used to travel as `-EncodedCommand`, which was fine until the script grew
  // the shim loader, the rectangle resolver and the burst loop: base64 of
  // UTF-16 doubles the bytes, and ~14KB of script became ~27KB of command line
  // — close enough to Windows' 32KB ceiling that a capture failed to spawn at
  // all with ENAMETOOLONG. A file has no such ceiling, and the BOM is what lets
  // PowerShell read a path that is not ASCII.
  const script = captureScript(planCapture({ mode: 'screen' }), 'C:\\a.png');
  const path = runScriptPath(script);
  assert.ok(path.startsWith(tmpdir()));
  assert.match(path, /dsh-screen-eye-run[\\/]run-[0-9a-f]{16}\.ps1$/u);
  assert.equal(runScriptPath(script), path, 'the name is a function of the script alone');
  assert.notEqual(runScriptPath(`${script} `), path, 'and a changed script gets its own file');

  // What PowerShell will be handed is read back off the disk. Written by asking
  // for a run — which writes the file before it looks for PowerShell, so this
  // half holds on a machine that has none, and therefore on CI's macOS job —
  // and then thrown away, because how the file is spelled is what this case is
  // about. That it *runs* is the next case's job, and that one is Windows-only.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eye-oneshot-'));
  try {
    const real = captureScript(planCapture({ mode: 'region', region: '0,0,32,24' }), join(dir, 'a.png'));
    await runOneShot(real).catch(() => {});
    const onDisk = await readFile(runScriptPath(real), 'utf8');
    assert.equal(onDisk.charCodeAt(0), 0xFEFF, 'the BOM is what makes it readable as UTF-8');
    assert.equal(onDisk.slice(1), real);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

await test('the resident engine is driven the one way PowerShell allows', () => {
  // Every assertion here is a bug that cost time: the engine's script has to
  // live in a file (an `-EncodedCommand` keeps stdin for the host, so ReadLine
  // never returns and the first attempt hung), its stdin has to be declared
  // UTF-8 (Windows PowerShell decodes a redirected stdin as ANSI, so a Chinese
  // output path arrived as mojibake and GDI+ failed with a generic error), and
  // it answers per line with the request's own id so several can be outstanding.
  const script = engineScript();
  assert.match(script, /\[Console\]::In\.ReadLine\(\)/u);
  assert.match(script, /\[Console\]::InputEncoding = New-Object System.Text\.UTF8Encoding/u);
  assert.match(script, /\[Console\]::OutputEncoding = New-Object System.Text\.UTF8Encoding/u);
  for (const kind of ['capture', 'burst', 'watch', 'changed', 'quit']) {
    assert.match(script, new RegExp(`kind -eq '${kind}'`, 'u'), `the engine does not serve ${kind}`);
  }
  assert.match(script, /id = \$request\.id/u, 'every reply must carry the request it answers');
  // The shim is loaded once, at engine start, which is most of why a warm
  // request costs 18ms instead of 380ms.
  assert.equal(script.match(/\$nativeSource = @'/gu)?.length, 1);
  assert.match(script, /ready = \$true/u, 'the engine announces itself before serving');

  const path = engineScriptPath();
  assert.ok(path.startsWith(tmpdir()));
  assert.match(path, /dsh-screen-eye-engine[\\/]engine-[0-9a-f]{16}\.ps1$/u);
  assert.equal(engineScriptPath(), path, 'the script path is a function of the script alone');
});

await test('a platform says whether it can take a whole burst in one call', () => {  // The optional half of the contract, asserted in both directions: Windows
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
  // The contract is conditional, and it is worth stating as such: an origin is
  // rendered when the inventory carries one and omitted when it does not.
  //
  // It used to be read as a platform claim — "macOS reports no origin, so none
  // may appear" — which was true when macOS was read through `system_profiler`
  // and stopped being true once the resident helper began contributing
  // positions. The render did not change; the premise did. So the assertion is
  // now about what the envelope does with what it is given, and a fixture with
  // no origin stands for every platform that has none rather than for one.
  const tool = screenshotTool(stubCtx({ attachments: stubAttachments() }), resolveSettings({}));
  const [unknown] = tool.output.render({}, screenshotShapes()['a display inventory']);
  assert.doesNotMatch(unknown.text, / at /u, 'an inventory with no origin must render without one');

  // And macOS may now report one — the same screen the inventory above leaves
  // bare, once the helper has told the plugin where it sits.
  const [macosWithOrigin] = tool.output.render({}, {
    mode: 'displays',
    displays: [{ index: 2, name: 'Sidecar Display', width: 2388, height: 1668, x: -748, y: 2160 }],
  });
  assert.match(macosWithOrigin.text, /at -748,2160/u, 'a negative origin is how a display to the left is addressed');

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

/**
 * A context that records tool registration and runs injected callbacks at once.
 *
 * The one place it is deliberately faithful rather than convenient: a callback
 * injected for a service this host does not have never runs, which is the
 * loader's actual contract and the reason `apply()` can depend on the settings
 * service without depending on every deployment having one. Pass
 * `{ settings: null }` for a host with no settings document at all.
 */
function wiringCtx(options = {}) {
  const registered = [];
  const definitions = [];
  const errors = [];
  const warnings = [];
  const sections = [];
  const promptSections = [];
  const registeredSkills = [];
  const logger = Object.assign(() => logger, {
    info() {},
    warn(format, ...args) {
      let index = 0;
      warnings.push(String(format).replace(/%s/gu, () => String(args[index++])));
    },
    error(format, ...args) {
      // Substitute like the real logger does, so a case asserts the message a
      // user would read rather than the raw format string.
      let index = 0;
      errors.push(String(format).replace(/%s/gu, () => String(args[index++])));
    },
  });
  const settings = options.settings === null
    ? undefined
    : options.settings ?? {
      installSection(owner, ns, schema, entry, hooks) {
        sections.push({ owner, ns, schema, entry, hooks });
      },
    };
  // The orders the installed harness hands out for the two anchors a case
  // reads, at the values it uses. Written as literals rather than imported,
  // because the point of the anchor is that it moves with the registry: a case
  // that imported the registry could not fail if the registry moved.
  const orders = { TOOL_WEB_FETCH: 2100, TOOL_LSP: 2200 };
  const systemPrompt = options.systemPrompt === null
    ? undefined
    : options.systemPrompt ?? {
      getSectionOrder: (orderName) => orders[orderName],
      section(section) {
        if (options.sectionCollision === section.name) {
          throw new Error(`prompt section "${section.name}" is already registered`);
        }
        promptSections.push(section);
        return () => {
          const at = promptSections.indexOf(section);
          if (at >= 0) promptSections.splice(at, 1);
        };
      },
    };
  const skills = options.skills === null
    ? undefined
    : options.skills ?? {
      register(skill) {
        if (options.skillCollision === skill.name) {
          throw new Error(`runtime skill "${skill.name}" is already registered`);
        }
        registeredSkills.push(skill);
        return () => {};
      },
    };
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
    settings,
    systemPrompt,
    skills,
    // Cordis runs the callback and adopts what it returns; the stub runs the
    // callback and hands the disposer back, which is what lets a case assert
    // both directions of a registration.
    effect(execute) {
      return execute();
    },
    get() {
      // No attachment store and no llm route: enough for the tool to mount,
      // and the absence is what the wiring cases assert against.
      return undefined;
    },
    inject(services, callback) {
      // Injected services arrive as properties of the scope handed to the
      // callback, which is why the tools are registered through `ctx.tools`
      // in `apply()` and the skill through `skillCtx.skills`. A stub that
      // handed back a bare object would test a contract cordis does not have.
      //
      // Absence is spelled by leaving a service out of `absent`, because a
      // value in the options cannot say it: `attachments: null` reaches this
      // line as null and `null ?? {}` is `{}`, which is exactly what the
      // default is. A case that wants no attachment store names it here.
      const absent = new Set(options.absent ?? []);
      const available = {
        tools: ctx.tools,
        attachments: options.attachments ?? {},
        settings,
        skills,
      };
      for (const service of services) {
        if (absent.has(service) || available[service] === undefined) return;
      }
      callback(ctx);
    },
  };
  return { ctx, registered, definitions, errors, warnings, sections, promptSections, registeredSkills };
}

await test('apply() offers its settings as a namespace, based on the mounted entry', async () => {
  // The bundle entry is the base layer: a deployment with no settings document
  // gets exactly what it mounted with, and a field a user clears falls back to
  // it. That is the whole reason to install a section rather than register a
  // namespace outright — the mount stays the default.
  await onPlatform('darwin', () => {
    const { ctx, sections } = wiringCtx();
    apply(ctx, { locale: 'zh', keepRecent: 7 });
    assert.equal(sections.length, 1, 'one namespace, installed once');
    const [section] = sections;
    assert.equal(section.ns, SETTINGS_NAMESPACE);
    assert.equal(section.ns, 'screen-eye', 'the namespace is the card key in the client half');
    assert.equal(section.entry.locale, 'zh', 'the entry is the base layer, not the defaults');
    assert.equal(section.entry.keepRecent, 7);
    assert.equal(section.entry.maxDimension, 4096, 'and it is schema-resolved, not raw');
    assert.equal(typeof section.hooks.setSource, 'function');
  });
});

await test('a settings edit reaches the next call without a restart', async () => {
  // The point of the section: the tools read the source per call, so what the
  // settings page writes is what the next capture uses. A value captured at
  // mount would make the page a decoration.
  //
  // The observable used here is the call budget, because it is decided before
  // anything touches the screen: a timeout the tool would refuse can only have
  // come from the moved source, and once the source is sane the same call gets
  // past that check and fails later, for a reason this case can name.
  await onPlatform('darwin', async () => {
    const { ctx, definitions, sections } = wiringCtx();
    apply(ctx, { requireImageCapableModel: false });
    const screenshot = definitions.find((definition) => definition.name === 'screenshot');
    assert.ok(screenshot, 'the screenshot tool mounts');
    const args = { mode: 'region', region: '0,0,8,8' };

    await assert.rejects(
      () => screenshot.execute(args, stubExec()),
      /no attachment service is mounted/u,
      'the mounted entry is what the first call runs on',
    );

    // The Host resolving the namespace over the user's document, simulated the
    // way the settings service does it: the source moves underneath the tool.
    sections[0].hooks.setSource(() => ({ timeoutMs: 500, requireImageCapableModel: false }));
    await assert.rejects(
      () => screenshot.execute(args, stubExec()),
      /timeout_ms must be a whole number/u,
      'a budget below the floor can only have been read at call time',
    );

    // And a value written back to something sane takes effect the same way,
    // which is what proves the refusal above was the reading and not a latch.
    sections[0].hooks.setSource(() => ({ timeoutMs: 60000, requireImageCapableModel: false }));
    await assert.rejects(
      () => screenshot.execute(args, stubExec()),
      /no attachment service is mounted/u,
      'the edited budget passed validation on the next call',
    );
  });
});

await test('a host with no settings document still mounts on its entry config', async () => {
  // `installSection` is optional by design: the composition entry is the
  // fallback when the provider is absent, and a plugin that refused to mount
  // without a settings document would be a plugin that cannot run on a
  // deployment that keeps its configuration in the bundle patch.
  await onPlatform('darwin', () => {
    const { ctx, registered, sections } = wiringCtx({ settings: null });
    assert.doesNotThrow(() => apply(ctx, { locale: 'zh' }));
    assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot']);
    assert.equal(sections.length, 0, 'nothing was installed, because there was nowhere to install it');
  });
});

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

process.stdout.write('\nannouncing the capability\n');

await test('the standing line is registered beside the tool it describes', async () => {
  // The measured failure this whole module exists for: a tool defined and sent
  // every request, and a model that never chose it, because nothing in the
  // system prompt said the capability was there. Of the sixty sessions in the
  // local store, fifty-four mention `screenshot` exactly once — inside the Web
  // surface's "no implicit DOM, route, or screenshot context".
  await onPlatform('darwin', () => {
    const { ctx, promptSections } = wiringCtx();
    apply(ctx, {});
    assert.equal(promptSections.length, 1, 'one standing line, not a paragraph per mode');
    const [section] = promptSections;
    assert.equal(section.name, 'tool:screen-eye');
    // Anchored to the last first-party tool-guidance order rather than a
    // literal: a number copied out of another package goes stale when that
    // package renumbers, and the gap to the next section is 100 wide.
    assert.equal(section.order, 2100 + 50, 'inside the tool-guidance block');
    assert.ok(section.order > 2100 && section.order < 2200, 'between web_fetch and lsp');
  });
});

await test('the line names the tool, the one-call shape, and the consent tool', async () => {
  // Asserted as the facts a caller plans with rather than as sentences: the
  // wording stays editable, and what must not go missing is the part that
  // changes the plan — the image arrives in the same call, so looking is one
  // step and not two.
  await onPlatform('darwin', () => {
    const { ctx, promptSections } = wiringCtx();
    apply(ctx, {});
    const text = promptSections[0].text();
    assert.match(text, /screenshot/u, 'names the tool to call');
    assert.match(text, /screen_permission/u, 'names the tool that answers the grant question');
    assert.match(text, /same call/u, 'says the picture comes back without a second step');
    assert.match(text, /read_image/u, 'and says which of the two reading tools this is');
    assert.match(text, /Screen Recording/u, 'names the macOS requirement rather than assuming it');
    // Word-bounded: a bare /never/ matches "whenever", which is how a scan of
    // this file's own prose once reported a prohibition that was not there.
    assert.doesNotMatch(text, /\b(you must|always|never)\b/iu, 'the line is not an order');
    assert.doesNotMatch(text, /is the default/u, 'and it is not mode guidance');
  });
});

await test('the line routes interface text away from the picture, and says so', async () => {
  // The session this exists for, in one sentence: asked what video was playing,
  // a model ran sixteen shell commands into a media app's cache database and
  // two web API calls to recover a title printed in the window's own title bar.
  // The old line said the answer might be "on screen rather than in a file",
  // which the model read as "in a picture" — so the split between the two
  // channels is now stated instead of left to inference.
  await onPlatform('darwin', () => {
    const { ctx, promptSections } = wiringCtx();
    apply(ctx, {});
    const text = promptSections[0].text();
    assert.match(text, /observing that app/u, 'sends interface text to the accessibility tree');
    assert.match(text, /accessibility tree/u, 'and names it plainly, because it is not obvious');
    assert.match(text, /text to read/u, 'gives the criterion: text versus no text');
    assert.match(text, /expand it, scroll it, or move it back into view/u,
      'a view too small or covered is a reason to change the view');
    assert.match(text, /caches, databases, files, or APIs/u,
      'and it says where not to go looking instead');
    assert.match(text, /look instead of searching/u, 'the frame is retrieval, not a last resort');
    // Still not an order, and still no claim that capture is the only route.
    assert.doesNotMatch(text, /\b(you must|always|never)\b/iu);
    assert.doesNotMatch(text, /the only way/u);
  });
});

await test('the line promises no consent tool on a platform that has none', async () => {
  // A standing line has to be true where it is registered. Windows has no
  // grant to report and registers no `screen_permission`, so a sentence
  // pointing at one would send the model after a tool that is not there.
  await onPlatform('win32', () => {
    const { ctx, promptSections } = wiringCtx();
    apply(ctx, {});
    const text = promptSections[0].text();
    assert.match(text, /screenshot/u);
    assert.doesNotMatch(text, /screen_permission/u, 'no pointer to a tool this platform lacks');
    assert.doesNotMatch(text, /Screen Recording/u, 'and no macOS-only requirement');
  });
});

await test('the line can be switched off, and switches back without a restart', async () => {
  // The text is a provider rather than a string so that this is true: it is
  // evaluated at each assembly and reads the settings as they stand then.
  // Registering conditionally would have frozen the decision at mount time,
  // which is the one moment the setting cannot yet have been edited.
  await onPlatform('darwin', () => {
    const { ctx, promptSections, sections } = wiringCtx();
    apply(ctx, {});
    assert.notEqual(promptSections[0].text(), '', 'on by default, because the failure was silence');

    // A settings document edited from the page arrives as a new resolved
    // source, which is what the tools already read through.
    sections[0].hooks.setSource(() => ({ announceCapability: false }));
    assert.equal(promptSections[0].text(), '', 'switched off with no re-registration');
    sections[0].hooks.setSource(() => ({ announceCapability: true }));
    assert.notEqual(promptSections[0].text(), '', 'and back on the same way');
  });
});

await test('a host with no attachments gets no line, because it has no tool', async () => {
  // Advertising a call that would return nothing is worse than silence: the
  // model would plan around a capability this deployment does not have.
  await onPlatform('darwin', () => {
    const { ctx, promptSections, registered } = wiringCtx({ absent: ['attachments'] });
    apply(ctx, {});
    assert.deepEqual(registered, ['screen_permission'], 'no attachment store, so no capture tool');
    assert.equal(promptSections.length, 0, 'nothing to announce, so nothing announced');
  });
});

await test('the line is not announced when the tool could not mount', async () => {
  // The collision case, seen from the prompt side: a second screenshot plugin
  // owns the name, so this one has no tool to describe.
  await onPlatform('darwin', () => {
    const { ctx, promptSections, errors } = wiringCtx({ collisions: new Set(['screenshot']) });
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.equal(promptSections.length, 0);
    assert.equal(errors.length, 1, 'the failure is still reported');
  });
});

await test('a prompt-section collision is reported without taking the host down', async () => {
  // Two copies of this plugin mounted, or a future harness that reserves the
  // name: the section throws on a duplicate, and a thrown apply aborts the
  // whole boot. The tools still mount and the failure is still reported.
  await onPlatform('darwin', () => {
    const { ctx, registered, errors, promptSections, registeredSkills } = wiringCtx({
      sectionCollision: 'tool:screen-eye',
    });
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot'], 'the tools still mount');
    assert.equal(promptSections.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /prompt section is unavailable/u);
    assert.match(errors[0], /already registered/u);
    assert.equal(registeredSkills.length, 1, 'and the skill is a separate registration, so it still lands');
  });
});

await test('the skill repeats the workflow for a reader who arrives through the catalog', async () => {
  await onPlatform('darwin', () => {
    const { ctx, registeredSkills } = wiringCtx();
    apply(ctx, {});
    assert.equal(registeredSkills.length, 1, 'registered at runtime, so installing the plugin is the installation');
    const [skill] = registeredSkills;
    assert.equal(skill.name, 'screen-eye');
    assert.equal(skill.source, 'runtime');
    assert.match(skill.description, /screen/u);
    assert.match(skill.whenToUse, /before/iu, 'a routing hint, because the catalog shows this and not the body');
    // The routing hint names the habit it is meant to interrupt, because that
    // is the moment of decision: a model about to grep a cache for something
    // the user is looking at.
    assert.match(skill.whenToUse, /caches, files, databases or APIs/u,
      'the catalog line has to catch the model before it goes looking elsewhere');
    // What the skill adds over the standing line: the mode table, the scaled
    // display, and the way out when nothing comes back.
    assert.match(skill.content, /two passes/u);
    assert.match(skill.content, /one image pixel per screen pixel/u);
    assert.match(skill.content, /screen_permission/u);
    assert.match(skill.content, /wait_for_change/u);
    assert.match(skill.content, /read_image/u, 'and where the boundary with reading a file sits');
    // And the part the measured session needed: which channel for which fact,
    // and what to do when the view itself is in the way.
    assert.match(skill.content, /Accessibility tree/u, 'interface text has a channel of its own');
    assert.match(skill.content, /the picture \*is\* the evidence/u, 'and pixels are not a failure to find text');
    assert.match(skill.content, /change the view/u, 'expanding a window is a step, not a detour');
    assert.match(skill.content, /was not hidden/u,
      'the failure is named as a route problem rather than a missing fact');
    assert.doesNotMatch(skill.content, /\b(you must|always|never)\b/iu, 'reference, not orders');
  });
});

await test('a host with no skill registry still gets its tools and its line', async () => {
  // The registry is part of the base composition but not of every deployment:
  // an SDK mount can leave it out, and the section is the half that matters.
  await onPlatform('darwin', () => {
    const { ctx, registered, promptSections, errors, warnings } = wiringCtx({ absent: ['skills'] });
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot']);
    assert.equal(promptSections.length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [], 'an absent registry is not worth a warning');
  });
});

await test('a skill-name collision is a warning, never a failed mount', async () => {
  // A project skill of the same name legitimately outranks a runtime one, and
  // the registry logs and moves on. Nothing about it may reach `apply`.
  await onPlatform('darwin', () => {
    const { ctx, registered, registeredSkills, errors, warnings } = wiringCtx({ skillCollision: 'screen-eye' });
    assert.doesNotThrow(() => apply(ctx, {}));
    assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot']);
    assert.equal(registeredSkills.length, 0);
    assert.deepEqual(errors, [], 'a taken skill name is not a mount failure');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skill could not be registered/u);
  });
});

await test('switching the announcement off at mount leaves the tools alone', async () => {
  await onPlatform('darwin', () => {
    const { ctx, registered, promptSections, registeredSkills } = wiringCtx();
    apply(ctx, { announceCapability: false });
    assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot'], 'the tools are unaffected');
    assert.equal(promptSections[0].text(), '', 'and the line is empty rather than absent');
    assert.equal(registeredSkills.length, 0, 'a skill cannot be walked back, so it is decided once');
  });
});

process.stdout.write('\nthe settings card (browser half)\n');

/**
 * As much DOM as the browser half touches: a nav whose buttons can be found by
 * text, a stylesheet sink, and the observer it uses to keep the nav marking
 * current. A real jsdom would be a dependency this plugin does not have, and the
 * half uses six DOM calls in total.
 *
 * @returns the stub DOM, with the collections the cases assert against.
 */
function fakeDom() {
  const buttons = [];
  const observers = [];
  const styles = [];
  const document = {
    querySelectorAll: (selector) => (selector.startsWith('nav') ? buttons : []),
    getElementById: (id) => styles.find((style) => style.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (node) => styles.push(node) },
  };
  return {
    buttons,
    observers,
    styles,
    document,
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
      disconnect() {}
    },
  };
}

/**
 * Load `client/client.js` the way the harness does: as a classic script that
 * registers itself on `window.__ModuleLoader__` and hands back a factory.
 *
 * This is the only way to test the browser half without a browser, and it is
 * worth doing because the half has no compiler in front of it: the file is
 * hand-written precisely so the plugin needs no build step, which means nothing
 * else would catch a mistake in it before a user opened the settings page.
 *
 * @param React - the React stand-in the page should be given. It has to be the
 *   same instance the caller renders with, or the page's state and the
 *   renderer's would live in two different places.
 * @param dom - the stub DOM the script should see; one is made when omitted.
 * @returns the registered plugin body, what the factory required, and the DOM.
 */
function loadClientHalf(React, dom = fakeDom()) {
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'), sandbox);

  assert.equal(registrations.length, 1, 'the script registers exactly one bundle');
  const [registration] = registrations;
  assert.equal(registration.id, 'dsh-screen-eye');

  const required = [];
  const body = registration.factory((specifier) => {
    required.push(specifier);
    if (specifier === 'react') return React;
    throw new Error(`the page required an unexpected module: ${specifier}`);
  });
  return { body, required, dom };
}

/**
 * As much React as this card uses: elements, the store hook, and state that
 * actually re-renders, so a control can be driven and the result inspected.
 *
 * Deliberately not a general implementation — it renders one component with
 * fixed props and no reconciliation. That is the whole contract the card needs,
 * and a real renderer would mean a dependency this plugin does not have.
 *
 * @returns the React stand-in and a render function.
 */
function tinyReact() {
  let cells = [];
  let cursor = 0;
  let current = null;

  const draw = () => {
    cursor = 0;
    current.tree = current.component(current.props);
    return current.tree;
  };

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next;
        draw();
      }];
    },
  };

  return {
    React,
    /**
     * Render a component and hand back a live handle.
     *
     * The handle rather than the tree, because the card re-renders itself from
     * its own state: reading `.tree` after a control is used is what makes a
     * driven interaction assertable, and re-rendering any other way would run
     * the hooks out of order.
     *
     * @param component - the function component.
     * @param props - its props.
     * @returns a handle whose `tree` is always the latest render.
     */
    render(component, props) {
      cells = [];
      current = { component, props, tree: null };
      draw();
      return {
        get tree() { return current.tree; },
        rerender: draw,
      };
    },
  };
}

/**
 * Find every element in a rendered tree whose props match.
 *
 * Child function components are expanded here rather than by a reconciler,
 * which is legitimate for this card and only for this card: nothing below its
 * top level uses a hook, so calling one with its props *is* rendering it. The
 * alternative — a real renderer — is a dependency this plugin does not have.
 *
 * @param tree - a rendered element tree.
 * @param match - predicate over an element.
 * @returns the matching elements, in tree order.
 */
function findAll(tree, match) {
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
    if (match(node)) found.push(node);
    node.children.forEach(walk);
  };
  walk(tree);
  return found;
}

/** Find one element by its class name. */
const byClass = (tree, className) => findAll(tree, (node) => node.props.className === className);

/**
 * A settings scope that answers from a fixed section and records writes.
 * @param section - the resolved section the card should read.
 * @param user - the raw user layer, whose keys mark overridden fields.
 * @returns the scope plus what it was asked to write.
 */
function stubScope(section, user = {}) {
  const writes = [];
  return {
    writes,
    subscribe: () => () => {},
    getSnapshot: () => ({
      status: 'ready', value: section, base: {}, user, revision: 1, writable: true, mode: 'host',
    }),
    set: async (field, value) => { writes.push({ op: 'set', field, value }); },
    unset: async (field) => { writes.push({ op: 'unset', field }); },
    mutate: async () => {},
  };
}

await test('the page claims its own settings section, named by the Host namespace', () => {
  // The two halves are paired by this string and by nothing else: the browser
  // binds the namespace the Host registered. A typo here is a page that renders
  // nothing, with no error anywhere to say why — which is exactly the kind of
  // thing a test is for.
  const react = tinyReact();
  const { body, required } = loadClientHalf(react.React);
  assert.equal(body.name, 'dsh-screen-eye');
  assert.deepEqual([...body.inject].sort(), ['locale', 'settingsScope', 'slots']);
  assert.deepEqual(required, ['react'], 'the page requires nothing but the shared React');

  const bound = [];
  const registered = [];
  const dictionaries = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: (ns) => (key) => `${ns}:${key}`,
      register: (ns, locale, dict) => { dictionaries.push({ ns, locale, dict }); return () => {}; },
    },
    settingsScope: { bind: (spec) => { bound.push(spec); return stubScope({}); } },
    slots: {
      inject(name, callback) { registered.push({ name, entries: [] }); callback(); },
      register(spec, component) { registered.at(-1).entries.push({ spec, component }); return () => {}; },
    },
    effect(callback, label) { effects.push(label); return callback(); },
  };
  body.apply(ctx);

  // The spec crosses the vm boundary, so its prototype is the sandbox's; the
  // namespace is what matters and it is a primitive.
  assert.equal(bound.length, 1);
  assert.equal(bound[0].namespace, SETTINGS_NAMESPACE, 'bound to the Host namespace');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'settings.section', 'a section of its own, not a card under Plugins');
  assert.equal(registered[0].entries.length, 1);
  const { spec } = registered[0].entries[0];
  assert.equal(spec.id, SETTINGS_NAMESPACE, 'the nav id is the namespace');
  assert.equal(typeof spec.label, 'function', 'the shell resolves the label per render');
  assert.ok(spec.order > 20, 'after what the harness ships: general 0, models 10, plugins 15, presets 20');
  assert.ok(spec.inject().scope, 'the page is handed its bound scope');
  assert.ok(
    effects.some((label) => String(label).includes('navigation glyph')),
    'the nav glyph is an effect, so it is removed with the plugin',
  );

  // Copy travels with the page: a third-party namespace the locale registry has
  // never heard of registers its own dictionaries.
  assert.deepEqual(dictionaries.map((entry) => entry.locale).sort(), ['en', 'zh']);
  for (const entry of dictionaries) assert.equal(entry.ns, 'screen-eye');
  const zh = dictionaries.find((entry) => entry.locale === 'zh').dict;
  const en = dictionaries.find((entry) => entry.locale === 'en').dict;
  assert.equal(en.nav, 'Screen Eye');
  assert.equal(zh.nav, '屏幕之眼', 'the nav row is named in both languages');
  assert.equal(zh.save, '保存');
  assert.ok(zh.timeoutMs.includes('毫秒'));
  // Both dictionaries must carry the same keys, or a language switch leaves the
  // page rendering undefined where a label should be.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

await test('the section marks its own nav row, which is the only way it gets an icon', () => {
  // The contract projects no id onto a nav row and no icon onto a section: the
  // shell picks glyphs from a closed list of built-in ids and gives anything
  // else the generic gear. So the row is claimed by the label this plugin
  // registered, and a stylesheet swaps the glyph. That is a workaround for a
  // contract gap, which is exactly the kind of thing that breaks silently — so
  // what it matches on and what it draws are both asserted.
  const react = tinyReact();
  const dom = fakeDom();
  const marked = new Map();
  const button = (text) => ({
    textContent: text,
    setAttribute: (name) => marked.set(text, name),
    removeAttribute: () => marked.delete(text),
  });
  dom.buttons.push(button('General'), button('Screen Eye'));

  const { body } = loadClientHalf(react.React, dom);
  body.apply({
    locale: { bind: () => (key) => key, register: () => () => {} },
    settingsScope: { bind: () => stubScope({}) },
    slots: { inject: (_name, callback) => callback(), register: () => () => {} },
    effect: (callback) => callback(),
  });

  assert.equal(marked.get('Screen Eye'), 'data-dsh-screen-eye-settings-nav', 'our row is marked');
  assert.equal(marked.has('General'), false, 'nobody else is');
  assert.equal(dom.observers.length, 1, 'and the marking is kept current as the dialog mounts and relabels');

  // The stylesheet is the other half of the workaround, and it has to be right:
  // it hides the shell's fallback glyph and draws an eye as a currentColor mask
  // so the row's own hover and active colours come through.
  assert.equal(dom.styles.length, 1, 'one stylesheet');
  const [css] = dom.styles;
  assert.match(css.textContent, /\[data-dsh-screen-eye-settings-nav\] > svg:first-child\{display:none\}/u);
  assert.match(css.textContent, /\[data-dsh-screen-eye-settings-nav\]::before\{[^}]*background:currentColor/u);
  assert.match(css.textContent, /mask:url\("data:image\/svg\+xml,[^"]*%3Ccircle[^"]*"\)/u);
  assert.match(css.textContent, /--dsw-alias-label-primary/u, 'and it is drawn in the host\u2019s own tokens');
});

await test('the page renders every setting, and nothing at all when unserved', () => {
  const react = tinyReact();
  const { body } = loadClientHalf(react.React);
  const registered = [];
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    settingsScope: { bind: () => stubScope({}) },
    slots: { inject: (_name, callback) => callback(), register: (spec, component) => { registered.push(component); return () => {}; } },
    effect: (callback) => callback(),
  };
  body.apply(ctx);

  const component = registered[0];
  const scope = stubScope({ locale: 'zh', keepRecent: 20, maxDimension: 4096 }, { keepRecent: 20 });
  const view = react.render(component, { scope, locale: undefined, t: (key) => key });

  // A page, not a card: the controls are there on arrival rather than behind a
  // disclosure, and the heading says what the page is.
  assert.equal(byClass(view.tree, 'screye-title').length, 1);
  const inputs = findAll(view.tree, (node) => node.props['aria-label'] !== undefined);
  assert.deepEqual(
    inputs.map((node) => node.props['aria-label']),
    ['locale', 'outputDir', 'keepRecent', 'timeoutMs', 'maxDimension', 'requireImageCapableModel', 'deleteAfterCommit', 'announceCapability'],
    'eight settings, eight controls, in the order they are declared',
  );
  // The stored value is what the control shows, in the field's own encoding.
  assert.equal(inputs[0].props.value, 'zh');
  assert.equal(inputs[2].props.value, '20');
  assert.equal(inputs[5].props.checked, true, 'a boolean renders as a checkbox');
  assert.equal(inputs[6].props.checked, false);
  // A field whose default is on shows on until it is turned off, so an unset
  // value in the document reads the way the plugin will behave.
  assert.equal(inputs[7].props.checked, true, 'the announcement is on by default');
  // An overridden field is marked and offers a reset; the others do not.
  assert.equal(byClass(view.tree, 'screye-badge').length, 1);
  assert.equal(byClass(view.tree, 'screye-reset').length, 1);

  // A namespace this deployment does not serve leaves no trace.
  const absent = stubScope({});
  absent.getSnapshot = () => ({
    status: 'unavailable', value: undefined, base: undefined, user: undefined,
    revision: 0, writable: false, mode: 'memory',
  });
  assert.equal(react.render(component, { scope: absent, locale: undefined, t: (key) => key }).tree, null);
});

await test('an edit is staged and written on save, and a refusal keeps it', async () => {
  const react = tinyReact();
  const { body } = loadClientHalf(react.React);
  const registered = [];
  const scope = stubScope({ locale: 'en', keepRecent: 50, requireImageCapableModel: true }, { keepRecent: 50 });
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    settingsScope: { bind: () => scope },
    slots: { inject: (_name, callback) => callback(), register: (spec, component) => { registered.push(component); return () => {}; } },
    effect: (callback) => callback(),
  };
  body.apply(ctx);

  const component = registered[0];
  const props = { scope, locale: undefined, t: (key) => key };
  const view = react.render(component, props);

  const control = (label) => findAll(view.tree, (node) => node.props['aria-label'] === label)[0];
  control('keepRecent').props.onChange({ target: { value: '5' } });
  control('locale').props.onChange({ target: { value: 'zh' } });
  control('requireImageCapableModel').props.onChange({ target: { checked: false } });
  // Nothing has been written yet: every settings write is a durable document
  // mutation, so an edit is staged until the user saves it.
  assert.deepEqual(scope.writes, []);

  assert.equal(byClass(view.tree, 'screye-save')[0].props.disabled, false, 'staged edits enable the save');
  assert.equal(byClass(view.tree, 'screye-pending').length, 1, 'and say so above the buttons');

  await byClass(view.tree, 'screye-save')[0].props.onClick();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(scope.writes, [
    { op: 'set', field: 'keepRecent', value: 5 },
    { op: 'set', field: 'locale', value: 'zh' },
    { op: 'set', field: 'requireImageCapableModel', value: false },
  ], 'each staged field is written as its own typed value');

  // A refused write keeps the draft, so the user corrects rather than retypes.
  const refused = stubScope({ keepRecent: 50 });
  refused.set = async () => { throw new Error('SETTINGS_CONFLICT'); };
  const refusedView = react.render(component, { scope: refused, locale: undefined, t: (key) => key });
  findAll(refusedView.tree, (node) => node.props['aria-label'] === 'keepRecent')[0]
    .props.onChange({ target: { value: '9' } });
  await byClass(refusedView.tree, 'screye-save')[0].props.onClick();
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.equal(byClass(refusedView.tree, 'screye-failed').length, 1, 'the refusal is reported');
  assert.equal(
    findAll(refusedView.tree, (node) => node.props['aria-label'] === 'keepRecent')[0].props.value,
    '9',
    'and the edited value is still in the box',
  );

  // A draft that is not a value the field takes blocks the save rather than
  // being dropped: silently discarding a typed number is how a form lies.
  const typed = react.render(component, props);
  findAll(typed.tree, (node) => node.props['aria-label'] === 'timeoutMs')[0]
    .props.onChange({ target: { value: '10' } });
  assert.equal(byClass(typed.tree, 'screye-save')[0].props.disabled, true, 'a value below the floor blocks the save');
  assert.equal(byClass(typed.tree, 'screye-invalid').length, 1, 'and says why');
});

// Remove every capture the suite took. Done unconditionally, so a failing
// case cannot leave PNGs of the user's screen in the temporary directory.
await rm(liveDir, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed`);
process.stdout.write(skipped.length === 0 ? '\n' : `, ${skipped.length} skipped\n`);
if (failures.length > 0) process.exitCode = 1;

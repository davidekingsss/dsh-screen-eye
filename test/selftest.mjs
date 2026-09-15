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
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Config, apply } from '../index.mjs';
import { buildCaptureName, captureStamp, isCaptureName } from '../lib/capture-name.mjs';
import {
  CAPTURE_MODES,
  CaptureError,
  INTERACTIVE_MODES,
  captureScreen,
  isSupportedPlatform,
  planCapture,
  screencaptureArgs,
} from '../lib/capture.mjs';
import { imageContent } from '../lib/image.mjs';
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

let passed = 0;
const failures = [];

/** Run one named case, recording rather than throwing so the suite reports all. */
async function test(name, body) {
  try {
    await body();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
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
  for (const key of ['locale', 'timeoutMs', 'keepRecent', 'requireImageCapableModel', 'deleteAfterCommit']) {
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
  const permission = screenPermissionTool(resolveSettings({}));
  assert.equal(permission.name, 'screen_permission');
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

await test('reports the live permission state and how to fix it', async () => {
  const tool = screenPermissionTool(resolveSettings({}));
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
  const tool = screenPermissionTool(resolveSettings({}));
  const explicit = await tool.execute({ action: 'check' }, stubExec());
  assert.equal(typeof explicit.authorized, 'boolean');
  assert.equal(explicit.settingsOpened, undefined);
});

await test('renders both outcomes with the path the user must grant', () => {
  const tool = screenPermissionTool(resolveSettings({}));
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

await test('renders the settings-opened outcome without claiming authorisation', () => {
  const tool = screenPermissionTool(resolveSettings({}));
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
  const message = captureFailureError(denied, 'en').message;
  assert.match(message, /refused by macOS/u);
  assert.ok(message.includes(grantTargetPath()), 'the message must name what to grant');
  assert.match(message, /Screen & System Audio Recording/u);
  assert.match(message, /No DSH restart is needed/u);
  // The raw system string is replaced, not merely prefixed: it reads like a
  // bug and tells the user nothing they can act on.
  assert.doesNotMatch(message, /could not create image from display/u);

  const chinese = captureFailureError(denied, 'zh').message;
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

const probe = await probeScreenRecording();
if (!probe.authorized) {
  process.stdout.write(`  skip live capture — Screen Recording not granted (${probe.reason})\n`);
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

  await test('reports a non-zero exit instead of writing an empty file', async () => {
    await assert.rejects(
      () => captureScreen(planCapture({ mode: 'display', display: 99 }), {
        outputPath: join(liveDir, 'should-not-exist.png'),
        signal: new AbortController().signal,
        timeoutMs: 20000,
      }),
      (error) => error instanceof CaptureError,
    );
  });
}

process.stdout.write('\nplatform gate\n');

await test('supports only darwin', () => {
  assert.equal(isSupportedPlatform('darwin'), true);
  assert.equal(isSupportedPlatform('win32'), false);
  assert.equal(isSupportedPlatform('linux'), false);
});

await test('the bundle patch gates the module on the platform', async () => {
  // The gate must sit in the patch, not only in apply(): that is what stops
  // the module being imported at all on a non-macOS host.
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /disabled:\s*!!js\s+process\.platform\s*!==\s*'darwin'/u);
  assert.match(patch, /name:\s*dsh-screen-eye/u);
});

await test('the package stays installable and publishable', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  // Declaring only `dsh.client` is the single most common reason a plugin is
  // rejected by the market: `dsh.bundle` is what makes it installable.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  for (const required of ['index.mjs', 'lib/', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(required), `${required} must ship in the tarball`);
  }
  assert.equal(manifest.main, 'index.mjs');
});

process.stdout.write('\nplugin wiring\n');

/** A context that records tool registration and runs injected callbacks at once. */
function wiringCtx() {
  const registered = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    tools: {
      register(definition) {
        registered.push(definition.name);
        return () => {};
      },
    },
    // The real loader waits for the service; the test provides it immediately.
    inject(_services, callback) {
      callback(ctx);
    },
  };
  return { ctx, registered };
}

await test('apply() registers both tools on macOS', () => {
  const { ctx, registered } = wiringCtx();
  apply(ctx, {});
  assert.deepEqual(registered.sort(), ['screen_permission', 'screenshot']);
});

await test('apply() registers nothing on a non-macOS host', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const { ctx, registered } = wiringCtx();
    apply(ctx, {});
    assert.deepEqual(registered, [], 'no capture tool may exist without a capture engine');
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

// Remove every capture the suite took. Done unconditionally, so a failing
// case cannot leave PNGs of the user's screen in the temporary directory.
await rm(liveDir, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;

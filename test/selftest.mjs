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
import { readFile } from 'node:fs/promises';

import { Config, apply } from '../index.mjs';
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
import { screenshotTool } from '../lib/screenshot-tool.mjs';
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
  for (const region of ['0,0,800', 'a,b,c,d', '0,0,800,-1', '0, 0, 800, 600', '', '0,0,800,600,1']) {
    assert.throws(
      () => planCapture({ mode: 'region', region }),
      /region/u,
      `expected ${JSON.stringify(region)} to be rejected`,
    );
  }
});

await test('requires region exactly when the mode is region', () => {
  assert.throws(() => planCapture({ mode: 'region' }), /requires region/u);
  assert.throws(() => planCapture({ mode: 'screen', region: '0,0,10,10' }), /only meaningful/u);
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

  assert.deepEqual(argv({}), ['-x', '-t', 'png', out]);
  assert.deepEqual(argv({ mode: 'display', display: 3 }), ['-x', '-t', 'png', '-D', '3', out]);
  assert.deepEqual(argv({ mode: 'region', region: '1,2,3,4' }), ['-x', '-t', 'png', '-R', '1,2,3,4', out]);
  assert.deepEqual(argv({ mode: 'window' }), ['-x', '-t', 'png', '-o', '-w', out]);
  assert.deepEqual(argv({ mode: 'select' }), ['-x', '-t', 'png', '-i', out]);
  assert.deepEqual(argv({ include_cursor: true }), ['-x', '-t', 'png', '-C', out]);
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

await test('the schemastery defaults agree with the module fallbacks', () => {
  // These two are applied on different paths — the schema when the loader
  // normalises config, the module when it is called directly — so a silent
  // drift between them would make behaviour depend on how the plugin loaded.
  const fromSchema = Config({});
  const fromModule = resolveSettings({});
  for (const key of ['locale', 'timeoutMs', 'requireImageCapableModel', 'deleteAfterCommit']) {
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

process.stdout.write('\nlive capture\n');

const probe = await probeScreenRecording();
if (!probe.authorized) {
  process.stdout.write(`  skip live capture — Screen Recording not granted (${probe.reason})\n`);
} else {
  await test('captures the real screen and commits an image attachment', async () => {
    const attachments = stubAttachments();
    const tool = screenshotTool(
      stubCtx({ attachments }),
      resolveSettings({ requireImageCapableModel: false }),
    );
    const value = await tool.execute({ mode: 'screen' }, stubExec());
    assert.match(value.path, /\.png$/u);
    assert.equal(value.mode, 'screen');
    assert.equal(attachments.saved.length, 1);
    assert.equal(attachments.saved[0].mediaType, 'image/png');
    assert.ok(attachments.saved[0].bytes > 1000, 'a real screen capture is not tiny');
    const blocks = tool.output.render({}, value);
    assert.equal(blocks[1].type, 'image');
  });

  await test('captures a region with mode=region', async () => {
    const attachments = stubAttachments();
    const tool = screenshotTool(
      stubCtx({ attachments }),
      resolveSettings({ requireImageCapableModel: false }),
    );
    const value = await tool.execute({ mode: 'region', region: '0,0,320,240' }, stubExec());
    assert.equal(value.mode, 'region');
    assert.equal(attachments.saved.length, 1);
  });

  await test('reports a non-zero exit instead of writing an empty file', async () => {
    await assert.rejects(
      () => captureScreen(planCapture({ mode: 'display', display: 99 }), {
        outputPath: '/tmp/dsh-screen-eye-should-not-exist.png',
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

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;

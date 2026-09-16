/**
 * macOS Screen Recording (TCC) permission: detection, diagnosis, onboarding.
 *
 * ## Why this module exists
 *
 * On macOS 10.15+ capturing screen pixels is gated by TCC, and the gate is
 * keyed to the *responsible process* — the app macOS holds accountable for a
 * whole process tree. DSH's host is frequently that process itself: the
 * in-app plugin market restarts the host through a detached (POSIX `setsid`)
 * helper, so the new host is reparented to launchd and has no GUI application
 * anywhere above it. The consequence is that a capture fails with
 * `could not create image from display` and **no permission prompt is ever
 * shown**, because macOS cannot attribute the request to anything the user
 * could grant.
 *
 * There is no supported way to grant TCC access programmatically: the
 * databases are SIP-protected, `tccutil` only resets, and
 * `CGRequestScreenCaptureAccess` refuses to prompt for a process that is not a
 * bundle. So this module does the two things that *are* possible, and does
 * them precisely:
 *
 * 1. **Detect** the denial by attempting a real one-pixel-class capture and
 *    reading the result, rather than guessing from a heuristic.
 * 2. **Onboard**: compute the exact executable the user must add, and open the
 *    exact settings pane, instead of describing the path in prose.
 *
 * @module dsh-screen-eye/permission
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from './exec.mjs';

/** The system capture binary. Present on every macOS install. */
export const SCREENCAPTURE = '/usr/sbin/screencapture';

/** Deep link that opens the Screen Recording pane of System Settings. */
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * The stderr `screencapture` writes when TCC refuses the capture.
 *
 * The noun at the end depends on what was asked for, and that is the whole
 * reason this is a prefix rather than a sentence. Measured with the grant
 * revoked, on macOS 26.6.2:
 *
 * | what was asked for | what `screencapture` says |
 * | --- | --- |
 * | the whole screen (`-m`) | `could not create image from display` |
 * | a display (`-D 1`) | `could not create image from display` |
 * | a rectangle (`-R …`) | `could not create image from **rect**` |
 *
 * The last one is the failure this constant used to miss. Matching only the
 * `display` wording meant a denied **region** capture was classified as an
 * ordinary failure, so instead of the onboarding steps the user got a bare
 * "could not create image from rect" — advice that names no remedy, for the one
 * capture mode the tool description recommends. Only the prefix is shared, so
 * only the prefix is matched.
 */
const TCC_DENIAL = 'could not create image from';

/** Failure kinds this module distinguishes. */
export const DENIED = 'screen-recording-denied';
export const OTHER = 'capture-failed';

/**
 * Classify a failed capture from its stderr.
 * @param stderr - the captured standard error.
 * @returns the failure kind.
 */
export function classifyFailure(stderr) {
  return stderr.includes(TCC_DENIAL) ? DENIED : OTHER;
}

/**
 * The executable the user should add to the Screen Recording list.
 *
 * macOS holds the *host* executable responsible for the child processes a
 * plugin spawns, so the answer is this process's own executable — normally the
 * `node` binary running DSH. It is computed rather than hard-coded because the
 * path differs per install (Homebrew, nvm, a bundled runtime).
 * @returns absolute path of the running host executable.
 */
export function grantTargetPath() {
  return process.execPath;
}

/**
 * Attempt a real capture to learn whether Screen Recording is authorised.
 *
 * The probe writes only inside a private temporary directory it creates and
 * removes, so it never leaves an artefact and never touches the user's
 * screenshot folder.
 * @param options - cancellation signal.
 * @returns whether capture works, and the failure kind when it does not.
 */
export async function probeScreenRecording(options = {}) {
  const { signal } = options;
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screen-eye-probe-'));
  const target = join(dir, 'probe.png');
  try {
    const result = await run(SCREENCAPTURE, ['-x', target], { signal, timeoutMs: 15000 });
    if (result.code === 0) return { authorized: true };
    const stderr = result.stderr.trim();
    return {
      authorized: false,
      reason: classifyFailure(stderr),
      detail: stderr === '' ? `screencapture exited with code ${result.code}` : stderr,
    };
  } catch (error) {
    return { authorized: false, reason: OTHER, detail: error.message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Open the Screen Recording pane so the user lands on the exact list they
 * must edit, instead of hunting through System Settings.
 * @param options - cancellation signal.
 */
export async function openScreenRecordingSettings(options = {}) {
  await run('/usr/bin/open', [SCREEN_RECORDING_SETTINGS_URL], {
    signal: options.signal,
    timeoutMs: 10000,
  });
}

const MESSAGES = {
  en: {
    title: 'macOS is refusing screen capture: Screen Recording permission has not been granted.',
    why: 'Capture is gated per responsible process, and this one is not in the list, so macOS denies it without ever showing a permission prompt.',
    steps: [
      'Open System Settings → Privacy & Security → Screen & System Audio Recording.',
      'Click “+”, press ⌘⇧G, paste the path below, and select the file.',
      'Turn its switch on.',
    ],
    targetLabel: 'Path to add',
    listedAs: 'macOS lists it by its file name, not the full path.',
    alt: 'If DSH was started from a terminal, granting that terminal app instead also works.',
    verify: 'Then re-run the tool. No DSH restart is needed — the grant applies immediately.',
    reconsent: 'macOS may ask you to re-confirm this permission periodically; re-enabling the same switch is enough.',
  },
  zh: {
    title: 'macOS 拒绝了截屏：尚未授予「屏幕录制」权限。',
    why: '截屏权限按「责任进程」授予，而当前进程不在授权列表里，所以 macOS 直接拒绝，连授权弹窗都不会出现。',
    steps: [
      '打开 系统设置 → 隐私与安全性 → 屏幕与系统音频录制。',
      '点「+」，按 ⌘⇧G，粘贴下面的路径并选中该文件。',
      '把它的开关打开。',
    ],
    targetLabel: '需要添加的路径',
    listedAs: 'macOS 在列表里显示的是文件名，不是完整路径。',
    alt: '如果 DSH 是从终端启动的，改为给那个终端 App 授权同样有效。',
    verify: '然后重新调用本工具即可。不需要重启 DSH——授权立即生效。',
    reconsent: 'macOS 可能定期要求重新确认此权限，把同一个开关重新打开即可。',
  },
};

/**
 * Resolve the message table for a locale, falling back to English.
 * @param locale - requested locale tag.
 * @returns the message table.
 */
export function messagesFor(locale) {
  const key = typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return MESSAGES[key];
}

/**
 * Build the actionable onboarding text for a denied capture.
 *
 * Every line is something the user can act on: the pane, the exact path, and
 * what to expect afterwards. The path is computed from the running host so the
 * instruction is correct for this install.
 * @param options - locale and an optional pre-computed grant target.
 * @returns the guidance as an array of lines.
 */
export function guidance(options = {}) {
  const m = messagesFor(options.locale);
  const target = options.target ?? grantTargetPath();
  const name = target.slice(target.lastIndexOf('/') + 1);
  return [
    m.title,
    m.why,
    ...m.steps.map((step, index) => `${index + 1}. ${step}`),
    `${m.targetLabel}: ${target}`,
    `${m.listedAs} Look for “${name}”.`,
    m.alt,
    m.verify,
    m.reconsent,
  ];
}

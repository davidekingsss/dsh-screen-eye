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
 * `could not create image from display` and **no permission prompt is shown**,
 * because macOS cannot attribute the request to anything the user could grant.
 * (When the host *is* a bundle — the desktop app — a prompt does appear, and
 * the state table below covers what happens then.)
 *
 * There is no supported way to grant TCC access programmatically: the
 * databases are SIP-protected and `tccutil` only resets. So this module does
 * the two things that *are* possible, and does them precisely:
 *
 * 1. **Detect** the denial by attempting a real one-pixel-class capture and
 *    reading the result, rather than guessing from a heuristic.
 * 2. **Onboard**: compute the exact executable the user must add, and open the
 *    exact settings pane, instead of describing the path in prose.
 *
 * ## Three states, and why the guidance names all three steps
 *
 * Switching a grant off and removing the app from the list are *different*
 * states, and only the second is "never granted". Both were produced on macOS
 * 26.6.2 and observed:
 *
 * | state | system prompt | in the list | captures work |
 * | --- | --- | --- | --- |
 * | never requested | **yes**, on the first request | after the user opens Settings | no |
 * | granted, then switched off | no | yes, switch off | no |
 * | removed from the list | **yes**, on the next request | after the user opens Settings | no |
 *
 * Two consequences, both learned by measurement rather than reasoning:
 *
 * - **Being in the list is not being granted.** The system adds the app with
 *   its switch **off**, so the step after the prompt is a manual one. A capture
 *   attempted in that window fails again, and the guidance has to say so: the
 *   user has done the part they were asked to do, and the remaining step is
 *   *switching the entry on*, which nothing this process can do will replace.
 * - **`CGRequestScreenCaptureAccess()` returning `false` does not mean no
 *   prompt appeared.** It returns immediately and the prompt arrives
 *   asynchronously, so the return value says nothing about what the user sees.
 *   An earlier revision of this note claimed that API "refuses to prompt for a
 *   process that is not a bundle"; in a real never-granted state the prompt
 *   appeared — *"「运行 Deepseek Harness」想要录制此电脑的屏幕和音频。"* — while
 *   the call returned `false` in the same second it was made.
 *
 * So the guidance names the three steps in order and does not retry between
 * them. There is nothing to do between the prompt and the switch, and a capture
 * attempted in that window can only reproduce the denial — which is why the
 * message stops rather than inviting another attempt.
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
    why: 'Capture is gated per responsible process. Depending on how DSH was started, macOS either asks the user once — which a bundled app like the desktop client does — or refuses silently, which is what happens when there is no application to attribute the request to. Either way nothing is captured until the switch below is on.',
    // Four steps in the order they actually happen. The third is the one that
    // is easy to skip and was missing before: the system adds the app to the
    // list by itself, with the switch OFF, so "it is in the list" is not
    // "it is granted" — a capture attempted at that point fails again.
    steps: [
      'Watch for a system dialog asking to record this computer’s screen. If it appears, click “Open System Settings” — it adds the app to the list for you. If it does not appear, open System Settings → Privacy & Security → Screen & System Audio Recording yourself.',
      'Find the entry in the list, using the name below. It may already be there, added by that dialog.',
      '**Switch it on.** An entry the system added is OFF by default, and being listed is not being granted.',
      'Then re-run the tool. Nothing else is needed — the grant applies immediately, and DSH does not have to be restarted.',
    ],
    targetLabel: 'Full path, if you have to add it by hand',
    listedAs: 'The list shows file names rather than paths, so the entry to switch on is named',
    alt: 'If DSH was started from a terminal, granting that terminal app instead also works.',
    verify: 'Do not retry in between: until the switch is on, every capture fails the same way, and this message is the whole remedy.',
    reconsent: 'macOS may ask you to re-confirm this permission periodically; switching the same entry back on is enough.',
  },
  zh: {
    title: 'macOS 拒绝了截屏：尚未授予「屏幕录制」权限。',
    why: '截屏权限按「责任进程」授予。取决于 DSH 的启动方式，macOS 要么只问用户一次（桌面客户端这类有 App 身份的会弹窗），要么直接静默拒绝（没有可归属的应用程序时就是这样）。两种情况都一样：下面的开关不打开，就什么都截不到。',
    // 四步，按真实发生顺序。第三步是最容易漏、之前也缺的：App 是系统自动加进列表的，
    // 而且开关默认是关的——「在列表里」不等于「已授权」，此时截图仍然会失败。
    steps: [
      '留意屏幕上是否弹出「想要录制此电脑的屏幕和音频」的系统对话框。若弹出，点「打开系统设置」——它会自动把该 App 加进列表。若没有弹出，就自己打开 系统设置 → 隐私与安全性 → 屏幕与系统音频录制。',
      '在列表里找到对应的条目，名字见下方。它可能已经在那了（就是刚才那个对话框加进去的）。',
      '**把它的开关打开。** 系统自动加入的条目默认是关闭的，在列表里并不等于已授权。',
      '然后重新调用本工具。不需要做别的——授权立即生效，也不需要重启 DSH。',
    ],
    targetLabel: '若需要手工添加，完整路径',
    listedAs: '列表里显示的是文件名而不是路径，所以要找的条目名是',
    alt: '如果 DSH 是从终端启动的，改为给那个终端 App 授权同样有效。',
    verify: '中途不要反复重试：开关没打开之前，每次截图都会以同样的方式失败，而这条消息就是全部的处理办法。',
    reconsent: 'macOS 可能定期要求重新确认此权限，把同一个条目的开关重新打开即可。',
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
    // The name first, because that is what the user has to find in a list that
    // shows file names rather than paths; the full path is the useful second
    // line, for the "add it by hand" case. This used to lead with the path and
    // then say "look for the file name", which asked the user to derive the
    // thing it had just declined to state.
    `${m.listedAs} ${name}`,
    `${m.targetLabel}: ${target}`,
    m.alt,
    m.verify,
    m.reconsent,
  ];
}

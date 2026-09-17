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

/**
 * What the user is told when the grant is missing.
 *
 * The scope is deliberate and narrow: this plugin is for a harness whose users
 * know their way around macOS, and granting Screen Recording is a basic
 * operation there. So the guidance states what is *not* obvious from the pane —
 * which entry to look for, and that an entry being present does not mean it is
 * on — and stops. It does not explain System Settings.
 *
 * ## Why the entry is named by a list rather than one string
 *
 * macOS names the entry after **the app bundle the request is attributed to**,
 * which is the app that started the harness. Measured on one machine, three
 * launchers produced three different names:
 *
 * | how DSH was started | entry in the list |
 * | --- | --- |
 * | the Shortcuts droplet (`运行Deepseek Harness.app`) | `运行 Deepseek Harness` |
 * | a browser | `Google Chrome` |
 * | a terminal | `Terminal` / `iTerm` |
 *
 * So there is no single correct name to print: the same plugin on the same
 * machine needs a different entry depending on how it was launched, and the
 * name cannot be computed from inside the process. `process.execPath` gives the
 * host executable — `node` — which is the right answer when the host is what
 * macOS attributes the request to, and one candidate among several when it is
 * not. Printing that alone sent readers to look for an entry that may not exist;
 * printing the principle lets them recognise the right one in a list they are
 * already looking at.
 */
const MESSAGES = {
  en: {
    title: 'macOS is refusing screen capture: Screen Recording permission is not in force for this process.',
    why: 'Capture is gated per responsible process, and this one is not granted. macOS asks on first request when there is an app to ask about; when the host has no app identity above it — a harness reparented to launchd — the request is refused without a prompt. Either way the fix is one switch.',
    steps: [
      'Open System Settings → Privacy & Security → Screen & System Audio Recording. If a system dialog asks to record this computer’s screen, “Open System Settings” takes you to the same place.',
      'Find the entry for **the app you started DSH with** — macOS names the entry after that app, not after the harness. Common ones are listed below.',
      '**Turn it on.** An entry the system added is off by default: being listed is not being granted, and a capture taken before the switch is on fails exactly as this one did.',
    ],
    listedAs: 'Entry names to look for',
    candidates: ['the Shortcuts droplet 运行 Deepseek Harness', 'the browser you launched it from', 'the terminal you launched it from'],
    verify: 'Do not retry in between — until the switch is on, every capture fails the same way.',
    reconsent: 'macOS may ask you to re-confirm this periodically; switching the same entry back on is enough.',
  },
  zh: {
    title: 'macOS 拒绝了截屏：「屏幕录制」权限对此进程未生效。',
    why: '截屏权限按「责任进程」授予，而当前进程没有得到授权。有可询问的 App 时，macOS 会在首次请求时弹窗询问；宿主上方没有 App 身份时（比如被重新挂到 launchd 的 harness），则会不弹窗直接拒绝。两种情况都只需打开一个开关。',
    steps: [
      '打开 系统设置 → 隐私与安全性 → 屏幕与系统音频录制。若弹出「想要录制此电脑的屏幕和音频」的系统对话框，点「打开系统设置」会到同一页。',
      '在列表里找到**你用来启动 DSH 的那个 App** 对应的条目——macOS 是按启动 DSH 的 App 命名的，不是按 harness 本身命名。常见条目见下方。',
      '**把它的开关打开。** 系统自动加入的条目默认是关闭的：在列表里并不等于已授权，开关打开之前截图会以完全相同的方式失败。',
    ],
    listedAs: '可能出现的条目名',
    candidates: ['快捷指令容器 运行 Deepseek Harness', '你启动它所用的浏览器', '你启动它所用的终端'],
    verify: '中途不要重试——开关打开之前，每次截图都会以同样的方式失败。',
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
 * Every line is something the user can act on: the pane, the entry to switch
 * on, and what to expect afterwards. The name is the host executable's, which is
 * the one candidate this process can compute — see the state table above for why
 * it is offered among others rather than as the single answer.
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
    // The host executable's name first — it is the one candidate this process
    // can actually compute, and the correct one whenever the host is what macOS
    // attributes the request to — then the launchers that were observed to take
    // its place. A single name was wrong on this machine in two of the three
    // ways DSH gets started.
    `${m.listedAs}: ${[name, ...m.candidates].join(' / ')}`,
    m.verify,
    m.reconsent,
  ];
}

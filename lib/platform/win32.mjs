/**
 * The Windows platform.
 *
 * Everything in this plugin that is specific to Windows is here, or is built
 * here and nowhere else: the capture engine and the PowerShell it drives, the
 * display inventory, and the desktop-session precondition that stands in for
 * the consent model macOS has and Windows does not.
 *
 * Like `darwin.mjs` it is reached only through `lib/platform.mjs`, so the tool
 * layer never learns which operating system it is on.
 *
 * ## Why PowerShell
 *
 * The same reason the macOS engine shells out to `screencapture`: the
 * alternative is a compiled artefact. Windows has no command-line capture tool
 * — Snipping Tool is an interactive application that hands its result to the
 * clipboard — so the engine is Windows PowerShell 5.1, present on every
 * Windows install, driving `System.Drawing` through a shim compiled in memory
 * by `Add-Type`. Nothing is shipped as a binary and nothing is installed.
 *
 * `powershell.exe` rather than `pwsh`: 5.1 is the one that is always there, and
 * it is STA by default, which is what the WinForms screen enumeration wants.
 *
 * ## DPI: measured, not assumed
 *
 * A DPI-unaware process does not capture the screen it is looking at. GDI
 * virtualises its coordinates: on the machine this was written on — a
 * 3840x2160 panel at 125% scaling — Windows PowerShell reports the desktop as
 * 3072x1728 and `CopyFromScreen` returns a *downscaled* bitmap of it. Text
 * captured that way is visibly softer, which for a tool whose whole purpose is
 * reading the screen is the product. So the shim declares per-monitor-v2
 * awareness before WinForms is loaded — the order matters, because
 * `Screen.AllScreens` caches on first touch — and the same panel then reports
 * 3840x2160, its true resolution. Both numbers were observed on that machine,
 * in that order, with the awareness call in between.
 *
 * ## What one capture costs, and why a burst is one process
 *
 * Measured on that same 4K machine: starting PowerShell and compiling the shim
 * costs about 600ms, and the frame itself costs 150ms at full screen — 65ms to
 * read the pixels and 85ms to encode them — or 16ms for an 800x600 region. So
 * a single capture costs about a second whatever it captures, and the area
 * barely matters. A burst taken as N separate calls would therefore pay that
 * second N times, turning a 400ms animation into six seconds of sampling —
 * which is not a sample of it at all. Hence `captureBurst`: one process, one
 * shim, one rectangle, N frames spaced by the plan's interval, which is the
 * only way the interval the tool advertises is reachable here.
 *
 * ## What Windows does not have
 *
 * No consent gate, so `permission` is `null` and no `screen_permission` tool is
 * registered; see `docs/windows.md`. What it has instead is a precondition: a
 * process that is not attached to the interactive window station cannot see
 * the desktop, and a naive engine reports that as a successful capture of a
 * black screen. This one refuses it by name before capturing anything, and
 * reports an all-black frame afterwards rather than passing it off as a picture
 * of the user's screen.
 *
 * @module dsh-screen-eye/platform/win32
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CaptureError } from '../capture-error.mjs';
import { run } from '../exec.mjs';

/** `process.platform` value this implements. */
export const id = 'win32';

/** Failure kinds this module distinguishes. */
export const NO_SESSION = 'no-interactive-session';
export const NO_SUCH_DISPLAY = 'no-such-display';
export const NO_FOREGROUND_WINDOW = 'no-foreground-window';
export const REGION_OUTSIDE_DESKTOP = 'region-outside-desktop';
export const UNSUPPORTED_MODE = 'unsupported-mode';
export const ENGINE_UNAVAILABLE = 'engine-unavailable';

/** The marker every script prints its one result line with. */
export const RESULT_MARKER = 'DSH_SCREEN_EYE_RESULT';

/**
 * What a thrown `Fail` carries inside the engine, where a failure has to end the
 * request rather than the process. Split on the first `|`.
 */
const FAIL_PREFIX = 'DSH-FAIL:';

/** How long an idle engine is kept before it is shut down. */
const ENGINE_IDLE_MS = 120000;

/** How long to wait for a freshly started engine to announce itself. */
const ENGINE_START_TIMEOUT_MS = 20000;

/** How long one request may take before it is abandoned. */
const ENGINE_REQUEST_TIMEOUT_MS = 120000;

/**
 * How much of a frame must be pure black before the frame is reported as
 * black, in tenths of a percent — integral, so the comparison travels across
 * the JavaScript/PowerShell boundary without a float.
 *
 * Not 1000 (every sampled pixel): a capture of a locked or disconnected
 * session is black, but so is a screen showing a full-screen black window, and
 * those are told apart by how the message reads, not by the threshold. 995
 * leaves room for a lit cursor or a stray pixel without letting a real desktop
 * through.
 */
export const BLACK_FRAME_PERMILLE = 995;

/** How many pixels the black-frame check examines, however large the frame. */
const BLACK_SAMPLE_BUDGET = 30000;

/**
 * How many pixels the change fingerprint examines.
 *
 * The fingerprint answers one question — "is this rectangle still showing what
 * it was showing?" — so it samples rather than reads every pixel: 4000 points
 * across the rectangle is enough that a moving element, a colour change or a
 * dialog opening all change it, and it costs about a millisecond in the engine.
 * Fewer would risk missing a small element; more would spend time on precision
 * that a yes/no answer does not need.
 */
const FINGERPRINT_SAMPLE_BUDGET = 4000;

/**
 * Where Windows PowerShell 5.1 lives.
 *
 * `SystemRoot` rather than a hard-coded `C:\Windows`, because the drive letter
 * is a choice the installer made. The fallback covers only an environment with
 * no `SystemRoot` at all, where nothing else on Windows works either.
 * @returns the absolute path to `powershell.exe`.
 */
export function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The argument vector that hands a script to PowerShell.
 *
 * `-EncodedCommand` takes the script as base64 of UTF-16LE, which sidesteps
 * command-line quoting entirely: the script carries paths, a C# source block
 * and here-strings, and none of it has to survive a trip through `cmd`-style
 * quoting rules. `-NonInteractive` keeps the engine from ever waiting on a
 * prompt, and `-ExecutionPolicy Bypass` is belt-and-braces: inline commands are
 * not subject to the policy, but a machine with a restrictive one is exactly
 * where a capture tool must not surprise its user.
 *
 * @param script - the PowerShell source to run.
 * @returns the argument vector.
 */
export function powershellArgs(script) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

/**
 * The C# shim, as source.
 *
 * Everything the .NET base library does not expose is here: the DPI
 * declaration, the window station the process is attached to, the foreground
 * window's rectangle, the cursor, and the black-frame sample. Its surface is
 * deliberately primitive — strings, `int[]`, `int` codes — so no nested struct
 * has to be constructed from script.
 */
const SHIM_SOURCE = `[DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, System.Text.StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
[DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
[DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
[StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
public static string WindowStationName() {
  System.Text.StringBuilder name = new System.Text.StringBuilder(256);
  uint needed = 0;
  if (!GetUserObjectInformation(GetProcessWindowStation(), 2, name, 256, out needed)) return "";
  return name.ToString();
}
public static bool MakeDpiAware() {
  try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true; } catch { }
  try { return SetProcessDPIAware(); } catch { return false; }
}
public static int[] ForegroundWindowRect() {
  IntPtr hwnd = GetForegroundWindow();
  if (hwnd == IntPtr.Zero) return null;
  RECT r;
  if (!GetWindowRect(hwnd, out r)) return null;
  return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
}
public static int DrawCursor(IntPtr hdc, int originX, int originY) {
  CURSORINFO info = new CURSORINFO();
  info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
  if (!GetCursorInfo(ref info)) return -1;
  if ((info.flags & 1) == 0) return -2;
  ICONINFO icon;
  if (!GetIconInfo(info.hCursor, out icon)) return -3;
  return DrawIconEx(hdc, info.ptScreenPos.X - originX, info.ptScreenPos.Y - originY, info.hCursor, 0, 0, 0, IntPtr.Zero, 3) ? 0 : -4;
}
public static int BlackPermille(IntPtr scan0, int stride, int width, int height) {
  int step = (int)Math.Sqrt(((double)width * height) / ${BLACK_SAMPLE_BUDGET}.0);
  if (step < 1) step = 1;
  long sampled = 0;
  long black = 0;
  for (int y = 0; y < height; y += step) {
    int row = y * stride;
    for (int x = 0; x < width; x += step) {
      int i = row + x * 3;
      sampled++;
      if (Marshal.ReadByte(scan0, i) < 8 && Marshal.ReadByte(scan0, i + 1) < 8 && Marshal.ReadByte(scan0, i + 2) < 8) black++;
    }
  }
  return sampled == 0 ? 0 : (int)(black * 1000 / sampled);
}
public static string Fingerprint(IntPtr scan0, int stride, int width, int height) {
  int step = (int)Math.Sqrt(((double)width * height) / ${FINGERPRINT_SAMPLE_BUDGET}.0);
  if (step < 1) step = 1;
  ulong hash = 14695981039346656037UL;
  for (int y = 0; y < height; y += step) {
    int row = y * stride;
    for (int x = 0; x < width; x += step) {
      int i = row + x * 3;
      hash = (hash ^ Marshal.ReadByte(scan0, i)) * 1099511628211UL;
      hash = (hash ^ Marshal.ReadByte(scan0, i + 1)) * 1099511628211UL;
      hash = (hash ^ Marshal.ReadByte(scan0, i + 2)) * 1099511628211UL;
    }
  }
  return hash.ToString("x16");
}
public static byte[] Sample(IntPtr scan0, int stride, int width, int height, int budget) {
  int step = (int)Math.Sqrt(((double)width * height) / (double)budget);
  if (step < 1) step = 1;
  System.Collections.Generic.List<byte> samples = new System.Collections.Generic.List<byte>();
  for (int y = 0; y < height; y += step) {
    int row = y * stride;
    for (int x = 0; x < width; x += step) {
      int i = row + x * 3;
      samples.Add(Marshal.ReadByte(scan0, i));
      samples.Add(Marshal.ReadByte(scan0, i + 1));
      samples.Add(Marshal.ReadByte(scan0, i + 2));
    }
  }
  return samples.ToArray();
}
public static int Difference(IntPtr scan0, int stride, int width, int height, int budget, byte[] baseline) {
  int step = (int)Math.Sqrt(((double)width * height) / (double)budget);
  if (step < 1) step = 1;
  int index = 0;
  int changed = 0;
  for (int y = 0; y < height; y += step) {
    int row = y * stride;
    for (int x = 0; x < width; x += step) {
      int i = row + x * 3;
      if (index + 2 >= baseline.Length) return changed;
      if (Math.Abs(Marshal.ReadByte(scan0, i) - baseline[index]) > 8
          || Math.Abs(Marshal.ReadByte(scan0, i + 1) - baseline[index + 1]) > 8
          || Math.Abs(Marshal.ReadByte(scan0, i + 2) - baseline[index + 2]) > 8) changed++;
      index += 3;
    }
  }
  return changed;
}`;

/**
 * Where the compiled shim is cached, named after its own source.
 *
 * Compiling that C# costs about 176ms of every engine call — measured, and by
 * far the largest fixed cost after PowerShell's own start — while loading the
 * same code as a compiled assembly costs 20ms. Since each capture is a fresh
 * process, the compile would otherwise be paid again for every frame of every
 * burst.
 *
 * The name carries a hash of the source, so a change to the shim invalidates it
 * by construction rather than by a version somebody has to remember to bump,
 * and the directory is the system's temporary one: a cache that can be deleted
 * at any time is the only kind worth having here, because the failure mode of a
 * missing cache is a recompile.
 *
 * @returns the absolute path of the cached assembly for this source.
 */
export function shimCachePath() {
  const digest = createHash('sha256').update(SHIM_SOURCE).digest('hex').slice(0, 16);
  return join(tmpdir(), 'dsh-screen-eye-shim', `native-${digest}.dll`);
}

/**
 * The script lines that make `DshScreenEye.Native` available.
 *
 * Three attempts, in descending order of speed, and the last one is exactly
 * what this did before there was a cache: load the compiled assembly, else
 * compile it to the cache and load that, else compile it in memory. Every
 * failure path ends in the old behaviour rather than in an error, so the cache
 * can only ever make an engine call faster — it cannot make one fail. The
 * windowsHide/DPI/black-frame machinery downstream does not know which of the
 * three produced the type.
 *
 * @returns the PowerShell source.
 */
function shimLoader() {
  return `$nativeSource = @'
${SHIM_SOURCE}
'@
$shim = '${quote(shimCachePath())}'
try {
  if (Test-Path $shim) { Add-Type -Path $shim -ErrorAction Stop }
  else {
    $staged = $shim + '.' + $PID + '.dll'
    Add-Type -Namespace DshScreenEye -Name Native -MemberDefinition $nativeSource -OutputAssembly $staged -ErrorAction Stop
    Move-Item -Force $staged $shim -ErrorAction SilentlyContinue
    if (Test-Path $shim) { try { Add-Type -Path $shim -ErrorAction Stop } catch { } }
  }
} catch { }
if ($null -eq ([System.Management.Automation.PSTypeName]'DshScreenEye.Native').Type) {
  try { Add-Type -Namespace DshScreenEye -Name Native -MemberDefinition $nativeSource -ErrorAction Stop }
  catch { Fail '${ENGINE_UNAVAILABLE}' ('the Windows capture helper could not be compiled: ' + $_.Exception.Message) }
}`;
}

/**
 * The script every engine call starts with.
 *
 * One marked result line on stdout, because PowerShell mixes other streams into
 * a redirected stdout on some hosts and a parser that trusted "the whole output
 * is JSON" would break on the first warning. Non-ASCII is escaped into the JSON
 * by hand rather than trusting the console encoding to survive the trip: a
 * localised Windows error message is exactly the text worth getting right, and
 * mojibake in an error is worse than a longer line.
 */
const PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$marker = '${RESULT_MARKER}'
function ConvertTo-AsciiJson($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 6
  return [regex]::Replace($json, '[^\\u0020-\\u007E]', { param($c) '\\u' + ('{0:X4}' -f [int][char]$c.Value) })
}
function Emit($payload) { Write-Output ($marker + ' ' + (ConvertTo-AsciiJson $payload)) }
function Fail([string]$kind, [string]$detail) { Emit @{ ok = $false; kind = $kind; detail = $detail }; exit 1 }
${shimLoader()}`;

/**
 * The precondition that stands in for a permission gate.
 *
 * A process on a window station other than `WinSta0`, or in session 0, has no
 * visible desktop to read. `CopyFromScreen` does not fail there — it returns
 * black — so this check exists to turn the engine's worst failure mode, a
 * confident picture of nothing, into an error that names the cause.
 */
const SESSION_CHECK = `$station = [DshScreenEye.Native]::WindowStationName()
  $session = (Get-Process -Id $PID).SessionId
  if ($station -ne 'WinSta0' -or $session -eq 0) {
    Fail '${NO_SESSION}' ("this process is attached to window station '" + $station + "' in session " + $session + ', which has no visible desktop to capture. Start the harness from a normal desktop session.')
  }`;

/**
 * Declare DPI awareness and load the assemblies the rectangle logic needs.
 * Split from the rectangle itself so both the capture and the inventory script
 * do it the same way, in the same order.
 */
const ENGINE_SETUP = `$aware = [DshScreenEye.Native]::MakeDpiAware()
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $primary = [System.Windows.Forms.Screen]::PrimaryScreen
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen`;

/**
 * Quoting for a PowerShell single-quoted string, the only kind used for
 * interpolated values: inside single quotes every character is literal except
 * the quote itself, so doubling it is the whole escaping rule.
 * @param value - the literal to embed.
 * @returns the literal, safe to place between single quotes.
 */
function quote(value) {
  return String(value).replaceAll("'", "''");
}

/**
 * Resolve a request's mode into `$rect`, in virtual-screen coordinates.
 *
 * That coordinate space is the one the tool already documents: the primary
 * display's top-left is the origin, and a display placed to its left or above
 * takes negative coordinates — which is exactly how Windows reports displays,
 * so `region` needs no translation. `screen` and `display` are the same
 * rectangle logic the inventory uses, so the index `listDisplays` hands out is
 * the index `capture` accepts.
 *
 * Written once and used by all three callers — the single-shot capture, the
 * single-shot burst and the resident engine — because those three drifting
 * apart on what `region` means is the one bug that would be invisible until a
 * user's rectangle landed in the wrong place. It reads `$request`, which the
 * one-shot scripts build as a hashtable and the engine receives as JSON.
 */
const RECT_RESOLVER = `if ($request.mode -eq 'screen') {
  $rect = $primary.Bounds
}
elseif ($request.mode -eq 'display') {
  $ordered = @($screens | Where-Object { $_.Primary }) + @($screens | Where-Object { -not $_.Primary })
  $index = [int]$request.display
  if ($index -lt 1 -or $index -gt $ordered.Count) {
    Fail '${NO_SUCH_DISPLAY}' ('display ' + $index + ' does not exist: this machine reports ' + $ordered.Count + ' display(s)')
  }
  $rect = $ordered[$index - 1].Bounds
}
elseif ($request.mode -eq 'region') {
  $rect = New-Object System.Drawing.Rectangle ([int]$request.x), ([int]$request.y), ([int]$request.w), ([int]$request.h)
  if ([System.Drawing.Rectangle]::Intersect($rect, $virtual).Width -lt 1 -or [System.Drawing.Rectangle]::Intersect($rect, $virtual).Height -lt 1) {
    Fail '${REGION_OUTSIDE_DESKTOP}' ('region ' + $request.x + ',' + $request.y + ',' + $request.w + ',' + $request.h + ' does not overlap any display; this desktop spans ' + $virtual.X + ',' + $virtual.Y + ' ' + $virtual.Width + 'x' + $virtual.Height)
  }
}
elseif ($request.mode -eq 'window') {
  # Windows has no "click a window to capture it" affordance, so window means
  # the window the user is actually looking at: the foreground one. Clamped to
  # the desktop, because a maximised window reports a rectangle about eight
  # pixels larger than the screen on every side — its invisible resize border —
  # and capturing beyond the desktop yields black edges.
  $foreground = [DshScreenEye.Native]::ForegroundWindowRect()
  if ($null -eq $foreground) {
    Fail '${NO_FOREGROUND_WINDOW}' 'no window is in the foreground to capture; use mode "region", or mode "displays" to pick a screen'
  }
  $rect = [System.Drawing.Rectangle]::Intersect((New-Object System.Drawing.Rectangle $foreground[0], $foreground[1], $foreground[2], $foreground[3]), $virtual)
  if ($rect.Width -lt 1 -or $rect.Height -lt 1) {
    Fail '${NO_FOREGROUND_WINDOW}' 'the window in the foreground does not overlap the desktop, so there is nothing to capture'
  }
}
elseif ($request.mode -eq 'select') {
  # Nothing on Windows provides a region picker: the Snipping Tool overlay is a
  # separate interactive application that hands its result to the clipboard. A
  # mode that silently captured something else would be worse than one that says
  # it is not available here.
  Fail '${UNSUPPORTED_MODE}' 'mode "select" has no Windows equivalent: Windows ships no system region picker for a program to lean on. Capture a known rectangle with mode "region" instead, taking its coordinates from an earlier full capture.'
}
else {
  Fail '${UNSUPPORTED_MODE}' ('mode "' + $request.mode + '" has no Windows implementation')
}`;

/**
 * The one place a frame is grabbed, shared by the single capture, the burst and
 * the resident engine.
 *
 * A burst that used a different code path from a single capture is how the two
 * drift apart, and the properties that matter here — 24 bits per pixel so no
 * alpha channel is invented, and the black sample taken from the same locked
 * bits that were just written — have to hold for every frame alike.
 *
 * The bitmap is 24bpp rather than 32: `CopyFromScreen` writes opaque pixels,
 * so an alpha channel would carry no information, and the attachment store
 * treats a needless alpha plane as a difference worth re-encoding for.
 *
 * The pointer is composited by hand: `CopyFromScreen` reads the desktop's
 * pixels and never includes the cursor, so a capture that claims to show where
 * the mouse is has to draw it — and drawing it *after* the copy, since the copy
 * would paint over anything drawn before. Whether to draw is the caller's third
 * argument rather than a decision baked into the script, because the resident
 * engine serves requests that differ in exactly that; the return value says
 * what was done either way — `$null` when nobody asked, a `DrawIconEx` code
 * when somebody did.
 *
 * @returns the PowerShell function definition.
 */
function frameFunction() {
  return `function Save-Frame([System.Drawing.Rectangle]$rect, [string]$path, [bool]$drawCursor) {
  $bitmap = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $cursor = $null
    if ($drawCursor) {
      $cursor = -9
      $hdc = $graphics.GetHdc()
      try { $cursor = [DshScreenEye.Native]::DrawCursor($hdc, $rect.X, $rect.Y) } finally { $graphics.ReleaseHdc($hdc) }
    }
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $whole = New-Object System.Drawing.Rectangle 0, 0, $bitmap.Width, $bitmap.Height
    $bits = $bitmap.LockBits($whole, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try { $black = [DshScreenEye.Native]::BlackPermille($bits.Scan0, $bits.Stride, $bitmap.Width, $bitmap.Height) }
    finally { $bitmap.UnlockBits($bits) }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return @{ black = $black; cursor = $cursor }
}`;
}

/**
 * Build the `$request` the resolver reads, for a one-shot script.
 *
 * The resident engine gets this object as JSON and the one-shot scripts build
 * it as a hashtable; both read the same fields, which is what keeps one
 * implementation of "what does this mode mean" instead of two.
 *
 * @param plan - the validated capture request.
 * @returns the PowerShell line that assigns `$request`.
 */
function requestLiteral(plan) {
  const parts = [`mode = '${plan.mode}'`];
  if (plan.mode === 'region') {
    const region = parseRegion(plan.region);
    parts.push(`x = ${region[0]}; y = ${region[1]}; w = ${region[2]}; h = ${region[3]}`);
  }
  if (plan.display !== undefined) parts.push(`display = ${plan.display}`);
  parts.push(`cursor = $${plan.includeCursor}`);
  return `$request = @{ ${parts.join('; ')} }`;
}

/**
 * Build the capture script for a single planned capture.
 *
 * Exported for testing: this mapping — plan to Windows rectangle — is the part
 * of the engine worth asserting without capturing anything, the way
 * `screencaptureArgs` is for macOS.
 *
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @returns the PowerShell source.
 * @throws a `CaptureError` when the plan does not carry what the mode needs.
 */
export function captureScript(plan, outputPath) {
  if (plan.mode === 'region') parseRegion(plan.region);
  return `${PRELUDE}

try {
  ${SESSION_CHECK}
  ${ENGINE_SETUP}
  ${requestLiteral(plan)}
  ${RECT_RESOLVER}

  if ($rect.Width -lt 1 -or $rect.Height -lt 1) {
    Fail 'capture-failed' ('the ${plan.mode} capture resolved to an empty rectangle ' + $rect.X + ',' + $rect.Y + ' ' + $rect.Width + 'x' + $rect.Height)
  }

  ${frameFunction()}
  $frame = Save-Frame $rect '${quote(outputPath)}' ([bool]$request.cursor)

  Emit @{
    ok = $true
    mode = '${plan.mode}'
    dpiAware = $aware
    cursorDrawn = $frame.cursor
    width = $rect.Width
    height = $rect.Height
    blackPermille = $frame.black
    desktop = @{ x = $virtual.X; y = $virtual.Y; width = $virtual.Width; height = $virtual.Height }
  }
} catch {
  Fail 'capture-failed' $_.Exception.Message
}`;
}

/**
 * Build the script that takes a whole burst in one engine call.
 *
 * The spacing rule is the one `lib/capture.mjs` applies to a platform that has
 * to spawn per frame: sleep the remainder of the target period, and let a frame
 * that already outran it run again immediately, which is the honest outcome for
 * an interval the machine cannot meet. What changes here is only that the
 * target is reachable at all, because the frames no longer pay for a process
 * each.
 *
 * @param plan - the validated capture request.
 * @param paths - the resolved absolute output path of every frame, in order.
 * @returns the PowerShell source.
 * @throws a `CaptureError` when the plan does not carry what the mode needs.
 */
export function burstScript(plan, paths) {
  const quoted = paths.map((path) => `'${quote(path)}'`).join(', ');
  const interval = plan.intervalMs ?? 0;
  return `${PRELUDE}

try {
  ${SESSION_CHECK}
  ${ENGINE_SETUP}
  ${requestLiteral(plan)}
  ${RECT_RESOLVER}

  if ($rect.Width -lt 1 -or $rect.Height -lt 1) {
    Fail 'capture-failed' ('the ${plan.mode} capture resolved to an empty rectangle ' + $rect.X + ',' + $rect.Y + ' ' + $rect.Width + 'x' + $rect.Height)
  }

  ${frameFunction()}
  $paths = @(${quoted})
  $interval = ${interval}
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $frames = @()
  $previous = $null
  foreach ($path in $paths) {
    if ($null -ne $previous) {
      $wait = $interval - ($clock.ElapsedMilliseconds - $previous.offsetMs)
      if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    }
    $offset = $clock.ElapsedMilliseconds
    $frame = Save-Frame $rect $path ([bool]$request.cursor)
    $frames += @{
      offsetMs = $offset
      ms = $clock.ElapsedMilliseconds - $offset
      blackPermille = $frame.black
      cursorDrawn = $frame.cursor
    }
    $previous = @{ offsetMs = $offset }
  }

  Emit @{
    ok = $true
    mode = '${plan.mode}'
    dpiAware = $aware
    width = $rect.Width
    height = $rect.Height
    spanMs = $clock.ElapsedMilliseconds
    desktop = @{ x = $virtual.X; y = $virtual.Y; width = $virtual.Width; height = $virtual.Height }
    frames = $frames
  }
} catch {
  Fail 'capture-failed' $_.Exception.Message
}`;
}

/**
 * Build the display-inventory script.
 * @returns the PowerShell source.
 */
export function displaysScript() {
  return `${PRELUDE}

try {
  ${SESSION_CHECK}
  ${ENGINE_SETUP}

  $inventory = @()
  foreach ($screen in $screens) {
    $inventory += @{
      device = $screen.DeviceName
      primary = [bool]$screen.Primary
      x = $screen.Bounds.X
      y = $screen.Bounds.Y
      width = $screen.Bounds.Width
      height = $screen.Bounds.Height
    }
  }
  if ($inventory.Count -eq 0) { Fail 'capture-failed' 'the display inventory listed no displays' }

  Emit @{
    ok = $true
    dpiAware = $aware
    desktop = @{ x = $virtual.X; y = $virtual.Y; width = $virtual.Width; height = $virtual.Height }
    screens = $inventory
  }
} catch {
  Fail 'capture-failed' $_.Exception.Message
}`;
}

/**
 * The resident engine's script: preload everything once, then answer requests.
 *
 * This exists for one reason, and it is not speed in general. A one-shot
 * animation — a hover, a panel opening, a page load — is over in a few hundred
 * milliseconds, and a burst cannot take its first frame before its engine
 * exists. Paying ~380ms per call means the first frame lands *after* such an
 * animation has finished: measured, a call issued at the instant the animation
 * starts yields **zero** usable frames. Started once and kept waiting, the same
 * engine answers in 15-18ms, which is inside the animation rather than after it.
 *
 * The script preloads the shim, DPI awareness, WinForms and the screen list,
 * announces itself with a `ready` line, and then serves one JSON request per
 * line of stdin until stdin closes. Closing stdin is the shutdown protocol: a
 * harness that dies takes its engine with it, without the engine having to
 * watch for a parent that is no longer there.
 *
 * Requests are answered with one marked JSON line each, carrying the request's
 * own id, so a caller may have several outstanding. A failure inside one
 * request is answered as a failure rather than ending the engine: `Fail` is
 * redefined below to throw, and the loop turns that back into a result.
 *
 * @returns the PowerShell source.
 */
export function engineScript() {
  return `${PRELUDE}
# In a one-shot script \`Fail\` ends the process; here it has to end the request.
function Fail([string]$kind, [string]$detail) { throw ('${FAIL_PREFIX}' + $kind + '|' + $detail) }

try {
  ${SESSION_CHECK}
  ${ENGINE_SETUP}
  ${frameFunction()}
} catch {
  Emit @{ ok = $false; kind = '${ENGINE_UNAVAILABLE}'; detail = $_.Exception.Message }
  exit 1
}

Emit @{
  ok = $true
  ready = $true
  dpiAware = $aware
  desktop = @{ x = $virtual.X; y = $virtual.Y; width = $virtual.Width; height = $virtual.Height }
  screens = @($screens | ForEach-Object {
    @{ device = $_.DeviceName; primary = [bool]$_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
  })
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $request = $null
  try { $request = $line | ConvertFrom-Json } catch { continue }
  if ($request.kind -eq 'quit') { break }
  try {
    $rect = $null
    if ($request.kind -eq 'capture') {
      ${RECT_RESOLVER}
      $frame = Save-Frame $rect $request.path ([bool]$request.cursor)
      Emit @{ id = $request.id; ok = $true; width = $rect.Width; height = $rect.Height; blackPermille = $frame.black; cursorDrawn = $frame.cursor }
    }
    elseif ($request.kind -eq 'burst') {
      ${RECT_RESOLVER}
      $paths = @($request.paths)
      $interval = [int]$request.intervalMs
      $clock = [System.Diagnostics.Stopwatch]::StartNew()
      $frames = @()
      $previous = $null
      foreach ($path in $paths) {
        if ($null -ne $previous) {
          $wait = $interval - ($clock.ElapsedMilliseconds - $previous)
          if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
        }
        $offset = $clock.ElapsedMilliseconds
        $frame = Save-Frame $rect $path ([bool]$request.cursor)
        $frames += @{ offsetMs = $offset; ms = $clock.ElapsedMilliseconds - $offset; blackPermille = $frame.black; cursorDrawn = $frame.cursor }
        $previous = $offset
      }
      Emit @{ id = $request.id; ok = $true; width = $rect.Width; height = $rect.Height; frames = $frames }
    }
    elseif ($request.kind -eq 'watch') {
      ${RECT_RESOLVER}
      $bitmap = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
        $whole = New-Object System.Drawing.Rectangle 0, 0, $bitmap.Width, $bitmap.Height
        $bits = $bitmap.LockBits($whole, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
          $script:baseline = [DshScreenEye.Native]::Sample($bits.Scan0, $bits.Stride, $bitmap.Width, $bitmap.Height, ${FINGERPRINT_SAMPLE_BUDGET})
          $script:baselineTotal = [int]($script:baseline.Length / 3)
        }
        finally { $bitmap.UnlockBits($bits) }
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
      Emit @{ id = $request.id; ok = $true; total = $script:baselineTotal }
    }
    elseif ($request.kind -eq 'changed') {
      ${RECT_RESOLVER}
      if ($null -eq $script:baseline) { Fail 'not-watching' 'nothing has been watched yet, so there is no baseline to compare against' }
      $bitmap = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
        $whole = New-Object System.Drawing.Rectangle 0, 0, $bitmap.Width, $bitmap.Height
        $bits = $bitmap.LockBits($whole, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try { $moved = [DshScreenEye.Native]::Difference($bits.Scan0, $bits.Stride, $bitmap.Width, $bitmap.Height, ${FINGERPRINT_SAMPLE_BUDGET}, $script:baseline) }
        finally { $bitmap.UnlockBits($bits) }
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
      Emit @{ id = $request.id; ok = $true; changed = $moved; total = $script:baselineTotal }
    }
    else {
      Fail 'unsupported-request' ('the engine has no request kind "' + $request.kind + '"')
    }
  } catch {
    $detail = $_.Exception.Message
    $kind = 'capture-failed'
    if ($detail.StartsWith('${FAIL_PREFIX}')) {
      $parts = $detail.Substring(${FAIL_PREFIX.length}).Split([char]124, 2)
      $kind = $parts[0]
      $detail = $parts[1]
    }
    Emit @{ id = $request.id; ok = $false; kind = $kind; detail = $detail }
  }
}`;
}

/**
 * Where the engine's script is cached, named after its own text.
 *
 * The script has to exist as a file: `-EncodedCommand` hands the script over on
 * the command line, and in that mode stdin belongs to the host, so
 * `[Console]::In.ReadLine()` never returns and a resident engine cannot be
 * driven at all. That is not a theory — it is what the first attempt did, and
 * it hung until it was killed.
 *
 * @returns the absolute path of the cached script for this text.
 */
export function engineScriptPath() {
  const digest = createHash('sha256').update(engineScript()).digest('hex').slice(0, 16);
  return join(tmpdir(), 'dsh-screen-eye-engine', `engine-${digest}.ps1`);
}

/**
 * The running engine, if one is running.
 *
 * Module-level because the point of it is to outlive a call: two tool calls a
 * second apart should share one warm engine, not start two cold ones.
 */
let engine = null;

/**
 * Start the engine, or return the one already running.
 *
 * Concurrent callers share one start: the first begins it, the rest await the
 * same promise. A start that fails is not cached — the next call tries again,
 * because the reason for a failure is usually transient (a crash, a machine
 * under load) and giving up permanently would turn one bad moment into a plugin
 * that never captures again.
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
    const scriptPath = engineScriptPath();
    await mkdir(dirname(scriptPath), { recursive: true });
    // Rewritten every start rather than only when missing: it is a few
    // kilobytes, and a half-written file from a killed process would otherwise
    // be a permanent engine failure with no way back.
    //
    // Written with a BOM: Windows PowerShell 5.1 reads a `.ps1` with no
    // byte-order mark as ANSI, so a script that ever carries a non-ASCII
    // character would be misread. The engine's own script is static ASCII today
    // and does not need it — the paths travel in the requests, not in the file —
    // but the next person to put a Chinese comment in here will not have to
    // discover this the way it was discovered.
    await writeFile(scriptPath, `\uFEFF${engineScript()}`, 'utf8');
    const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    record.child = child;
    // Unreferenced, all four streams: a resident process that keeps the event
    // loop alive would keep the *harness* alive, and a harness that will not
    // exit is a worse bug than a slow capture. Nothing is lost by letting go —
    // when this process ends, the engine's stdin closes and it exits on its own,
    // which is the shutdown protocol it was built with.
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
    child.stdout.on('data', (chunk) => consumeEngineOutput(record, chunk));
    child.stderr.on('data', (chunk) => { record.stderr += chunk; });
    child.on('exit', (code) => {
      // Everything still waiting will never be answered by this process.
      const error = new CaptureError(`the Windows engine exited with code ${code}`, {
        kind: ENGINE_UNAVAILABLE,
        detail: record.stderr.trim().slice(0, 500),
      });
      for (const waiter of record.pending.values()) waiter.reject(error);
      record.pending.clear();
      record.ready = false;
      if (engine === record) engine = null;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CaptureError(`the Windows engine did not start within ${ENGINE_START_TIMEOUT_MS}ms`, { kind: ENGINE_UNAVAILABLE, detail: record.stderr.trim().slice(0, 500) })), ENGINE_START_TIMEOUT_MS);
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
    const payload = parseScriptResult(line);
    if (payload === undefined) continue;
    if (payload.ready === true) {
      record.ready = true;
      record.info = payload;
      record.onReady?.();
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
 * @throws a `CaptureError` when the engine could not answer.
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
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }
    const timer = setTimeout(() => {
      settle(reject, new CaptureError(`the Windows engine did not answer request ${id} within ${ENGINE_REQUEST_TIMEOUT_MS}ms`, { kind: ENGINE_UNAVAILABLE }));
    }, options.timeoutMs ?? ENGINE_REQUEST_TIMEOUT_MS);
    record.pending.set(id, { resolve: (payload) => settle(resolve, payload), reject: (error) => settle(reject, error), timer });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    record.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    scheduleEngineIdle(record);
  });
}

/**
 * Keep the engine for a while after its last request, then let it go.
 *
 * A resident process that never leaves is a process the user did not ask for,
 * so it is given a finite life: long enough that a burst of tool calls shares
 * one engine, short enough that an idle harness is not holding a PowerShell
 * process for the rest of the day.
 * @param record - the engine record.
 */
function scheduleEngineIdle(record) {
  clearTimeout(record.idleTimer);
  record.idleTimer = setTimeout(() => {
    if (engine === record) stopEngine();
  }, ENGINE_IDLE_MS);
  record.idleTimer.unref?.();
}

/**
 * Shut the engine down, waiting briefly for it to leave of its own accord.
 * @returns when the engine has gone or has been killed.
 */
export function stopEngine() {
  const record = engine;
  if (record === null) return;
  engine = null;
  clearTimeout(record.idleTimer);
  const error = new CaptureError('the Windows engine was shut down', { kind: ENGINE_UNAVAILABLE });
  for (const waiter of record.pending.values()) waiter.reject(error);
  record.pending.clear();
  try { record.child.stdin.end(); } catch { /* already closed */ }
  const killer = setTimeout(() => { try { record.child.kill(); } catch { /* already gone */ } }, 1000);
  killer.unref?.();
  record.child.once('exit', () => clearTimeout(killer));
}

// A harness that exits takes its engine with it; the engine would also notice
// on its own, because its stdin closes, but this makes it immediate.
process.once('exit', () => {
  try { engine?.child?.kill(); } catch { /* nothing to kill */ }
});

/**
 * Read the one result line a script prints.
 *
 * The last marked line wins, so a stray value that some future PowerShell
 * decides to write to stdout cannot displace the answer — and a script that
 * died before printing one is reported as having produced no answer at all,
 * rather than being parsed as an empty success.
 *
 * @param stdout - the captured standard output.
 * @returns the decoded payload, or undefined when no result line is present.
 */
export function parseScriptResult(stdout) {
  let payload;
  for (const line of String(stdout).split(/\r?\n/u)) {
    if (!line.startsWith(`${RESULT_MARKER} `)) continue;
    try {
      payload = JSON.parse(line.slice(RESULT_MARKER.length + 1));
    } catch {
      payload = undefined;
    }
  }
  return payload;
}

/**
 * Turn a `Screen.AllScreens` payload into the ordered display list.
 *
 * Split out from the call for the same reason as its macOS counterpart: the
 * ordering is the part that has to be right, and it is the part that can be
 * checked on a machine with one display — including a CI runner.
 *
 * @param parsed - the decoded inventory payload.
 * @returns one entry per display, main first, indexed from 1.
 * @throws when the payload lists no displays, which means the inventory failed
 *   rather than that the machine has no screen.
 */
export function displaysFromScreens(parsed) {
  const screens = Array.isArray(parsed?.screens) ? parsed.screens : [];
  if (screens.length === 0) {
    throw new Error('the display inventory listed no displays');
  }
  const displays = screens.map((screen) => ({
    // Assigned after sorting, so the index is the one `capture` accepts.
    index: 0,
    name: typeof screen.device === 'string' && screen.device !== ''
      ? screen.device
      : 'unknown display',
    ...(Number.isInteger(screen.width) && Number.isInteger(screen.height)
      ? { width: screen.width, height: screen.height }
      : {}),
    // Windows addresses displays in virtual-screen coordinates, so the origin
    // is what makes a region on a second screen expressible at all. macOS does
    // not report one, and its entries simply carry no such field.
    ...(Number.isInteger(screen.x) ? { x: screen.x } : {}),
    ...(Number.isInteger(screen.y) ? { y: screen.y } : {}),
    main: screen.primary === true,
  }));
  const ordered = [
    ...displays.filter((display) => display.main),
    ...displays.filter((display) => !display.main),
  ];
  return ordered.map((display, position) => ({ ...display, index: position + 1 }));
}

/**
 * The observations a frame can carry back besides its pixels.
 *
 * A frame that is black everywhere is what Windows returns when the session is
 * locked, when the display is asleep or disconnected, or when a full-screen
 * black window is in front. All of those are worth saying out loud: the image
 * is returned rather than withheld — it is what the screen really shows — but
 * the model is told why it may be looking at nothing, instead of being left to
 * conclude the user's desktop is blank. A capture whose DPI awareness could not
 * be declared is reported too, because a downscaled frame breaks the mapping
 * between what the model measures in the image and the coordinates `region`
 * expects.
 *
 * @param frame - one frame's decoded result fields.
 * @returns the notes to attach, in the order they matter.
 */
export function notesForFrame(frame) {
  const notes = [];
  if (frame?.dpiAware === false) {
    notes.push('this capture may be scaled down: the engine could not declare DPI awareness, so Windows '
      + 'reported a virtualised desktop size and the pixels are a rescaled copy of the screen.');
  }
  if (Number.isInteger(frame?.cursorDrawn) && frame.cursorDrawn < -1) {
    notes.push('the mouse pointer could not be drawn into this capture, although it was asked for: the '
      + 'pointer is hidden, or Windows would not hand it over.');
  }
  if (typeof frame?.blackPermille === 'number' && frame.blackPermille >= BLACK_FRAME_PERMILLE) {
    notes.push('this capture came back entirely black — every sampled pixel is black, which is what Windows '
      + 'returns when the session is locked, when the display is asleep or disconnected, or when a full-screen '
      + 'black window is in front of the desktop. If the screen really is black, this is the correct picture.');
  }
  return notes;
}

/**
 * Run one script and decode its result.
 * @param script - the PowerShell source.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the decoded payload.
 * @throws a `CaptureError` when the engine could not run or reported a failure.
 */
async function runScript(script, options) {
  const powershell = powershellPath();
  if (!existsSync(powershell)) {
    throw new CaptureError(`the Windows capture engine needs ${powershell}, which is missing`, {
      kind: ENGINE_UNAVAILABLE,
    });
  }
  // Best effort, and deliberately not awaited into the failure path: if the
  // directory cannot be made, the script compiles the shim in memory exactly as
  // it did before there was a cache.
  await mkdir(dirname(shimCachePath()), { recursive: true }).catch(() => {});
  const result = await run(powershell, powershellArgs(script), {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120000,
  });
  const parsed = parseScriptResult(result.stdout);
  if (parsed === undefined) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new CaptureError(
      detail === ''
        ? `the Windows capture engine exited with code ${result.code} and said nothing`
        : detail,
      { kind: ENGINE_UNAVAILABLE, detail },
    );
  }
  if (parsed.ok !== true) {
    const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
    throw new CaptureError(detail === '' ? 'the Windows capture engine reported a failure' : detail, {
      kind: typeof parsed.kind === 'string' ? parsed.kind : 'capture-failed',
      detail,
    });
  }
  return parsed;
}

/**
 * The byte length of a file the engine claims to have written.
 * @param path - the absolute path.
 * @returns the size, or 0 when there is no such file.
 */
function sizeOf(path) {
  return stat(path).then(
    (info) => info.size,
    () => 0,
  );
}

/**
 * Run one request, through the resident engine when there is one and through a
 * one-shot process when there is not.
 *
 * The fallback is the point: the engine is an optimisation with a lifecycle,
 * and a lifecycle can fail — a broken script file, a machine that refuses to
 * start another process, a crash mid-request. Every one of those ends in the
 * one-shot path that this module used before the engine existed, so the worst
 * case is the old speed rather than no capture. Only an engine that could not
 * run at all falls back; a refusal that came *from* the engine — a display that
 * does not exist — is the answer, and retrying it in another process would only
 * produce the same refusal more slowly.
 *
 * @param request - the engine request body.
 * @param fallback - builds the one-shot script to use if the engine cannot run.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the decoded payload.
 */
async function runRequest(request, fallback, options) {
  try {
    const reply = await engineRequest(request, options);
    if (reply.ok === true) return reply;
    const detail = typeof reply.detail === 'string' ? reply.detail : '';
    throw new CaptureError(detail === '' ? 'the Windows capture engine reported a failure' : detail, {
      kind: typeof reply.kind === 'string' ? reply.kind : 'capture-failed',
      detail,
    });
  } catch (error) {
    if (!(error instanceof CaptureError) || error.kind !== ENGINE_UNAVAILABLE) throw error;
    stopEngine();
    return runScript(fallback(), options);
  }
}

/**
 * Capture one frame through Windows PowerShell.
 * @param plan - the validated capture request.
 * @param outputPath - the resolved absolute output path.
 * @param options - cancellation signal and wall-clock budget.
 * @returns the written PNG's path and byte length, plus any observation.
 */
async function capture(plan, outputPath, options) {
  await mkdir(dirname(outputPath), { recursive: true });
  const parsed = await runRequest(
    { ...engineRequestFor(plan), kind: 'capture', path: outputPath },
    () => captureScript(plan, outputPath),
    options,
  );
  const bytes = await sizeOf(outputPath);
  if (bytes === 0) {
    throw new CaptureError('the Windows capture engine reported success but wrote no file', {
      kind: 'capture-failed',
    });
  }
  const notes = notesForFrame(parsed);
  return { outputPath, bytes, ...(notes.length === 0 ? {} : { note: notes.join(' ') }) };
}

/**
 * Read a validated `x,y,w,h` region from the plan.
 * @param raw - the normalised region string.
 * @returns the four numbers.
 * @throws a `CaptureError` when it is not four integers, which would mean the
 *   plan was not validated before it reached the engine.
 */
function parseRegion(raw) {
  const parts = String(raw ?? '').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isInteger)) {
    throw new CaptureError(`the Windows engine needs a region of four integers; received ${JSON.stringify(raw)}`);
  }
  return parts;
}

/**
 * The mode and rectangle fields of a request, as the resolver reads them.
 * @param plan - the validated capture request.
 * @returns the fields, spread into whichever request is being built.
 */
function engineRequestFor(plan) {
  const fields = { mode: plan.mode, cursor: plan.includeCursor === true };
  if (plan.mode === 'region') {
    const [x, y, w, h] = parseRegion(plan.region);
    Object.assign(fields, { x, y, w, h });
  }
  if (plan.display !== undefined) fields.display = plan.display;
  return fields;
}

/**
 * Take a whole burst in one engine call.
 *
 * `lib/capture.mjs` drives a burst frame by frame for any platform that does
 * not implement this, which is the contract's baseline; implementing it is how
 * a platform says that paying for a process start per frame would make the
 * interval it advertises a fiction.
 *
 * @param plan - the validated capture request, including `frames`.
 * @param options - frame path factory, cancellation signal, wall-clock budget.
 * @returns the frames in capture order, with the spacing actually achieved.
 */
async function captureBurst(plan, options) {
  const at = options.framePath ?? ((index) => `${options.outputPath}-${index + 1}.png`);
  const paths = Array.from({ length: plan.frames }, (_unused, index) => at(index));
  await Promise.all(paths.map((path) => mkdir(dirname(path), { recursive: true })));

  const startedWall = Date.now();
  const parsed = await runRequest(
    { ...engineRequestFor(plan), kind: 'burst', paths, intervalMs: plan.intervalMs ?? 0 },
    () => burstScript(plan, paths),
    options,
  );
  const reported = Array.isArray(parsed.frames) ? parsed.frames : [];
  if (reported.length !== paths.length) {
    throw new CaptureError(
      `the Windows capture engine returned ${reported.length} of the ${paths.length} frames asked for`,
      { kind: 'capture-failed' },
    );
  }

  const frames = [];
  for (const [index, frame] of reported.entries()) {
    const bytes = await sizeOf(paths[index]);
    if (bytes === 0) {
      throw new CaptureError(`the Windows capture engine wrote no frame at ${paths[index]}`, {
        kind: 'capture-failed',
      });
    }
    const startedAt = startedWall + (Number.isInteger(frame.offsetMs) ? frame.offsetMs : 0);
    const notes = notesForFrame({ ...parsed, ...frame });
    frames.push({
      outputPath: paths[index],
      bytes,
      startedAt,
      takenAtMs: startedAt + (Number.isInteger(frame.ms) ? frame.ms : 0),
      ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
    });
  }

  const spacingMs = frames.length < 2
    ? undefined
    : Math.round((frames.at(-1).startedAt - frames[0].startedAt) / (frames.length - 1));
  return { frames, spacingMs };
}

/**
 * Read the connected displays.
 * @param options - cancellation signal and wall-clock budget.
 * @returns one entry per display, in the order `capture` numbers them.
 */
async function listDisplays(options = {}) {
  // The inventory is one of the things the resident engine preloads, so when it
  // is running this is a round trip rather than a process.
  try {
    const record = await ensureEngine();
    if (Array.isArray(record.info?.screens) && record.info.screens.length > 0) {
      return displaysFromScreens({ screens: record.info.screens });
    }
  } catch { /* it could not start; the one-shot path below still can */ }
  const parsed = await runScript(displaysScript(), {
    ...options,
    timeoutMs: options.timeoutMs ?? 20000,
  });
  return displaysFromScreens(parsed);
}

/**
 * Remember what the rectangle looks like now.
 *
 * This pair — `watch` then `changed` — is how a burst catches an animation that
 * runs once. A model cannot know when the user presses the button, and by the
 * time its call has been reasoned about and scheduled the animation is over:
 * measured, a burst issued at the instant a 300ms transition begins yields zero
 * usable frames on Windows and one at best on macOS. So the plugin takes the
 * start of the animation as its cue instead of the start of the call.
 *
 * A plain "has anything changed" would not do. The first attempt used one, and
 * it fired 461ms into a call that was watching a still screen, because a cursor
 * blinked somewhere in the rectangle. What is remembered here is a few thousand
 * sampled pixels, so a caller can ask *how much* changed and ignore the noise.
 *
 * @param plan - the validated capture request.
 * @param options - cancellation signal and budget.
 * @returns the number of sample points being compared.
 */
async function watch(plan, options = {}) {
  const reply = await engineRequest({ ...engineRequestFor(plan), kind: 'watch' }, options);
  if (reply.ok !== true) throw engineReplyError(reply, 'the Windows engine could not start watching the screen');
  return reply.total;
}

/**
 * Ask how many of those sample points have moved since `watch`.
 * @param plan - the validated capture request.
 * @param options - cancellation signal and budget.
 * @returns how many sample points changed, and how many there are.
 */
async function changed(plan, options = {}) {
  const reply = await engineRequest({ ...engineRequestFor(plan), kind: 'changed' }, options);
  if (reply.ok !== true) throw engineReplyError(reply, 'the Windows engine could not check the screen for changes');
  return { changed: reply.changed, total: reply.total };
}

/**
 * Turn a failed engine reply into the error it describes.
 * @param reply - the engine's answer.
 * @param fallback - what to say when it carried no detail.
 * @returns the error to throw.
 */
function engineReplyError(reply, fallback) {
  return new CaptureError(
    typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : fallback,
    { kind: typeof reply.kind === 'string' ? reply.kind : 'capture-failed', detail: reply.detail ?? '' },
  );
}

/** The Windows platform, as `lib/platform.mjs` expects it. */
export const win32 = Object.freeze({
  id,
  capture,
  captureBurst,
  watch,
  changed,
  listDisplays,
  // No consent model: any process attached to the interactive desktop may
  // capture it, so there is no grant to report and no permission tool.
  permission: null,
  // Only `select` waits for a person here. `window` means the window already in
  // front, which is why a burst of it is allowed: the rectangle is resolved once
  // before the loop, so every frame covers the same window.
  interactiveModes: new Set(['select']),
  briefing: {
    surface: 'this Windows desktop',
    consent: 'Windows has no screen-recording permission to grant: a capture needs no consent, so nothing has to be authorised and nothing will refuse it.',
    interactive: '"window" captures the window the user currently has in front, as it appears on screen, so anything overlapping it is included; "select" is not available on Windows, which ships no region picker — capture a known rectangle with "region" instead.',
    timing: 'It is a target, not a promise, and how low it can go depends on the machine: a single capture costs about 380ms here, mostly PowerShell start-up rather than area — measured 148ms of it with nothing to do at all — while a burst runs in one engine process, where a frame costs about 155ms at full screen and 11-22ms on a region, so an interval of 20-40ms is reachable over a component and 155ms is the floor over a whole 4K screen.',
  },
});
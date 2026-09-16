// The macOS capture engine: set ScreenCaptureKit up once, then answer one
// request per line of stdin.
//
// This exists for one reason, and it is not speed in general. A one-shot
// animation — a hover, a panel opening, a page load — is over in a few hundred
// milliseconds, and a watcher cannot start observing it before its engine
// exists. `/usr/sbin/screencapture` costs about 45ms of process start whatever
// it captures, so every change check pays it, and a wait that confirms a change
// twice pays it twice: measured, a burst issued at the moment an animation began
// landed its first frame 150-200ms in, by which time two thirds of a 300ms
// transition had already happened. Resident, the same rectangle is read in about
// 13ms and hashed in about 23ms, so the same burst starts inside the animation
// instead of after it.
//
// It is deliberately *not* a second implementation of the plugin. All it does is
// read a rectangle and answer what it looks like; the flags, the modes, the
// validation, the retention and the decision about when to stop all stay in the
// JavaScript, so there is one place where each of those lives. `screencapture`
// remains the engine of record — it is the thing with no build step and no
// version to match — and this process is an optimisation that can fail, at which
// point the caller falls back to it.
//
// Protocol: one JSON object per line in, one JSON object per line out, each
// reply carrying the request's own `id` so a caller may have several
// outstanding. Closing stdin is the shutdown protocol, which is what cleans up
// after a harness that dies without saying goodbye.

import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// MARK: - Output

/// Write one line and flush it. A reply that sits in a buffer is a caller that
/// waits for a timeout it did not need to wait for.
func emit(_ text: String) {
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

func emitJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8) else {
        emit(#"{"ok":false,"detail":"could not encode a reply"}"#)
        return
    }
    emit(text)
}

func fail(_ id: Int, _ kind: String, _ detail: String) {
    emitJSON(["id": id, "ok": false, "kind": kind, "detail": detail])
}

// MARK: - Requests

struct Request {
    let id: Int
    let op: String
    let display: Int
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let path: String
    let cursor: Bool

    init?(_ line: String) {
        guard let data = line.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        id = raw["id"] as? Int ?? 0
        op = raw["op"] as? String ?? "capture"
        display = raw["display"] as? Int ?? 1
        x = raw["x"] as? Int ?? 0
        y = raw["y"] as? Int ?? 0
        width = raw["width"] as? Int ?? 0
        height = raw["height"] as? Int ?? 0
        path = raw["path"] as? String ?? ""
        cursor = raw["cursor"] as? Bool ?? false
    }
}

// MARK: - Capturing

/// The screen rectangle a request names, in the display's own coordinate space.
///
/// Requests carry a rectangle in the desktop's global space, which is the space
/// `region` is documented in and the space `screencapture -R` takes. A display
/// that does not start at the desktop's origin — a second screen placed to the
/// left or above the main one — has its own origin, and `sourceRect` is measured
/// from *that*, so the display's origin is subtracted here. Getting this wrong
/// captures the right size of the wrong place, which for a tool whose whole
/// purpose is reading the screen is the worst possible failure: a plausible
/// picture of something else.
///
/// The subtraction is load-bearing and was verified the hard way on a second
/// display. A request arrives in the desktop's global coordinates — the space
/// `region` is documented in — while `sourceRect` is measured from the display's
/// own top-left corner, so the display's frame origin comes off. On the main
/// display `frame.min` is (0, 0) and every one of these forms behaves the same,
/// which is exactly why the mistake survives on a single-screen machine: with a
/// Sidecar display at frame (-748, 2160), subtracting both is the only form that
/// captures anything at all, and passing the global rectangle through unchanged
/// fails with `SCStreamErrorDomain Code=-3812`.
func sourceRect(_ request: Request, _ display: SCDisplay) -> CGRect? {
    if request.width > 0 && request.height > 0 {
        return CGRect(x: CGFloat(request.x) - display.frame.minX,
                      y: CGFloat(request.y) - display.frame.minY,
                      width: CGFloat(request.width),
                      height: CGFloat(request.height))
    }
    return nil
}

/// How many native pixels this display has per point.
///
/// This is the difference between a correct capture and a broken one on any
/// display that is not 1x, and it was found the hard way — on a 2x Sidecar
/// display the engine returned **half** the panel's resolution for a full-screen
/// capture, and refused a region outright with
/// `SCStreamErrorDomain Code=-3812 "the operation could not be completed"`.
///
/// The cause is that ScreenCaptureKit speaks in *points* while the display has
/// *pixels*: `SCDisplay.width` is the point width (1194 for a 2388-wide iPad)
/// and wants to be told the output size in pixels. Asking for 1194x834 asked the
/// framework for a half-resolution copy, and pairing a point-sized `sourceRect`
/// with it produced the invalid-parameter error on a region.
///
/// The scale comes from the display *mode*, and specifically from
/// `pixelWidth / width`. That pairing was measured, not assumed: on the same
/// machine and in the same process, `CGDisplayPixelsWide` reports 1194 for the
/// iPad — the point width, not the pixel width — so the obvious
/// `CGDisplayPixelsWide / CGDisplayBounds.width` ratio comes out as 1 and leaves
/// the bug in place. Only the mode returns both numbers, and only their ratio is
/// right.
///
/// @param display - the display to measure.
/// @returns the scale factor, 1 when it cannot be determined.
func backingScale(_ display: SCDisplay) -> CGFloat {
    guard let mode = CGDisplayCopyDisplayMode(display.displayID), mode.width > 0 else { return 1 }
    let scale = CGFloat(mode.pixelWidth) / CGFloat(mode.width)
    return scale > 0 ? scale : 1
}

/// Read a rectangle, or the whole display when no size was asked for.
func grab(_ request: Request, _ display: SCDisplay) async throws -> CGImage {
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    let scale = backingScale(display)
    if let rect = sourceRect(request, display) {
        // The rectangle is in points, in the display's own space, and
        // `sourceRect` is documented in points too — so only the *output* size
        // is scaled. That is the asymmetry the error above came from: the
        // request was consistent, the answer was not.
        config.sourceRect = rect
        config.width = Int(CGFloat(request.width) * scale)
        config.height = Int(CGFloat(request.height) * scale)
    } else {
        // "The whole display" means its native resolution, not its point size.
        config.width = Int(CGFloat(display.width) * scale)
        config.height = Int(CGFloat(display.height) * scale)
    }
    config.showsCursor = request.cursor
    config.captureResolution = .best
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

/// Write a capture as PNG.
func write(_ image: CGImage, to path: String) -> Bool {
    guard let destination = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination)
}

/// A cheap fingerprint of what a rectangle looks like right now.
///
/// The comparison a wait needs is "same or different", and the honest way to
/// answer it does not require a PNG: the rectangle is drawn into a 64x64 bitmap
/// and those pixels are hashed in process. That is about 23ms against the 56ms
/// a `screencapture` costs, and unlike the file comparison it cannot be
/// disturbed by anything the encoder writes beside the pixels.
///
/// The cost of the shortcut is the same one Windows' sampling accepts: a change
/// too small to survive a 64x64 reduction is not seen. That is why the shared
/// wait requires a change to be confirmed twice rather than believing one
/// crossing, and why its guidance tells the caller to watch the region the
/// animation is in rather than the whole desktop.
func fingerprint(_ request: Request, _ display: SCDisplay, into buffer: inout [UInt8], size: Int) throws -> UInt64 {
    let image = try awaitSync { try await grab(request, display) }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(data: &buffer, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: size * 4, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw NSError(domain: "screen-eye", code: 1, userInfo: [NSLocalizedDescriptionKey: "no bitmap context"])
    }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325      // FNV-1a, for no reason beyond being short and stable
    for byte in buffer {
        hash ^= UInt64(byte)
        hash = hash &* 0x0000_0100_0000_01b3
    }
    return hash
}

/// Run an async operation from the synchronous request loop.
///
/// The loop is synchronous on purpose — a resident engine that answered out of
/// order would be a resident engine whose replies cannot be matched to its
/// requests by the `id` alone — so each request blocks its thread on a semaphore
/// while the work happens on a Task.
func awaitSync<T>(_ work: @escaping () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
    Task {
        do { result = .success(try await work()) } catch { result = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()
    return try result!.get()
}

// MARK: - The loop

let setupStarted = Date()
let content: SCShareableContent
do {
    content = try awaitSync { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
} catch {
    // The usual cause is a missing Screen Recording grant. Saying so here lets
    // the caller fall back to `screencapture`, which reports the same condition
    // in the words the plugin already knows how to turn into onboarding steps.
    emitJSON(["ok": false, "kind": "engine-unavailable", "detail": "\(error)"])
    exit(1)
}
let displays = content.displays
let setupMs = Int(Date().timeIntervalSince(setupStarted) * 1000)

// The readiness line carries the inventory, so the caller does not have to ask
// a second question to learn what this process can see.
emitJSON([
    "ok": true,
    "ready": true,
    "setupMs": setupMs,
    "displays": displays.map { ["index": 0, "width": $0.width, "height": $0.height,
                                "x": Int($0.frame.minX), "y": Int($0.frame.minY)] },
])

var buffer = [UInt8](repeating: 0, count: 64 * 64 * 4)

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let request = Request(line) else {
        // A line that is not a request is not fatal: the engine stays up and the
        // next line is read, because a caller that sends one malformed request
        // should not lose the process it just paid to start.
        emitJSON(["ok": false, "kind": "bad-request", "detail": "not a JSON request"])
        continue
    }
    let index = request.display - 1
    guard index >= 0 && index < displays.count else {
        fail(request.id, "display-missing", "display \(request.display) does not exist: this machine reports \(displays.count) display(s)")
        continue
    }
    let display = displays[index]

    do {
        switch request.op {
        case "poll":
            let started = Date()
            let hash = try fingerprint(request, display, into: &buffer, size: 64)
            emitJSON(["id": request.id, "ok": true, "hash": String(hash),
                      "ms": Int(Date().timeIntervalSince(started) * 1000)])
        case "capture":
            guard !request.path.isEmpty else { fail(request.id, "bad-request", "capture needs a path"); continue }
            let started = Date()
            let image = try awaitSync { try await grab(request, display) }
            guard write(image, to: request.path) else {
                fail(request.id, "capture-failed", "could not write \(request.path)"); continue
            }
            emitJSON(["id": request.id, "ok": true, "width": image.width, "height": image.height,
                      "ms": Int(Date().timeIntervalSince(started) * 1000)])
        default:
            fail(request.id, "bad-request", "unknown op \(request.op)")
        }
    } catch {
        fail(request.id, "capture-failed", "\(error)")
    }
}

import AVFoundation
import AppKit
import CoreMedia
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: swift extract_last_frame.swift <input-video> <output-png>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let asset = AVURLAsset(url: inputURL)
let durationSeconds = CMTimeGetSeconds(asset.duration)

guard durationSeconds.isFinite, durationSeconds > 0 else {
    fputs("Could not read a valid video duration.\n", stderr)
    exit(3)
}

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .positiveInfinity
generator.requestedTimeToleranceAfter = .zero

var lastError: Error?
let offsets = [0.001, 0.01, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0]

for offset in offsets {
    let frameTime = CMTime(seconds: max(0, durationSeconds - offset), preferredTimescale: 600)
    do {
        let cgImage = try generator.copyCGImage(at: frameTime, actualTime: nil)
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            fputs("Could not encode PNG data.\n", stderr)
            exit(4)
        }
        try data.write(to: outputURL, options: .atomic)
        print(outputURL.path)
        exit(0)
    } catch {
        lastError = error
    }
}

fputs("Failed to extract a decodable tail frame: \(String(describing: lastError))\n", stderr)
exit(5)

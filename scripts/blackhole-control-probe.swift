// Control probe for the BlackHole live-audio gate: writes a 440 Hz tone
// directly into the BlackHole output via AVAudioEngine (pinned by device id,
// independent of Mosh and of the system default device). If THIS tone does
// not appear on BlackHole's input, the driver's loopback is inoperative at
// the system level and no app can pass the gate — the gate must report
// ENV-BLOCKED, not FAIL. (Root-caused 2026-06-11: driver loopback dead on
// macOS 26.4.1 with BlackHole 0.6.1 until coreaudiod restart/reinstall.)
//
// Usage: swift blackhole-control-probe.swift <seconds>
// Exits 0 after playing; exits 2 if no BlackHole device exists.

import AVFoundation
import CoreAudio

let seconds = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 6.0) : 6.0

var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)

var target: AudioDeviceID = 0
for id in ids {
    var nameAddr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var nsize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    if AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nsize, &name) == noErr,
       let n = name?.takeRetainedValue() as String?, n.contains("BlackHole") {
        target = id
        break
    }
}
guard target != 0 else {
    print("control-probe: no BlackHole device")
    exit(2)
}

let engine = AVAudioEngine()
let output = engine.outputNode
var dev = target
let pinErr = AudioUnitSetProperty(output.audioUnit!, kAudioOutputUnitProperty_CurrentDevice,
                                  kAudioUnitScope_Global, 0, &dev,
                                  UInt32(MemoryLayout<AudioDeviceID>.size))
guard pinErr == noErr else {
    print("control-probe: could not pin device (err \(pinErr))")
    exit(2)
}

let sr = output.outputFormat(forBus: 0).sampleRate
let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
final class Phase { var v: Double = 0 }
let phase = Phase()
let player = AVAudioSourceNode { _, _, frameCount, audioBufferList -> OSStatus in
    let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
    for frame in 0..<Int(frameCount) {
        let v = Float(sin(phase.v) * 0.5)
        phase.v += 2.0 * Double.pi * 440.0 / sr
        for buf in ablPointer {
            buf.mData!.assumingMemoryBound(to: Float.self)[frame] = v
        }
    }
    return noErr
}
engine.attach(player)
engine.connect(player, to: output, format: fmt)
do { try engine.start() } catch {
    print("control-probe: engine start failed: \(error)")
    exit(2)
}
print("control-probe: 440Hz @0.5 into BlackHole id \(target) for \(seconds)s, sr=\(sr)")
Thread.sleep(forTimeInterval: seconds)
engine.stop()

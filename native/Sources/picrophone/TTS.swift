import AVFoundation
import AppKit
import TTSKit
import Hub

// Text-to-speech. Engines (see Platform.swift for availability/selection):
//   --engine auto (default) pick the best available for this macOS version.
//   --engine neural         new on-device neural model (macOS 26+; not yet wired).
//   --engine av             AVSpeechSynthesizer — in-process system voices,
//                           killable so a kill stops audio instantly (barge-in).
//   --engine say            shell out to /usr/bin/say (always-present fallback).
// Reads text from args or stdin; blocks until playback ends.

private final class AVDelegate: NSObject, AVSpeechSynthesizerDelegate {
    // Set once the utterance actually begins so the watchdog can tell "hasn't
    // started yet" from "finished without a callback."
    var started = false
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        started = true
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        CFRunLoopStop(CFRunLoopGetMain())
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        CFRunLoopStop(CFRunLoopGetMain())
    }
}

// Strong refs so they survive until the run loop stops.
private var avSynth: AVSpeechSynthesizer?
private var avDelegate: AVDelegate?

private func installExitOnSignal() {
    // Barge-in: the extension kills us; exit stops in-process audio immediately.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { exit(0) }
        src.resume()
        // Keep the source alive.
        signalSources.append(src)
    }
}
private var signalSources: [DispatchSourceSignal] = []

// The voice the user selected in System Settings (Spoken Content / Accessibility).
// NSSpeechSynthesizer.defaultVoice reflects that choice; we map it to the matching
// AVSpeechSynthesisVoice by identifier (falling back to name) so `--engine av`
// honors the user's system pick.
private func systemDefaultVoice() -> AVSpeechSynthesisVoice? {
    let def = NSSpeechSynthesizer.defaultVoice
    let voices = AVSpeechSynthesisVoice.speechVoices()
    if let byId = voices.first(where: { $0.identifier == def.rawValue }) { return byId }
    let attrs = NSSpeechSynthesizer.attributes(forVoice: def)
    if let name = attrs[.name] as? String {
        return voices.first { $0.name == name }
    }
    return nil
}

// Best English voice the user has installed, but ONLY if it's better than the
// stock default (enhanced/premium) — otherwise return nil so we fall back to the
// system default voice instead of an arbitrary novelty voice. Prefer en-US.
// Users add enhanced/premium voices in System Settings > Accessibility > Spoken.
private func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
    let good = AVSpeechSynthesisVoice.speechVoices().filter {
        $0.language.hasPrefix("en") && $0.quality != .default
    }
    let ranked = good.sorted { $0.quality.rawValue > $1.quality.rawValue }
    return ranked.first { $0.language == "en-US" } ?? ranked.first
}

private func speakAV(_ text: String, voiceId: String?, rate: Float?) -> Never {
    let synth = AVSpeechSynthesizer()
    let delegate = AVDelegate()
    synth.delegate = delegate
    avSynth = synth
    avDelegate = delegate

    let utterance = AVSpeechUtterance(string: text)
    if let voiceId, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
        utterance.voice = voice
    } else {
        utterance.voice = systemDefaultVoice()
            ?? bestEnglishVoice()
            ?? AVSpeechSynthesisVoice(language: "en-US")
    }
    if let rate { utterance.rate = max(0, min(1, rate)) }

    installExitOnSignal()
    synth.speak(utterance)

    // Watchdog: AVSpeechSynthesizer intermittently never fires didFinish/
    // didCancel — especially for short utterances and the first utterance on a
    // freshly-created synth. Streaming read-aloud spawns a new process (new
    // synth) per sentence, so every fragment is a "first utterance" and the
    // missed callback shows up regularly, hanging this process forever (until
    // the extension's 120s safety kill) and stranding voice mode in the
    // "speaking" state. Poll isSpeaking and stop the run loop ourselves when
    // playback has clearly ended, so we don't depend on the delegate alone.
    let start = Date()
    let startGrace: TimeInterval = 3.0 // allow slow synth/audio-session warmup
    let watchdog = Timer(timeInterval: 0.1, repeats: true) { [weak synth, weak delegate] t in
        guard let synth else { CFRunLoopStop(CFRunLoopGetMain()); t.invalidate(); return }
        let began = delegate?.started ?? false
        if synth.isSpeaking || synth.isPaused { return } // still going
        // Not speaking. Either it finished (began == true) or it never started
        // within the grace window (silent failure) — both mean we're done.
        if began || Date().timeIntervalSince(start) > startGrace {
            t.invalidate()
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
    RunLoop.main.add(watchdog, forMode: .common)

    CFRunLoopRun() // stopped by the delegate on finish/cancel, or the watchdog
    watchdog.invalidate()
    exit(0)
}

private func speakSay(_ text: String, voiceId: String?, rate: Int?) -> Never {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    var sayArgs: [String] = []
    if let voiceId { sayArgs += ["-v", voiceId] }
    if let rate {
        // `say` reads -r as words per minute. Reject nonsense loudly instead of
        // letting say clamp it silently — an out-of-range rate (e.g. 1 or 100000)
        // would otherwise play at an unusable speed with no diagnostic.
        guard rate >= 60, rate <= 600 else {
            fail("--rate \(rate) out of range for the say engine (60-600 words per minute)")
        }
        sayArgs += ["-r", String(rate)]
    }
    sayArgs += ["-f", "-"]
    process.arguments = sayArgs

    let stdin = Pipe()
    process.standardInput = stdin

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let handler = {
        let pid = process.processIdentifier
        if pid > 0 { kill(pid, SIGKILL) } // say ignores SIGTERM; force it
        exit(0)
    }
    for sig in [SIGTERM, SIGINT] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler(handler: handler)
        src.resume()
        signalSources.append(src)
    }

    do {
        try process.run()
    } catch {
        fail("failed to launch say: \(error.localizedDescription)")
    }
    stdin.fileHandleForWriting.write(Data(text.utf8))
    stdin.fileHandleForWriting.closeFile()
    process.waitUntilExit()
    exit(process.terminationStatus)
}

// List installed voices as NDJSON so the extension/user can pick one.
func runVoices() -> Never {
    for v in AVSpeechSynthesisVoice.speechVoices() {
        let quality: String
        switch v.quality {
        case .premium: quality = "premium"
        case .enhanced: quality = "enhanced"
        default: quality = "default"
        }
        emit(["id": v.identifier, "name": v.name, "language": v.language, "quality": quality])
    }
    exit(0)
}

// Placeholder for the next-macOS neural synthesizer. Kept here so the wiring
// (engine selection, availability gate, extension flag) is already in place;
// only this body needs filling in when the API ships. Until then it should
// never be reached — resolveTTSEngine() won't return .neural while
// neuralTTSAvailable() is false — but guard anyway.
private func speakNeural(_ text: String, voiceId: String?, rate: Float?) -> Never {
    // TODO: implement using the new on-device speech synthesis API.
    debugLog("neural TTS not implemented; falling back to AVSpeechSynthesizer")
    speakAV(text, voiceId: voiceId, rate: rate)
}

// Cache dir for downloaded Qwen3-TTS Core ML models. Matches WhisperSTT's
// `modelBaseDir()` so all model weights live under one place.
private func qwenModelBaseDir() -> URL {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let dir = base.appendingPathComponent("picrophone", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

// Download the Qwen3 tokenizer repo into our cache dir (base) and return the
// local folder holding tokenizer.json. Uses a cache-scoped HubApi so the files
// land under ~/Library/Caches/picrophone instead of ~/Documents/huggingface.
private func fetchQwenTokenizer(base: URL) async throws -> URL {
    let hub = HubApi(downloadBase: base)
    // Grab just the tokenizer/config JSON + merges/vocab; skip model weights.
    return try await hub.snapshot(
        from: Qwen3TTSConstants.defaultTokenizerRepo,
        matching: ["*.json", "*.txt"]
    ) { _ in }
}

// Resolve a `--voice` value to a Qwen3 speaker, defaulting to a clear English
// voice. Accepts the raw speaker id (e.g. "ryan", "serena", "uncle-fu").
private func resolveQwenSpeaker(_ voiceId: String?) -> Qwen3Speaker {
    if let voiceId, let s = Qwen3Speaker(rawValue: voiceId.lowercased()) { return s }
    return .aiden
}

// On-device Qwen3-TTS via WhisperKit's TTSKit. Downloads + loads the model on
// first use (progress logged), then streams synthesized audio. Killed on
// SIGTERM/SIGINT for barge-in, same as speakAV.
private func speakQwen(_ text: String, voiceId: String?, rate: Float?) -> Never {
    installExitOnSignal()
    let speaker = resolveQwenSpeaker(voiceId)
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let base = qwenModelBaseDir()
            debugLog("qwen tts: resolving model (speaker=\(speaker.rawValue))")
            let folder = try await TTSKit.download(downloadBase: base) { progress in
                debugLog("qwen tts: downloading \(Int(progress.fractionCompleted * 100))%")
            }
            // Pre-fetch the Qwen tokenizer repo INTO our cache dir and hand TTSKit
            // the resulting local folder. TTSKit treats `tokenizerFolder` as a
            // local path (loads directly if it holds tokenizer.json, else falls
            // back to a Hub download at ~/Documents/huggingface — the Documents
            // TCC prompt). Downloading it here via a cache-scoped HubApi keeps
            // everything under ~/Library/Caches and avoids the prompt.
            let tokenizerFolder = try await fetchQwenTokenizer(base: base)
            let config = TTSKitConfig(
                modelFolder: folder,
                downloadBase: base,
                tokenizerFolder: tokenizerFolder,
                verbose: false,
                logLevel: .error,
                download: false,
                load: true
            )
            debugLog("qwen tts: loading model from \(folder.path)")
            let tts = try await TTSKit(config)
            debugLog("qwen tts: model loaded; synthesizing \(text.count) chars")
            let result = try await tts.play(
                text: text,
                speaker: speaker,
                language: .english
            )
            debugLog("qwen tts: done (\(result.audio.count) samples)")
            sem.signal()
        } catch {
            debugLog("qwen tts failed: \(error.localizedDescription); falling back to AV")
            sem.signal()
            speakAV(text, voiceId: nil, rate: rate)
        }
    }
    sem.wait()
    exit(0)
}

func runTTS(_ args: [String]) -> Never {
    var engine = "auto"
    var voiceId: String?
    var rateArg: String?
    var words: [String] = []

    var i = 0
    while i < args.count {
        switch args[i] {
        case "--engine": i += 1; if i < args.count { engine = args[i] }
        case "--voice": i += 1; if i < args.count { voiceId = args[i] }
        case "--rate": i += 1; if i < args.count { rateArg = args[i] }
        default: words.append(args[i])
        }
        i += 1
    }

    var text = words.joined(separator: " ")
    if text.isEmpty {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        text = String(data: data, encoding: .utf8) ?? ""
    }
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { exit(0) }

    switch resolveTTSEngine(engine) {
    case .say:
        // Parse strictly: `say`'s rate is integer wpm. A non-integer value used to
        // fail Int() -> nil -> silently fall back to 175, which read as "my speed
        // setting does nothing". Reject it instead so the cause is visible.
        var sayRate: Int?
        if let raw = rateArg {
            guard let parsed = Int(raw.trimmingCharacters(in: .whitespaces)) else {
                fail("--rate '\(raw)' is not a whole number of words per minute for the say engine")
            }
            sayRate = parsed
        }
        speakSay(text, voiceId: voiceId, rate: sayRate)
    case .neural:
        speakNeural(text, voiceId: voiceId, rate: rateArg.flatMap { Float($0) })
    case .qwen:
        speakQwen(text, voiceId: voiceId, rate: rateArg.flatMap { Float($0) })
    case .av:
        speakAV(text, voiceId: voiceId, rate: rateArg.flatMap { Float($0) })
    }
}

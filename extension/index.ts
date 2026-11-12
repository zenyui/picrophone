import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { toSpeakable } from "./speakable";
import { SentenceStreamer } from "./stream-speech";
import { binariesExist, getVersion } from "./voice/native/mac";
import { registry, isError } from "./voice/registry";
import type { CueStyle, SpeakHandle, SttMessage, SttSession } from "./voice/protocol";
import { DEFAULT_WHISPER_MODEL } from "./voice/stt/whisper";
import { DEFAULT_QWEN_VOICE } from "./voice/tts/qwen";

// Persisted engine preferences (STT + TTS). Each TTS provider has its own
// built-in default voice; there is no per-voice picker. Lives outside the repo
// so it survives rebuilds.
const CONFIG_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "picrophone.json");
// Bump when the on-disk shape changes incompatibly. Config is validated
// all-or-nothing; anything that doesn't match the schema falls back to defaults.
const CONFIG_VERSION = 2;

// Config uses our own explicit tokens for every field; we map them to the
// backend identifiers (WhisperKit model names, Qwen speaker ids) on our side,
// so the on-disk config stays stable even if a backend renames things.
const STT_ENGINES = ["whisper", "apple"] as const;
const TTS_ENGINES = ["auto", "av", "say", "qwen"] as const;
// Whisper model token -> WhisperKit model id passed to the binary.
const WHISPER_MODELS = {
	tiny: "tiny.en",
	base: "base.en",
	small: "small.en",
	large: "large-v3",
} as const;
const QWEN_SPEAKERS = [
	"ryan", "aiden", "serena", "vivian", "eric", "dylan", "sohee", "ono-anna", "uncle-fu",
] as const;

type SttEngine = (typeof STT_ENGINES)[number] | "none";
type TtsEngine = (typeof TTS_ENGINES)[number];
type WhisperModel = keyof typeof WHISPER_MODELS;
type QwenVoice = (typeof QWEN_SPEAKERS)[number];

// Single source of truth for the on-disk shape AND the TypeScript type.
// Nested per-section (stt / tts) with a sub-object per provider, so provider-
// specific settings (e.g. whisper's model) live under that provider and new
// ones can be added without disturbing the others.
const ConfigSchema = Type.Object({
	version: Type.Optional(Type.Number()),
	stt: Type.Object({
		// "none" disables speech-to-text entirely: /voice on starts read-aloud
		// and mic-free prompt handling only, never launching a recognizer, so no
		// mic capture and no speech-recognition process at all.
		engine: StringEnum(["none", ...STT_ENGINES]),
		whisper: Type.Object({ model: StringEnum(Object.keys(WHISPER_MODELS) as WhisperModel[]) }),
	}),
	tts: Type.Object({
		engine: StringEnum(TTS_ENGINES),
		qwen: Type.Object({ voice: StringEnum(QWEN_SPEAKERS) }),
		// Speed as a multiple of the engine default (1 = unchanged). The say
		// engine defaults to 175 wpm, so 1.5 is ~262. Bounds keep a typo from
		// producing glacial or unintelligible playback instead of an error.
		rate: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3 })),
	}),
	// Optional so existing config files still validate — a missing section means
	// "use the default", never "invalid file, fall back to everything".
	hum: Type.Optional(Type.Object({ enabled: Type.Boolean() })),
});
type VoiceConfig = Omit<Static<typeof ConfigSchema>, "version">;

const DEFAULT_CONFIG: VoiceConfig = {
	stt: { engine: "whisper", whisper: { model: "base" } },
	tts: { engine: "av", qwen: { voice: DEFAULT_QWEN_VOICE as QwenVoice } },
	hum: { enabled: true },
};

// Backend id mappings used at the native boundary.
const whisperModelId = (m: WhisperModel): string => WHISPER_MODELS[m];

// Result of reading the config. `problem` is set when the file exists but is
// broken (unparseable or fails schema), and carries a detailed report — meant
// to be handed to the agent so it can fix the file (it has the JSON Schema and
// the per-field errors to work from).
interface ReadResult {
	config: VoiceConfig;
	problem: { summary: string; report: string } | null;
}

// Read + validate the on-disk config, all-or-nothing: if the file is missing,
// unparseable, or fails the schema, fall back to defaults. A missing file is
// not a problem; a present-but-invalid file is.
function readConfig(): ReadResult {
	let text: string;
	try {
		text = readFileSync(CONFIG_PATH, "utf8");
	} catch {
		return { config: structuredClone(DEFAULT_CONFIG), problem: null };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return {
			config: structuredClone(DEFAULT_CONFIG),
			problem: {
				summary: `${CONFIG_PATH} is not valid JSON; using defaults.`,
				report: configFixReport(text, [`JSON parse error: ${(e as Error).message}`]),
			},
		};
	}
	if (!Check(ConfigSchema, raw)) {
		const issues = [...Errors(ConfigSchema, raw)].map((err) => {
			const at = err.instancePath || "(root)";
			const allowed = (err.params as { allowedValues?: unknown[] })?.allowedValues;
			return allowed ? `${at}: ${err.message} (${allowed.join(", ")})` : `${at}: ${err.message}`;
		});
		return {
			config: structuredClone(DEFAULT_CONFIG),
			problem: {
				summary: `${CONFIG_PATH} is invalid; using defaults. ${issues.length} issue(s).`,
				report: configFixReport(text, issues),
			},
		};
	}
	const { version, ...cfg } = raw;
	return { config: cfg, problem: null };
}

// Build a self-contained report the agent can act on: the errors, the current
// (invalid) file, and the JSON Schema describing the valid shape.
function configFixReport(fileText: string, issues: string[]): string {
	return [
		`The picrophone voice config at ${CONFIG_PATH} is invalid, so defaults are in use.`,
		"Please fix the file so it matches the schema, then tell the user to restart voice mode (/voice off, then on).",
		"",
		"Validation errors:",
		...issues.map((i) => `- ${i}`),
		"",
		"Current file contents:",
		"```json",
		fileText.trim(),
		"```",
		"",
		"JSON Schema it must satisfy:",
		"```json",
		JSON.stringify(ConfigSchema, null, 2),
		"```",
	].join("\n");
}

function loadConfig(): VoiceConfig {
	return readConfig().config;
}

function saveConfig(cfg: VoiceConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ version: CONFIG_VERSION, ...cfg }, null, 2));
	} catch {}
}

// Version the extension expects the picrophone binary to match. Read from our own
// package.json (the single source of truth) so it can never drift from the
// binary, which gen-version stamps from the same file.
const EXPECTED_VERSION: string = JSON.parse(
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const VOICE_MODE_PROMPT = [
	"You are in VOICE MODE. Your replies are READ ALOUD, so brevity is critical.",
	"Hard rules:",
	"(1) Answer in at most 2-3 short sentences — aim for under ~40 words — unless",
	"the user explicitly asks for detail, a list, or a walkthrough.",
	"(2) Lead with the answer or the action. No preamble, no recap of the question,",
	"no 'Sure, I can help with that.'",
	"(3) Never read code, file paths, diffs, tables, or bullet lists aloud. If you",
	"wrote or changed code, just say what you did in one sentence and stop.",
	"(4) If the honest answer is long, give a one-sentence summary and offer to",
	"expand ('want the details?') rather than dumping everything.",
	"(5) Sound conversational, like spoken English, not written documentation.",
	"Messages prefixed with 🎙 were dictated by the user via speech-to-text: treat",
	"them as raw transcripts that may contain homophones, missing punctuation, or",
	"recognition errors. Infer intent and don't nitpick wording.",
].join(" ");

// Prefix on auto-sent transcripts so the model (and user) can tell it was spoken.
const MIC_PREFIX = "🎙  ";

// Spoken interrupt words. Two match modes:
// - strict (normal listening): the WHOLE utterance must be a stop word, so
//   "stop the server" is a real request, not an interrupt.
// - loose (while we're speaking): a stop word appearing ANYWHERE triggers,
//   because the mic hears our TTS mixed with the user, so the transcript is
//   garbled (e.g. "pop stop") and never matches exactly.
const STOP_WORDS = new Set([
	"stop", "stop stop", "cancel", "nevermind", "never mind", "wait", "shut up", "shutup",
]);
const STOP_PATTERN = /\b(stop|cancel|wait|shut\s*up|never\s*mind)\b/i;
function isStopWord(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "").trim();
	return STOP_WORDS.has(t);
}
function containsStopWord(text: string): boolean {
	return STOP_PATTERN.test(text);
}

// Voice mute: pause/resume dictation without leaving voice mode.
// - mute: strict whole-utterance match (so "mute the audio" isn't a mute).
// - unmute: loose match anywhere (easy to turn back on even with a noisy
//   transcript, since while muted the only thing we listen for is unmute).
const MUTE_WORDS = new Set(["mute", "pause", "hush"]);
const UNMUTE_PATTERN = /\b(unmute|resume|wake up|listen up|start listening)\b/i;
function isMuteWord(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "").trim();
	return MUTE_WORDS.has(t);
}
function isUnmuteWord(text: string): boolean {
	return UNMUTE_PATTERN.test(text);
}

export default function (pi: ExtensionAPI) {
	// Voice mode is a small state machine driven entirely by events (pi lifecycle
	// + STT messages) — no polling loop, per pi extension best practice.
	type VoiceState = "off" | "listening" | "thinking" | "speaking";
	let state: VoiceState = "off";
	let stt: SttSession | null = null;
	let ready = false; // binary present + version ok
	let cfg: VoiceConfig = loadConfig();
	// Seed the config file on first run so there's a documented, editable file on
	// disk. Settings are changed by editing this file (or asking the agent to);
	// changes apply on the next /voice start.
	if (!existsSync(CONFIG_PATH)) saveConfig(cfg);
	let micMuted = false; // user paused dictation via voice ("mute"); only unmute is heard
	const voiceOn = () => state !== "off";

	// Cues provider (default: cross-platform baked WAVs). Resolved once; may be
	// undefined on an unsupported host, so every call site is null-guarded.
	const cues = registry.cues.default();
	const playChime = (style?: CueStyle) => cues?.chime(style);

	// Resolve the TTS provider + speak options for the current engine setting.
	// "qwen" -> qwen provider (Qwen3 speaker id); everything else -> system
	// provider with the engine hint ("auto" | "av" | "say").
	function speakNow(text: string, ctx: ExtensionContext): SpeakHandle | null {
		const id = cfg.tts.engine === "qwen" ? "qwen" : "system";
		const prov = registry.tts.get(id);
		if (isError(prov)) {
			ctx.ui.notify(`picrophone: ${prov.message}`, "error");
			return null;
		}
		return cfg.tts.engine === "qwen"
			? prov.speak(text, { voiceId: cfg.tts.qwen.voice })
			: prov.speak(text, { engine: cfg.tts.engine, rate: cfg.tts.rate });
	}

	// TTS + speak queue.
	let speaking: { kill: () => void } | null = null;
	let speakGen = 0; // guards the post-playback echo-flush timer
	const speakQueue: string[] = [];
	// Streaming read-aloud: assistant text is spoken sentence-by-sentence as it
	// arrives, instead of waiting for agent_end. `generating` is true for the
	// duration of an agent loop so the queue draining between sentences doesn't
	// prematurely hand the turn back (chime) mid-reply. `streamedTurn` records
	// whether we spoke anything from the stream, so agent_end can fall back to
	// the full-text path if no deltas were delivered.
	const streamer = new SentenceStreamer();
	let generating = false;
	let streamedTurn = false;
	// While reading aloud (plus a short tail) the mic hears our own TTS, so we
	// suppress input except the stop word to avoid a self-talk feedback loop.
	let suppressInputUntil = 0;
	const TTS_TAIL_MS = 700;

	// Self-talk backstop. The suppression window above is a flat 700ms while a
	// `picrophone tts` child lives several seconds, so the tail of our own
	// read-aloud can finalize as a real transcript: turn -> reply -> read aloud ->
	// mic hears it -> turn, forever, appending to session.messages and the
	// session JSONL on every pass. Text can't tell "the user" from "us", so bound
	// it two ways instead: never auto-send the same normalized transcript twice
	// inside the window, and never auto-send more often than the interval.
	const SPEECH_DEDUPE_WINDOW_MS = 15_000;
	const MIN_SEND_INTERVAL_MS = 2_000;
	const RECENT_SPEECH_MAX = 16;
	let recentSpeech: { text: string; at: number }[] = [];
	let lastAutoSendAt = 0;

	// Compare on words only: whisper is not deterministic about punctuation and
	// casing for the same audio, and our own read-aloud of a sentence comes back
	// as roughly what we said.
	function normalizeSpeech(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	// True if this looks like a repeat of something we already auto-sent (ours
	// own echo) inside the dedupe window.
	function isRepeatSpeech(text: string): boolean {
		const now = Date.now();
		recentSpeech = recentSpeech.filter((r) => now - r.at < SPEECH_DEDUPE_WINDOW_MS);
		const norm = normalizeSpeech(text);
		return recentSpeech.some((r) => r.text === norm);
	}

	function recordSpeech(text: string): void {
		recentSpeech.push({ text: normalizeSpeech(text), at: Date.now() });
		if (recentSpeech.length > RECENT_SPEECH_MAX) recentSpeech.splice(0, recentSpeech.length - RECENT_SPEECH_MAX);
		lastAutoSendAt = Date.now();
	}

	// Hum (thinking sound).
	let humming: { kill: () => void } | null = null;

	function engineInfo(): string {
		return `(tts: ${cfg.tts.engine}, stt: ${cfg.stt.engine})`;
	}

	// Single source of truth for the picrophone widget (above the editor). The
	// live partial transcription and whisper first-run progress take priority
	// over the steady-state line; when voice is off the widget is cleared.
	let partial = ""; // in-progress STT transcription (partial), shown while talking
	let downloadMsg = ""; // whisper model download/compile progress

	function renderWidget(): string[] {
		if (state === "off") return [];
		if (partial) return [`🎙  ${partial}`];
		if (downloadMsg) return [`🎙  ${downloadMsg}`];
		let base: string;
		switch (state) {
			case "thinking": base = "🎙  thinking"; break;
			case "speaking": base = "🎙  speaking"; break;
			// stt.engine "none" means there is no microphone at all, so don't
			// claim the mic is "on" — that reads as capture happening.
			case "listening": base = cfg.stt.engine === "none" ? "🔈  read-aloud only" : "🎙  on"; break;
			default: base = micMuted ? "🔇  muted" : "🎙  on"; break;
		}
		return [`${base} ${engineInfo()}`];
	}

	// Whisper emits partials several times a second and each one came straight
	// through here: setWidget disposes the old component, builds a new
	// Container/Text pair and requests a full TUI render. A one-line widget needs
	// ~10Hz at most, so coalesce to WIDGET_MIN_INTERVAL_MS and skip renders where
	// the rendered lines are unchanged (the common case: same state, same text).
	const WIDGET_MIN_INTERVAL_MS = 100;
	let lastWidgetAt = 0;
	let lastWidgetLines: string[] | null = null;
	let widgetTimer: ReturnType<typeof setTimeout> | null = null;

	function paintWidget(ctx: ExtensionContext) {
		lastWidgetAt = Date.now();
		const lines = renderWidget();
		const prev = lastWidgetLines;
		if (prev !== null && prev.length === lines.length && prev.every((l, i) => l === lines[i])) return;
		lastWidgetLines = lines;
		// The trailing edge of a throttle can land after the session changed ctx.
		try {
			ctx.ui.setWidget("picrophone", lines);
		} catch {}
	}

	function updateWidget(ctx: ExtensionContext) {
		const since = Date.now() - lastWidgetAt;
		if (since >= WIDGET_MIN_INTERVAL_MS) {
			paintWidget(ctx);
			return;
		}
		if (widgetTimer) return; // a coalesced render is already scheduled
		widgetTimer = setTimeout(() => {
			widgetTimer = null;
			paintWidget(ctx);
		}, WIDGET_MIN_INTERVAL_MS - since);
	}

	function setState(next: VoiceState, ctx: ExtensionContext) {
		const prev = state;
		state = next;
		updateWidget(ctx);
		// Play a short earcon when we hand the turn back to the user (finished
		// thinking/speaking). Fires within the TTS mute tail, so it isn't
		// re-transcribed as input.
		if (next === "listening" && (prev === "thinking" || prev === "speaking")) playChime();
	}

	function stopHum() {
		humming?.kill();
		humming = null;
	}

	// Voice mute/unmute: pause or resume dictation without leaving voice mode.
	function setMicMuted(on: boolean, ctx: ExtensionContext) {
		if (micMuted === on) return;
		micMuted = on;
		partial = "";
		updateWidget(ctx);
		ctx.ui.notify(on ? 'Mic muted — say "unmute" to resume.' : "Mic live.", "info");
		playChime(on ? "down" : "bloop");
	}

	// --- Speak queue: items play to completion in order (no overlap). ------
	// Hard cap on the read-aloud backlog. Every item is a separate
	// `picrophone tts` process (seconds of startup + synthesis per item, see
	// voice/native/mac.ts), so an unbounded queue lets a fast agent build
	// minutes of backlog and hold that many processes alive — with a stuck
	// synthesizer (the safety timer there can run up to 120s) it grows for the
	// whole turn. On overflow drop the OLDEST items: the newest part of the
	// reply is the part the user is still listening to.
	const MAX_SPEAK_QUEUE = 8;

	function enqueueSpeak(text: string, ctx: ExtensionContext) {
		const spoken = toSpeakable(text);
		if (!spoken) return;
		speakQueue.push(spoken);
		if (speakQueue.length > MAX_SPEAK_QUEUE) {
			speakQueue.splice(0, speakQueue.length - MAX_SPEAK_QUEUE);
		}
		if (!speaking) drainSpeak(ctx);
	}

	function drainSpeak(ctx: ExtensionContext) {
		const next = speakQueue.shift();
		if (next === undefined) {
			// Queue empty. Mid-generation we keep the "speaking" state so the gap
			// between sentences isn't treated as the end of the turn (no chime, no
			// premature listening). Only revert once the agent loop has finished.
			if (!generating && state === "speaking") setState("listening", ctx);
			return;
		}
		if (state !== "speaking") setState("speaking", ctx);
		stopHum(); // reading aloud takes over from the thinking sound
		// For Qwen, --voice selects a Qwen3 speaker; the system engines (av/say)
		// use their own built-in default voice.
		const s = speakNow(next, ctx);
		if (!s) {
			// Provider unavailable: skip this item, keep draining the queue.
			if (state === "speaking" && speakQueue.length === 0) setState("listening", ctx);
			else drainSpeak(ctx);
			return;
		}
		speaking = s;
		void s.done.then(() => {
			// Stale completion: this handle was already replaced (clearSpeakQueue
			// killed it and dropped the reference, or a newer child took over).
			// `done` resolves on the child's real exit event, tens of ms after
			// SIGTERM, so draining here would spawn a second synthesizer while
			// the killed one is still winding down — and it would overwrite
			// `speaking`, orphaning the live child's kill handle forever (a Swift
			// process holding an AVSpeechSynthesizer + Core Audio output stream
			// that nothing can kill). One orphan per interrupt is how memory grows
			// over a session. Do nothing.
			if (speaking !== s) return;
			speaking = null;
			suppressInputUntil = Date.now() + TTS_TAIL_MS;
			// Flush any of our own TTS the mic picked up during playback so it
			// never finalizes into a spurious message. Wait out the echo tail
			// first so trailing audio is discarded too.
			if (speakQueue.length === 0) {
				const gen = ++speakGen;
				setTimeout(() => {
					if (gen === speakGen && !speaking) stt?.reset();
				}, TTS_TAIL_MS);
			}
			drainSpeak(ctx);
		});
	}

	// Flush queued + active readback (stop word, new turn, voice off).
	function clearSpeakQueue() {
		speakQueue.length = 0;
		streamer.reset();
		speaking?.kill();
		speaking = null;
		suppressInputUntil = Date.now() + TTS_TAIL_MS;
		// Flush echo captured during playback, after the tail passes.
		const gen = ++speakGen;
		setTimeout(() => {
			if (gen === speakGen && !speaking) stt?.reset();
		}, TTS_TAIL_MS);
	}

	// True while our own TTS is (or just was) playing — mic input is our echo.
	function inputMuted(): boolean {
		return speaking !== null || Date.now() < suppressInputUntil;
	}

	// Send a spoken utterance, picking the delivery mode from the live busy/idle
	// state: steer while mid-turn, a fresh turn when idle. The state can flip
	// between the check and the send (whisper finalizes ~1-2s late), and passing
	// the wrong mode throws — so on failure re-check and retry with the opposite
	// mode rather than silently dropping the utterance.
	async function deliverSpoken(content: string, ctx: ExtensionContext) {
		const send = () =>
			ctx.isIdle()
				? pi.sendUserMessage(content)
				: pi.sendUserMessage(content, { deliverAs: "steer" });
		try {
			await send();
		} catch {
			try {
				await send();
			} catch {}
		}
	}

	// Spoken "stop": flush readback, stop hum, abort the turn (like Esc).
	function handleStop(ctx: ExtensionContext) {
		clearSpeakQueue();
		stopHum();
		if (!ctx.isIdle()) ctx.abort();
		partial = "";
		if (state !== "off") setState("listening", ctx);
		else updateWidget(ctx);
	}

	function handleStt(msg: SttMessage, ctx: ExtensionContext) {
		switch (msg.type) {
			case "ready":
				downloadMsg = "";
				if (state !== "thinking" && state !== "speaking") setState("listening", ctx);
				else updateWidget(ctx);
				break;
			case "partial": {
				// While muted, ignore partials entirely. Unmute is handled on the
				// final only, so the unmute utterance isn't sent after resuming.
				if (micMuted) break;
				const muted = inputMuted();
				if (muted ? containsStopWord(msg.text) : isStopWord(msg.text)) {
					handleStop(ctx);
					break;
				}
				if (muted) break; // ignore our own TTS echo; only a stop word is heard
				partial = msg.text;
				updateWidget(ctx);
				break;
			}
			case "final": {
				partial = "";
				updateWidget(ctx);
				const text = msg.text.trim();
				if (!text) break;
				// Unmute is always allowed (even while muted), final-only.
				if (micMuted) {
					if (isUnmuteWord(text)) setMicMuted(false, ctx);
					break; // muted: ignore everything except "unmute"
				}
				const muted = inputMuted();
				// Stop/barge-in works even during our own speech (loose match).
				if (muted ? containsStopWord(text) : isStopWord(text)) {
					handleStop(ctx);
					break;
				}
				if (muted) break; // our own TTS echo — never mute or send from it
				// Real user speech from here on.
				if (isMuteWord(text)) {
					setMicMuted(true, ctx);
					break;
				}
				// Deliver based on whether the agent is busy. If it's mid-turn
				// (thinking or reading a reply back), explicitly steer so the
				// utterance barges in and redirects the current turn rather than
				// stacking a separate one. When idle, send a plain message that
				// starts a fresh turn.
				//
				// The busy/idle state can flip between this check and the async send
				// (whisper finalizes a transcript ~1-2s after speech, so the turn may
				// end in that window). sendUserMessage throws if a delivery mode is
				// passed while idle, or omitted while streaming — so a stale choice
				// would silently drop the utterance. Re-check and retry with the
				// opposite mode so spoken input is never lost to that race.
				// Self-talk backstop: drop a transcript we already acted on, or a
				// new one arriving implausibly soon after the last auto-send. Both
				// are the signature of hearing our own read-aloud come back, and
				// each one would otherwise start another turn that ends in another
				// read-aloud.
				if (isRepeatSpeech(text)) break;
				if (lastAutoSendAt !== 0 && Date.now() - lastAutoSendAt < MIN_SEND_INTERVAL_MS) break;
				recordSpeech(text);
				void deliverSpoken(`${MIC_PREFIX}${text}`, ctx);
				break;
			}
			case "permission":
				ctx.ui.notify(
					`picrophone: mic=${msg.mic}, speech=${msg.speech}. Grant access to Picrophone in System Settings → Privacy.`,
					"error",
				);
				void stopVoice(ctx);
				break;
			case "warn":
				ctx.ui.notify(`picrophone: ${msg.message}`, "warning");
				break;
			case "progress":
				// Model download/compile progress (whisper first run). Show it live in
				// the widget rather than as stacked notifications.
				downloadMsg = msg.message;
				updateWidget(ctx);
				break;
		}
	}

	async function startVoice(ctx: ExtensionContext) {
		if (!ready || voiceOn()) return;
		// Re-read the config file so edits made since startup (e.g. by the agent
		// editing picrophone.json directly) take effect, and surface any invalid
		// values instead of silently resetting them.
		const { config: fresh, problem } = readConfig();
		cfg = fresh;
		if (problem) {
			ctx.ui.notify(`picrophone config: ${problem.summary}`, "warning");
			// Hand the schema + errors to the agent so it can repair the file.
			if (ctx.isIdle()) pi.sendUserMessage(problem.report);
		}
		downloadMsg = "starting…";
		// stt.engine "none" is an explicit opt-out: never capture the mic, never
		// spawn a recognizer, never keep coreaudiod hot. Read-aloud still works.
		if (cfg.stt.engine === "none") {
			stt = null;
			downloadMsg = "";
			setState("speaking", ctx);
			ctx.ui.notify(
				"picrophone: listening is disabled (stt.engine = \"none\") — read-aloud only, " +
					"no microphone and no speech recognition. Set stt.engine back to \"whisper\" " +
					"or \"apple\" in the config to re-enable dictation.",
				"info",
			);
			return;
		}
		setState("listening", ctx);
		if (cfg.stt.engine === "whisper") {
			ctx.ui.notify(
				`Voice STT: whisper (${cfg.stt.whisper.model}). First run downloads the model ` +
					"(~150 MB for base.en) to ~/Library/Caches/picrophone — one time, " +
					"then cached. Progress shows in the footer.",
				"info",
			);
		}
		const prov = registry.stt.get(cfg.stt.engine);
		if (isError(prov)) {
			ctx.ui.notify(`picrophone: ${prov.message}`, "error");
			setState("off", ctx);
			return;
		}
		stt = prov.start((msg: SttMessage) => handleStt(msg, ctx), {
			silenceMs: 1200,
			model: cfg.stt.engine === "whisper" ? whisperModelId(cfg.stt.whisper.model) : undefined,
		});
	}

	async function stopVoice(ctx: ExtensionContext) {
		stt?.stop();
		stt = null;
		micMuted = false;
		partial = "";
		downloadMsg = "";
		stopHum();
		clearSpeakQueue();
		setState("off", ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!binariesExist()) {
			ctx.ui.notify("picrophone binary/app missing — run `npm run build && npm run build:app`.", "warning");
			return;
		}
		try {
			const v = await getVersion();
			if (v.version !== EXPECTED_VERSION) {
				ctx.ui.notify(
					`picrophone version ${v.version} != extension ${EXPECTED_VERSION}; rebuild (npm run build).`,
					"warning",
				);
				return;
			}
			ready = true;
		} catch {
			ctx.ui.notify("picrophone: failed to read version; rebuild the binary.", "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopVoice(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!voiceOn()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${VOICE_MODE_PROMPT}` };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!voiceOn()) return;
		clearSpeakQueue(); // new turn: drop any leftover readback
		generating = true;
		streamedTurn = false;
		setState("thinking", ctx);
		// The hum is a long, continuous tone under every turn. Plenty of people find
		// that actively irritating (it runs while they read the reply, and with a slow
		// engine for a long time), and there's no other reason it's on — so it's
		// opt-out via config: hum.enabled = false.
		if (cfg.hum?.enabled !== false && !humming) humming = cues?.hum() ?? null;
	});

	// Stream read-aloud: as assistant text arrives, flush complete sentences into
	// the speak queue so playback starts before the reply is finished.
	pi.on("message_update", async (event, ctx) => {
		if (!voiceOn()) return;
		const e = event.assistantMessageEvent;
		if (e.type !== "text_delta") return;
		for (const chunk of streamer.push(e.delta)) {
			streamedTurn = true;
			enqueueSpeak(chunk, ctx);
		}
	});

	// End of an assistant message (there may be several per loop, split by tool
	// calls): flush whatever sentence fragment is still buffered.
	pi.on("message_end", async (event, ctx) => {
		if (!voiceOn() || event.message.role !== "assistant") return;
		for (const chunk of streamer.flush()) {
			streamedTurn = true;
			enqueueSpeak(chunk, ctx);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		generating = false;
		if (!voiceOn()) {
			stopHum();
			return;
		}
		// Drain any straggler fragment, then fall back to speaking the full reply
		// only if streaming delivered nothing (e.g. deltas weren't emitted).
		for (const chunk of streamer.flush()) {
			streamedTurn = true;
			enqueueSpeak(chunk, ctx);
		}
		if (!streamedTurn) {
			const assistant = [...event.messages].reverse().find((m) => m.role === "assistant");
			if (assistant) {
				const text = assistant.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				enqueueSpeak(text, ctx);
			}
		}
		// Nothing queued or playing: done thinking, hand the turn back now.
		if (!speaking && speakQueue.length === 0) {
			stopHum();
			if (state !== "listening") setState("listening", ctx);
		}
	});

	pi.registerCommand("voice", {
		description: "Toggle voice mode on/off (speak, sends on pause).",
		handler: async (_args, ctx) => {
			if (!ready) {
				ctx.ui.notify("picrophone not ready — build the binary first.", "warning");
				return;
			}
			if (!voiceOn()) {
				await startVoice(ctx);
				ctx.ui.notify("Voice on — speak, sends on pause.", "info");
			} else {
				await stopVoice(ctx);
				ctx.ui.notify("Voice mode off.", "info");
			}
		},
	});

	// Toggle mic mute without leaving voice mode (same effect as saying
	// "mute"/"unmute"). No-op unless voice mode is on.
	pi.registerCommand("mute", {
		description: "Mute/unmute voice dictation without leaving voice mode.",
		handler: async (_args, ctx) => {
			if (!voiceOn()) {
				ctx.ui.notify("Voice mode is off — run /voice first.", "info");
				return;
			}
			setMicMuted(!micMuted, ctx);
		},
	});

	// LLM-callable: lets the agent turn voice mode on/off when the user asks.
	pi.registerTool({
		name: "voice_mode",
		label: "Voice Mode",
		description:
			"Turn native macOS voice mode on or off. When on, the user's speech is " +
			"transcribed into prompts and the agent's replies are read aloud.",
		promptSnippet: "Enable/disable spoken voice mode (mic dictation + read-aloud replies)",
		promptGuidelines: [
			"Call voice_mode when the user asks to turn voice/dictation/read-aloud on or off.",
		],
		parameters: Type.Object({
			action: StringEnum(["on", "off", "toggle"] as const),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ready) {
				return {
					content: [{ type: "text", text: "picrophone not ready — build it first (npm run build && npm run build:app)." }],
					details: { voiceOn: voiceOn() },
				};
			}
			const target = params.action === "toggle" ? !voiceOn() : params.action === "on";
			if (target && !voiceOn()) await startVoice(ctx);
			else if (!target && voiceOn()) await stopVoice(ctx);
			const label = voiceOn() ? "on" : "off";
			return { content: [{ type: "text", text: `Voice mode ${label}.` }], details: { voiceOn: voiceOn() } };
		},
	});

}

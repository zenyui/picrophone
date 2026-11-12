// Shared, transport-agnostic types + a tiny NDJSON socket read loop.
//
// Everything above the native layer speaks in these types. Providers wrap a
// native helper (Swift picrophone today, a Windows exe later) and translate its
// wire format into these; the engine never sees a socket or NDJSON line.

import type { Socket } from "node:net";

/** Node platform id, e.g. "darwin" | "win32" | "linux". */
export type Platform = NodeJS.Platform;

// --- Speech-to-text messages (already parsed; no wire format leaks out) -----
export type SttMessage =
	| { type: "ready" }
	| { type: "partial"; text: string }
	| { type: "final"; text: string }
	| { type: "permission"; mic: string; speech: string }
	| { type: "warn"; message: string }
	/** Model download / load progress (whisper first run). */
	| { type: "progress"; message: string };

/** A live STT session. Messages arrive via the onMessage callback. */
export interface SttSession {
	stop: () => void;
	/** Discard any audio the recognizer accumulated (e.g. our own TTS echo). */
	reset: () => void;
}

export interface SttOptions {
	silenceMs?: number;
	locale?: string;
	onDevice?: boolean;
	/** whisper only: model name (tiny.en, base.en, small.en, large-v3-turbo). */
	model?: string;
}

// --- Text-to-speech ---------------------------------------------------------
export interface SpeakHandle {
	done: Promise<void>;
	/** Stop playback immediately (barge-in). */
	kill: () => void;
}

export interface SpeakOptions {
	/** Backend voice id (AVSpeech voice, or a Qwen3 speaker id). */
	voiceId?: string;
	/**
	 * Speed as a multiple of the engine's default pace (1 = unchanged). The
	 * macOS `say` engine's default is 175 words per minute, so 1.5 -> ~262 wpm.
	 * Only honored by engines with a tunable rate; others ignore it.
	 */
	rate?: number;
	/**
	 * Backend-specific engine hint. For the macOS system provider this is
	 * "av" | "say", or omitted for the OS default ("auto"). Providers that
	 * expose a single backend ignore it.
	 */
	engine?: string;
}

export interface Voice {
	id: string;
	name: string;
	language: string;
	quality: "premium" | "enhanced" | "default";
}

// --- Cues -------------------------------------------------------------------
export interface CueHandle {
	kill: () => void;
}

// --- Native helper version handshake ----------------------------------------
export interface HelperVersion {
	name: string;
	version: string;
	protocol: number;
	capabilities: string[];
	/** Running OS version, e.g. "15.7.4". */
	os?: string;
	/** TTS engines available on this OS, best-first, e.g. ["av","say"]. */
	ttsEngines?: string[];
	/** Engine `--engine auto` resolves to on this OS. */
	ttsEngine?: string;
}

// --- Provider interfaces ----------------------------------------------------
// Native helpers never implement these directly; each provider is a thin TS
// wrapper that conforms to the interface and shells out to whatever native
// helper / API it needs. Every provider declares which platforms it supports
// and reports its own readiness (permissions / binary present).

/** Whether a provider can run right now, and why not if it can't. */
export interface Readiness {
	available: boolean;
	/** Human-readable reason when `available` is false. */
	reason?: string;
}

interface ProviderMeta {
	/** Stable id used in config + commands (e.g. "apple", "whisper", "qwen"). */
	readonly id: string;
	/** Short human label for notices. */
	readonly label: string;
	/** Platforms this provider can run on (Node platform ids). */
	readonly supports: readonly Platform[];
	/** True if the provider needs a native binary present on disk. */
	readonly needsBinary?: boolean;
	/** Per-implementation permission / readiness check (doctor hook). */
	readiness(): Readiness | Promise<Readiness>;
}

export interface SttProvider extends ProviderMeta {
	start(onMessage: (msg: SttMessage) => void, opts?: SttOptions): SttSession;
}

export interface TtsProvider extends ProviderMeta {
	speak(text: string, opts?: SpeakOptions): SpeakHandle;
	/** List installed backend voices, if the backend exposes them. */
	listVoices?(): Promise<Voice[]>;
}

export type CueStyle =
	| "triad" | "ping" | "bloop" | "blip" | "pop" | "dew" | "glass" | "down" | "fifth";

export interface CuesProvider extends ProviderMeta {
	/** Ambient "thinking" sound until .kill() is called. */
	hum(volume?: number): CueHandle;
	/** Short "listening"/earcon (fire-and-forget). */
	chime(style?: CueStyle): void;
}

// --- NDJSON socket read loop ------------------------------------------------
/**
 * Attach a line-buffered NDJSON reader to a socket. Parses each complete line
 * as JSON and hands it to onLine; ignores blank/garbled lines. Returns nothing
 * — the caller owns the socket lifecycle.
 */
export function readNdjson(socket: Socket, onLine: (obj: unknown) => void, onRaw?: (line: string) => void): void {
	let buf = "";
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			onRaw?.(line);
			try {
				onLine(JSON.parse(line));
			} catch {
				// non-JSON line; ignore (already surfaced via onRaw)
			}
		}
	});
}

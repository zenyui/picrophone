// macOS native boundary: launch the Swift `picrophone` binary / Picrophone.app and move
// bytes between it and TypeScript. This is the ONLY file that knows about the
// picrophone CLI, `open`, and the unix-socket callback transport. Providers call
// these helpers; the engine never sees them.

import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readNdjson, type HelperVersion, type SttMessage, type SttOptions, type SttSession, type SpeakHandle, type Voice } from "../protocol";

const LOG_PATH = "/tmp/picrophone-ext.log";
// Diagnostics are opt-in. This write is a blocking syscall on the event loop and
// it ran for every STT partial and progress tick (measured ~160us per call, so
// ~0.8s per 5000 messages) — pure overhead on the hot path. Enable with
// PICROMEPHONE_DEBUG=1.
const DEBUG = process.env.PICOMEPHONE_DEBUG === "1";
// Rotate instead of letting one session's log grow without bound.
const LOG_MAX_BYTES = 1_000_000;
function log(msg: string): void {
	if (!DEBUG) return;
	try {
		const size = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
		if (size > LOG_MAX_BYTES) {
			// Keep one previous generation; nothing older is worth the disk.
			try { unlinkSync(`${LOG_PATH}.1`); } catch {}
			renameSync(LOG_PATH, `${LOG_PATH}.1`);
		}
	} catch {}
	try {
		appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
}

// The platform binaries ship in a per-platform package (`picrophone-darwin`)
// installed as an optionalDependency and gated by npm on `os`/`cpu`. Resolve
// its `bin/` at runtime; fall back to the in-repo workspace copy for local dev
// (`pi -e ...` from a checkout, where the package is symlinked or not installed).
const here = dirname(fileURLToPath(import.meta.url));
function resolveBinDir(): string {
	const pkg = `picrophone-${process.platform}`;
	try {
		// Resolves through node_modules (npm install) or the workspace symlink.
		return dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`));
	} catch {
		// Dev fallback: packages/<pkg> relative to this file in the source tree.
		// extension/voice/native/mac.ts -> ../../../packages/<pkg>
		return join(here, "..", "..", "..", "packages", pkg);
	}
}
const binDir = join(resolveBinDir(), "bin");
const BIN = join(binDir, "picrophone");
const APP = join(binDir, "Picrophone.app");

/** Both the CLI binary and the .app bundle must be present. */
export function binariesExist(): boolean {
	return existsSync(BIN) && existsSync(APP);
}

/** Read `picrophone version` (JSON handshake). */
export function getVersion(): Promise<HelperVersion> {
	return new Promise((resolve, reject) => {
		execFile(BIN, ["version"], (err, stdout) => {
			if (err) return reject(err);
			try {
				resolve(JSON.parse(stdout.trim()));
			} catch (e) {
				reject(e);
			}
		});
	});
}

// `say`'s own default pace, in words per minute. Measured, not guessed: with no
// -r flag `say` renders identically to `-r 175` on this platform.
const SAY_DEFAULT_WPM = 175;

/**
 * Speak text aloud via `picrophone tts`. Text is piped over stdin; killing the
 * process supports barge-in. `engine` (av | say | qwen) is optional; omit for
 * picrophone's own `auto`. `voiceId` is an AVSpeech voice or a Qwen3 speaker id.
 * `rate` is a speed multiplier (1 = engine default) and applies to `say` only.
 */
export function speak(text: string, opts: { engine?: string; voiceId?: string; rate?: number } = {}): SpeakHandle {
	const args = ["tts"];
	if (opts.engine) args.push("--engine", opts.engine);
	if (opts.voiceId) args.push("--voice", opts.voiceId);
	if (opts.rate != null && opts.engine === "say") {
		// The CLI takes whole words per minute; round rather than truncate so
		// 1.5 -> 262.5 lands on 263 instead of 262.
		const wpm = Math.round(opts.rate * SAY_DEFAULT_WPM);
		args.push("--rate", String(wpm));
	}
	const child = spawn(BIN, args, { stdio: ["pipe", "ignore", "ignore"] });
	child.stdin.on("error", () => {});
	child.stdin.end(text);
	// Resolve on the FIRST of exit/close/error so `speaking` can never get stuck
	// (a stuck handle would deadlock all further input). Safety timer too.
	// The primary defense against a hung synth is the Swift-side watchdog
	// (AVSpeechSynthesizer sometimes never fires didFinish); this length-aware
	// cap is a last resort for any engine (say/qwen) that wedges. Scale with the
	// text so long readouts aren't cut off, but stay far below the old flat 120s
	// so a stuck process can't strand voice mode in "speaking".
	const safetyMs = Math.min(120_000, Math.max(15_000, text.length * 250));
	const done = new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish();
		}, safetyMs);
		child.on("exit", finish);
		child.on("close", finish);
		child.on("error", finish);
	});
	return {
		done,
		kill: () => {
			try {
				child.kill("SIGTERM");
			} catch {}
		},
	};
}

/** List installed TTS voices (parsed from `picrophone voices` NDJSON). */
export function getVoices(): Promise<Voice[]> {
	return new Promise((resolve, reject) => {
		execFile(BIN, ["voices"], (err, stdout) => {
			if (err) return reject(err);
			const voices: Voice[] = [];
			for (const line of stdout.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				try {
					voices.push(JSON.parse(t) as Voice);
				} catch {}
			}
			resolve(voices);
		});
	});
}

/** Play the soft ambient thinking sound until .kill() is called. */
export function hum(volume?: number): { kill: () => void } {
	const args = ["hum"];
	if (volume != null) args.push("--volume", String(volume));
	const child = spawn(BIN, args, { stdio: "ignore" });
	return { kill: () => child.kill("SIGTERM") };
}

/** Play the short "listening" earcon (fire-and-forget). */
export function chime(style = "bloop"): void {
	try {
		spawn(BIN, ["chime", "--style", style], { stdio: "ignore" });
	} catch {}
}

// Grace period between asking the app to stop and releasing the socket. Short
// when it is connected (it will close on its own), longer when it is still
// booting (`open -n` takes ~500ms+) so cleanup doesn't pull the socket out from
// under an app that is about to connect.
const STOP_CLEANUP_MS = 300;
const STOP_CLEANUP_MS_BOOTING = 3_000;

/**
 * Start STT: open a unix socket, launch Picrophone.app (which detaches stdio, so it
 * connects back over the socket and streams NDJSON), stream parsed messages to
 * onMessage. `engine` selects apple | whisper inside picrophone.
 */
export function startStt(
	onMessage: (msg: SttMessage) => void,
	opts: SttOptions & { engine?: string } = {},
): SttSession {
	const dir = join(tmpdir(), "picrophone");
	mkdirSync(dir, { recursive: true });
	const sockPath = join(dir, `stt-${process.pid}-${Date.now()}.sock`);
	if (existsSync(sockPath)) unlinkSync(sockPath);

	let conn: Socket | null = null;
	let stopped = false;
	// Set by stop() before the app has connected. Picrophone.app is launched
	// asynchronously (`open -n`) and needs ~500ms+ to boot and load the model, so
	// a /voice off inside that window used to drop the stop signal and unlink the
	// socket out from under the booting app — which then either failed to connect
	// or kept the mic open. Remember the request and send it the moment we connect.
	let stopRequested = false;
	let cleanedUp = false;

	const server: Server = createServer((socket) => {
		conn = socket;
		log("Picrophone.app connected to socket");
		if (stopRequested) {
			try {
				socket.write("stop\n");
			} catch {}
		}
		socket.on("close", () => {
			log("socket closed");
			// The app is gone: release the server + socket handles here instead of
			// waiting for a stop() that may never come (crash, /voice off from
			// another path, app killed externally).
			cleanup();
		});
		readNdjson(
			socket,
			(obj) => {
				log(`recv: ${JSON.stringify(obj)}`);
				onMessage(obj as SttMessage);
			},
			(raw) => {
				// keep a trace of unparsed lines too
				if (raw.length && raw[0] !== "{") log(`recv (unparsed): ${raw}`);
			},
		);
	});

	// `process.on("exit")` only gets synchronous work to run, so use the sync fs
	// API here: ask the app to stop (best effort — it may still be booting, see
	// stopRequested) and unlink the socket file we created. Without this, a
	// SIGHUP'd pi leaves an stt-*.sock behind in $TMPDIR/picrophone.
	const onProcessExit = () => {
		try {
			conn?.write("stop\n");
		} catch {}
		try {
			if (existsSync(sockPath)) unlinkSync(sockPath);
		} catch {}
	};
	process.on("exit", onProcessExit);

	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		stopped = true;
		// server.close() only stops accepting new connections — the accepted
		// socket, the server handle and the whole readNdjson closure graph stay
		// live for the life of the pi process unless we destroy them. That was
		// one leaked server + socket per voice session.
		try {
			server.close();
		} catch {}
		try {
			conn?.destroy();
		} catch {}
		conn = null;
		process.off("exit", onProcessExit);
		if (existsSync(sockPath)) {
			try {
				unlinkSync(sockPath);
			} catch {}
		}
	};

	server.on("error", (e) => log(`socket server error: ${String(e)}`));
	server.listen(sockPath, () => {
		const args = ["-n", APP, "--args", "stt", "--socket", sockPath];
		if (opts.silenceMs) args.push("--silence-ms", String(opts.silenceMs));
		if (opts.locale) args.push("--locale", opts.locale);
		if (opts.onDevice) args.push("--on-device");
		if (opts.engine) args.push("--engine", opts.engine);
		if (opts.model) args.push("--model", opts.model);
		log(`listening on ${sockPath}; launching: open ${args.join(" ")}`);
		const child: ChildProcess = spawn("open", args, { stdio: "ignore" });
		child.on("error", (e) => {
			log(`open failed: ${String(e)}`);
			onMessage({ type: "warn", message: "failed to launch Picrophone.app" });
		});
		child.on("exit", (code) => log(`open exited code=${code}`));
	});

	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			stopRequested = true;
			try {
				conn?.write("stop\n");
			} catch {}
			// If the app never connected, wait long enough for it to boot and
			// connect (so stopRequested can fire) instead of unlinking the socket
			// path underneath it.
			setTimeout(cleanup, conn ? STOP_CLEANUP_MS : STOP_CLEANUP_MS_BOOTING);
		},
		reset: () => {
			if (stopped) return;
			try {
				conn?.write("reset\n");
			} catch {}
		},
	};
}

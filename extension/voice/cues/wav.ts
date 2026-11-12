// Default, cross-platform cues: play baked WAV assets via the system player.
// - macOS: `afplay`
// - Windows: PowerShell System.Media.SoundPlayer (STUB path shape; verified later)
// Removes hum/chime synthesis from picrophone (and from any future native helper);
// the WAVs are baked from the original Swift DSP (scripts/bake-cues.mjs) so the
// sound is unchanged.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CueHandle, CuesProvider, CueStyle, Readiness } from "../protocol";

// extension/voice/cues/wav.ts -> ../../../assets
const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets");
const HUM_WAV = join(assetsDir, "hum.wav");
const chimeWav = (style: CueStyle) => join(assetsDir, `chime-${style}.wav`);

/** Spawn the platform WAV player for one file; returns the child (or null). */
function playOnce(file: string): ChildProcess | null {
	try {
		if (process.platform === "win32") {
			return spawn(
				"powershell",
				["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${file}').PlaySync()`],
				{ stdio: "ignore" },
			);
		}
		// macOS (and Linux with afplay available). `detached: false` keeps the
		// player in this process's group so kill()'s SIGTERM reaches it instead
		// of orphaning it with an open Core Audio stream.
		return spawn("afplay", [file], { stdio: "ignore", detached: false });
	} catch {
		return null;
	}
}

export const wavCues: CuesProvider = {
	id: "wav",
	label: "Baked WAV cues",
	// Player is present on macOS; Windows path is a documented stub until tested.
	supports: ["darwin", "win32"],
	needsBinary: false,
	readiness(): Readiness {
		return existsSync(HUM_WAV)
			? { available: true }
			: { available: false, reason: "cue WAV assets missing — run `node scripts/bake-cues.mjs`." };
	},
	hum(): CueHandle {
		// Loop the one-cycle hum by respawning the player when it exits.
		//
		// Each `afplay` spawn opens a fresh Core Audio output stream and only
		// tears it down on a clean exit, so a 2.4s hum cycle means ~1500 streams
		// per hour and the previous build leaked them into coreaudiod (~15GB of
		// retained buffers after a few days, with audioanalyticsd spinning at
		// 100% CPU trying to account for sessions that no longer exist). Two
		// changes close that off:
		//   - `detached: false` keeps the child in this process's group so the
		//     SIGTERM below actually reaches the player.
		//   - resolve the handle only once the child has really exited, and stop
		//     looping on a non-zero/signal exit, so a player that dies or is
		//     killed can't trigger a respawn that outlives the hum.
		// The native `hum` subcommand is the leak-free path when the binary is
		// present; this remains as the no-binary fallback.
		let killed = false;
		let child: ChildProcess | null = null;
		const loop = () => {
			if (killed) return;
			child = playOnce(HUM_WAV);
			if (!child) {
				killed = true; // player unavailable; give up quietly
				return;
			}
			child.on("error", () => {
				killed = true; // spawn failed; don't spin on it
			});
			child.on("exit", (code, signal) => {
				child = null;
				// A signal exit means we killed it — don't restart. A non-zero code
				// means the player failed; restarting would just spin.
				if (!killed && code === 0 && signal === null) loop();
				else if (!killed) killed = true;
			});
		};
		loop();
		return {
			kill: () => {
				killed = true;
				try {
					child?.kill("SIGTERM");
				} catch {}
				// Drop the reference so the exit handler can't touch a dead handle
				// and so nothing keeps the player alive via closure.
				child = null;
			},
		};
	},
	chime(style: CueStyle = "bloop"): void {
		const file = chimeWav(style);
		if (existsSync(file)) playOnce(file);
	},
};

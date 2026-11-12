// System TTS: AVSpeech + `say`, wrapping `picrophone tts` (macOS). Covers the
// "auto" (OS default), "av", and "say" engines — selected via SpeakOptions.engine.

import type { SpeakHandle, SpeakOptions, TtsProvider, Voice } from "../protocol";
import { binariesExist, getVoices, speak } from "../native/mac";

export const systemTts: TtsProvider = {
	id: "system",
	label: "System (AVSpeech / say)",
	supports: ["darwin"],
	needsBinary: true,
	readiness() {
		return binariesExist()
			? { available: true }
			: { available: false, reason: "picrophone binary/app missing — run `npm run build`." };
	},
	speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
		// engine "auto" (or unset) -> let picrophone pick the best available backend.
		const engine = opts.engine && opts.engine !== "auto" ? opts.engine : undefined;
		return speak(text, { engine, voiceId: opts.voiceId, rate: opts.rate });
	},
	listVoices(): Promise<Voice[]> {
		return getVoices();
	},
};

# Configuration

## Config file

Voice-mode settings live in `~/.pi/agent/picrophone.json` (seeded with defaults
on first run). Edit it directly, or ask the agent to. Changes are picked up the
next time voice mode starts (`/voice`), which validates the whole file — if
anything is invalid it warns, falls back to defaults, and (when the agent is
idle) hands the agent the validation errors plus the JSON Schema so it can
repair the file for you.

Settings are grouped by section (`stt`, `tts`), each with an `engine` plus a
sub-object per provider for that provider's own settings.

```json
{
  "version": 2,
  "stt": {
    "engine": "whisper",
    "whisper": { "model": "base" }
  },
  "tts": {
    "engine": "av",
    "qwen": { "voice": "aiden" }
  },
  "hum": { "enabled": false }
}
```

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `stt.engine` | `whisper` \| `apple` | `whisper` | Dictation back-end. |
| `stt.whisper.model` | `tiny`, `base`, `small`, `large` | `base` | Used when `stt.engine` is `whisper`. Mapped to the WhisperKit model on our side. |
| `tts.engine` | `auto` \| `av` \| `say` \| `qwen` | `av` | Read-aloud back-end. |
| `tts.qwen.voice` | `ryan`, `aiden`, `serena`, `vivian`, `eric`, `dylan`, `sohee`, `ono-anna`, `uncle-fu` | `aiden` | Used when `tts.engine` is `qwen`. |
| `hum.enabled` | `true` \| `false` | `true` | The "thinking" tone. Set to `false` to turn it off — it's a long, continuous sound under every turn, which some people find irritating. The whole `hum` section is optional; omit it to keep the default. |

Turning the hum off doesn't affect anything else: `listening`/`stop` earcons and
read-aloud are unaffected, and the widget still shows the `thinking` state.

See [engines](engines.md) for what each engine does.

## Internal CLI flags

The `picrophone` binary is an internal helper — the extension drives it and
sets these flags for you. You don't call it directly. This section is a
reference for the flags the extension passes.

## `stt`

- `--silence-ms <n>` — pause length that commits a phrase (default 1200).
- `--locale <id>` — recognizer locale (default `en-US`).
- `--on-device` — force on-device recognition (apple engine).
- `--engine <apple|whisper>` — pick the STT back-end (extension default `whisper`).
- `--model <name>` — whisper model (default `base.en`).
- `--vad-threshold <0..1>` — whisper voice-activity energy threshold (default
  0.3; lower = more sensitive).

## `tts`

- `--engine <name>` — `auto` (default) | `neural` | `av` | `say`. `auto` picks
  the best engine available for your macOS version; older systems fall back
  automatically. `picrophone version` reports `os`, `ttsEngines`, and the
  resolved `ttsEngine`.
- `--voice <id> --rate <wpm>` — pick a `say` voice / speed.

## `hum`

- `--volume <0..1> --interval <sec>` — tune the thinking sound.

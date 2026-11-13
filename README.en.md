# Strudel AI Composer

A web app that turns a text description of music into [Strudel](https://strudel.cc/) code (a live-coding music framework) and plays it in the browser with per-part visualisations.

- **Text → code** — an LLM generates Strudel code with streaming (live typing effect)
- **Structured composition** — the model picks ideas (harmony, form, roles, energy), a deterministic compiler turns them into code. The track develops over time: sections, harmony changes, transitions
- **Trace and timeline** — see how the track was built: spec, score, refinement steps; above the editor — section blocks and the energy curve
- **Music analysis** — the generated code is measured against objective metrics (tempo, density, groove, scale fit, range, register separation) and gets a transparent 0–100 score with a per-criterion breakdown
- **Audio analysis** — the track is rendered in the browser by the same DSP core that you hear: loudness (LUFS), true peak, spectral bands, silence, render repeatability. The audio block is 20% of the score, and its findings are machine-readable ("bass quieter" → a command, not a sentence)
- **Feedback loop** — "✨ Improve from analysis": the model rewrites the track against concrete findings ("tempo 90, target 124–142", "too few onsets", "bass and melody in the same octave")
- **A/B variants** — best-of-N: several variants generated from different angles, each scored, best on top
- **Live score** — every `$PART:` gets a large piano roll or oscilloscope with the part's code above it
- **Playback** — `@strudel/web`: sound right after generation
- **Mixer** — volume, mute and solo per part, with live level meters
- **Edits by description** — "✨ Improve" shows a diff and applies it on confirmation
- **Voice** — optional voice input (Groq Whisper); the button is hidden without a key
- **Presets and history** — six built-in presets, generation history, export/import, shareable track links
- **Design** — dark jade theme by default, obsidian alternative, no UI libraries
- **Samples** — `dirt-samples` (bd, sd, hh, cp, 808*, breaks* …) and `shabda:piano`, loaded on demand, names without `.bank(...)`

Details on the analysis and the feedback loop: [docs/MUSIC-ANALYSIS.md](docs/MUSIC-ANALYSIS.md).
Render metrics and acceptance: [docs/AUDIO-QA.md](docs/AUDIO-QA.md).
How structured composition works: [docs/COMPOSE.md](docs/COMPOSE.md).
Russian version of this README: [README.md](README.md).

## Install

```bash
npm install
cp .env.example .env   # put your keys in
npm run dev
```

Opens at `http://localhost:5173`. The first click unlocks audio (browser AudioContext policy).

## API keys

| Variable | Where to get it | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys | Strudel code generation |
| `OPENAI_MODEL` | — | generation model |
| `OPENAI_BASE_URL` *(optional)* | compatible proxy | for regions blocked from api.openai.com |
| `OPENAI_FALLBACK_MODEL` *(optional)* | — | fallback model when the primary is unavailable |
| `GROQ_API_KEY` *(optional)* | https://console.groq.com/keys | voice transcription; without it the mic button is hidden |
| `OLLAMA_MODEL` *(optional)* | — | local inference, no internet and no cost |
| `ANTHROPIC_API_KEY` *(optional)* | https://console.anthropic.com | another provider in the router |

Providers are tried in the order given by `LLM_PROVIDERS` (default `openai`): if one
is unavailable, the request moves to the next. Supported: `openai`, `groq`, `ollama`,
`anthropic` — both OpenAI-compatible endpoints and the Anthropic Messages API.

Keys live on the server only: requests go through the Vite proxy (`/api/generate` → LLM) and never reach the frontend.

## Usage

1. Describe the music in the "Command" field and press "▶ Generate"
2. "🧩 Plan and build" — structured mode: the model plans the track (sections,
   harmony, roles), the compiler assembles the code. The pipeline trace and the
   section timeline with the energy curve appear
3. "🎼 Analyse" — score the track against objective metrics and see what holds it back
4. "✨ Improve from analysis" — the model rewrites the track against the findings; shows before → after
5. "🎲 A/B variants" — three variants from different angles, each scored, best on top
6. "✨ Improve" — describe edits to the current track, review the diff, apply
7. The "Strudel code" panel is editable: edit by hand and press "▶ Play this code"
8. Mixer on the right: M mutes a part, S solos it, the slider sets volume
9. 🎤 next to the prompt records a voice description (needs `GROQ_API_KEY`); nothing is sent automatically

### Two generation modes

| Mode | What the model does | What you get |
|---|---|---|
| **Structured** (default) | plans sections, harmony, energy and role patterns in TrackSpec | the validated spec is deterministically compiled into Strudel code |
| **Free** | writes the whole code itself | maximum freedom, no guarantee of form |

The switch sits under the "Command" field. The structured path is plan →
`validateTrackSpec` → synchronous `compileTrackSpec(spec)` → score/refine,
with validation and compilation repeated for every accepted refinement.
The compiler returns a code string. The single schema lives in
`src/schemas/track-spec.schema.js`: `meta`, `structure.sections`, `parts.roles`.
The old top-level `harmony/form` format is not supported. Free mode validates
model-generated code; both modes retain analysis and improvement.

### Hotkeys

| Keys | Action |
|---|---|
| `Space` | play / stop |
| `Ctrl` + `Enter` | generate a track |
| `Ctrl` + `S` | save a preset |

### Example commands

- "drum pattern in the style of Queen with a heavy bass"
- "calm piano melody in A minor, 80 BPM"
- "add hi-hats on every eighth to the current code"
- "make the bass heavier and slow the tempo down"

## Structure

```
├── index.html                 # markup: three columns + transport
├── src/
│   ├── main.js                # entry point
│   ├── ui.js                  # buttons, log, streaming, hotkeys, theme
│   ├── editor.js              # syntax highlighting, current line, active part
│   ├── strudel-engine.js      # initStrudel, evaluateCode, stop, reset, unlockAudio
│   ├── pianoroll.js           # jade piano rolls and oscilloscopes
│   ├── meters.js              # live part levels (onTrigger) and their injection into code
│   ├── live.js                # wiring meters to mixer, visualisations and editor
│   ├── mixer.js               # channels, fader, mute/solo
│   ├── transport.js           # play/stop, BPM, key, recording
│   ├── history.js             # presets and history
│   ├── improve.js             # "improve" mode with a diff
│   ├── music-panel.js         # music analysis panel: score, findings, variants
│   ├── voice.js               # voice input (MediaRecorder → /api/transcribe)
│   ├── accents.js             # part accents: jade / mint / teal / lime
│   ├── core/                  # validator, code-model, storage, share, recorder, wav,
│   │                          # highlight, visual-plan
│   ├── presets/               # six built-in presets
│   └── styles/                # tokens / layout / components / animations
├── server/                    # Node proxy: /api/generate (SSE), /api/fix,
│                              # /api/transcribe, /api/music/*, prompts, health
│   ├── llm/                   # router.js — multi-provider LLM router
│   └── music/                 # mini.js, notes.js, extract.js, features.js,
│                              # references.js, score.js — analysis and scoring
├── deploy/                    # nginx-music.conf, ecosystem.config.cjs, deploy.sh
├── scripts/                   # check-secrets, check-presets, probe-music, calibrate
└── tests/                     # vitest: unit tests + broken-code fixtures
```

## Checks

```bash
npm test              # unit and integration tests (vitest); current count is reported by the run
npm run check:presets # preset mini-notation checked by Strudel's own parser
npm run check:secrets # no keys committed to the repo
npm run build         # production build into dist/
node scripts/probe-music.mjs   # analyse every preset with per-criterion scores
node scripts/calibrate.mjs     # fit criterion weights to human ratings
```

`npm run check:presets` matters: Strudel spells a rest as `~`, not `.`. Presets and
generated code are checked with Strudel's real parser, while the linter in
`src/core/validator.js` catches a dot in a rest position before playback.

> Note: drum samples (dirt-samples) are fetched lazily from Strudel's GitHub CDN on
> the first playback of sample code; synthesizers work without them. Code generation
> needs internet access and a valid key.

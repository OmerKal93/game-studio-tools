# game-studio-tools

Small, reusable command-line tools for making games: bringing in third-party assets with a licence register, shrinking and reviewing glTF characters, running Blender and Unreal Engine headless, checking frames, voice-over processing, and a few review helpers. Plain Node.js scripts, some Python for Blender and Unreal, and a few PowerShell and shell helpers. Each tool has a usage header at the top of the file, and most have a `selftest`.

Some tools are Windows-oriented (PowerShell, DPAPI secrets, `.exe` names). Most run anywhere Node does.

## What is in here

| Tool | What it does |
|---|---|
| `tools/asset-intake.mjs` | Asset intake with a licence register: refuses licences not on an allow list, records source URL, author, hash and whether the file may ship. |
| `tools/fetch-asset.mjs` | Searches and downloads CC0 assets from Poly Haven and ambientCG, and registers each file. |
| `tools/optimize-gltf.mjs` | Shrinks glTF/GLB for the web (meshopt, WebP, simplify) and validates the result. |
| `tools/make-sfx.mjs` | Procedural sound effects (jsfxr presets, noise beds) normalised to mono Opus. |
| `tools/gen-image.mjs` | *Experimental.* Generates an image through an optional Codex plugin, resizes it, and registers it as AI-generated. |
| `tools/voice-process.mjs`, `tools/voice-profiles.json` | Splits a recorded voice take into per-line files and processes them with named voice profiles. |
| `tools/voice/` | `game_voice.py`: text-to-speech with automatic checks, loudness and lip-sync data (models are fetched separately by `fetch_models.py`). |
| `tools/blender-run.mjs`, `blender/` | Runs Blender Python headless with a timeout and a log; Python generators for a procedural building kit, MPFB2 characters and review renders. |
| `tools/unreal/ue-run.mjs` | Runs Unreal Engine headless (editor Python, commandlets, UAT, `-game` map-load checks) with logs and lock files. |
| `tools/unreal/ue-device.mjs`, `ue-mobile-preview.mjs` | adb phone loop (build, install, launch) and mobile-renderer preview settings. |
| `tools/unreal/bpdsl.py` and other scripts | A small rules DSL that emits Blueprints, plus retarget and clip-dump scripts for Unreal's Python. |
| `tools/prepare-mixamo-npc.mjs` | Packs a Mixamo character and its clips (which you download yourself) into one optimised GLB. |
| `tools/render-sheet.mjs`, `frames-sheet.mjs`, `compare-sheet.mjs`, `lookdev-compare.mjs`, `check-garment.mjs` | Contact sheets, side-by-side comparisons, photo-vs-frame ratios, and a cloth poke-through check. |
| `tools/two-bone-ik.mjs` | Analytic two-bone IK for three.js bone chains (importable). |
| `tools/import-boundary.mjs` | Proves that guarded modules never reach a forbidden import, transitively. |
| `tools/phone-perf.mjs` | Scripted frame-time and metrics capture from a WebView game over adb. |
| `tools/apk-build.ps1` | Builds a debug APK, verifies the signature and archives it with a hash. |
| `tools/learn/frame-gate.mjs` | Frame gate: measures luma, hue and chroma boxes of candidate frames against accepted ones and fails outside tolerance. |
| `tools/learn/trend.mjs` | Draws a `ROUNDS.csv` log (rounds and hours per task) as a phone-width SVG. |
| `tools/learn/learn.mjs` | Learn reviewer: an AI first pass over frames against a checklist, and a retro over your own lessons log (needs a Gemini or Anthropic API key). |
| `tools/review/secret-scan.mjs` | Secret scan that reports file and line, never the value; optionally scans history. |
| `tools/review/codex-review.sh` | Wrapper that asks the Codex CLI for a read-only review of a plan or diff (third-party code, see below). |
| `tools/hooks/readonly-bash.mjs` | A PreToolUse hook that lets reviewer agents run only read-only shell commands. |
| `tools/secrets/` | Pattern for keeping API keys in a Windows DPAPI-encrypted store and injecting one into a single command. |
| `tools/locked-run.mjs` | Runs a command while holding a directory mutex. |
| `tools/backup-bundle.sh` | Verified git bundles (plus Git LFS objects) with a manifest. |
| `skill/` | The same know-how as recipes (APK, assets, animation, Blender, Unreal, verification) in a form an AI coding agent can load as a skill. |

## Requirements

- Node.js (developed and tested on Node 24), then `npm ci` in this folder. Everything it installs is pinned by `package-lock.json`.
- Optional, depending on the tool, kept in the git-ignored `bin/` or on your PATH (set `FFMPEG`, `FFPROBE`, `STUDIO_BLENDER`, `UE_ROOT`, `ADB` to point elsewhere):
  - ffmpeg and ffprobe (sound and voice tools);
  - gltfpack (the optional `--engine gltfpack` of `optimize-gltf.mjs`);
  - Blender 4.5 LTS (`blender-run.mjs`);
  - Unreal Engine 5.8 and the Android SDK (the `unreal/` tools, `apk-build.ps1`);
  - Python 3.10+ (the voice tool), plus its own model downloads.
- Binaries are never part of this repository.

## Running the tests

```
npm ci
npm test
```

`npm test` runs the offline checks: the `node --test` files in `tools/learn/` and the `selftest` of the tools that need no extra program. Tools that need a binary run their selftest when it is installed:

```
node tools/optimize-gltf.mjs selftest        # needs only node_modules
node tools/make-sfx.mjs selftest             # needs ffmpeg
node tools/voice-process.mjs selftest        # needs ffmpeg
node tools/blender-run.mjs selftest          # needs Blender
```

## Configuration

Paths come from environment variables or relative folders, never from a fixed machine path:

| Variable | Used by | Default |
|---|---|---|
| `ASSET_REGISTER` | `asset-intake.mjs` and the tools that register files | `ASSET-REGISTER.json` in the repo root (git-ignored; start from `ASSET-REGISTER.example.json`) |
| `LEARN_LOG` | `learn.mjs` spend log | `~/.game-studio-tools/learn-spend.csv` |
| `LEARN_CONTEXT`, `LEARN_ROUNDS`, `LEARN_LEARNINGS` | `learn.mjs` | a generic prompt; `ROUNDS.csv` and `LEARNINGS.md` in the current folder |
| `UE_ROOT`, `UE_HEAVY_LOCK`, `UE_YIELD_LOCK` | `ue-run.mjs` | the Epic launcher install; a lock in the temp folder; no yield lock |
| `STUDIO_BLENDER`, `FFMPEG`, `FFPROBE`, `ADB` | Blender, sound and phone tools | `bin/...` or PATH |
| `ANDROID_TOOLCHAIN` | `apk-build.ps1` | none, you must set it |
| `GAME_STUDIO_SECRETS_DIR` | `tools/secrets/*.ps1` | `%LOCALAPPDATA%\GameStudioSecrets` |
| `GAME_VOICE_WORK` | `voice/game_voice.py` | `./voice-work` |
| `TREND_BASELINE` | `trend.mjs` | `baseline` |

Keys such as `ANTHROPIC_API_KEY` and `GOOGLE_AI_API_KEY` are read only from the environment of the one command that needs them. Never commit a key.

## Licensed assets are never included

This repository ships code only. It contains no Mixamo, Megascans/Fab, MetaHuman, Rokoko, Sketchfab or other licensed models, animations, textures, audio, voice models or archives, and `.gitignore` blocks their file types. The tools help you download and register assets **you** are licensed to use, and they keep raw files out of your repositories. Read each source's licence yourself; nothing here is legal advice.

## Third-party code

`tools/review/codex-review.sh` comes from an MIT-licensed open-source project; its notice is kept in `tools/review/LICENSE-codex-review`.

The licence allow list in `asset-intake.mjs` reflects one reading of each vendor's terms at the time of writing. It is not legal advice: check the current terms of every source before you ship an asset.

## AI-assisted development

Most of this code was written with the help of AI coding assistants (Claude, with some Codex and Gemini review) and checked by the self-tests and by a human owner.

## Contributing and licence

See `CONTRIBUTING.md`. The code is released under the MIT licence (`LICENSE`).

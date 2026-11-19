---
name: game-studio
description: "Proven tools and recipes for making games: building and checking an Android APK, bringing in a third-party asset (model, animation, texture, sound, font) with a licence register, retargeting animation onto a character, rendering a review sheet, running a game's e2e, headless Unreal and Blender. Use whenever a task repeats something done before."
---

# Game studio tools

This folder is a skill for an AI coding agent (it also reads fine as plain documentation). The tools live in `tools/`, the recipes in `recipes/` next to this file, and every third-party asset goes into a register (`ASSET-REGISTER.json`, which stays on your machine; copy `ASSET-REGISTER.example.json` to start one).

## Every run

1. **Follow the recipe** for the job:
   - APK build, version bump, signature check: [recipes/apk.md](recipes/apk.md)
   - any downloaded asset (licence gate, register, budget): [recipes/assets.md](recipes/assets.md)
   - Mixamo download, retarget onto a character, bake clips: [recipes/animation.md](recipes/animation.md)
   - generated images (icons, concept art, UI textures): [recipes/generate.md](recipes/generate.md)
   - procedural geometry in Blender (building kit, LODs, in-game review): [recipes/blender.md](recipes/blender.md)
   - headless e2e, screenshots, render review, scripted phone performance (adb, Perfetto): [recipes/verify.md](recipes/verify.md)
   - Unreal Engine headless (project, Python, Movie Render Queue stills, Android APK): [recipes/unreal.md](recipes/unreal.md)
2. **Tools in `tools/`** (fresh checkout: `npm ci` in the repo root; `bin/` is git-ignored and holds portable ffmpeg, gltfpack and Blender if you want them there):
   - `blender-run.mjs`: headless Blender Python with a timeout and a log (generators are in `blender/`).
   - `optimize-gltf.mjs`, `fetch-asset.mjs`, `make-sfx.mjs`, `gen-image.mjs`: asset shrinking, CC0 downloads, procedural sound, generated images.
   - `asset-intake.mjs`: the licence register.
   - `phone-perf.mjs`: scripted phone performance over adb.
   - `prepare-mixamo-npc.mjs`, `render-sheet.mjs`, `check-garment.mjs`, `frames-sheet.mjs`, `compare-sheet.mjs`, `lookdev-compare.mjs`: character baking and review sheets.
   - `two-bone-ik.mjs`: analytic two-bone IK for three.js bone chains (importable).
   - `import-boundary.mjs`: no guarded module may reach a forbidden import, transitively.
   - `voice-process.mjs`, `voice/`: voice-over splitting and processing; text-to-speech with checks.
   - `locked-run.mjs`: run a command holding a mkdir mutex.
   - `unreal/ue-run.mjs`, `unreal/ue-device.mjs`: headless Unreal and the adb phone loop.
   - `backup-bundle.sh`: verified git bundles plus LFS objects.
   - `learn/`: frame gate, round trend, and an AI first-pass reviewer.
   - `review/`, `hooks/`: secret scan, Codex review wrapper, read-only shell allowlist for reviewer agents.
   - `secrets/`: DPAPI-encrypted secret store pattern for Windows.
   Each tool has a usage header, and most have a `selftest`.
3. **Promote repeats.** A command or script you needed for the second time becomes a tool in `tools/` (generic: paths and names as parameters, a one-line usage header, a selftest when it has logic), plus a line in the matching recipe. Project-only scripts stay in the project and are linked from the recipe.
4. **Write down what surprised you.** When a lesson changes how a step is done, edit the recipe itself: the recipe is the single source of truth.

## Rules

- Every asset enters through `tools/asset-intake.mjs`, before any game uses it.
- Never publish, share, spend money or change access without the owner's explicit word.
- Never commit secrets, signing keys or licensed raw assets (see the README).

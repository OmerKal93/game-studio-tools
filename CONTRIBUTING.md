# Contributing

Small, boring tools that other projects can copy. A change is welcome when it follows these rules.

## A tool is

- one file, or one folder, in `tools/`, with a usage header at the top;
- generic: paths, names and project details come from parameters or environment variables, never from a fixed machine path;
- tested: a `selftest` (or a `node --test` file) for any logic, a branch, a parser or a state machine. The tests run offline and build their own fixtures in code.

Promote a script to a tool when you needed it a second time. Project-only scripts stay in the project.

## What must never be committed

- Licensed or third-party raw assets: models, animations, textures, audio, voice models, archives. Generate fixtures in code instead. `.gitignore` blocks the usual extensions.
- Secrets: keys, tokens, signing keystores, `.env` files. Read them from the environment.
- Personal data: real names, e-mail addresses, phone numbers, local machine paths.
- Binaries (ffmpeg, Blender, gltfpack, ...). Document how to get them and their checksums instead.

Run `node tools/review/secret-scan.mjs .` before you push.

## Assets in your own projects

Every third-party asset goes through `tools/asset-intake.mjs` before any game uses it. To allow a new licence, read its terms, add it to `LICENSES` in the tool, and give the reason in the commit message.

## Process

- Write the failing test first, then the smallest change that passes it.
- Run `npm test` and the selftests of the tools you touched. Say in the pull request what you ran and what you could not run.
- Keep a change small and say what it leaves out.
- Disclose AI assistance in the pull request description when it wrote a meaningful part of the change.

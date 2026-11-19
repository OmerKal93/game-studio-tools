# Generated images

For HUD icons, concept art, storyboard frames and UI or banner textures. Not for ground or wall materials (not seamless or PBR-correct): use Poly Haven or ambientCG ([assets.md](assets.md)).

1. **Generate:** `node tools/gen-image.mjs --prompt "flat loaf of bread, game HUD icon" --out <dir>/bread.webp --size 128 [--transparent]`. It calls the outsourcerer plugin's `image` subcommand (a Codex image backend billed to your ChatGPT plan, no cash) and resizes with sharp. Only that keyless backend is allowed: backends that need an API key or bill cash are refused, so ask the owner before running them by hand.
2. **Register:** done by the tool as licence `AI-OWN` (kind texture, credit false), with "AI-generated, check provider terms", the backend and the prompt in the note. Provider terms and any disclosure duty are for the owner to check before a store release.
3. **Budget** the file as in [assets.md](assets.md) step 4 (WebP, smallest size that reads well). Prompts leave the machine: no secrets or personal data in them.
4. Check the result by eye before it enters a game. Done when the file is registered, within budget and looked at.

The tool is tested offline only (`node tools/gen-image.mjs selftest`). A real run needs the plugin installed and an image backend available (`outsourcerer.sh doctor` shows the resolved backend).

# Unreal Engine 5.8 (headless): project, Python scripting, stills, Android APK

Engine: Epic launcher install (default `C:\Program Files\Epic Games\UE_5.8`; set `UE_ROOT` to use another folder). The owner installs it and logs in. Agents never log in, never write into the engine folder and never elevate.

Needed launcher options (Library > 5.8 tile > arrow next to Launch > Options):
- **Android** (Target Platforms), for any APK.
- **MetaHuman Creator Core Data**, for MetaHuman Creator.

Close every Unreal Editor before adding options, or the launcher skips them. Check what is really on disk against `zen-manifest.json` in the engine root, which lists every optional file. A missing `Engine\Build\Android` means Android is not installed.

Tool: `node tools/unreal/ue-run.mjs` (usage header, `selftest`).
- `py <project.uproject> <script.py> [-- args]`: runs UnrealEditor-Cmd `-run=pythonscript`. Use it for asset import and materials only.
  - It cannot spawn actors (spawn returns None) and has no StaticMeshEditorSubsystem (use `unreal.EditorStaticMeshLibrary`).
  - Plugin content needs `AssetRegistryHelpers.get_asset_registry().scan_paths_synchronous([...])` first.
  - A Python traceback fails the run even when Unreal exits 0.
- `py ... --editor`: runs the full editor with `-RenderOffscreen`. Use it for levels, actors, sequences and Movie Render Queue.
  - The editor quits as soon as the script returns. A script that waits on callbacks calls `unreal.EditorPythonScripting.set_keep_python_script_alive(True)` and later `unreal.SystemLibrary.quit_editor()`.
  - Script paths and args go with forward slashes, because `-ExecutePythonScript` eats backslash escapes.
- `--ue-arg -flag` adds an engine switch. It is repeatable. For example, `-featureleveles31` renders through the mobile path.
- `uat -- BuildCookRun ...`: runs RunUAT through one verbatim `cmd /s /c "..."` line. Plain `cmd /c` with two quoted paths fails with "'C:\Program' is not recognized".
  - It reads SDK/NDK/JDK from the project's `Config/DefaultEngine.ini` `[/Script/AndroidPlatformEditor.AndroidSDKSettings]` and passes them as env to the child only. UBT's SDK check ignores project config and would otherwise fall back to Android Studio's JBR.
  - It sets `uebp_LogFolder`/`uebp_EngineSavedFolder` to `<project>\Saved\UAT`. Without that, UAT writes cook logs into `Engine\Programs\AutomationTool\Saved`, which is inside the engine folder.
- `game <project.uproject> [/Game/Map] [--expect regex]...`: runs `-game -nullrhi -nosound`. It passes once every regex has appeared in the log (default: `Bringing World ... up for play`, i.e. the map loaded), then stops the game.
- `cmdlet <project.uproject> <Commandlet> [-- args]`: runs any commandlet, for example `WorldPartitionConvertCommandlet`.
- Every run passes `-LocalDataCachePath=<project>\DerivedDataCache`.
- With `--yield-lock <dir>` (or env `UE_YIELD_LOCK`), every run waits while that directory exists and never takes it. `--max-wait s` gives up after s seconds and runs at idle CPU priority.
- **Locks** (mkdir mutexes):
  - Every mode takes `<project>\.ue-lock`: one Unreal process per working copy.
  - `uat`, and `py --heavy` (stills, shader-heavy work), also take `$UE_HEAVY_LOCK` (default `<tmpdir>/.ue-heavy-lock`): one heavy job per machine.
  - `--lock-wait s` (default 3600) gives up with the lock's path. `owner.txt` inside the lock names the pid.
  - A lock left behind by a killed run is removed by hand, and only after checking that its pid is gone.
  - A wrapper must not hold these locks itself and then call ue-run: it would wait on itself.
- **From Git Bash, prefix calls that pass `/Game/...` with `MSYS_NO_PATHCONV=1`.** Otherwise MSYS rewrites the path to `C:/Program Files/Git/Game/...`, and the game answers "map could not be found" and loads the default map.
- `--editor` runs on 5.8 sometimes crash (0xC0000005) after `LogExit: Exiting.`. ue-run accepts that case with a warning, because the script's saves are done by then.

**Blueprint graphs from Python (5.8).** `unreal.BlueprintGraphEditor` places and wires graph nodes headless, and the result runs.
- Get an editor:
  - `BlueprintGraphEditor.get_graph_editor(BlueprintEditorLibrary.find_event_graph(bp))`, or
  - `create_and_edit_function_graph(bp, name)`.
- Nodes:
  - `add_call_function_node('/Script/Engine.KismetSystemLibrary:PrintString')`;
  - `add_branch_node`, `add_custom_event_node`, `add_get/set_member_variable_node`;
  - `BlueprintEditorLibrary.add_event_override(bp, 'ReceiveBeginPlay', IntPoint)`;
  - `create_node_from_name('Utilities|FlowControl|Branch', ...)` for any palette action.
- Pins: `find_input_pin` / `find_output_pin` / `BlueprintEditorLibrary.find_execute_pin` / `find_then_pin` / `find_self_pin`, then `.try_create_connection(other)` and `.set_pin_value(text)`.
- Call nodes to the Blueprint's **own** functions and custom events (by bare name) work only after a `compile_blueprint`.
- 5.8 math operators (`Greater_IntInt`) spawn as promotable **Wildcard** pins, so `set_pin_value` fails until a typed pin is wired in. Feed literals from `MakeLiteralInt` or similar.
- `SubobjectDataSubsystem.rename_subobject_member_variable` returned False, yet the rename took effect. Verify by use.
- The class header is under `Private\`: pin the engine version for anything built on it.
- The Python stub (`Intermediate\PythonStub\unreal.py`, about 36 MB) comes from an `--editor` run with `--ue-arg "-ini:Engine:[/Script/PythonScriptPlugin.PythonScriptPluginSettings]:bDeveloperMode=True"`. It is written on a delayed tick, so keep the script alive until the file exists. No ini file is changed.

**Rules as a Blueprint from one AST (`tools/unreal/bpdsl.py`, proven on a 2900-node duel rules Blueprint).** Write the logic once as a small int/bool/string AST (`Program`, `Body` with `with b.if_(...)`, `for_`, `while_`, `call`), then run it two ways: `Interp` (plain Python, milliseconds, the oracle) and `Emitter` (headless UE 5.8: member variables incl. arrays, function graphs with inputs/outputs, locals, Branch, ForLoop, string and math nodes, then compile).
- Run the builder with plain `ue-run.mjs py` (commandlet, about 70 s, no shader compile). `--editor` sat behind shader compiles for 10 minutes. The commandlet crashes at Python teardown after the save: judge by a `BUILD_DONE` log marker, never `os._exit` (it hung the process).
- Test map without `--editor`: `EditorLoadingAndSavingUtils.new_blank_map` + `world.get_world_settings().set_editor_property('default_game_mode', cls)` + `save_map` works in the commandlet, and the GameMode BP can hold the test component (`SubobjectDataSubsystem.add_new_subobject` with a Blueprint class; a Blueprint can be the parent class of another). `ue-run game <map> --expect RULES_DONE` then runs it.
- Pure nodes re-evaluate at every consumer: a value read, written, then reused changes under you (a probe returned 13 instead of 10). The emitter builds each expression fresh per statement and function results go through locals.
- Blueprint names are case-insensitive: a parameter `act` collides with a member array `Act`. A Blueprint aborts one event after 1,000,000 loop iterations ("Runaway loop detected"): run long loops in slices per Tick.
- `add_graph_output_parameter` returns the K2Node_FunctionResult (pin `.find_input_pin(name)`), `add_graph_input_parameter` returns the entry data pin. A ForLoop macro body just ends (no back edge); a `while` is a Branch with its exec wired back.

- **Layering on a generated Blueprint.** A second bpdsl Program can build a *child* Blueprint of a generated one (for example a BP_DuelBrain that is a child of BP_DuelSim). Call `duel_rules.build()` to get the parent's Program, mark your own vars and functions with a new group, prefix their names (names are case-insensitive across the class), and emit only that group. Rebuild the child whenever the parent is rebuilt. Another class's variables: `ed.add_get_member_variable_node(name, '/Game/X/BP_Y.BP_Y_C')`, with its self pin wired from the component getter. Another class's functions: `add_call_function_node('/Game/X/BP_Y.BP_Y_C:Func')`. Both work headless.
- **Content-only on Android (no UATRules DLL).** UBT `NativeProjects.RequiresTempTarget` makes a Blueprint project "code-based" if any plugin that has Runtime modules and is not enabled by default is enabled for the Game target. It reports only the first such plugin, so fix one, rerun and read the next. One project needed two changes: drop `GameplayStateTree`, and give `MetaHumanCharacter` the setting `"TargetAllowList": ["Editor"]`. With both, UAT cook and stage from a worktree compiled no UATRules DLL, so Smart App Control had nothing to block.

**Phone loop:** `node tools/unreal/ue-device.mjs` (usage header, `selftest`).
- Subcommands: `devices`, `install`, `cmdline`, `launch --expect`, `pull`, `screencap`.
- `ship <uproject> [--map] [--config]` is one command: BuildCookRun → install → `UECommandLine.txt` → launch → wait in logcat for the map to load.
- With no ready device (none, unauthorized or offline), the device steps exit 3 and `ship` checks the map load in a desktop `game` run instead.
- The device paths need `bUseExternalFilesDir=True` (Android runtime settings): Development then reads `/sdcard/Android/data/<package>/files/UnrealGame/<Project>/UECommandLine.txt` (LaunchAndroid.cpp). Shipping ignores the file.

**World Partition.** `ue-run.mjs cmdlet <uproject> WorldPartitionConvertCommandlet -- /Game/Maps/X -AllowCommandletRendering [-DisableStreaming]` converts the map in place to one file per actor (`-ConversionSuffix` writes `X_WP` instead).
- A map rebuilt by `new_blank_map(False)` comes back non-partitioned, so convert again after any rebuild.
- `a project script run with `ue-run.mjs py ... --editor` proves the level sequences still bind.

**Backups:** `tools\backup-bundle.sh` adds `<repo>-...-lfs.tar` (`.git\lfs\objects`) next to the bundle and restore-checks every object and every HEAD file. A bundle alone carries only the LFS pointers.
- GNU tar reads `C:/...` as a remote host: `--force-local`.

1. **Android toolchain (5.8).**
   - Epic lists NDK r27c, build-tools 35.0.1, target SDK 35 (min 34) and JDK 21.
   - The engine itself pins these in `Engine\Config\Android\Android_SDK.json`: android-36, build-tools 36.0.0, cmake 3.22.1, ndk 27.2.12479018, plus Gradle 8.13 / AGP 8.13.
   - Do **not** run `SetupAndroid.bat`. It writes user env vars (ANDROID_HOME, JAVA_HOME, PATH, NDKROOT).
   - Instead, run its sdkmanager line yourself into `%LOCALAPPDATA%\Android\Sdk` with the portable cmdline-tools:
     ```
     JAVA_HOME=<toolchain>\jdk-17 <toolchain>\sdk\cmdline-tools\latest\bin\sdkmanager.bat --sdk_root=<sdk> "platforms;android-35" "platforms;android-36" "build-tools;35.0.1" "cmake;3.22.1" "ndk;27.2.12479018"
     ```
   - Android Studio's JBR is JDK 25, too new for Gradle 8.13. Use a JDK 17 of your own; AGP 8.13 needs 17+.
2. **Project without the New Project dialog.**
   - Copy `Templates\TP_ThirdPersonBP\Content` and `Config`.
   - Copy each `SharedContentPacks` entry from `TemplateDefs.ini`: `Templates\TemplateResources\<Detail>\<Mount>\Content` goes to `Content\<Mount>`, and `__ExternalActors__` goes to `Content\__ExternalActors__\<Mount>`.
   - The Combat variant (`Variant_Combat`) is Blueprint-only: melee combo, AI enemies with damage, touch UI, no C++ (no Visual Studio here). It has no block.
   - Write the `.uproject` by hand: `EngineAssociation` "5.8"; Python, EditorScriptingUtilities and MovieRenderPipeline as editor-only plugins.
   - Give MovieRenderPipeline `"PlatformAllowList": ["Win64"]` **and** put `+DirectoriesToNeverCook=(Path="/MovieRenderPipeline")` in DefaultGame.ini. Otherwise the Android cook fails on its editor widgets (`UI_MovieGraphImagePreview`).
   - If the launcher updates the Fab plugin, its new DLL can be blocked by Windows Application Control (error 4551), and the editor then exits at startup. The project does not need Fab, so set it to `"Enabled": false`.
   - `.gitignore`: Binaries, Intermediate, Saved, DerivedDataCache, Build/Android, *.jks.
   - Use repo-local git LFS (`git lfs install --local`) for uasset, umap, fbx, glb and png.
3. **Signing.** Set `DebugKeyStore`, `DebugKeyAlias`, `DebugKeyStorePassword` and `DebugKeyPassword` under `[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]`. Copy the keystore into `<project>\Build\Android` (gitignored), so Gradle never creates `~\.android\debug.keystore`.
4. **glTF/GLB from the web games.**
   - Interchange does not read meshopt or WebP. Run `gltf-transform dequantize` (decodes meshopt) and `gltf-transform png --formats "*"` first.
   - **Characters:** use `InterchangeManager.import_asset` with override pipelines. Pass a project copy of `/Interchange/Pipelines/DefaultGLTFAssetsPipeline` with `mesh_pipeline.combine_skeletal_meshes_behavior = BY_SKELETON`, **plus** `/Interchange/Pipelines/DefaultGLTFPipeline`, which builds the glTF materials.
     - A bare `InterchangeGenericAssetsPipeline()` imports untextured grey meshes.
     - The default stack splits a knight into one skeletal mesh per part.
     - A web-game glTF character and a Mixamo-rigged one can face opposite ways: check the shield side in a still and add 180 degrees where needed.
   - **Kit pieces with LOD nodes:** Blender joins each `<id>_LOD0`/`_LOD1` group into one mesh and exports FBX (a small Blender script of your own).
     - Import with `import_uniform_scale` 100, because Blender's metre FBX arrives 1/100 size.
     - Delete the destination folder first: a reimport over existing meshes keeps their old import options.
     - For legacy FbxImportUI options (normals, vertex colours), run `Interchange.FeatureFlags.Import.FBX false` first.
   - Coordinates: UE (X, Y, Z) = 100 x game (x, z, y), and game yaw theta becomes UE yaw -deg(theta).
5. **Levels.**
   - Create maps with `EditorLoadingAndSavingUtils.new_blank_map(False)` + `save_map(world, path)`. `LevelEditorSubsystem.new_level` fails silently headless ("doesn't have a filename").
   - Give each map its own Level Sequence: possessable bindings resolve only inside their own level.
6. **Stills.**
   - Use Movie Render Queue through `MoviePipelinePIEExecutor` in `--editor` mode, with one camera-cut section per matched view and `use_camera_cut_for_warm_up False` plus engine warm-up frames.
   - Exposure for like-for-like stills: `AEM_HISTOGRAM` with min = max = EV100 (noon 14, dusk 11.5). AEM_MANUAL + bias came out all white.
   - Side-by-side sheets: `tools\frames-sheet.mjs --cols 2`.
   - **Mobile-renderer stills** (what the phone draws): the editor refuses `-featureleveles31` ("Feature Level 5 video card is required").
     - Instead, set the preview platform before launch in `<project>\Saved\Config\WindowsEditor\EditorPerProjectUserSettings.ini`: `PreviewFeatureLevel=1`, `PreviewPlatformName=Android`, `PreviewShaderFormatName=SF_VULKAN_ES31_ANDROID`, `PreviewShaderPlatformName=VULKAN_ES3_1_ANDROID_Preview` (the `_Preview` suffix matters: without it the editor crashes, "not compatible with PCD3D_SM6"), `bPreviewShaderPlatformActive=True`, `PreviewDeviceProfileName=Android_Preview_Vulkan`.
     - Use `node tools\unreal\ue-mobile-preview.mjs <uproject> -- <ue-run args>`: it writes those keys (plus `bPreviewFeatureLevelWasDefault=False` and the `;METADATA=(Diff=true, UseCommands=true)` header, without which a fresh worktree's editor ignored the file and rendered SM6 with clouds) and restores the file afterwards. Proof in the log: `LoadEditorShaderPlatformPreview: VULKAN_ES3_1_ANDROID_Preview`.
     - Portrait stills: set each cine camera's `constrain_aspect_ratio` to False in memory before queueing (PIE copies the editor world); with the 16:9 filmback a portrait output is letterboxed.
     - Mobile lighting (5.8): one directional light per lighting channel (`MobileDirectionalLights[channel]`), so a second "fill" directional takes the sun's place. A movable real-time-capture sky light gave near-zero shade in the preview; a specified-cubemap sky light whose intensity follows the exposure lifted it.
     - These PNGs carry alpha 0: flatten with sharp `removeAlpha()` before making sheets.
7. **APK.** Two minutes 44 seconds warm on this machine; 213 MB Development.
   - From a git worktree (a new project path) UAT failed in 2 s: Application Control blocked the freshly compiled `%TEMP%\UAT\...\Rules\UATRules-<hash>.dll` (0x800711C7), while the main copy's DLL still loads. Build APKs in the main copy until that is solved.
   ```
   ue-run.mjs uat -- BuildCookRun -project=<uproject> "-unrealexe=<UE>/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" -platform=Android -cookflavor=ASTC -clientconfig=Development -build -cook -stage -pak -iostore -package -archive -archivedirectory=<dir> -nop4 -utf8output -unattended -nocompileeditor
   ```
   - `-unrealexe` is needed for a Blueprint-only project: without it, UAT looks for `Binaries\Win64\<Project>Editor.target`.
   - Verify with build-tools 35.0.1 `apksigner verify --print-certs` (JAVA_HOME = JDK 17) and `aapt2 dump badging`.
   - Lumen on Android (experimental) is a second APK built with `bSupportsVulkanSM5=True`. The engine's `Android_Adreno_Vulkan_SM5` device profile matches Adreno 7xx/8xx on Android 10+ when SM5 shaders are present.

## Secrets, remote and art store
- **Secrets.** Signing passwords and the Android File Server token live in `Config/UserEngine.ini`, which is gitignored. UBT reads it after DefaultEngine.ini (ConfigHierarchy.cs:1022).
  - A new worktree has no copy. Copy the file from the main working copy before building an APK there, and never commit it.
- **Remote.** Keep the remote for code and pointers only.
  - `remote.origin.lfsurl` can point LFS at a local bare store, so art never uploads to a public host.
  - Back art up through `backup-bundle.sh`.

## More lessons
- **FBX scale.** `Interchange.FeatureFlags.Import.FBX false` must run in the same session before every FBX import with `import_uniform_scale 100`; without it terrain and roads arrived 100x too large (extents 2.5 km for a 512 m tile). A commandlet FBX terrain import produced no assets: use `--editor`.
- **Git Bash mangles `/Game/...` arguments** (turned into `C:/Program Files/Git/Game/...`): set `MSYS_NO_PATHCONV=1` and then give node Windows-style script paths.
- **A killed ue-run leaves its locks.** A dead pid in `<lock>/owner.txt` with no UnrealEditor process running is a stale lock: remove it by hand.
- **Draped road ribbons.** Terrain tiles are coarse (4-16 m), so a vertex-colour road cannot show a 4 m road; build ribbon meshes (UV x across 0..1) and take Z from the tile's own bilinear grid plus 0.2 m.

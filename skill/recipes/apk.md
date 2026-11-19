# APK build

Toolchain: a portable Android toolchain folder that holds `env.ps1` (sets ANDROID_HOME and JAVA_HOME), `gradle-dist/` and `gradle-home/`. Point `ANDROID_TOOLCHAIN` (or `-Toolchain`) at it. Debug keystores live outside every repo.

0. Build from a clean worktree at the committed HEAD (`git worktree add --detach <path> HEAD`), so uncommitted work never ships. In it:
   - install dependencies from the lockfile (for example `corepack pnpm install --frozen-lockfile`);
   - run the TypeScript compiler as `node node_modules/typescript/bin/tsc`, since `npx tsc` can fetch an unrelated package;
   - pass `-ExecutionPolicy Bypass` to `apk-build.ps1`;
   - remove the worktree afterwards in the background, because `node_modules` can take minutes to delete.
1. Build the web client the APK serves (for example `node node_modules/vite/bin/vite.js build --config client/vite.config.ts`).
2. Bump `versionCode` and `versionName` in the module's `build.gradle`, so a phone installs it over the previous build. Commit the bump separately, naming the source commit.
3. Run `powershell -File tools/apk-build.ps1 -Project <android dir> -OutDir <archive dir> -Name <app>-debug`. It builds, finds this build's APK, reads the badging, demands `apksigner` "Verifies", archives it as `<Name>-<versionName>.apk` with `.badging.txt`, `.apksigner.txt` and `.sha256`, and prints one JSON line.
4. Done when the JSON shows the expected package, versionCode and versionName, `usesPermission` is the expected count, and the sha256 is recorded in your release notes.

If the app is a WebView shell that serves bundled assets from `https://appassets.androidplatform.net` with network loads blocked, every asset must be bundled.

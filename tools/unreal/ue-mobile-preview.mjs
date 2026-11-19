// Run ue-run.mjs with the editor's mobile preview (Android Vulkan ES3.1) switched on, so Movie Render Queue stills show what the phone renderer draws.
// usage: node ue-mobile-preview.mjs <project.uproject> -- <ue-run.mjs args...>      node ue-mobile-preview.mjs selftest
// Writes the preview keys into <project>/Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini, runs ue-run, then restores the file
// byte for byte (or deletes it if it did not exist), even when the run fails. The editor rewrites this file on exit, hence the restore.
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';

const SECTION = '[/Script/UnrealEd.EditorPerProjectUserSettings]';
const KEYS = { PreviewFeatureLevel: '1', PreviewPlatformName: 'Android', PreviewShaderFormatName: 'SF_VULKAN_ES31_ANDROID',
  PreviewShaderPlatformName: 'VULKAN_ES3_1_ANDROID_Preview', bPreviewShaderPlatformActive: 'True', PreviewDeviceProfileName: 'Android_Preview_Vulkan',
  PreviewShaderPlatformFriendlyName: 'Android Vulkan', bPreviewFeatureLevelWasDefault: 'False' };

/** Return ini text with KEYS set inside SECTION (section added if missing, existing keys replaced). */
export function withPreview(text) {
  const lines = text ? text.split(/\r?\n/) : [';METADATA=(Diff=true, UseCommands=true)'];
  let s = lines.findIndex(l => l.trim() === SECTION);
  if (s < 0) { lines.push(SECTION); s = lines.length - 1; }
  let e = lines.findIndex((l, i) => i > s && l.startsWith('['));
  if (e < 0) e = lines.length;
  const body = lines.slice(s + 1, e).filter(l => !(l.split('=')[0] in KEYS));
  const set = Object.entries(KEYS).map(([k, v]) => `${k}=${v}`);
  return [...lines.slice(0, s + 1), ...set, ...body, ...lines.slice(e)].join('\r\n');
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'selftest') {
    const t = withPreview('[A]\nx=1\n[/Script/UnrealEd.EditorPerProjectUserSettings]\nPreviewFeatureLevel=4\nfoo=2\n[B]\ny=3');
    assert.match(t, /PreviewFeatureLevel=1/); assert.doesNotMatch(t, /PreviewFeatureLevel=4/); assert.match(t, /foo=2/); assert.match(t, /\[B\]\r\ny=3/);
    assert.ok(withPreview('').startsWith(`;METADATA=(Diff=true, UseCommands=true)\r\n${SECTION}\r\nPreviewFeatureLevel=1`));
    console.log('ue-mobile-preview selftest ok'); process.exit(0);
  }
  const dd = argv.indexOf('--'); assert(dd === 1, 'usage: ue-mobile-preview.mjs <project.uproject> -- <ue-run args>');
  const ini = path.join(path.dirname(path.resolve(argv[0])), 'Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini');
  const had = fs.existsSync(ini), orig = had ? fs.readFileSync(ini) : null;
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  fs.writeFileSync(ini, withPreview(had ? orig.toString('utf8') : ''));
  let code = 1;
  try { code = spawnSync(process.execPath, [path.join(path.dirname(self), 'ue-run.mjs'), ...argv.slice(2)], { stdio: 'inherit' }).status ?? 1; }
  finally { if (had) fs.writeFileSync(ini, orig); else fs.rmSync(ini, { force: true }); }
  process.exit(code);
}

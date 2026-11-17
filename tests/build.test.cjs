const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('SDK QA exits promptly for missing, invalid, or incomplete manifests', t => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'streamdeck-invalid-'));
  t.after(() => fs.rmSync(plugin, {recursive: true, force: true}));
  fs.mkdirSync(path.join(plugin, 'bin'));
  fs.writeFileSync(path.join(plugin, 'bin', 'launcher.js'), '');
  for (const contents of [null, '{', '{}']) {
    if (contents !== null) fs.writeFileSync(path.join(plugin, 'manifest.json'), contents);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/sdk-qa.cjs'), plugin], {encoding: 'utf8', timeout: 2000});
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /manifest/i);
  }
});
test('source manifest release version matches package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(manifest.Version, `${pkg.version}.0`);
});

test('installer version follows releases and rejects ambiguous versions', async () => {
  const { pluginVersion, createPluginManifest } = await import('../scripts/plugin-manifest.mjs');
  assert.equal(pluginVersion('1.0.4'), '1.0.4.0');
  assert.equal(createPluginManifest({ Version: '1.0.0.0', Name: 'AI' }, { version: '1.2.3' }).Version, '1.2.3.0');
  for (const invalid of ['1.0', '1.0.4-beta.1', '01.0.4', '1.2.3.4', '65536.0.0', undefined]) {
    assert.throws(() => pluginVersion(invalid));
  }
});

test('SDK migration declares the supported host and runtime versions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(pkg.dependencies['@elgato/streamdeck'], '3.0.0');
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(manifest.Nodejs.Version, '24');
  assert.equal(manifest.Software.MinimumVersion, '7.1');
  assert.equal(manifest.OS.find(os => os.Platform === 'mac').MinimumVersion, '13.5');
  assert.equal(manifest.OS.find(os => os.Platform === 'windows').MinimumVersion, '10');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
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

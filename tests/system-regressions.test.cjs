const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadTS } = require('./helpers.cjs');

function setup(platform, outputs) {
  const calls = [];
  const child = { spawn(command, args) {
    const result = outputs.shift();
    if (!result) throw Error('unexpected process');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stdin = new EventEmitter();
    proc.stdin.end = value => { calls.push({ command, args, input: value }); queueMicrotask(() => {
      if (result.stdinError) proc.stdin.emit('error', Error('failed'));
      else if (result.error) proc.emit('error', Error('failed'));
      else { if (result.text) proc.stdout.emit('data', result.text); proc.emit('close', result.code ?? 0); }
    }); };
    proc.kill = () => {};
    return proc;
  }};
  const system = loadTS('src/system-utils.ts', {child_process:child}, '', {process:{platform, env:{}}});
  return {system, calls};
}
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: selection requires a changed and stable revision`, async () => {
    const { system } = setup(platform, [{text:'5'}, {}, {text:'6'}, {text:'same $ 😀\n'}, {text:'6'}]);
    assert.equal(await system.captureSelectedText(), 'same $ 😀\n');
    const unstable = setup(platform, [{text:'5'}, {}, {text:'6'}, {text:'text'}, {text:'7'}]);
    await assert.rejects(unstable.system.captureSelectedText(), /changed during capture/);
    const unchanged = setup(platform, [{text:'5'}, {}, ...Array.from({length:10}, () => ({text:'5'}))]);
    await assert.rejects(unchanged.system.captureSelectedText(), /did not update/);
    const empty = setup(platform, [{text:'5'}, {}, {text:'6'}, {}, {text:'6'}]);
    await assert.rejects(empty.system.captureSelectedText(), /No text/);
    const bad = setup(platform, [{text:'bad'}]);
    await assert.rejects(bad.system.captureSelectedText(), /revision/);
  });
  test(`${platform}: clipboard writes use exact stdin and surface process errors`, async () => {
    const text = 'Привет 😀 $ `\r\n \n';
    const {system,calls} = setup(platform, [{}]);
    await system.copyToClipboard(text);
    assert.equal(calls[0].input, text);
    if (platform === 'win32') assert.equal(calls[0].command, 'C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    await assert.rejects(setup(platform, [{stdinError:true}]).system.copyToClipboard(text), /failed/);
    await assert.rejects(setup(platform, [{code:1}]).system.pasteFromClipboard(), /failed/);
  });
}
test('Windows clipboard read preserves trailing whitespace', async () => {
  const text = 'Привет 😀\r\n  \n';
  const {system,calls} = setup('win32', [{text}]);
  assert.equal(await system.pasteFromClipboard(), text);
  assert.match(calls[0].args.at(-1), /Get-Clipboard -Raw/);
  assert.match(calls[0].args.at(-1), /Console\]::Write/);
});

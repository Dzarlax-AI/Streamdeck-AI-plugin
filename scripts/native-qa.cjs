const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { loadTS } = require('../tests/helpers.cjs');

const sample = 'Stream Deck QA — Привет 😀 $&';
const system = loadTS('src/system-utils.ts', { child_process: childProcess }, '\nexport { clipboardRevision };');

(async () => {
  assert.ok(['darwin', 'win32'].includes(process.platform), 'Run native QA on macOS or Windows');
  await system.clipboardRevision();
  console.log(`PASS ${process.platform}: native clipboard revision is readable`);
  if (!process.argv.includes('--selection')) {
    console.log('Clipboard contents were not read or changed.');
    console.log('To check Copy, put the documented sample in an isolated editor, select it, then run npm run qa:native -- --selection.');
    return;
  }
  console.log(`Select this exact sample in an isolated editor: ${sample}`);
  console.log('Focus the editor now; Copy will run in 5 seconds. No text is sent to an API.');
  await new Promise(resolve => setTimeout(resolve, 5000));
  const captured = await system.captureSelectedText();
  assert.equal(captured, sample, 'Captured selection does not match the isolated QA sample');
  console.log(`PASS ${process.platform}: native selection Copy preserves Unicode and literal dollar sequences`);
})().catch(error => {
  // Do not print assertion actual/expected fields: the clipboard can contain private text.
  console.error(`FAIL ${process.platform}: ${error.message?.split('\n')[0] || 'Native check failed'}`);
  process.exitCode = 1;
});

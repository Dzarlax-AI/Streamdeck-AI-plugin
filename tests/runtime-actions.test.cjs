const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTS } = require('./helpers.cjs');

function setup(options = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let captures = 0, calls = [], writes = [], replies = [], probes = [];
  const sdk = { logger: { info() {} }, settings: { getGlobalSettings: async () => ({apiKey:'secret',provider:'openai',model:'m'}) }, ui: { action: {id:'a'}, sendToPropertyInspector: async payload => replies.push(payload) } };
  const mod = loadTS('src/plugin.ts', {
    '@elgato/streamdeck': {__esModule:true,default:sdk,action:()=>value=>value,SingletonAction:class {}},
    './api-client.js': {
      callAI: async (_s,u) => { calls.push(u); await gate; return {text:'result'}; },
      testConnection: async () => ({success:true,message:'ok'}),
      listModels: async () => ({models:[{id:'m',name:'m',temperatureSupport:'unknown'}],truncated:false}),
      testGeneration: async config => { probes.push(config); if (options.probeFailure) throw Error('secret response'); await gate; return {success:true,status:'verified',message:'visible text'}; }
    },
    './system-utils.js': { captureSelectedText: async () => {captures++; if (options.fail && captures === 1) throw Error('capture failed'); return 'value $& $1 😀';}, pasteFromClipboard: async ()=>'clip', copyToClipboard: async t=>writes.push(t), simulatePaste: async()=>{} }
  });
  const action = id => ({id,isKey:()=>true,isDial:()=>true,setState:async()=>{},setFeedback:async()=>{},showAlert:async()=>{},setFeedbackLayout:async()=>{}});
  return {mod,action,sdk,release,get captures(){return captures},calls,writes,replies,probes};
}
test('global guard prevents overlapping button and dial capture; template preserves replacement text', async () => {
  const t = setup();
  const button = new t.mod.AITextAction(), dial = new t.mod.PromptSelectorAction();
  const a = t.action('a'), b = t.action('b');
  const pending = button.onKeyDown({action:a,payload:{settings:{userPromptTemplate:'{{text}} / {{text}}',postAction:'copy'}}});
  await new Promise(resolve => setImmediate(resolve));
  await button.onKeyDown({action:a,payload:{settings:{}}});
  await dial.onDialDown({action:b,payload:{settings:{}}});
  assert.equal(t.captures,1);
  assert.deepEqual(t.calls,['value $& $1 😀 / value $& $1 😀']);
  t.release(); await pending;
  assert.deepEqual(t.writes,['result']);
  await dial.onTouchTap({action:b,payload:{settings:{}}});
  assert.equal(t.captures,2);
});

test('both inspectors route catalogs and generation without touching the clipboard', async () => {
  const t = setup(); t.release();
  for (const instance of [new t.mod.AITextAction(), new t.mod.PromptSelectorAction()]) {
    for (const event of ['fetchModels','testGeneration']) await instance.onSendToPlugin({action:t.action('a'),payload:{event,requestId:event,apiKey:'untrusted'}});
  }
  assert.deepEqual(t.replies.map(r=>r.event),['modelsResult','generationTestResult','modelsResult','generationTestResult']);
  assert.equal(t.replies[0].models[0].id,'m');
  assert.equal(t.replies[1].status,'verified');
  assert.equal(t.probes[0].apiKey,'secret');
  assert.equal(t.captures,0); assert.equal(t.writes.length,0);
  assert.ok(!JSON.stringify(t.replies).includes('secret'));
});

test('generation probe shares busy guard, releases on error, and ignores stale inspector', async () => {
  const t = setup(); const instance = new t.mod.AITextAction(), action = t.action('a');
  const pending = instance.onSendToPlugin({action,payload:{event:'testGeneration',requestId:'first'}});
  await new Promise(resolve=>setImmediate(resolve));
  await instance.onKeyDown({action,payload:{settings:{}}});
  await instance.onSendToPlugin({action,payload:{event:'testGeneration',requestId:'second'}});
  assert.equal(t.captures,0); assert.equal(t.probes.length,1);
  assert.equal(t.replies[0].status,'error');
  t.sdk.ui.action = {id:'other'};
  t.release(); await pending;
  assert.equal(t.replies.length,1);
  const failure = setup({probeFailure:true});
  await new failure.mod.AITextAction().onSendToPlugin({action:failure.action('a'),payload:{event:'testGeneration',requestId:'failure'}});
  assert.ok(!JSON.stringify(failure.replies).includes('secret'));
  failure.release();
  await new failure.mod.AITextAction().onKeyDown({action:failure.action('a'),payload:{settings:{postAction:'copy'}}});
  assert.equal(failure.captures,1);
});


test('guard releases after failure and both actions respond to connection probes', async () => {
  const t = setup({fail:true});
  const button = new t.mod.AITextAction(), dial = new t.mod.PromptSelectorAction();
  const a = t.action('a');
  await button.onKeyDown({action:a,payload:{settings:{}}});
  t.release();
  await dial.onDialDown({action:a,payload:{settings:{}}});
  assert.equal(t.captures,2);
  for (const instance of [button,dial]) await instance.onSendToPlugin({action:a,payload:{event:'testConnection',requestId:'id'}});
  assert.equal(t.replies.length,2);
  assert.equal(t.replies[0].event,'connectionTestResult');
  assert.equal(t.replies[0].requestId,'id');
});

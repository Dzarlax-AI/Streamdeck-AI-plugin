const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const pluginPath = process.argv[2] && path.resolve(process.argv[2]);
if (!pluginPath || !fs.existsSync(path.join(pluginPath, 'bin/launcher.js'))) {
  console.error('Usage: node scripts/sdk-qa.cjs /path/to/disposable/built.sdPlugin');
  process.exit(2);
}

(async () => {
  const manifest = readManifest();
  let generations = 0;
  const api = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer dummy-key');
    let data;
    if (request.method === 'GET') {
      assert.equal(request.url, '/v1/models');
      data = {data:[{id:'qa-model'}]};
    } else {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.model, 'qa-model');
      assert.equal(body.max_tokens, 128);
      assert.deepEqual(body.messages, [{role:'system',content:'You are a helpful assistant.'},{role:'user',content:'Reply with OK.'}]);
      generations++;
      data = {choices:[{message:{content:'O'},finish_reason:'length'}]};
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const info = {
    application: { version: '7.4.2', platform: process.platform === 'win32' ? 'windows' : 'mac', platformVersion: '13.5', language: 'en' },
    plugin: { uuid: manifest.UUID, version: manifest.Version },
    devices: [{ id: 'qa-device', name: 'QA', type: 7, size: {columns: 4, rows: 2} }], colors: {}, devicePixelRatio: 1
  };
  let child;
  const replies = [];
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error('SDK integration timed out')), 12000);
  const commands = ['testConnection', 'fetchModels', 'testGeneration'];
  let commandIndex = 0, currentKind = 'text-action';
  const sendCommand = socket => {
    const context = `qa-${currentKind}`;
    socket.send(JSON.stringify({event:'sendToPlugin',action:`com.dzarlax.ai-assistant.${currentKind}`,context,device:'qa-device',payload:{event:commands[commandIndex],requestId:`${context}-${commandIndex}`}}));
  };
  const nextAction = (socket, kind) => {
    currentKind = kind; commandIndex = 0;
    const action = `com.dzarlax.ai-assistant.${kind}`;
    const context = `qa-${kind}`;
    socket.send(JSON.stringify({ event: 'willAppear', action, context, device: 'qa-device', payload: {controller: kind === 'text-action' ? 'Keypad' : 'Encoder', settings: {}, coordinates: {column: 0, row: 0}, state: 0} }));
    socket.send(JSON.stringify({ event: 'propertyInspectorDidAppear', action, context, device: 'qa-device' }));
    sendCommand(socket);
  };
  wss.on('connection', socket => {
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes);
        if (message.event === 'registerPlugin') {
          assert.equal(message.uuid, 'com.dzarlax.ai-assistant');
          nextAction(socket, 'text-action');
        } else if (message.event === 'getGlobalSettings') {
          socket.send(JSON.stringify({ event: 'didReceiveGlobalSettings', id: message.id, payload: {settings: {provider: 'custom', apiKey: 'dummy-key', model: 'qa-model', baseUrl: `http://127.0.0.1:${api.address().port}/v1`, timeout: 5}} }));
        } else if (message.event === 'sendToPropertyInspector') {
          assert.equal(message.payload.event, ['connectionTestResult','modelsResult','generationTestResult'][commandIndex]);
          assert.equal(message.payload.success, true);
          assert.equal(message.payload.requestId, `${message.context}-${commandIndex}`);
          if (commandIndex === 0) assert.match(message.payload.message, /Generation was not tested/);
          if (commandIndex === 1) assert.equal(message.payload.models[0].id,'qa-model');
          if (commandIndex === 2) assert.equal(message.payload.status,'verified');
          assert.ok(!JSON.stringify(message.payload).includes('dummy-key'));
          replies.push(message.payload.requestId);
          commandIndex++;
          if (commandIndex < commands.length) sendCommand(socket);
          else if (currentKind === 'text-action') nextAction(socket, 'prompt-selector');
          else finish();
        }
      } catch (error) { fail(error); }
    });
  });
  try {
    child = spawn(process.execPath, ['bin/launcher.js', '-port', String(wss.address().port), '-pluginUUID', 'com.dzarlax.ai-assistant', '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)], { cwd: pluginPath, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    child.on('error', fail);
    child.on('exit', code => { if (replies.length !== 6) fail(new Error(`Plugin exited before SDK checks completed (${code}); ${logs.slice(-800)}`)); });
    await completed;
    assert.equal(replies.length,6);
    assert.equal(generations,2);
    console.log('PASS: SDK 3 startup and correlated access, catalog and minimal generation replies for button and encoder');
    console.log('All requests used a loopback API fixture. No clipboard or physical Stream Deck was used.');
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => api.close(resolve));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pluginPath, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read plugin manifest: ${error.message}`);
  }
  if (typeof manifest?.UUID !== 'string' || !manifest.UUID.trim() ||
      typeof manifest?.Version !== 'string' || !manifest.Version.trim()) {
    throw new Error('Plugin manifest must specify UUID and Version');
  }
  return manifest;
}

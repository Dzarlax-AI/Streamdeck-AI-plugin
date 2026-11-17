const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function element(value = '') {
  return {
    value, textContent: '', disabled: false, style: {}, children: [], listeners: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    appendChild(child) { this.children.push(child); if (!this.value) this.value = child.value; },
    set innerHTML(_value) { this.children = []; this.value = ''; },
    get innerHTML() { return ''; },
    querySelector() { return element(); },
    setAttribute() {},
    setCustomValidity() {}, reportValidity() {},
    previousElementSibling: { classList: { toggle() {} } }
  };
}
function harness(file, fetchImpl) {
  const ids = ['provider','apiKey','baseUrl','modelSelect','modelSelectRow','customModelGroup','customModelInput','temperature','temperatureValue','maxTokens','timeout','fetchStatus','fetchModelsBtn','actionName','systemPrompt','userPromptTemplate','inputMode','postAction','modelSelectRow','testConnection','connectionDot','connectionText','presetList','presetSelector','loadPresetBtn','resetPresetsBtn','baseUrlGroup'];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  elements.provider.value = 'openai'; elements.apiKey.value = 'key'; elements.modelSelect.value = 'old-model'; elements.maxTokens.value = '4096'; elements.timeout.value = '30'; elements.temperature.value = '0.7';
  let domReady;
  const document = { getElementById: id => elements[id] || (elements[id] = element()), createElement: () => element(), addEventListener(name, listener) { if (name === 'DOMContentLoaded') domReady = listener; }, querySelectorAll: () => [] };
  const sent = [];
  const context = { document, fetch: fetchImpl, console, setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout, WebSocket: function() {}, URL, Promise, AbortController, sent };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('property-inspector/js/shared-settings.js', 'utf8'), context, { filename: 'property-inspector/js/shared-settings.js' });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  vm.runInContext(`globalSettings.provider = 'openai'; globalSettings.apiKey = 'key'; globalSettings.model = 'old-model'; websocket = { send: message => sent.push(JSON.parse(message)) }; uuid = 'test-context';`, context);
  return { context, elements, sent, ready: () => domReady?.() };
}

function modelReply(h, requestId, models = [{id:'gpt-new-model',name:'New model',temperatureSupport:'unknown'}]) {
  h.context.handleModelsResult({event:'modelsResult',requestId,success:true,models,truncated:false});
}
function beginFetch(h) {
  h.context.fetchModels();
  return h.sent.findLast(message => message.event === 'sendToPlugin' && message.payload.event === 'fetchModels').payload.requestId;
}

test('fetch saves first and preserves displayed manual model with credential-free Node command', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file, () => { throw Error('browser network must not be used'); });
    const id = beginFetch(h);
    assert.equal(h.sent[0].event,'setGlobalSettings');
    assert.deepEqual(Object.keys(h.sent[1].payload).sort(),['event','requestId']);
    modelReply(h,id);
    const saved = h.sent.findLast(message=>message.event==='setGlobalSettings');
    assert.equal(saved.payload.model,h.context.getSelectedModel());
    assert.equal(saved.payload.model,'old-model');
    assert.equal(h.elements.fetchModelsBtn.disabled,false);
  }
});

test('both inspectors preserve temperature zero', () => {
  for (const [file, update] of [['property-inspector/js/property-inspector.js', 'updateGlobalUI'], ['global-settings/js/global-settings.js', 'updateUI']]) {
    const h = harness(file, async () => {});
    vm.runInContext('globalSettings.temperature = 0', h.context);
    h.context[update]();
    assert.equal(h.elements.temperature.value, 0);
  }
});


test('custom model endpoints support an API root, a chat completion path, and a proxy query', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file, async () => {});
    assert.equal(h.context.AISettings.getModelsEndpoint('custom', 'https://example.test/v1/').url, 'https://example.test/v1/models');
    assert.equal(h.context.AISettings.getModelsEndpoint('custom', 'https://example.test/proxy/v1?tenant=alpha').url, 'https://example.test/proxy/v1/models?tenant=alpha');
    assert.equal(h.context.AISettings.getModelsEndpoint('custom', 'https://example.test/proxy/v1/Chat/Completions/?tenant=alpha#unused').url, 'https://example.test/proxy/v1/models?tenant=alpha');
    assert.equal(h.context.AISettings.getModelsEndpoint('custom', 'https://example.test/proxy/generate?tenant=alpha').url, 'https://example.test/proxy/models?tenant=alpha');
    assert.throws(() => h.context.AISettings.getModelsEndpoint('custom', 'file:///tmp/api'), /HTTP or HTTPS/);
    assert.throws(() => h.context.AISettings.getModelsEndpoint('custom', 'https://user:pass@example.test/v1'), /username or password/);
  }
});

test('model-list responses are ignored after provider changes in flight', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file);
    const id = beginFetch(h);
    const before = h.sent.filter(message=>message.event==='setGlobalSettings').length;
    h.elements.provider.value = 'custom';
    modelReply(h,id,[{id:'gpt-stale',name:'Stale',temperatureSupport:'unknown'}]);
    assert.equal(h.sent.filter(message=>message.event==='setGlobalSettings').length,before);
    assert.match(h.elements.fetchStatus.textContent,/settings changed/);
  }
});

test('invalidating fetch re-enables button and old response cannot clear newer request', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file); h.ready();
    const first = beginFetch(h);
    h.elements.provider.value = 'custom'; h.elements.baseUrl.value = 'https://proxy.example/v1';
    h.elements.provider.listeners.change();
    assert.equal(h.elements.fetchModelsBtn.disabled,false);
    const second = beginFetch(h);
    modelReply(h,first);
    assert.equal(h.elements.fetchModelsBtn.disabled,true);
    modelReply(h,second);
    assert.equal(h.elements.fetchModelsBtn.disabled,false);
    assert.equal(h.elements.fetchModelsBtn.textContent,'Fetch');
  }
});

test('API key and Custom URL changes invalidate pending model results', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    for (const inputId of ['apiKey','baseUrl']) {
      const h = harness(file); h.ready();
      if (inputId === 'baseUrl') {
        h.elements.provider.value = 'custom'; h.elements.baseUrl.value = 'https://proxy.example/v1';
        h.elements.provider.listeners.change();
      }
      const id = beginFetch(h);
      h.elements[inputId].value = inputId === 'apiKey' ? 'changed-key' : 'https://proxy.example/other/v1';
      h.elements[inputId].listeners.input();
      assert.equal(h.elements.fetchModelsBtn.disabled,false);
      modelReply(h,id);
      assert.equal(h.elements.fetchModelsBtn.textContent,'Fetch');
    }
  }
});

test('global provider changes reuse that provider’s fetched model cache', () => {
  const h = harness('global-settings/js/global-settings.js', async () => {});
  vm.runInContext("globalSettings.provider = 'anthropic'; globalSettings.model = 'claude-current'; globalSettings.modelCache = { openai: [{id:'openai-cached-only', name:'Cached OpenAI model'}] }", h.context);
  h.elements.provider.value = 'anthropic';
  h.ready();
  h.elements.provider.value = 'openai';
  h.elements.provider.listeners.change();
  assert.ok(h.elements.modelSelect.children.some(option => option.value === 'openai-cached-only'));
});

test('Gemini with no model cache never offers OpenAI fallback IDs', () => {
  const h = harness('global-settings/js/global-settings.js', async () => {});
  vm.runInContext("globalSettings.provider = 'gemini'; globalSettings.model = 'gemini-current'; globalSettings.modelCache = {}", h.context);
  h.context.updateUI();
  assert.equal(h.elements.modelSelect.children.some(option => /^gpt-|^o[1-4]/.test(option.value)), false);
});

test('model parser drops malformed IDs and falls back to a valid ID for display names', () => {
  const h = harness('property-inspector/js/property-inspector.js', async () => {});
  for (const provider of ['openrouter', 'custom']) {
    const models = h.context.AISettings.parseModelsResponse(provider, { data: [{}, { id: null }, { id: '  ' }, { id: '', name: 'misleading label' }, { id: 'valid-model', name: 5 }, { id: 'other-model', name: '  ' }] });
    assert.deepEqual(JSON.parse(JSON.stringify(models)), [
      { id: 'other-model', name: 'other-model' },
      { id: 'valid-model', name: 'valid-model' }
    ]);
  }
  const anthropic = h.context.AISettings.parseModelsResponse('anthropic', { data: [{ id: '', display_name: 'Bad ID' }, { id: 'claude-valid', display_name: 5 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(anthropic)), [{ id: 'claude-valid', name: 'claude-valid' }]);
});

test('Custom Fetch preserves a manually entered model when it is absent from the list', async () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file, async () => ({ ok: true, json: async () => ({ data: [{ id: 'server-model' }] }) }));
    h.elements.provider.value = 'custom';
    h.elements.baseUrl.value = 'https://proxy.example/v1';
    h.elements.customModelInput.value = 'my-local-model';
    vm.runInContext("globalSettings.provider = 'custom'; globalSettings.baseUrl = 'https://proxy.example/v1'; globalSettings.model = 'my-local-model'", h.context);
    h.ready();
    h.elements.customModelInput.value = 'my-local-model';
    modelReply(h,beginFetch(h),[{id:'server-model',name:'Server',temperatureSupport:'unknown'}]);
    assert.equal(h.sent.at(-1).payload.model, 'my-local-model', file);
    assert.equal(h.elements.customModelInput.value, 'my-local-model', file);
  }
});

test('encoder preset order can move with accessible keyboard controls and is persisted', () => {
  const h = harness('property-inspector/js/property-inspector.js', async () => {});
  h.context.moveEncoderPreset(1, -1);
  assert.equal(h.sent.at(-1).payload.encoderPresets[0].key, 'translate-en');
  assert.equal(h.sent.at(-1).payload.encoderPresets[1].key, 'fix-grammar');
});


test('a completed connection test cannot be overwritten by its old timeout', () => {
  for (const [file, statusId] of [['property-inspector/js/property-inspector.js', 'connectionStatus'], ['global-settings/js/global-settings.js', 'connectionText']]) {
    let timeoutCallback;
    const h = harness(file, async () => {});
    h.context.setTimeout = callback => { timeoutCallback = callback; return 42; };
    h.context.clearTimeout = () => {};
    h.context.testConnection();
    const requestId = h.sent.at(-1).payload.requestId;
    h.context.completeConnectionTest(requestId, true, 'Connected');
    assert.equal(h.elements[statusId].textContent, 'Connected');
    timeoutCallback();
    assert.equal(h.elements[statusId].textContent, 'Connected');
  }
});


test('connection tests save first, send no selected text, and ignore results after settings change', () => {
  for (const [file, statusId] of [['property-inspector/js/property-inspector.js', 'connectionStatus'], ['global-settings/js/global-settings.js', 'connectionText']]) {
    const h = harness(file, async () => {});
    h.context.testConnection();
    assert.equal(h.sent[0].event, 'setGlobalSettings');
    assert.equal(h.sent[1].event, 'sendToPlugin');
    assert.equal(h.sent[1].payload.event, 'testConnection');
    assert.equal(h.sent[1].payload.text, undefined);
    h.elements.provider.value = 'custom';
    h.context.completeConnectionTest(h.sent[1].payload.requestId, true, 'Connected');
    assert.match(h.elements[statusId].textContent, /Settings changed/);
  }
});

test('reset restores all encoder presets after one was disabled', () => {
  const h = harness('property-inspector/js/property-inspector.js', async () => {});
  vm.runInContext("encoderSettings.encoderPresets[0].enabled = false; resetEncoderPresets()", h.context);
  const enabled = vm.runInContext('encoderSettings.encoderPresets.map(preset => preset.enabled)', h.context);
  assert.equal(enabled.length, 9);
  assert.ok(enabled.every(Boolean));
});

test('built-in provider saves never forward the hidden custom endpoint', () => {
  for (const [file, saveFn] of [['property-inspector/js/property-inspector.js', 'saveGlobalSettings'], ['global-settings/js/global-settings.js', 'saveSettings']]) {
    const h = harness(file, async () => {});
    h.elements.baseUrl.value = 'https://proxy.example/v1';
    vm.runInContext(`${saveFn}()`, h.context);
    assert.equal(h.sent.at(-1).payload.baseUrl, '');
  }
});

test('generation is explicit, uses credential-free command, and handles verified/inconclusive/stale responses', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file); h.ready();
    assert.equal(h.sent.some(message=>message.payload?.event==='testGeneration'),false);
    h.context.testGeneration();
    const command = h.sent.at(-1);
    assert.equal(command.payload.event,'testGeneration');
    assert.deepEqual(Object.keys(command.payload).sort(),['event','requestId']);
    assert.equal(h.elements.testGeneration.disabled,true);
    h.context.handleGenerationTestResult({requestId:command.payload.requestId,status:'inconclusive',success:false,message:'No visible text; unverified'});
    assert.match(h.elements.generationStatus.textContent,/unverified/);
    assert.equal(h.elements.testGeneration.disabled,false);
    h.context.testGeneration();
    const second = h.sent.at(-1).payload.requestId;
    h.context.handleGenerationTestResult({requestId:second,status:'verified',success:true,message:'Generation returned visible text',usedParameters:{maxTokens:1,temperatureIncluded:true}});
    assert.match(h.elements.generationStatus.textContent,/visible text/);
    h.context.testGeneration();
    const third = h.sent.at(-1).payload.requestId;
    h.elements.temperature.value='0.2';
    h.context.handleGenerationTestResult({requestId:third,status:'verified',success:true,message:'stale success'});
    assert.ok(!h.elements.generationStatus.textContent.includes('stale success'));
  }
});

test('capabilities disable unsupported temperature and expose output limit without rewriting saved values', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file); h.ready();
    modelReply(h,beginFetch(h),[{id:'old-model',name:'Current',temperatureSupport:'unsupported',outputTokenLimit:2048}]);
    assert.equal(h.elements.temperature.disabled,true);
    assert.equal(h.elements.maxTokens.value,4096);
    assert.equal(h.elements.maxTokens.dataset.modelLimit,'2048');
  }
});


test('completed generation status and model capabilities are invalidated after connection changes', () => {
  for (const file of ['property-inspector/js/property-inspector.js', 'global-settings/js/global-settings.js']) {
    const h = harness(file); h.ready();
    h.context.testGeneration();
    const requestId = h.sent.at(-1).payload.requestId;
    h.context.handleGenerationTestResult({requestId,success:true,status:'verified',message:'Verified',capabilities:{id:'old-model',temperatureSupport:'unsupported'}});
    assert.equal(h.elements.temperature.disabled,true);
    h.elements.temperature.value='0.2'; h.elements.temperature.listeners.input();
    assert.match(h.elements.generationStatus.textContent,/Settings changed/);
    h.elements.apiKey.value='new-key'; h.elements.apiKey.listeners.input();
    assert.equal(h.elements.temperature.disabled,false);
  }
});

for (const [file, connectionStatus] of [
  ['property-inspector/js/property-inspector.js', 'connectionStatus'],
  ['global-settings/js/global-settings.js', 'connectionText']
]) {
  test(`${file}: changing providers clears the previous model ID`, () => {
    const h = harness(file); h.ready();
    h.elements.provider.value = 'anthropic';
    h.elements.provider.listeners.change();
    assert.equal(h.context.getSelectedModel(), '');
    assert.equal(h.sent.at(-1).payload.model, '');
    h.context.testGeneration();
    assert.match(h.elements.generationStatus.textContent, /select a model/i);
    assert.equal(h.sent.some(message => message.payload.event === 'testGeneration'), false);
  });

  test(`${file}: probing one model does not restore another model's stale limits`, () => {
    const h = harness(file); h.ready();
    modelReply(h, beginFetch(h), [
      {id: 'old-model', name: 'Current', temperatureSupport: 'unsupported', outputTokenLimit: 5000},
      {id: 'other', name: 'Other', temperatureSupport: 'supported'}
    ]);
    h.elements.apiKey.value = 'new-key';
    h.elements.apiKey.listeners.input();
    h.elements.modelSelect.value = 'other';
    h.elements.modelSelect.listeners.change();
    h.context.testGeneration();
    h.context.handleGenerationTestResult({
      requestId: h.sent.at(-1).payload.requestId, success: true, status: 'verified',
      capabilities: {id: 'other', temperatureSupport: 'unsupported'}
    });
    assert.equal(h.elements.temperature.disabled, true);
    h.elements.modelSelect.value = 'old-model';
    h.elements.modelSelect.listeners.change();
    assert.equal(h.elements.temperature.disabled, false);
    assert.equal(h.elements.maxTokens.dataset.modelLimit, '');
  });

  test(`${file}: failed saves open advanced settings and explain why requests stopped`, () => {
    const h = harness(file); h.ready();
    h.elements.maxTokens.reportValidity = () => assert.equal(h.elements.advancedDetails.open, true);
    const requestId = beginFetch(h);
    modelReply(h, requestId, [{id: 'old-model', name: 'Current', outputTokenLimit: 2048}]);
    assert.equal(h.elements.advancedDetails.open, true);
    assert.match(h.elements.fetchStatus.textContent, /settings.*not saved/i);
    assert.equal(h.sent.filter(message => message.event === 'setGlobalSettings').length, 1);
    h.elements.advancedDetails.open = false;
    h.elements.modelSelect.listeners.change();
    assert.equal(h.elements.advancedDetails.open, true);
    assert.match(h.elements.settingsSaveStatus.textContent, /not saved/i);
    h.context.fetchModels();
    assert.match(h.elements.fetchStatus.textContent, /fix the highlighted settings/i);
    h.context.testConnection();
    assert.match(h.elements[connectionStatus].textContent, /fix the highlighted settings/i);
    assert.equal(h.sent.filter(message => message.event === 'sendToPlugin').length, 1);
    h.elements.maxTokens.value = '2000';
    h.elements.maxTokens.listeners.change();
    assert.equal(h.elements.settingsSaveStatus.textContent, '');
    assert.equal(h.sent.at(-1).payload.maxTokens, 2000);
  });
}

/**
 * Global Settings for AI Plugin
 */

let globalSettings = {
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4.1',
  temperature: 0.7,
  maxTokens: 4096,
  timeout: 30
};

let websocket = null;
let uuid = null;
let modelFetchVersion = 0;
let modelsRequestId = null;
let modelsRequestTimeoutId = null;
let modelsRequestSignature = null;
let modelsRequestVersion = null;
let actionUUID = 'com.dzarlax.ai-assistant.text-action';
let connectionRequestId = null;
let connectionTimeoutId = null;
let connectionTestSignature = null;
let generationRequestId = null;
let generationTimeoutId = null;
let generationTestSignature = null;
let providerConnectionRevision = 0;
let modelCacheRevisionByProvider = {};
let receivedGlobalSettings = false;

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  uuid = inUUID;
  try { actionUUID = JSON.parse(inActionInfo).action || actionUUID; } catch (_) {}
  websocket = new WebSocket('ws://localhost:' + inPort);

  websocket.onopen = () => {
    websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: uuid }));
    websocket.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
  };

  websocket.onmessage = (evt) => {
    const jsonObj = JSON.parse(evt.data);
    if (jsonObj.event === 'didReceiveGlobalSettings') {
      const s = jsonObj.payload.settings;
      if (s && Object.keys(s).length > 0) {
        const initial = !receivedGlobalSettings;
        receivedGlobalSettings = true;
        if (['provider', 'apiKey', 'baseUrl'].some(key => s[key] !== undefined && s[key] !== globalSettings[key])) providerConnectionRevision++;
        globalSettings = { ...globalSettings, ...s };
        updateUI(initial);
        if (generationTestSignature && generationTestSignature !== currentGenerationSignature()) invalidateGenerationTest();
      }
    }
    if (jsonObj.event === 'sendToPropertyInspector' && jsonObj.payload?.event === 'connectionTestResult' && jsonObj.payload.requestId === connectionRequestId) {
      completeConnectionTest(jsonObj.payload.requestId, jsonObj.payload.success, jsonObj.payload.message);
    }
    if (jsonObj.event === 'sendToPropertyInspector' && jsonObj.payload?.event === 'modelsResult') handleModelsResult(jsonObj.payload);
    if (jsonObj.event === 'sendToPropertyInspector' && jsonObj.payload?.event === 'generationTestResult') handleGenerationTestResult(jsonObj.payload);
  };
}

// --- Model fetching ---

const { getModelsEndpoint, validateNumericSettings, temperatureOrDefault, sanitizeModelInfo, findModelInfo, generationTestTimeout } = AISettings;

async function fetchModels() {
  invalidateModelFetch();
  if (!saveSettings()) return;
  const provider = document.getElementById('provider').value;
  const apiKey = document.getElementById('apiKey').value.trim();
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const statusEl = document.getElementById('fetchStatus');
  const btn = document.getElementById('fetchModelsBtn');

  if (!apiKey && provider !== 'openrouter') {
    statusEl.textContent = 'Enter API key first';
    return;
  }

  if (provider === 'custom') {
    try { if (!getModelsEndpoint(provider, baseUrl)) throw new Error(); }
    catch (_) { statusEl.textContent = 'Enter a valid HTTP or HTTPS custom endpoint URL'; return; }
  }
  if (!websocket) {
    statusEl.textContent = 'Stream Deck connection is unavailable';
    return;
  }

  modelFetchVersion++;
  modelsRequestVersion = modelFetchVersion;
  modelsRequestId = `models-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  modelsRequestSignature = currentConnectionSignature();
  btn.disabled = true;
  btn.textContent = 'Loading…';
  statusEl.textContent = 'Loading model catalogue…';
  const requestId = modelsRequestId;
  modelsRequestTimeoutId = setTimeout(() => {
    if (modelsRequestId === requestId) finishModelRequest('Model catalogue request timed out');
  }, 30000);
  websocket.send(JSON.stringify({ event: 'sendToPlugin', action: actionUUID, context: uuid, payload: { event: 'fetchModels', requestId } }));
}

function handleModelsResult(result) {
  if (!result || result.requestId !== modelsRequestId) return;
  if (modelsRequestVersion !== modelFetchVersion || modelsRequestSignature !== currentConnectionSignature()) {
    finishModelRequest('Catalogue result ignored because connection settings changed');
    return;
  }
  if (!result.success) {
    finishModelRequest(result.message || 'Model catalogue request failed');
    return;
  }
  const models = sanitizeModelInfo(result.models);
  if (result.models && models.length !== result.models.length) {
    finishModelRequest('Catalogue response contained invalid model entries');
    return;
  }

  const provider = document.getElementById('provider').value;
  const selectedModel = getSelectedModel() || globalSettings.model || '';
  globalSettings.modelCache = globalSettings.modelCache || {};
  globalSettings.modelCache[provider] = models;
  modelCacheRevisionByProvider[provider] = providerConnectionRevision;
  populateModelSelect(models, selectedModel);
  updateModelCapabilities();
  saveSettings();
  const suffix = result.truncated ? ' (catalogue truncated)' : '';
  finishModelRequest(models.length ? `${models.length} models loaded${suffix}` : `No models found${suffix}`);
}

function finishModelRequest(message) {
  clearTimeout(modelsRequestTimeoutId);
  modelsRequestTimeoutId = null;
  modelsRequestId = null;
  modelsRequestVersion = null;
  const status = document.getElementById('fetchStatus');
  const btn = document.getElementById('fetchModelsBtn');
  if (status) status.textContent = message;
  if (btn) { btn.disabled = false; btn.textContent = 'Fetch'; }
}

// --- UI helpers ---

function populateModelSelect(models, requestedModel = globalSettings.model || '') {
  const select = document.getElementById('modelSelect');
  const current = requestedModel || '';
  select.innerHTML = '';

  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name !== m.id ? m.name + ' (' + m.id + ')' : m.id;
    select.appendChild(opt);
  });

  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Custom model...';
  select.appendChild(customOpt);

  const inList = models.some(m => m.id === current);
  if (inList) {
    select.value = current;
    document.getElementById('customModelGroup').style.display = 'none';
  } else {
    select.value = '__custom__';
    document.getElementById('customModelInput').value = current;
    document.getElementById('customModelGroup').style.display = 'block';
  }
}

function getSelectedModel() {
  const sel = document.getElementById('modelSelect');
  return sel.value === '__custom__'
    ? (document.getElementById('customModelInput').value || '')
    : sel.value;
}

function updateUI(initial = !receivedGlobalSettings) {
  document.getElementById('provider').value = globalSettings.provider || 'openai';
  document.getElementById('apiKey').value = globalSettings.apiKey || '';
  document.getElementById('baseUrl').value = globalSettings.baseUrl || '';
  document.getElementById('temperature').value = temperatureOrDefault(globalSettings.temperature);
  document.getElementById('temperatureValue').textContent = temperatureOrDefault(globalSettings.temperature);
  document.getElementById('maxTokens').value = globalSettings.maxTokens || 4096;
  document.getElementById('timeout').value = globalSettings.timeout || 30;

  toggleBaseUrl();
  const cached = modelsForCurrentConnection(globalSettings.provider);
  populateModelSelect(cached, globalSettings.model || '');
  updateModelCapabilities();
  updateConnectionSummary();
  const details = document.getElementById('connectionDetails');
  if (details && initial) details.open = !(globalSettings.apiKey || '').trim();
}

function saveSettings() {
  const modelInfo = getSelectedModelInfo();
  const numeric = validateNumericSettings(document.getElementById('maxTokens'), document.getElementById('timeout'), modelInfo, document.getElementById('temperature'));
  if (!numeric) return false;
  globalSettings = {
    provider: document.getElementById('provider').value,
    apiKey: document.getElementById('apiKey').value,
    baseUrl: document.getElementById('provider').value === 'custom' ? document.getElementById('baseUrl').value : '',
    model: getSelectedModel(),
    temperature: parseFloat(document.getElementById('temperature').value),
    maxTokens: numeric.maxTokens,
    timeout: numeric.timeout,
    modelCache: globalSettings.modelCache || {}
  };
  if (websocket) {
    websocket.send(JSON.stringify({ event: 'setGlobalSettings', context: uuid, payload: globalSettings }));
  }
  updateConnectionSummary();
  return true;
}

function getSelectedModelInfo() {
  const provider = document.getElementById('provider').value;
  return findModelInfo({ [provider]: modelsForCurrentConnection(provider) }, provider, getSelectedModel());
}

function modelsForCurrentConnection(provider) {
  const models = sanitizeModelInfo((globalSettings.modelCache || {})[provider]);
  if (modelCacheRevisionByProvider[provider] === providerConnectionRevision) return models;
  return models.map(model => ({ id: model.id, name: model.name, temperatureSupport: 'unknown' }));
}

function updateModelCapabilities() {
  const info = getSelectedModelInfo();
  const temperature = document.getElementById('temperature');
  const temperatureHint = document.getElementById('temperatureHint');
  temperature.disabled = info?.temperatureSupport === 'unsupported';
  temperature.max = Number.isFinite(info?.temperatureMax) ? String(Math.min(2, info.temperatureMax)) : '2';
  temperatureHint.textContent = info?.temperatureSupport === 'unsupported'
    ? 'This model does not support temperature.'
    : info?.temperatureSupport === 'supported'
      ? (Number.isFinite(info.temperatureMax) ? `Supported up to ${Math.min(2, info.temperatureMax)}.` : 'Temperature is supported.')
      : 'Temperature support not yet verified for this model.';

  const maxTokens = document.getElementById('maxTokens');
  const maxTokensHint = document.getElementById('maxTokensHint');
  const outputLimit = Number.isFinite(info?.outputTokenLimit) && info.outputTokenLimit > 0 ? Math.min(128000, info.outputTokenLimit) : null;
  maxTokens.dataset.modelLimit = outputLimit ? String(outputLimit) : '';
  maxTokens.max = String(outputLimit || 128000);
  const current = parseInt(maxTokens.value, 10);
  maxTokensHint.textContent = outputLimit
    ? (Number.isFinite(current) && current > outputLimit ? `Current value (${current}) exceeds this model's ${outputLimit} token limit; change it to save.` : `Selected model supports up to ${outputLimit} output tokens.`)
    : 'Maximum output tokens not yet verified for this model.';
}

function toggleBaseUrl() {
  document.getElementById('baseUrlGroup').style.display =
    document.getElementById('provider').value === 'custom' ? 'block' : 'none';
}

// --- Event listeners ---

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('provider').addEventListener('change', () => {
    invalidateModelFetch();
    invalidateConnectionTest();
    invalidateGenerationTest();
    toggleBaseUrl();
    const p = document.getElementById('provider').value;
    document.getElementById('fetchStatus').textContent = '';
    const cached = modelsForCurrentConnection(p);
    populateModelSelect(cached, getSelectedModel());
    updateModelCapabilities();
    saveSettings();
  });

  ['apiKey', 'baseUrl', 'maxTokens', 'timeout'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveSettings);
  });
  ['apiKey', 'baseUrl'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { providerConnectionRevision++; invalidateModelFetch(); invalidateConnectionTest(); invalidateGenerationTest(); updateModelCapabilities(); }));

  document.getElementById('modelSelect').addEventListener('change', () => {
    invalidateModelFetch();
    invalidateConnectionTest();
    invalidateGenerationTest();
    const v = document.getElementById('modelSelect').value;
    document.getElementById('customModelGroup').style.display = v === '__custom__' ? 'block' : 'none';
    updateModelCapabilities();
    saveSettings();
  });

  document.getElementById('customModelInput')?.addEventListener('input', () => { invalidateModelFetch(); invalidateConnectionTest(); invalidateGenerationTest(); updateConnectionSummary(); updateModelCapabilities(); });
  document.getElementById('customModelInput')?.addEventListener('change', saveSettings);

  const temp = document.getElementById('temperature');
  temp.addEventListener('input', () => {
    document.getElementById('temperatureValue').textContent = temp.value;
    invalidateGenerationTest();
  });
  temp.addEventListener('change', saveSettings);
  document.getElementById('maxTokens').addEventListener('input', () => { updateModelCapabilities(); invalidateGenerationTest(); });
  document.getElementById('timeout').addEventListener('input', invalidateGenerationTest);

  document.getElementById('fetchModelsBtn').addEventListener('click', fetchModels);

  document.getElementById('testConnection').addEventListener('click', testConnection);
  document.getElementById('testGeneration').addEventListener('click', testGeneration);
  updateUI();
});

function showConnectionResult(success, message) {
  const dot = document.getElementById('connectionDot');
  const txt = document.getElementById('connectionText');
  dot.className = success ? 'status-dot ok' : 'status-dot err';
  txt.textContent = message;
}

function testConnection() {
  const provider = document.getElementById('provider').value;
  const key = document.getElementById('apiKey').value.trim();
  if (!key && provider !== 'openrouter') return showConnectionResult(false, 'Enter an API key first');
  if (provider === 'custom') {
    try { if (!getModelsEndpoint(provider, document.getElementById('baseUrl').value.trim())) throw new Error(); }
    catch (_) { return showConnectionResult(false, 'Enter a valid HTTP or HTTPS custom endpoint URL'); }
  }
  if (!saveSettings()) return;
  if (!websocket) return showConnectionResult(false, 'Stream Deck connection is unavailable');
  connectionRequestId = `connection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  connectionTestSignature = currentConnectionSignature();
  showConnectionResult(false, 'Testing connection…');
  websocket.send(JSON.stringify({ event: 'sendToPlugin', action: actionUUID, context: uuid, payload: { event: 'testConnection', requestId: connectionRequestId } }));
  const requestId = connectionRequestId;
  connectionTimeoutId = setTimeout(() => { if (connectionRequestId === requestId) { connectionRequestId = null; connectionTimeoutId = null; showConnectionResult(false, 'Connection test timed out'); } }, 30000);
}

function currentConnectionSignature() {
  return JSON.stringify(['provider', 'apiKey', 'baseUrl', 'modelSelect', 'customModelInput'].map(id => document.getElementById(id)?.value || ''));
}

function completeConnectionTest(requestId, success, message) {
  if (requestId !== connectionRequestId) return;
  if (connectionTestSignature !== currentConnectionSignature()) return invalidateConnectionTest();
  clearTimeout(connectionTimeoutId);
  connectionTimeoutId = null;
  connectionRequestId = null;
  showConnectionResult(success, message || (success ? 'Connected' : 'Connection failed'));
}

function invalidateModelFetch() {
  modelFetchVersion++;
  clearTimeout(modelsRequestTimeoutId);
  modelsRequestTimeoutId = null;
  modelsRequestId = null;
  modelsRequestVersion = null;
  modelsRequestSignature = null;
  const btn = document.getElementById('fetchModelsBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Fetch';
  }
  const status = document.getElementById('fetchStatus');
  if (status) status.textContent = 'Connection settings changed; fetch again';
}

function invalidateConnectionTest() {
  if (!connectionRequestId) return;
  clearTimeout(connectionTimeoutId);
  connectionTimeoutId = null;
  connectionRequestId = null;
  showConnectionResult(false, 'Settings changed; test again');
}

function showGenerationStatus(status, message, usedParameters = null) {
  const el = document.getElementById('generationStatus');
  if (!el) return;
  el.className = 'status-text';
  el.dataset.hasResult = 'true';
  if (status === 'verified') el.classList.add('ok');
  else if (status === 'inconclusive') el.classList.add('inconclusive');
  else el.classList.add('err');
  const details = usedParameters && typeof usedParameters === 'object' ? ` Used parameters: ${Object.entries(usedParameters).map(([key, value]) => `${key}=${value}`).join(', ')}.` : '';
  el.textContent = `${message || (status === 'verified' ? 'Generation verified' : status === 'inconclusive' ? 'Generation was inconclusive' : 'Generation test failed')}${details}`;
}

function invalidateGenerationTest() {
  const wasPending = !!generationRequestId;
  const status = document.getElementById('generationStatus');
  if (!wasPending && status?.dataset.hasResult !== 'true') return;
  clearTimeout(generationTimeoutId);
  generationTimeoutId = null;
  generationRequestId = null;
  const button = document.getElementById('testGeneration');
  if (button) { button.disabled = false; button.textContent = 'Test generation'; }
  showGenerationStatus('inconclusive', 'Settings changed; run the test again.');
}

function handleGenerationTestResult(result) {
  if (!result || result.requestId !== generationRequestId) return;
  if (generationTestSignature !== currentGenerationSignature()) {
    invalidateGenerationTest();
    return;
  }
  clearTimeout(generationTimeoutId);
  generationTimeoutId = null;
  generationRequestId = null;
  const button = document.getElementById('testGeneration');
  if (button) { button.disabled = false; button.textContent = 'Test generation'; }
  applyGenerationCapabilities(result.capabilities);
  const verified = result.success === true && result.status === 'verified';
  const status = verified ? 'verified' : result.status === 'inconclusive' ? 'inconclusive' : 'error';
  showGenerationStatus(status, result.message, result.usedParameters);
}

function testGeneration() {
  if (generationRequestId) return;
  const provider = document.getElementById('provider').value;
  const key = document.getElementById('apiKey').value.trim();
  if (!key && provider !== 'openrouter') return showGenerationStatus('error', 'Enter an API key first.');
  if (provider === 'custom') {
    try { if (!getModelsEndpoint(provider, document.getElementById('baseUrl').value.trim())) throw new Error(); }
    catch (_) { return showGenerationStatus('error', 'Enter a valid HTTP or HTTPS custom endpoint URL.'); }
  }
  if (!saveSettings()) return showGenerationStatus('error', 'Fix the highlighted settings before testing.');
  if (!websocket) return showGenerationStatus('error', 'Stream Deck connection is unavailable.');

  generationRequestId = `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  generationTestSignature = currentGenerationSignature();
  const requestId = generationRequestId;
  const button = document.getElementById('testGeneration');
  button.disabled = true;
  button.textContent = 'Testing…';
  showGenerationStatus('inconclusive', 'Generation test is running…');
  document.getElementById('generationStatus').dataset.hasResult = 'false';
  generationTimeoutId = setTimeout(() => {
    if (generationRequestId !== requestId) return;
    generationRequestId = null;
    generationTimeoutId = null;
    button.disabled = false;
    button.textContent = 'Test generation';
    showGenerationStatus('error', 'Generation test timed out.');
  }, generationTestTimeout(globalSettings.timeout));
  websocket.send(JSON.stringify({ event: 'sendToPlugin', action: actionUUID, context: uuid, payload: { event: 'testGeneration', requestId } }));
}

function currentGenerationSignature() {
  return JSON.stringify([currentConnectionSignature(), document.getElementById('temperature').value, document.getElementById('maxTokens').value, document.getElementById('timeout').value]);
}

function applyGenerationCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return;
  const provider = document.getElementById('provider').value;
  const id = getSelectedModel();
  if (!id) return;
  const candidate = sanitizeModelInfo([{ id, name: id, ...capabilities }])[0];
  if (!candidate || !Object.keys(capabilities).some(key => ['temperatureSupport', 'temperatureMax', 'outputTokenLimit', 'reasoning'].includes(key))) return;
  const models = sanitizeModelInfo((globalSettings.modelCache || {})[provider]);
  const index = models.findIndex(model => model.id === id);
  if (index >= 0) models[index] = { ...models[index], ...candidate };
  else models.push(candidate);
  globalSettings.modelCache = globalSettings.modelCache || {};
  globalSettings.modelCache[provider] = models;
  modelCacheRevisionByProvider[provider] = providerConnectionRevision;
  updateModelCapabilities();
  saveSettings();
}

function updateConnectionSummary() {
  const summary = document.getElementById('connectionSummary');
  if (!summary) return;
  const provider = document.getElementById('provider')?.value || globalSettings.provider || 'openai';
  const hasKey = !!document.getElementById('apiKey')?.value.trim();
  const model = getSelectedModel() || globalSettings.model || 'no model';
  summary.textContent = `${provider} · ${model} · ${hasKey ? 'key set' : 'key needed'}`;
  const modelId = document.getElementById('modelIdText');
  if (modelId) modelId.textContent = `Selected model: ${model}`;
}

/**
 * Property Inspector for AI Assistant
 */

const PRESETS = {
  'fix-grammar': {
    actionName: 'Fix Grammar',
    systemPrompt: 'You are a professional proofreader. Fix all spelling and grammar errors while preserving the original meaning and tone. Output ONLY the corrected text, nothing else.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  },
  'translate-en': {
    actionName: 'Translate EN',
    systemPrompt: 'You are a professional translator. Translate the following text to English. Preserve the tone and style. Output ONLY the translated text.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  },
  'translate-ru': {
    actionName: 'Translate RU',
    systemPrompt: 'You are a professional translator. Translate the following text to Russian. Preserve the tone and style. Output ONLY the translated text.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  },
  'translate-sr': {
    actionName: 'Translate SR',
    systemPrompt: 'You are a professional translator. Translate the following text to Serbian. Preserve the tone and style. Output ONLY the translated text.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  },
  'translate-de': {
    actionName: 'Translate DE',
    systemPrompt: 'You are a professional translator. Translate the following text to German. Preserve the tone and style. Output ONLY the translated text.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  },
  'summarize': {
    actionName: 'Summarize',
    systemPrompt: 'You are an expert at summarization. Summarize the following content concisely in 3-5 bullet points. Use clear, simple language.',
    userPromptTemplate: '{{text}}',
    postAction: 'copy'
  },
  'explain-code': {
    actionName: 'Explain Code',
    systemPrompt: 'You are a programming expert. Explain the following code in simple terms. Describe what it does, how it works, and any notable patterns or techniques used.',
    userPromptTemplate: '{{text}}',
    postAction: 'copy'
  },
  'professional': {
    actionName: 'Professional',
    systemPrompt: 'You are a professional editor. Rewrite the following text in a more professional, polished tone while keeping the same meaning.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  },
  'casual': {
    actionName: 'Casual',
    systemPrompt: 'You are a casual, friendly editor. Rewrite the following text in a more relaxed, conversational tone while keeping the same meaning.',
    userPromptTemplate: '{{text}}',
    postAction: 'paste'
  }
};

// Default encoder preset configuration
const DEFAULT_ENCODER_PRESETS = [
  { key: 'fix-grammar', enabled: true },
  { key: 'translate-en', enabled: true },
  { key: 'translate-ru', enabled: true },
  { key: 'translate-sr', enabled: true },
  { key: 'translate-de', enabled: true },
  { key: 'summarize', enabled: true },
  { key: 'explain-code', enabled: true },
  { key: 'professional', enabled: true },
  { key: 'casual', enabled: true }
];


let globalSettings = {
  provider: 'openai',
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4.1',
  temperature: 0.7,
  maxTokens: 4096,
  timeout: 30,
  modelCache: {}
};

let actionSettings = {
  actionName: '',
  systemPrompt: '',
  userPromptTemplate: '{{text}}',
  inputMode: 'selection',
  postAction: 'paste'
};

let encoderSettings = {
  presetIndex: 0,
  encoderPresets: DEFAULT_ENCODER_PRESETS.map(preset => ({ ...preset }))
};

let websocket = null;
let uuid = null;
let actionType = null; // 'text-action' or 'prompt-selector'
let actionUUID = 'com.dzarlax.ai-assistant.text-action';
let connectionRequestId = null;
let connectionTimeoutId = null;
let connectionTestSignature = null;
let modelFetchVersion = 0;
let modelsRequestId = null;
let modelsRequestTimeoutId = null;
let modelsRequestSignature = null;
let modelsRequestVersion = null;
let generationRequestId = null;
let generationTimeoutId = null;
let generationTestSignature = null;
let providerConnectionRevision = 0;
const trustedModelCapabilities = new Map();
let receivedGlobalSettings = false;

function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  uuid = inUUID;
  websocket = new WebSocket('ws://localhost:' + inPort);

  // Parse action info to determine action type
  try {
    const actionInfo = JSON.parse(inActionInfo);
    // action is full UUID like "com.dzarlax.ai-assistant.prompt-selector"
    actionType = actionInfo.action.includes('prompt-selector') ? 'prompt-selector' : 'text-action';
    actionUUID = actionInfo.action || actionUUID;
  } catch (e) {
    actionType = 'text-action'; // fallback
  }

  websocket.onopen = () => {
    websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: uuid }));
    websocket.send(JSON.stringify({ event: 'getSettings', context: uuid }));
    websocket.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
  };

  websocket.onmessage = (evt) => {
    const data = JSON.parse(evt.data);

    if (data.event === 'didReceiveSettings' && data.payload.settings) {
      if (actionType === 'prompt-selector') {
        encoderSettings = { ...encoderSettings, ...data.payload.settings };
        showActionSections();
        updateEncoderUI();
      } else {
        actionSettings = { ...actionSettings, ...data.payload.settings };
        updateActionUI();
      }
    }

    if (data.event === 'didReceiveGlobalSettings') {
      const s = data.payload.settings;
      if (s && Object.keys(s).length > 0) {
        const initial = !receivedGlobalSettings;
        receivedGlobalSettings = true;
        if (['provider', 'apiKey', 'baseUrl'].some(key => s[key] !== undefined && s[key] !== globalSettings[key])) providerConnectionRevision++;
        globalSettings = { ...globalSettings, ...s };
        updateGlobalUI(initial);
        if (generationTestSignature && generationTestSignature !== currentGenerationSignature()) invalidateGenerationTest();
      }
    }

    if (data.event === 'sendToPropertyInspector' && data.payload?.event === 'connectionTestResult' && data.payload.requestId === connectionRequestId) {
      completeConnectionTest(data.payload.requestId, data.payload.success, data.payload.message);
    }
    if (data.event === 'sendToPropertyInspector' && data.payload?.event === 'modelsResult') handleModelsResult(data.payload);
    if (data.event === 'sendToPropertyInspector' && data.payload?.event === 'generationTestResult') handleGenerationTestResult(data.payload);
  };

  // Show/hide sections based on action type
  showActionSections();
}

// --- Model fetching ---

const { getModelsEndpoint, validateNumericSettings, temperatureOrDefault, sanitizeModelInfo, findModelInfo, generationTestTimeout } = AISettings;

function fetchModels() {
  invalidateModelFetch();
  if (!saveGlobalSettings()) {
    finishModelRequest('Fix the highlighted settings before fetching models.');
    return;
  }
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
  const selectedModel = getSelectedModel();
  globalSettings.modelCache = globalSettings.modelCache || {};
  globalSettings.modelCache[provider] = models;
  trustedModelCapabilities.set(provider, {
    revision: providerConnectionRevision,
    models: new Map(models.map(model => [model.id, model]))
  });
  populateModelSelect(models, selectedModel);
  updateModelCapabilities();
  if (!saveGlobalSettings()) {
    finishModelRequest('Catalogue received. Settings were not saved. Fix the highlighted settings.');
    return;
  }
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
  customOpt.textContent = 'Enter model ID…';
  select.appendChild(customOpt);

  if (models.some(m => m.id === current)) {
    select.value = current;
    document.getElementById('customModelGroup').style.display = 'none';
  } else {
    select.value = '__custom__';
    document.getElementById('customModelInput').value = current;
    document.getElementById('customModelGroup').style.display = 'block';
  }
}

function getSelectedModel() {
  const provider = document.getElementById('provider').value;
  const select = document.getElementById('modelSelect');
  return provider === 'custom' || select.value === '__custom__'
    ? document.getElementById('customModelInput').value || ''
    : select.value || '';
}

function updateModelUI(provider, model = globalSettings.model || '') {
  const isCustom = provider === 'custom';
  document.getElementById('modelSelectRow').style.display = isCustom ? 'none' : '';
  const cached = modelsForCurrentConnection(provider);
  populateModelSelect(cached, model);
  document.getElementById('customModelGroup').style.display = isCustom || document.getElementById('modelSelect').value === '__custom__' ? 'block' : 'none';
  document.getElementById('customModelInput').value = model;
  document.getElementById('fetchStatus').textContent = cached.length ? `${cached.length} models cached` : 'Fetch the model catalogue to load available models.';
  updateModelCapabilities();
}

function updateGlobalUI(initial = !receivedGlobalSettings) {
  const provider = globalSettings.provider || 'openai';
  document.getElementById('provider').value = provider;
  document.getElementById('apiKey').value = globalSettings.apiKey || '';
  document.getElementById('baseUrl').value = globalSettings.baseUrl || '';
  document.getElementById('temperature').value = temperatureOrDefault(globalSettings.temperature);
  document.getElementById('temperatureValue').textContent = temperatureOrDefault(globalSettings.temperature);
  document.getElementById('maxTokens').value = globalSettings.maxTokens || 4096;
  document.getElementById('timeout').value = globalSettings.timeout || 30;

  toggleBaseUrl();
  updateModelUI(provider);
  updateConnectionSummary();
  const connectionDetails = document.getElementById('connectionDetails');
  if (connectionDetails && initial) connectionDetails.open = !(globalSettings.apiKey || '').trim();
}

function updateActionUI() {
  document.getElementById('actionName').value = actionSettings.actionName || '';
  document.getElementById('systemPrompt').value = actionSettings.systemPrompt || '';
  document.getElementById('userPromptTemplate').value = actionSettings.userPromptTemplate || '{{text}}';
  document.getElementById('inputMode').value = actionSettings.inputMode || 'selection';
  document.getElementById('postAction').value = actionSettings.postAction || 'paste';
}

function saveGlobalSettings() {
  const modelInfo = getSelectedModelInfo();
  const numeric = validateNumericSettings(
    document.getElementById('maxTokens'), document.getElementById('timeout'),
    modelInfo, document.getElementById('temperature'), document.getElementById('advancedDetails')
  );
  document.getElementById('settingsSaveStatus').textContent = numeric ? '' : 'Settings were not saved. Fix the highlighted settings.';
  if (!numeric) return false;
  globalSettings = {
    provider: document.getElementById('provider').value,
    apiKey: document.getElementById('apiKey').value,
    baseUrl: document.getElementById('provider').value === 'custom' ? document.getElementById('baseUrl').value : '',
    model: getSelectedModel().trim(),
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

function modelsForCurrentConnection(provider) {
  const models = sanitizeModelInfo((globalSettings.modelCache || {})[provider]);
  const trusted = trustedModelCapabilities.get(provider);
  const current = trusted?.revision === providerConnectionRevision ? trusted.models : null;
  return models.map(({ id, name }) => current?.get(id) || { id, name, temperatureSupport: 'unknown' });
}

function getSelectedModelInfo() {
  const provider = document.getElementById('provider').value;
  return findModelInfo({ [provider]: modelsForCurrentConnection(provider) }, provider, getSelectedModel());
}

function updateModelCapabilities() {
  const info = getSelectedModelInfo();
  const temperature = document.getElementById('temperature');
  const temperatureHint = document.getElementById('temperatureHint');
  temperature.disabled = info?.temperatureSupport === 'unsupported';
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

function saveActionSettings() {
  actionSettings = {
    actionName: document.getElementById('actionName').value,
    systemPrompt: document.getElementById('systemPrompt').value,
    userPromptTemplate: document.getElementById('userPromptTemplate').value,
    inputMode: document.getElementById('inputMode').value,
    postAction: document.getElementById('postAction').value
  };
  if (websocket) {
    websocket.send(JSON.stringify({ event: 'setSettings', context: uuid, payload: actionSettings }));
  }
}

function toggleBaseUrl() {
  document.getElementById('baseUrlGroup').style.display =
    document.getElementById('provider').value === 'custom' ? 'block' : 'none';
}

function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const heading = section.previousElementSibling;
  section.classList.toggle('collapsed');
  heading.classList.toggle('collapsed');
}

function loadPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  document.getElementById('actionName').value = preset.actionName;
  document.getElementById('systemPrompt').value = preset.systemPrompt;
  document.getElementById('userPromptTemplate').value = preset.userPromptTemplate;
  document.getElementById('postAction').value = preset.postAction;
  saveActionSettings();
}

// --- Encoder Preset Configuration ---

function showActionSections() {
  const isEncoder = actionType === 'prompt-selector';
  const setDisplay = (id, display) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  };

  // Hide entire Prompt Settings and Quick Presets blocks for encoder (heading + content)
  setDisplay('promptBlock', isEncoder ? 'none' : 'block');
  setDisplay('presetBlock', isEncoder ? 'none' : 'block');
  setDisplay('encoderSection', isEncoder ? 'block' : 'none');
  setDisplay('divider1', isEncoder ? 'none' : 'block');
  setDisplay('divider2', isEncoder ? 'none' : 'block');
}

function updateEncoderUI() {
  renderPresetList();
}

function renderPresetList() {
  const container = document.getElementById('presetList');
  container.innerHTML = '';

  const presets = encoderSettings.encoderPresets || DEFAULT_ENCODER_PRESETS;

  presets.forEach((preset, index) => {
    const presetInfo = PRESETS[preset.key];
    if (!presetInfo) return;

    const item = document.createElement('div');
    item.className = 'preset-item' + (preset.enabled ? '' : ' disabled');
    item.draggable = false;
    item.dataset.index = index;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'preset-toggle';
    checkbox.checked = !!preset.enabled;
    checkbox.dataset.key = preset.key;
    checkbox.setAttribute('aria-label', `Show ${presetInfo.actionName} in encoder`);
    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = presetInfo.actionName;
    const moveUp = document.createElement('button');
    moveUp.type = 'button'; moveUp.className = 'move-preset'; moveUp.textContent = '↑';
    moveUp.setAttribute('aria-label', `Move ${presetInfo.actionName} up`);
    moveUp.disabled = index === 0;
    moveUp.addEventListener('click', () => moveEncoderPreset(index, -1));
    const moveDown = document.createElement('button');
    moveDown.type = 'button'; moveDown.className = 'move-preset'; moveDown.textContent = '↓';
    moveDown.setAttribute('aria-label', `Move ${presetInfo.actionName} down`);
    moveDown.disabled = index === presets.length - 1;
    moveDown.addEventListener('click', () => moveEncoderPreset(index, 1));
    item.appendChild(checkbox); item.appendChild(name); item.appendChild(moveUp); item.appendChild(moveDown);

    // Drag events
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragend', handleDragEnd);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragleave', handleDragLeave);

    // Toggle event
    checkbox.addEventListener('change', (e) => {
      const key = e.target.dataset.key;
      const idx = encoderSettings.encoderPresets.findIndex(p => p.key === key);
      if (idx !== -1) {
        encoderSettings.encoderPresets[idx].enabled = e.target.checked;
        item.className = 'preset-item' + (e.target.checked ? '' : ' disabled');
        saveEncoderSettings();
      }
    });

    container.appendChild(item);
  });
}

function moveEncoderPreset(index, direction) {
  const nextIndex = index + direction;
  const presets = encoderSettings.encoderPresets || (encoderSettings.encoderPresets = DEFAULT_ENCODER_PRESETS.map(p => ({ ...p })));
  if (nextIndex < 0 || nextIndex >= presets.length) return;
  [presets[index], presets[nextIndex]] = [presets[nextIndex], presets[index]];
  saveEncoderSettings();
  renderPresetList();
}

let draggedItem = null;

function handleDragStart(e) {
  draggedItem = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  this.classList.remove('dragging');
  document.querySelectorAll('.preset-item').forEach(item => {
    item.classList.remove('drag-over');
  });
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}

function handleDragLeave(e) {
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');

  if (draggedItem === this) return;

    const fromIndex = parseInt(draggedItem.dataset.index);
    const toIndex = parseInt(this.dataset.index);

  if (fromIndex !== toIndex) {
    const presets = encoderSettings.encoderPresets;
    const [removed] = presets.splice(fromIndex, 1);
    presets.splice(toIndex, 0, removed);

    saveEncoderSettings();
    renderPresetList();
  }
}

function saveEncoderSettings() {
  if (websocket) {
    websocket.send(JSON.stringify({
      event: 'setSettings',
      context: uuid,
      payload: encoderSettings
    }));
  }
}

function resetEncoderPresets() {
  encoderSettings.encoderPresets = JSON.parse(JSON.stringify(DEFAULT_ENCODER_PRESETS));
  encoderSettings.presetIndex = 0;
  saveEncoderSettings();
  renderPresetList();
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
    updateModelUI(p, '');
    saveGlobalSettings();
  });

  ['apiKey', 'baseUrl', 'maxTokens', 'timeout'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveGlobalSettings);
  });
  ['apiKey', 'baseUrl'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { providerConnectionRevision++; invalidateModelFetch(); invalidateConnectionTest(); invalidateGenerationTest(); updateModelCapabilities(); }));

  document.getElementById('modelSelect').addEventListener('change', () => {
    invalidateModelFetch();
    invalidateConnectionTest();
    invalidateGenerationTest();
    const v = document.getElementById('modelSelect').value;
    document.getElementById('customModelGroup').style.display = v === '__custom__' ? 'block' : 'none';
    updateModelCapabilities();
    saveGlobalSettings();
  });

  document.getElementById('customModelInput')?.addEventListener('input', () => { invalidateModelFetch(); invalidateConnectionTest(); invalidateGenerationTest(); updateConnectionSummary(); updateModelCapabilities(); });
  document.getElementById('customModelInput')?.addEventListener('change', saveGlobalSettings);

  const temp = document.getElementById('temperature');
  temp.addEventListener('input', () => {
    document.getElementById('temperatureValue').textContent = temp.value;
    invalidateGenerationTest();
  });
  temp.addEventListener('change', saveGlobalSettings);
  document.getElementById('maxTokens').addEventListener('input', () => { updateModelCapabilities(); invalidateGenerationTest(); });
  document.getElementById('timeout').addEventListener('input', invalidateGenerationTest);

  document.getElementById('fetchModelsBtn').addEventListener('click', fetchModels);

  document.getElementById('testConnection').addEventListener('click', testConnection);
  document.getElementById('testGeneration').addEventListener('click', testGeneration);

  // Action inputs
  ['actionName', 'systemPrompt', 'userPromptTemplate', 'inputMode', 'postAction'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('change', saveActionSettings);
  });

  // Preset
  document.getElementById('loadPresetBtn').addEventListener('click', () => {
    const key = document.getElementById('presetSelector').value;
    if (key) loadPreset(key);
  });

  // Encoder reset button
  document.getElementById('resetPresetsBtn').addEventListener('click', resetEncoderPresets);

  updateGlobalUI();
  updateActionUI();
});

function showConnectionResult(success, message) {
  const status = document.getElementById('connectionStatus');
  if (!status) return;
  status.className = success ? 'status-text ok' : 'status-text err';
  status.textContent = message;
}

function updateConnectionSummary() {
  const summary = document.getElementById('connectionSummary');
  if (!summary) return;
  const provider = document.getElementById('provider')?.value || globalSettings.provider || 'openai';
  const model = getSelectedModel().trim() || 'no model';
  const modelId = document.getElementById('modelIdText');
  if (modelId) modelId.textContent = `Selected model: ${model}`;
  const hasKey = !!document.getElementById('apiKey')?.value.trim();
  summary.textContent = `${provider} · ${model} · ${hasKey ? 'key set' : 'key needed'}`;
}

function testConnection() {
  const key = document.getElementById('apiKey').value.trim();
  const provider = document.getElementById('provider').value;
  if (!key && provider !== 'openrouter') return showConnectionResult(false, 'Enter an API key first');
  if (provider === 'custom') {
    try { if (!getModelsEndpoint(provider, document.getElementById('baseUrl').value.trim())) throw new Error(); }
    catch (_) { return showConnectionResult(false, 'Enter a valid HTTP or HTTPS custom endpoint URL'); }
  }
  if (!saveGlobalSettings()) return showConnectionResult(false, 'Fix the highlighted settings before checking access.');
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
  if (!getSelectedModel().trim()) return showGenerationStatus('error', 'Select a model before testing generation.');
  if (!saveGlobalSettings()) return showGenerationStatus('error', 'Fix the highlighted settings before testing.');
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
  const id = getSelectedModel().trim();
  if (!id || capabilities.id !== id) return;
  const candidate = sanitizeModelInfo([{ id, name: id, ...capabilities }])[0];
  if (!candidate || !Object.keys(capabilities).some(key => ['temperatureSupport', 'temperatureMax', 'outputTokenLimit', 'reasoning'].includes(key))) return;
  const models = modelsForCurrentConnection(provider);
  const index = models.findIndex(model => model.id === id);
  if (index >= 0) models[index] = candidate;
  else models.push(candidate);
  globalSettings.modelCache = globalSettings.modelCache || {};
  globalSettings.modelCache[provider] = models;
  const trusted = trustedModelCapabilities.get(provider);
  const current = trusted?.revision === providerConnectionRevision ? trusted.models : new Map();
  current.set(id, candidate);
  trustedModelCapabilities.set(provider, { revision: providerConnectionRevision, models: current });
  updateModelCapabilities();
  saveGlobalSettings();
}

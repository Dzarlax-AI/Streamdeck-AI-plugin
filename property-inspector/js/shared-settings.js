/* Shared provider/model helpers used by both Stream Deck settings inspectors. */
(function exposeAISettings(global) {
  function getModelsEndpoint(provider, baseUrl) {
    if (provider === 'openai') return { url: 'https://api.openai.com/v1/models', headers: {} };
    if (provider === 'anthropic') return { url: 'https://api.anthropic.com/v1/models', headers: { 'anthropic-version': '2023-06-01' } };
    if (provider === 'gemini') return { url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: {} };
    if (provider === 'openrouter') return { url: 'https://openrouter.ai/api/v1/models', headers: {} };
    if (provider !== 'custom' || !baseUrl) return null;

    const endpoint = new URL(baseUrl.trim());
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Use an HTTP or HTTPS endpoint URL');
    if (endpoint.username || endpoint.password) throw new Error('Endpoint URLs cannot contain a username or password');
    endpoint.hash = '';
    const path = endpoint.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(path)) endpoint.pathname = path.replace(/\/chat\/completions$/i, '') + '/models';
    else if (!path || /\/v\d+$/i.test(path)) endpoint.pathname = (path || '') + '/models';
    else endpoint.pathname = path.replace(/[^/]+$/, 'models');
    return { url: endpoint.toString(), headers: {} };
  }

  function parseModelsResponse(provider, data) {
    const isNonBlankString = value => typeof value === 'string' && value.trim().length > 0;
    const records = value => Array.isArray(value) ? value.filter(model => model && typeof model === 'object') : [];
    if (provider === 'anthropic') {
      return records(data?.data)
        .filter(model => isNonBlankString(model.id))
        .map(model => ({ id: model.id, name: isNonBlankString(model.display_name) ? model.display_name : model.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (provider === 'gemini') {
      return records(data?.models)
        .filter(model => isNonBlankString(model.name))
        .map(model => {
          const id = (model.name || '').replace(/^models\//, '');
          return { id, name: isNonBlankString(model.displayName) ? model.displayName : id };
        })
        .filter(model => isNonBlankString(model.id) && model.id.startsWith('gemini'))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    let models = records(data?.data)
      .filter(model => isNonBlankString(model.id))
      .map(model => ({ id: model.id, name: isNonBlankString(model.name) ? model.name : model.id }));
    if (provider === 'openai') {
      models = models.filter(model => /^gpt-|^o[1-4]/.test(model.id));
    }
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  function validateNumericSettings(maxTokensEl, timeoutEl, modelInfo, temperatureEl, advancedDetails) {
    function invalid(control, message) {
      if (advancedDetails) advancedDetails.open = true;
      control.setCustomValidity?.(message);
      control.reportValidity?.();
      return null;
    }
    maxTokensEl.setCustomValidity?.('');
    timeoutEl.setCustomValidity?.('');
    temperatureEl?.setCustomValidity?.('');
    const maxTokens = parseInt(maxTokensEl.value, 10);
    const timeout = parseInt(timeoutEl.value, 10);
    const modelLimit = Number(maxTokensEl.dataset.modelLimit);
    const maxAllowed = Number.isFinite(modelLimit) && modelLimit >= 1 ? Math.min(128000, modelLimit) : 128000;
    if (!Number.isFinite(maxTokens) || maxTokens < 100 || maxTokens > maxAllowed) {
      return invalid(maxTokensEl, maxTokens > maxAllowed ? `Selected model allows at most ${maxAllowed} output tokens` : `Enter a value from 100 to ${maxAllowed}`);
    }
    if (!Number.isFinite(timeout) || timeout < 5 || timeout > 120) {
      return invalid(timeoutEl, 'Enter a value from 5 to 120 seconds');
    }
    if (temperatureEl && modelInfo?.temperatureSupport === 'supported' && Number.isFinite(modelInfo.temperatureMax)) {
      if (parseFloat(temperatureEl.value) > modelInfo.temperatureMax) {
        return invalid(temperatureEl, `Selected model supports temperature up to ${modelInfo.temperatureMax}`);
      }
    }
    return { maxTokens, timeout };
  }

  function temperatureOrDefault(value) {
    return value ?? 0.7;
  }

  function sanitizeModelInfo(models) {
    if (!Array.isArray(models)) return [];
    const isNonBlankString = value => typeof value === 'string' && value.trim().length > 0;
    return models.filter(model => model && typeof model === 'object' && isNonBlankString(model.id)).map(model => {
      const info = {
        id: model.id,
        name: isNonBlankString(model.name) ? model.name : model.id,
        temperatureSupport: ['supported', 'unsupported', 'unknown'].includes(model.temperatureSupport) ? model.temperatureSupport : 'unknown'
      };
      if (Number.isFinite(model.temperatureMax) && model.temperatureMax >= 0) info.temperatureMax = model.temperatureMax;
      if (Number.isFinite(model.outputTokenLimit) && model.outputTokenLimit > 0) info.outputTokenLimit = model.outputTokenLimit;
      if (typeof model.reasoning === 'boolean') info.reasoning = model.reasoning;
      return info;
    });
  }

  function findModelInfo(modelCache, provider, modelId) {
    if (!modelId || !modelCache || !Array.isArray(modelCache[provider])) return null;
    return modelCache[provider].find(model => model && model.id === modelId) || null;
  }

  function generationTestTimeout(timeoutSeconds) {
    const configured = Number(timeoutSeconds);
    const configuredMs = Number.isFinite(configured) && configured > 0 ? configured * 1000 : 30000;
    return Math.min(Math.max(Math.min(configuredMs, 25000) * 2 + 5000, 20000), 60000);
  }

  global.AISettings = Object.freeze({ getModelsEndpoint, parseModelsResponse, validateNumericSettings, temperatureOrDefault, sanitizeModelInfo, findModelInfo, generationTestTimeout });
})(globalThis);

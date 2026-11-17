import axios from 'axios';
import { createHash } from 'node:crypto';
import type { ModelInfo } from './provider-capabilities.js';
export type { ModelInfo } from './provider-capabilities.js';

export interface AIRequestConfig {
    provider: string;
    apiKey: string;
    model: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
}

export interface AIResponse {
    text: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
    };
}

function extractAPIError(error: any): string {
    if (error.response) {
        const status = error.response.status;
        if (status === 400) {
            const detail = error.response.data?.error;
            const allowedCodes = ['unsupported_parameter', 'unsupported_value', 'invalid_request_error'];
            const allowedParams = ['temperature', 'model', 'max_completion_tokens', 'max_tokens', 'messages', 'system', 'reasoning_effort'];
            const code = allowedCodes.includes(detail?.code) ? detail.code
                : allowedCodes.includes(detail?.type) ? detail.type : undefined;
            const param = allowedParams.includes(detail?.param) ? detail.param : undefined;
            return code ? `HTTP 400: ${code}${param ? ` (${param})` : ''}` : 'HTTP 400';
        }

        if (status === 401) return 'Invalid API key';
        if (status === 403) return 'Access denied';
        if (status === 404) return 'Model not found';
        if (status === 429) return 'Rate limit exceeded';
        if (status === 500 || status === 502 || status === 503) return 'API server error';

        return `HTTP ${status}`;
    }
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) return 'Request timed out';
    if (error.code === 'ENOTFOUND') return 'Cannot reach API';
    if (error.message === 'Invalid custom base URL' || error.message === 'Unsupported provider' || error.message === 'Invalid models response') return error.message;
    return 'Unable to reach API';
}

function endpoints(config: AIRequestConfig): { generate: string; models: string } {
    switch (config.provider) {
        case 'openai': return { generate: 'https://api.openai.com/v1/chat/completions', models: 'https://api.openai.com/v1/models' };
        case 'openrouter': return { generate: 'https://openrouter.ai/api/v1/chat/completions', models: 'https://openrouter.ai/api/v1/models' };
        case 'anthropic': return { generate: 'https://api.anthropic.com/v1/messages', models: 'https://api.anthropic.com/v1/models' };
        case 'gemini': return { generate: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, models: 'https://generativelanguage.googleapis.com/v1beta/models' };
        case 'custom': {
            let url: URL;
            try { url = new URL(config.baseUrl || ''); } catch { throw new Error('Invalid custom base URL'); }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid custom base URL');
            url.hash = '';
            const path = url.pathname.replace(/\/+$/, '');
            const isBase = !path || /\/v\d+$/i.test(path);
            const isStandard = /\/chat\/completions$/i.test(path);
            const modelBase = isBase ? path : isStandard
                ? path.replace(/\/chat\/completions$/i, '')
                : path.replace(/\/[^/]*$/, '');
            if (isBase) url.pathname = `${path}/chat/completions`;
            const generate = url.toString();
            url.pathname = `${modelBase}/models`;
            return { generate, models: url.toString() };
        }
        default: throw new Error('Unsupported provider');
    }
}

function requestOptions(config: AIRequestConfig) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.provider === 'anthropic') {
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
    } else if (config.provider === 'gemini') {
        headers['x-goog-api-key'] = config.apiKey;
    } else {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }
    if (config.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/dzarlax/streamdeck-ai-plugin';
        headers['X-Title'] = 'Stream Deck AI Assistant';
    }
    return {
        headers,
        ...(config.provider !== 'custom' ? { maxRedirects: 0 } : {}),
        timeout: (config.timeout ?? 30) * 1000
    };
}

const metadata = new Map<string, { expires: number; model: ModelInfo }>();
const unsupportedTemperature = new Map<string, { expires: number }>();
const TTL = 3600000;
function identity(config: AIRequestConfig): string {
    return createHash('sha256').update(JSON.stringify([config.provider, endpoints(config).generate, config.apiKey, config.model])).digest('hex');
}
function put<T>(map: Map<string, T>, key: string, value: T, capacity = 100): void {
    map.delete(key); map.set(key, value);
    while (map.size > capacity) map.delete(map.keys().next().value!);
}
function getCurrent<T extends { expires: number }>(map: Map<string, T>, key: string): T | undefined {
    const value = map.get(key);
    if (value && value.expires > Date.now()) return value;
    map.delete(key); return undefined;
}
function baseline(config: AIRequestConfig): ModelInfo {
    const model = config.model;
    const info: ModelInfo = { id: model, name: model, temperatureSupport: 'unknown' };
    if (config.provider === 'openai') {
        if (/^(?:gpt-5\.[12])(?:-\d{4}-\d{2}-\d{2})?$/.test(model) || /^gpt-4(?:o|[.-]|$)/.test(model)) {
            info.temperatureSupport = 'supported'; info.temperatureMax = 2; info.reasoning = false;
        } else if (/^(?:o[134](?:[.-]|$)|gpt-5(?:[.-]|$)|gpt-6(?:[.-]|$))/.test(model)) {
            info.temperatureSupport = 'unsupported'; info.reasoning = true;
        }
    } else if (config.provider === 'anthropic') {
        if (/^claude-(?:opus|sonnet|haiku)-4-[0-6](?:-|$)/i.test(model) || /^claude-3(?:[.-]|$)/i.test(model)) {
            info.temperatureSupport = 'supported'; info.temperatureMax = 1;
        } else if (/^claude-(?:(?:opus|sonnet|haiku)-4-[7-9]|(?:opus|sonnet|haiku)-5|mythos|fable)/i.test(model)) {
            info.temperatureSupport = 'unsupported'; info.reasoning = true;
        }
    }
    return info;
}
function resolveCapabilities(config: AIRequestConfig): ModelInfo {
    const base = baseline(config);
    const cached = getCurrent(metadata, identity(config))?.model;
    if (!cached) return base;
    return { ...base, ...cached, temperatureSupport: base.temperatureSupport === 'unsupported' ? 'unsupported' : cached.temperatureSupport === 'unknown' ? base.temperatureSupport : cached.temperatureSupport };
}
function parseModel(config: AIRequestConfig, item: any): ModelInfo | undefined {
    if (!item || typeof item !== 'object' || item.retired === true || item.status === 'retired' || item.status === 'shutdown' || item.lifecycle?.status === 'retired' || item.lifecycle?.status === 'shutdown') return;
    const raw = config.provider === 'gemini' ? (typeof item.name === 'string' ? item.name.replace(/^models\//, '') : undefined) : item.id;
    if (typeof raw !== 'string' || !raw.trim()) return;
    if (config.provider === 'openai' && /(?:^gpt-image|^dall-e|^whisper|^sora|^davinci|^babbage|transcrib|(?:^|-)tts(?:-|$)|realtime|search|audio|embedding|moderation)/i.test(raw)) return;
    if (config.provider === 'gemini' && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes('generateContent')) return;
    if (config.provider === 'openrouter' && Array.isArray(item.architecture?.output_modalities) && !item.architecture.output_modalities.includes('text')) return;
    const info = baseline({ ...config, model: raw });
    const display = config.provider === 'gemini' ? item.displayName : config.provider === 'anthropic' ? item.display_name : item.name;
    if (typeof display === 'string' && display.trim()) info.name = display;
    if (config.provider === 'gemini') {
        info.generationSupport = Array.isArray(item.supportedGenerationMethods) ? 'supported' : 'unknown';
        if (typeof item.maxTemperature === 'number' && Number.isFinite(item.maxTemperature)) { info.temperatureSupport = 'supported'; info.temperatureMax = item.maxTemperature; }
        if (typeof item.thinking === 'boolean') { info.thinkingSupport = item.thinking; if (!item.thinking) info.reasoning = false; }
        if (Number.isSafeInteger(item.outputTokenLimit) && item.outputTokenLimit > 0) info.outputTokenLimit = item.outputTokenLimit;
    } else if (config.provider === 'anthropic') {
        if (Number.isSafeInteger(item.max_tokens) && item.max_tokens > 0) info.outputTokenLimit = item.max_tokens;
        if (typeof item.capabilities?.thinking?.supported === 'boolean') { info.thinkingSupport = item.capabilities.thinking.supported; if (!info.thinkingSupport) info.reasoning = false; }
    } else if (config.provider === 'openrouter') {
        if (Array.isArray(item.supported_parameters)) {
            info.temperatureSupport = item.supported_parameters.includes('temperature') ? 'supported' : 'unsupported';
            if (item.supported_parameters.includes('reasoning')) info.reasoning = true;
        }
        if (Number.isSafeInteger(item.top_provider?.max_completion_tokens) && item.top_provider.max_completion_tokens > 0) info.outputTokenLimit = item.top_provider.max_completion_tokens;
    }
    return info;
}

export async function listModels(config: AIRequestConfig): Promise<{ models: ModelInfo[]; truncated: boolean }> {
    const base = endpoints(config).models;
    const models: ModelInfo[] = [];
    const ids = new Set<string>(), cursors = new Set<string>();
    const deadline = Date.now() + 20000;
    let cursor: string | undefined, truncated = false;
    for (let page = 0; page < 10; page++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { truncated = true; break; }
        const url = new URL(base);
        if (cursor) url.searchParams.set(config.provider === 'gemini' ? 'pageToken' : 'after_id', cursor);
        const response = await axios.get(url.toString(), { ...requestOptions(config), timeout: Math.min(remaining, 20000) });
        const data = response.data;
        const items = config.provider === 'gemini' ? data?.models : data?.data;
        if (!Array.isArray(items)) throw new Error('Invalid models response');
        for (const item of items) {
            const model = parseModel(config, item);
            if (model && !ids.has(model.id)) {
                if (models.length >= 2000) { truncated = true; break; }
                ids.add(model.id); models.push(model);
                put(metadata, identity({ ...config, model: model.id }), { expires: Date.now() + TTL, model }, 2000);
            }
        }
        if (truncated) break;
        const next = config.provider === 'gemini' ? data?.nextPageToken
            : config.provider === 'anthropic' && data?.has_more ? data.last_id : undefined;
        if (config.provider === 'anthropic' && data?.has_more === true && (typeof next !== 'string' || !next.trim())) { truncated = true; break; }
        if (!next) break;
        if (typeof next !== 'string' || cursors.has(next)) { truncated = true; break; }
        cursors.add(next); cursor = next;
        if (page === 9) truncated = true;
    }
    return { models, truncated };
}

export async function testConnection(config: AIRequestConfig): Promise<{ success: boolean; message: string }> {
    try {
        const result = await listModels(config);
        const found = result.models.some(item => item.id === config.model);
        const catalog = config.provider === 'openrouter' ? 'Model catalog reachable; key validity not confirmed.' : 'Model catalog reachable.';
        const selection = config.model ? `Selected model ${found ? 'is listed' : 'was not found in this list'}.` : 'No model selected.';
        return { success: true, message: `${catalog} ${selection}${result.truncated ? ' Catalog results are partial.' : ''} Generation was not tested.` };
    } catch (error: any) { return { success: false, message: extractAPIError(error) }; }
}

class OutputError extends Error {}
function parseResponse(provider: string, data: any, probe: boolean): AIResponse {
    let parts: any[], reason: string | undefined;
    if (provider === 'anthropic') { parts = data?.content || []; reason = data?.stop_reason; }
    else if (provider === 'gemini') { parts = data?.candidates?.[0]?.content?.parts || []; reason = data?.candidates?.[0]?.finishReason; }
    else { const choice = data?.choices?.[0]; reason = choice?.finish_reason; parts = Array.isArray(choice?.message?.content) ? choice.message.content : [{type:'text', text:choice?.message?.content}]; }
    if (!Array.isArray(parts)) throw new OutputError('No text returned by model');
    const text = parts.filter(p => p && !p.thought && (p.type === 'text' || !p.type) && typeof p.text === 'string').map(p => p.text).join('');
    if (reason && !['stop', 'end_turn', 'stop_sequence', 'STOP', 'length', 'max_tokens', 'MAX_TOKENS'].includes(reason)) throw new OutputError('Model response was blocked or incomplete');
    if (!text.trim()) throw new OutputError('No text returned by model; check token limit or model access');
    if (!probe && ['length', 'max_tokens', 'MAX_TOKENS'].includes(reason || '')) throw new OutputError('Response was truncated; increase the token limit');
    return { text, usage: provider === 'anthropic' ? { promptTokens: data?.usage?.input_tokens, completionTokens: data?.usage?.output_tokens }
        : provider === 'gemini' ? { promptTokens: data?.usageMetadata?.promptTokenCount, completionTokens: data?.usageMetadata?.candidatesTokenCount }
        : { promptTokens: data?.usage?.prompt_tokens, completionTokens: data?.usage?.completion_tokens } };
}
function tempUnsupported(error: any): boolean {
    const detail = error?.response?.data?.error;
    return error?.response?.status === 400 && detail?.code === 'unsupported_parameter' && detail?.param === 'temperature';
}
function generationParameters(config: AIRequestConfig, probe: boolean, omitTemperature: boolean) {
    if (!config.model.trim()) throw new OutputError('Select a model in settings');
    const capabilities = resolveCapabilities(config);
    if (omitTemperature) capabilities.temperatureSupport = 'unsupported';
    const temperature = config.temperature ?? 0.7;
    const temperatureIncluded = capabilities.temperatureSupport !== 'unsupported' && !(config.provider === 'anthropic' && capabilities.temperatureSupport === 'unknown');
    const maxTokens = probe ? Math.min(capabilities.reasoning === false ? 1 : 128, capabilities.outputTokenLimit ?? 128) : (config.maxTokens ?? 4096);
    if (temperatureIncluded && (!Number.isFinite(temperature) || temperature < 0 || (capabilities.temperatureMax !== undefined && temperature > capabilities.temperatureMax) || temperature > 2)) throw new OutputError('Temperature is outside the supported range');
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || (capabilities.outputTokenLimit !== undefined && maxTokens > capabilities.outputTokenLimit)) throw new OutputError('Token limit is outside the supported range');
    const usedParameters = { maxTokens, temperatureIncluded, ...(temperatureIncluded ? { temperature } : {}) };
    return { capabilities, usedParameters };
}

async function generate(system: string, user: string, config: AIRequestConfig, probe: boolean, parameters: ReturnType<typeof generationParameters>['usedParameters']): Promise<AIResponse> {
    const { maxTokens: tokenLimit, temperatureIncluded: includeTemp, temperature } = parameters;
    const body = config.provider === 'anthropic' ? { model: config.model, system, messages:[{role:'user',content:user}], max_tokens:tokenLimit, ...(includeTemp ? {temperature} : {}) }
        : config.provider === 'gemini' ? { contents:[{parts:[{text:user}]}], systemInstruction:{parts:[{text:system}]}, generationConfig:{maxOutputTokens:tokenLimit, ...(includeTemp ? {temperature} : {})} }
        : { model:config.model, messages:[{role:'system',content:system},{role:'user',content:user}], ...(config.provider === 'custom' ? {max_tokens:tokenLimit} : {max_completion_tokens:tokenLimit}), ...(includeTemp ? {temperature} : {}) };
    const options = requestOptions(config);
    if (probe) options.timeout = Math.min(options.timeout, 25000);
    const response = await axios.post(endpoints(config).generate, body, options);
    return parseResponse(config.provider, response.data, probe);
}

export async function callAI(systemPrompt: string, userPrompt: string, config: AIRequestConfig): Promise<AIResponse> {
    try {
        const omitTemperature = !!getCurrent(unsupportedTemperature, identity(config));
        const { usedParameters } = generationParameters(config, false, omitTemperature);
        return await generate(systemPrompt, userPrompt, config, false, usedParameters);
    }
    catch (error: any) { if (error instanceof OutputError) throw error; throw new Error(extractAPIError(error)); }
}

export async function testGeneration(config: AIRequestConfig): Promise<{ success: boolean; status: 'verified'|'inconclusive'|'error'; message: string; capabilities?: ModelInfo; usedParameters?: Record<string,string|number|boolean> }> {
    const key = identity(config);
    let omit = !!getCurrent(unsupportedTemperature, key);
    for (let attempt = 0; attempt < 2; attempt++) {
        let sentTemperature = false;
        try {
            const { capabilities, usedParameters } = generationParameters(config, true, omit);
            sentTemperature = usedParameters.temperatureIncluded;
            await generate('You are a helpful assistant.', 'Reply with OK.', config, true, usedParameters);
            if (attempt > 0) put(unsupportedTemperature, key, { expires: Date.now() + TTL });
            return {success:true,status:'verified',message: config.provider === 'custom' ? 'Generation returned visible text; normal token limit was not tested and endpoint enforcement is unverified.' : 'Generation returned visible text; normal token limit was not tested.',capabilities,usedParameters};
        } catch (error: any) {
            if (attempt === 0 && config.provider !== 'custom' && !omit && sentTemperature && tempUnsupported(error)) { omit = true; continue; }
            if (error instanceof OutputError && error.message.startsWith('No text')) return {success:false,status:'inconclusive',message:'Request accepted but no visible text was returned; generation remains unverified.'};
            return {success:false,status:'error',message:error instanceof OutputError ? error.message : extractAPIError(error)};
        }
    }
    return {success:false,status:'error',message:'Generation test failed'};
}

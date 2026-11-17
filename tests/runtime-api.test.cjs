const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTS } = require('./helpers.cjs');

test('built-in requests ignore stale custom URL and reject redirects', async () => {
  const calls = [];
  const axios = { post: async (...args) => { calls.push(args); return {data:{choices:[{message:{content:'ok'}}]}}; } };
  const { callAI } = loadTS('src/api-client.ts', { 'node:crypto': require('node:crypto'), axios });
  await callAI('s', 'u', {provider:'openai',apiKey:'secret',model:'m',baseUrl:'https://evil.example'});
  assert.equal(calls[0][0], 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0][2].maxRedirects, 0);
});

test('custom URL normalization and read-only connection test', async () => {
  const calls = [];
  const axios = { get: async (...args) => { calls.push(args); return {data:{data:[{id:'m'}]}}; } };
  const { testConnection } = loadTS('src/api-client.ts', { 'node:crypto': require('node:crypto'), axios });
  const result = await testConnection({provider:'custom',apiKey:'secret',model:'m',baseUrl:'https://example.com/proxy/v1/chat/completions/?x=1'});
  assert.equal(calls[0][0], 'https://example.com/proxy/v1/models?x=1');
  assert.equal(result.success, true);
});

test('all built-in providers use fixed generation and model-list origins', async () => {
  const requests = [];
  const axios = {
    post: async (url, body, opts) => { requests.push({url,opts}); return {data:{choices:[{message:{content:'ok'}}],content:[{text:'ok'}],candidates:[{content:{parts:[{text:'ok'}]}}]}}; },
    get: async (url,opts) => { requests.push({url,opts}); return {data:{data:[],models:[]}}; }
  };
  const {callAI,testConnection} = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios});
  for (const [provider, origin] of [['openai','https://api.openai.com/'], ['anthropic','https://api.anthropic.com/'], ['gemini','https://generativelanguage.googleapis.com/'], ['openrouter','https://openrouter.ai/']]) {
    const config = {provider,apiKey:'secret',model:'x/y?z',baseUrl:'https://evil.example'};
    await callAI('system','input',config);
    await testConnection(config);
    for (const request of requests.splice(0)) {
      assert.ok(request.url.startsWith(origin));
      assert.equal(request.opts.maxRedirects,0);
      if (provider === 'gemini' && request.url.includes(':generateContent')) assert.match(request.url,/x%2Fy%3Fz:generateContent/);
    }
  }
});

test('invalid custom URLs fail without sending requests and error text is sanitized', async () => {
  const axios = {get:async()=>{throw new Error('secret https://secret.example');}};
  const {testConnection} = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios});
  const bad = await testConnection({provider:'custom',apiKey:'secret',model:'m',baseUrl:'file:///etc/passwd'});
  assert.equal(bad.success,false);
  assert.equal(bad.message,'Invalid custom base URL');
  const error = await testConnection({provider:'openai',apiKey:'secret',model:'m'});
  assert.equal(error.message,'Unable to reach API');
});

test('custom endpoint resolution preserves legacy paths, query and endpoint casing', async () => {
  const calls = [];
  const axios = {
    post: async (url) => { calls.push(url); return {data:{choices:[{message:{content:'ok'}}]}}; },
    get: async (url) => { calls.push(url); return {data:{data:[]}}; }
  };
  const {callAI,testConnection} = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios});
  for (const [path, generation, models] of [
    ['/', '/chat/completions', '/models'],
    ['/proxy/v1', '/proxy/v1/chat/completions', '/proxy/v1/models'],
    ['/generate', '/generate', '/models'],
    ['/proxy/generate', '/proxy/generate', '/proxy/models'],
    ['/v1/Chat/Completions', '/v1/Chat/Completions', '/v1/models'],
    ['/v1/chat/completions/', '/v1/chat/completions/', '/v1/models']
  ]) {
    const config = {provider:'custom',apiKey:'key',model:'m',baseUrl:`https://example.com${path}?x=1#fragment`};
    await callAI('s','u',config);
    await testConnection(config);
    assert.deepEqual(calls.splice(0), [`https://example.com${generation}?x=1`, `https://example.com${models}?x=1`]);
  }
});

test('OpenAI GPT-6 reasoning models omit temperature while other providers retain it', async () => {
  const requests = [];
  const axios = {post:async (url, body) => {
    requests.push(body);
    if (url.startsWith('https://api.openai.com/') && body.model.startsWith('gpt-6') && Object.hasOwn(body, 'temperature')) throw {response:{status:400,data:{error:{code:'unsupported_parameter',param:'temperature'}}}};
    return {data:{choices:[{message:{content:'ok'}}]}};
  }};
  const {callAI} = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios});
  for (const model of ['gpt-6.1-terra','gpt-6.1-terra-2026-11-01','gpt-6-astra']) {
    await callAI('s','u',{provider:'openai',apiKey:'key',model,temperature:0});
    assert.equal(Object.hasOwn(requests.at(-1),'temperature'),false);
  }
  await callAI('s','u',{provider:'openai',apiKey:'key',model:'gpt-4o',temperature:0});
  assert.equal(requests.at(-1).temperature,0);
  for (const provider of ['custom','openrouter']) {
    await callAI('s','u',{provider,apiKey:'key',model:'gpt-6.1-terra',baseUrl:'https://example.com/v1',temperature:0});
    assert.equal(requests.at(-1).temperature,0);
  }
});

test('HTTP 400 diagnostics only disclose allowlisted error codes and parameters', async () => {
  let errorData = {error:{code:'unsupported_parameter',param:'temperature',message:'secret prompt'}};
  const axios = {post:async()=>{throw {response:{status:400,data:errorData}};}};
  const {callAI} = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios});
  const config = {provider:'openai',apiKey:'key',model:'m'};
  await assert.rejects(callAI('s','u',config), e => e.message === 'HTTP 400: unsupported_parameter (temperature)');
  errorData = {error:{code:'secret-code',param:'secret-param',message:'secret prompt'}};
  await assert.rejects(callAI('s','u',config), e => e.message === 'HTTP 400');
});

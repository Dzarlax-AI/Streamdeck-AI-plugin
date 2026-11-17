const { test } = require('node:test');
const assert = require('node:assert/strict');
const {loadTS} = require('./helpers.cjs');

test('generation probe uses fixed prompt and low nonreasoning budget', async () => {
  let body;
  const api = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async (_url,b)=>{body=b;return {data:{choices:[{message:{content:'O'},finish_reason:'length'}]}};}}});
  const result = await api.testGeneration({provider:'openai',apiKey:'key',model:'gpt-4o',maxTokens:4096});
  assert.equal(result.status,'verified');
  assert.equal(body.max_completion_tokens,1);
  assert.equal(body.messages[1].content,'Reply with OK.');
});

test('normal truncated or empty response cannot become output', async () => {
  const api = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async()=>({data:{choices:[{message:{content:'partial'},finish_reason:'length'}]}})}});
  await assert.rejects(api.callAI('s','u',{provider:'openai',apiKey:'key',model:'gpt-4o'}), /truncat/i);
});

test('Gemini catalog excludes models without generateContent', async () => {
  const api = loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{get:async()=>({data:{models:[{name:'models/gemini-ok',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']}]}})}});
  const result = await api.listModels({provider:'gemini',apiKey:'key',model:'gemini-ok'});
  assert.deepEqual(Array.from(result.models,x=>x.id),['gemini-ok']);
});

test('all providers parse capability metadata and keep unknowns distinct', async () => {
  const fixtures = {
    openai:{data:[{id:'gpt-4o'},{id:'gpt-image-2'},{id:'dall-e-3'},{id:'whisper-1'},{id:'sora-2'},{id:'davinci-002'},{id:'babbage-002'},{id:''}]},
    anthropic:{data:[{id:'claude-sonnet-4-5',display_name:'Sonnet'},{id:'claude-mystery'}]},
    gemini:{models:[{name:'models/gemini-test',displayName:'Gem',maxTemperature:1,outputTokenLimit:900,thinking:true},{name:'models/gemini-unknown'}]},
    openrouter:{data:[{id:'provider/chat',name:'Chat',architecture:{output_modalities:['text']},supported_parameters:['temperature'],top_provider:{max_completion_tokens:300}},{id:'provider/image',architecture:{output_modalities:['image']}}]},
    custom:{data:[{id:'my-model',name:'My Model'}]}
  };
  for (const provider of Object.keys(fixtures)) {
    let options;
    const api=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{get:async (_url,o)=>{options=o;return {data:fixtures[provider]};}}});
    const result=await api.listModels({provider,model:'x',apiKey:'key',baseUrl:'https://example.com/v1'});
    assert.ok(result.models.length > 0);
    if(provider==='openai') assert.deepEqual(Array.from(result.models,m=>m.id),['gpt-4o']);
    if(provider==='anthropic') {assert.equal(result.models[0].temperatureMax,1);assert.equal(result.models[1].temperatureSupport,'unknown');assert.equal(options.headers['anthropic-version'],'2023-06-01');}
    if(provider==='gemini') {assert.equal(result.models[0].outputTokenLimit,900);assert.equal(result.models[0].thinkingSupport,true);assert.equal(result.models[0].reasoning,undefined);assert.equal(result.models[1].temperatureSupport,'unknown');assert.equal(options.headers['x-goog-api-key'],'key');}
    if(provider==='openrouter') {assert.equal(result.models.length,1);assert.equal(result.models[0].outputTokenLimit,300);}
  }
});

test('pagination is bounded and rejects repeated cursors without following URLs', async () => {
  const urls=[];
  const api=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{get:async url=>{urls.push(url);return {data:{models:[{name:'models/m'+urls.length}],nextPageToken:'cursor'}};}}});
  const result=await api.listModels({provider:'gemini',model:'m',apiKey:'k'});
  assert.equal(urls.length,2); assert.equal(result.truncated,true);
  assert.ok(urls.every(url=>new URL(url).origin==='https://generativelanguage.googleapis.com'));
});

test('probe retries only structured unsupported temperature and caches per exact identity', async () => {
  const bodies=[]; let rejectTemp=true;
  const api=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async (_url,body)=>{bodies.push(body);if(rejectTemp && Object.hasOwn(body,'temperature')) throw {response:{status:400,data:{error:{code:'unsupported_parameter',param:'temperature'}}}};return {data:{choices:[{message:{content:'OK'},finish_reason:'stop'}]}};}}});
  const config={provider:'openrouter',baseUrl:'https://example.com/v1',apiKey:'a',model:'m',temperature:0.5,maxTokens:1000};
  assert.equal((await api.testGeneration(config)).status,'verified');
  assert.equal(bodies.length,2); assert.equal(Object.hasOwn(bodies[1],'temperature'),false);
  rejectTemp=false;
  await api.callAI('s','u',config); assert.equal(Object.hasOwn(bodies.at(-1),'temperature'),false);
  await api.callAI('s','u',{...config,apiKey:'b'}); assert.equal(bodies.at(-1).temperature,0.5);
  await api.callAI('s','u',{...config,maxTokens:2000}); assert.equal(Object.hasOwn(bodies.at(-1),'temperature'),false);
  await api.callAI('s','u',{...config,temperature:0.6}); assert.equal(Object.hasOwn(bodies.at(-1),'temperature'),false);
  await api.callAI('s','u',{...config,model:'other'}); assert.equal(bodies.at(-1).temperature,0.5);
});

test('probe reports the parameters it sent even when catalog metadata expires mid-request', async () => {
  let now = 0;
  const api = loadTS('src/api-client.ts', {
    'node:crypto': require('node:crypto'),
    axios: {
      get: async () => ({data: {data: [{id: 'm', supported_parameters: [], top_provider: {max_completion_tokens: 64}}]}}),
      post: async (_url, body) => {
        assert.equal(body.max_completion_tokens, 64);
        assert.equal(Object.hasOwn(body, 'temperature'), false);
        now += 3600001;
        return {data: {choices: [{message: {content: 'OK'}}]}};
      }
    }
  }, '', {Date: {now: () => now}});
  const config = {provider: 'openrouter', apiKey: 'fixture', model: 'm'};
  await api.listModels(config);
  const result = await api.testGeneration(config);
  assert.equal(result.status, 'verified');
  assert.equal(result.usedParameters.maxTokens, 64);
  assert.equal(result.usedParameters.temperatureIncluded, false);
  assert.equal(result.capabilities.outputTokenLimit, 64);
});

test('unauthorized and empty probe results do not retry', async () => {
  let calls=0;
  const api=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async()=>{calls++;throw {response:{status:401}};}}});
  assert.equal((await api.testGeneration({provider:'openai',apiKey:'bad',model:'gpt-4o'})).status,'error'); assert.equal(calls,1);
  const empty=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async()=>({data:{choices:[{message:{content:''},finish_reason:'length'}]}})}});
  assert.equal((await empty.testGeneration({provider:'openai',apiKey:'bad',model:'gpt-4o'})).status,'inconclusive');
});

test('multipart text excludes thinking and rejects truncated responses', async () => {
  let stop='end_turn';
  const api=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async()=>({data:{content:[{type:'thinking',thinking:'secret'},{type:'text',text:'one'},{type:'text',text:'two'}],stop_reason:stop}})}});
  const config={provider:'anthropic',apiKey:'key',model:'claude-sonnet-4-5',temperature:0.5};
  assert.equal((await api.callAI('s','u',config)).text,'onetwo');
  stop='max_tokens'; await assert.rejects(api.callAI('s','u',config),/truncated/);
});

test('catalog caps ten pages and two thousand models', async () => {
  let count=0;
  const pages=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{get:async()=>({data:{data:[{id:'m'+ ++count}],has_more:true,last_id:'cursor'+count}})}});
  const paginated=await pages.listModels({provider:'anthropic',apiKey:'k',model:'m'});
  assert.equal(count,10); assert.equal(paginated.truncated,true);
  const batch=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{get:async()=>({data:{data:Array.from({length:2001},(_,i)=>({id:'m'+i}))}})}});
  const limited=await batch.listModels({provider:'custom',apiKey:'k',model:'m',baseUrl:'https://example.com/v1'});
  assert.equal(limited.models.length,2000); assert.equal(limited.truncated,true);
});

test('OpenAI GPT-5.1 and GPT-5.2 allow temperature while Claude policy stays conservative', async () => {
  const requests=[];
  const api=loadTS('src/api-client.ts',{'node:crypto': require('node:crypto'),axios:{post:async (_url,body)=>{requests.push(body);return {data:body.messages && body.system ? {content:[{type:'text',text:'ok'}],stop_reason:'end_turn'} : {choices:[{message:{content:'ok'},finish_reason:'stop'}]}};}}});
  for (const model of ['gpt-5.1','gpt-5.2-2025-12-11']) {
    await api.callAI('s','u',{provider:'openai',apiKey:'k',model,temperature:0}); assert.equal(requests.at(-1).temperature,0);
  }
  for (const model of ['claude-opus-4-7','claude-fable-5','claude-unknown']) {
    await api.callAI('s','u',{provider:'anthropic',apiKey:'k',model,temperature:0.5}); assert.equal(Object.hasOwn(requests.at(-1),'temperature'),false);
  }
  await assert.rejects(api.callAI('s','u',{provider:'anthropic',apiKey:'k',model:'claude-sonnet-4-5',temperature:1.5}),/range/);
});


test('custom uses max_tokens and never retries unsupported temperature', async () => {
  const bodies=[];
  const api=loadTS('src/api-client.ts',{'node:crypto':require('node:crypto'),axios:{post:async (_url,body)=>{bodies.push(body);throw {response:{status:400,data:{error:{code:'unsupported_parameter',param:'temperature'}}}};}}});
  const result=await api.testGeneration({provider:'custom',baseUrl:'https://example.com/v1',apiKey:'a',model:'m'});
  assert.equal(result.status,'error'); assert.equal(bodies.length,1); assert.equal(bodies[0].max_tokens,128); assert.equal(Object.hasOwn(bodies[0],'max_completion_tokens'),false);
});

test('probe validates its own budget, not normal limit or omitted temperature', async () => {
  let body;
  const api=loadTS('src/api-client.ts',{'node:crypto':require('node:crypto'),axios:{get:async()=>({data:{data:[{id:'claude-opus-4-7',max_tokens:64,capabilities:{thinking:{supported:true}}}]}}),post:async (_url,b)=>{body=b;return {data:{content:[{type:'text',text:'O'}],stop_reason:'max_tokens'}};}}});
  const config={provider:'anthropic',apiKey:'k',model:'claude-opus-4-7',maxTokens:10000,temperature:9};
  const catalog=await api.listModels(config);
  assert.equal(catalog.models[0].outputTokenLimit,64); assert.equal(catalog.models[0].thinkingSupport,true);
  const result=await api.testGeneration(config); assert.equal(result.status,'verified'); assert.equal(body.max_tokens,64); assert.match(result.message,/normal token limit was not tested/);
  await assert.rejects(api.callAI('s','u',config),/Token limit/);
});

test('retired lifecycle and malformed Anthropic pagination are handled safely', async () => {
  const api=loadTS('src/api-client.ts',{'node:crypto':require('node:crypto'),axios:{get:async()=>({data:{data:[{id:'retired',lifecycle:{status:'retired'}},{id:'active'}],has_more:true}})}});
  const config={provider:'anthropic',apiKey:'k',model:'active'};
  const result=await api.listModels(config); assert.equal(result.truncated,true); assert.deepEqual(Array.from(result.models,x=>x.id),['active']);
  assert.match((await api.testConnection(config)).message,/partial/);
});

test('malformed catalog names and nonfinite or fractional token limits are ignored', async () => {
  const fixtures = {
    gemini: {models:[{name:42},{name:{}},{name:'models/valid',outputTokenLimit:Infinity},{name:'models/fractional',outputTokenLimit:2.5}]},
    anthropic: {data:[{id:'valid',max_tokens:Infinity},{id:'fractional',max_tokens:2.5}]},
    openrouter: {data:[{id:'valid',top_provider:{max_completion_tokens:Infinity}},{id:'fractional',top_provider:{max_completion_tokens:2.5}}]}
  };
  for (const [provider,data] of Object.entries(fixtures)) {
    const api=loadTS('src/api-client.ts',{'node:crypto':require('node:crypto'),axios:{get:async()=>({data})}});
    const result=await api.listModels({provider,apiKey:'k',model:'valid'});
    assert.equal(result.models.length,2);
    assert.ok(result.models.every(model=>model.outputTokenLimit === undefined));
  }
});

test('generation probe caps request timeout while normal action keeps configured timeout', async () => {
  const timeouts=[];
  const api=loadTS('src/api-client.ts',{'node:crypto':require('node:crypto'),axios:{post:async (_url,_body,options)=>{timeouts.push(options.timeout);return {data:{choices:[{message:{content:'OK'},finish_reason:'stop'}]}};}}});
  const config={provider:'openai',apiKey:'key',model:'gpt-4o',timeout:120};
  assert.equal((await api.testGeneration(config)).status,'verified');
  await api.callAI('s','u',config);
  assert.deepEqual(timeouts,[25000,120000]);
});

test('catalog larger than one hundred entries retains metadata for early selected models', async () => {
  let body;
  const models=Array.from({length:150},(_,i)=>({id:'m'+i,supported_parameters:i===0?[]:['temperature']}));
  const api=loadTS('src/api-client.ts',{'node:crypto':require('node:crypto'),axios:{get:async()=>({data:{data:models}}),post:async (_url,b)=>{body=b;return {data:{choices:[{message:{content:'ok'},finish_reason:'stop'}]}};}}});
  const config={provider:'openrouter',apiKey:'key',model:'m0'};
  await api.listModels(config);
  await api.callAI('s','u',config);
  assert.equal(Object.hasOwn(body,'temperature'),false);
});

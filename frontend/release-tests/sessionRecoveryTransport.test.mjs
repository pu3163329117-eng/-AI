import test from 'node:test'
import assert from 'node:assert/strict'
import { importSource } from './import-source.mjs'
const { RequestError, requestJson, setPrivateWritesSuspended, privateWritesAreSuspended, configureAuthTransport } = await importSource('http.ts')

test('sealed transport rejects private writes before fetch but permits session revalidation', async () => {
  const original=globalThis.fetch, calls=[]
  globalThis.fetch=async (url, init) => { calls.push([url,init.method??'GET']); return new Response('{"ok":true}',{status:200}) }
  try {
    configureAuthTransport('synthetic-csrf'); setPrivateWritesSuspended(true); assert.equal(privateWritesAreSuspended(),true)
    await assert.rejects(requestJson('/api/v1/training/sessions/a/commands',{method:'POST'}), error => error instanceof RequestError && error.message==='AUTH_REVALIDATION_PENDING')
    assert.deepEqual(calls,[]); await requestJson('/api/v1/auth/session'); assert.deepEqual(calls,[['/api/v1/auth/session','GET']])
    setPrivateWritesSuspended(false); await requestJson('/api/v1/training/sessions/a/commands',{method:'POST'}); assert.equal(calls.length,2)
  } finally { setPrivateWritesSuspended(false); configureAuthTransport(null); globalThis.fetch=original }
})

test('a late success from the previous identity cannot publish after a session change', async () => {
  const original=globalThis.fetch
  let resolveFetch
  globalThis.fetch=()=>new Promise(resolve=>{resolveFetch=resolve})
  try {
    setPrivateWritesSuspended(false); configureAuthTransport('synthetic-old')
    const pending=requestJson('/api/v1/training/sessions/a')
    configureAuthTransport('synthetic-new')
    resolveFetch(new Response('{"old":"private"}',{status:200}))
    await assert.rejects(pending, error=>error instanceof RequestError && error.message==='SESSION_CHANGED')
  } finally {configureAuthTransport(null); globalThis.fetch=original}
})

test('401 expires the identity before even a stalled error body can publish old results', async () => {
  const original=globalThis.fetch, {subscribeAuthExpiry}=await importSource('http.ts')
  let release,expired=false
  const stalled=new Promise(resolve=>{release=resolve})
  const unsubscribe=subscribeAuthExpiry(()=>{expired=true;setPrivateWritesSuspended(true);configureAuthTransport(null)})
  globalThis.fetch=async()=>({status:401,ok:false,json:()=>stalled})
  try {
    configureAuthTransport('synthetic-csrf');setPrivateWritesSuspended(false)
    const pending=requestJson('/api/v1/training/sessions/a/commands',{method:'POST'})
    await new Promise(resolve=>setImmediate(resolve));assert.equal(expired,true);assert.equal(privateWritesAreSuspended(),true)
    release({error:{code:'AUTH_REQUIRED'}})
    await assert.rejects(pending,error=>error instanceof RequestError && error.message==='SESSION_CHANGED')
  } finally {unsubscribe();setPrivateWritesSuspended(false);configureAuthTransport(null);globalThis.fetch=original}
})

test('unknown creation blocks all direct creation routes before fetch but allows reads and unrelated writes',async()=>{
 const {setCreationWritesBlocked}=await importSource('http.ts'),original=globalThis.fetch,calls=[]
 globalThis.fetch=async(url,init)=>{calls.push([url,init.method??'GET']);return new Response('{"ok":true}',{status:200})}
 try {
  setPrivateWritesSuspended(false);setCreationWritesBlocked(true)
  for(const url of ['/api/v1/profiles','/api/v1/training/sessions','/api/v1/profiles/synthetic/recommendations/task/start']) await assert.rejects(requestJson(url,{method:'POST'}),e=>e instanceof RequestError && e.message==='CREATION_OUTCOME_PENDING')
  assert.deepEqual(calls,[]);await requestJson('/api/v1/auth/session');await requestJson('/api/v1/training/sessions/existing/commands',{method:'POST'});assert.equal(calls.length,2)
  setCreationWritesBlocked(false);await requestJson('/api/v1/training/sessions',{method:'POST'});assert.equal(calls.length,3)
 } finally {setCreationWritesBlocked(false);globalThis.fetch=original}
})

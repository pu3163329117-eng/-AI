import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { importSource } from './import-source.mjs'
const { executeTrainingCommand } = await importSource('trainingCommandOutcome.ts')
const { RequestError, uncertainWrite, setPrivateWritesSuspended, privateWritesAreSuspended } = await importSource('http.ts')
const src = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('App.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let callback
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'runCommand' && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(tree) === 'useCallback') callback=node.initializer.arguments[0]
  ts.forEachChild(node,visit)
}
visit(tree); assert.ok(callback, 'actual App runCommand callback exists')
const wrapper = `export function build(h) { const {privateWritesAreSuspended, executeTrainingCommand, mounted, commandContext, operationLock, commandOwner, setPendingCommand, setBusy, setError, trainingApi, RequestError, uncertainIntent, setUncertainCommand, setSession, setProfile, uncertainWrite, errorMessage} = h; return ${callback.getText(tree)} }`
const js=ts.transpileModule(wrapper,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {build}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))

test('actual App executor keeps the original unknown key while sealed and explicitly replays it after revalidation',async()=>{
 const intent={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{reason:'合成草稿'},key:'original-synthetic-key'}, sent=[]
 const context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'synthetic-profile',session:{state_version:1,profile_id:'synthetic-profile'}}}
 let fail=true, stored=null
 const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},
  setPendingCommand(){},setBusy(){},setError(){},trainingApi:{async command(id,version,type,payload,key){sent.push(key);if(fail)throw new RequestError('NETWORK_ERROR');return {session:{state_version:2,profile_id:'synthetic-profile'}}}},
  RequestError,uncertainIntent:{current:null},setUncertainCommand(value){stored=value},setSession(){},setProfile(){},uncertainWrite,errorMessage:e=>e.message}
 const run=build(h)
 try {
  setPrivateWritesSuspended(false); assert.equal((await run(intent)).status,'unknown'); assert.equal(stored.key,intent.key); assert.deepEqual(sent,[intent.key])
  setPrivateWritesSuspended(true); assert.equal((await run(stored)).status,'blocked'); assert.equal(stored.key,intent.key); assert.deepEqual(sent,[intent.key])
  fail=false; setPrivateWritesSuspended(false); assert.equal((await run(stored)).status,'confirmed'); assert.equal(stored,null); assert.deepEqual(sent,[intent.key,intent.key])
 } finally {setPrivateWritesSuspended(false)}
})

test('a first command completing while sealed cannot start the next command', async () => {
 const sent=[], context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'synthetic-profile',session:{state_version:1,profile_id:'synthetic-profile'}}}
 let resolveFirst
 const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},
  setPendingCommand(){},setBusy(){},setError(){},trainingApi:{command(id,version,type){sent.push(type);return new Promise(resolve=>{resolveFirst=resolve})}},
  RequestError,uncertainIntent:{current:null},setUncertainCommand(){},setSession(s){context.current.session=s},setProfile(){},uncertainWrite,errorMessage:e=>e.message}
 const run=build(h), first={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{},key:'synthetic-first'}
 try {
  setPrivateWritesSuspended(false); const pending=run(first); assert.deepEqual(sent,['SAVE_REASONING'])
  setPrivateWritesSuspended(true); resolveFirst({session:{state_version:2,profile_id:'synthetic-profile'}})
  assert.equal((await pending).status,'confirmed')
  assert.equal((await run({...first,version:2,type:'SUBMIT_ATTEMPT',key:'synthetic-second'})).status,'blocked')
  assert.deepEqual(sent,['SAVE_REASONING'])
 } finally {setPrivateWritesSuspended(false)}
})

test('unknown command followed by a replay 409 keeps its original key and does not refresh away the pending intent', async () => {
 const sent=[], intent={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{reason:'synthetic-draft'},key:'synthetic-unknown-key'}
 const context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'synthetic-profile',session:{state_version:1,profile_id:'synthetic-profile'}}}
 let stored=null, mode='lost', reads=0
 const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},
  setPendingCommand(){},setBusy(){},setError(){},trainingApi:{async command(id,version,type,payload,key){sent.push(key);if(mode==='lost')throw new RequestError('NETWORK_ERROR');if(mode==='conflict')throw new RequestError('VERSION_CONFLICT',409);return {session:{state_version:2,profile_id:'synthetic-profile'}}}, async getSession(){reads++;return {session:{state_version:2,profile_id:'synthetic-profile'}}}},
  RequestError,uncertainIntent:{current:null},setUncertainCommand(value){stored=value},setSession(){},setProfile(){},uncertainWrite,errorMessage:e=>e.message}
 try {
  setPrivateWritesSuspended(false);const run=build(h);assert.equal((await run(intent)).status,'unknown');assert.equal(stored.key,intent.key)
  mode='conflict';assert.equal((await run(stored)).status,'unknown');assert.equal(stored.key,intent.key);assert.equal(h.uncertainIntent.current,intent);assert.equal(reads,0)
  mode='success';assert.equal((await run(stored)).status,'confirmed');assert.equal(stored,null);assert.deepEqual(sent,[intent.key,intent.key,intent.key])
 } finally {setPrivateWritesSuspended(false)}
})

test('every replay 4xx after unknown keeps the same intent, payload and key; valid receipt alone clears it', async () => {
 for (const [code,status] of [['VERSION_CONFLICT',409],['FORBIDDEN',403],['NOT_FOUND',404],['RATE_LIMITED',429]]) {
  const intent={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{reason:'synthetic-draft'},key:'synthetic-key'}, sent=[]
  const context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'synthetic-profile',session:{state_version:1,profile_id:'synthetic-profile'}}}
  let pending=null, stage='lost', reads=0, lastError=''
  const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},setPendingCommand(){},setBusy(){},setError(v){lastError=v},
   trainingApi:{async command(id,version,type,payload,key){sent.push({id,version,type,payload,key});if(stage==='lost')throw new RequestError('NETWORK_ERROR');if(stage==='reject')throw new RequestError(code,status);return {session:{state_version:2,profile_id:'synthetic-profile'}}},async getSession(){reads++}},
   RequestError,uncertainIntent:{current:null},setUncertainCommand(v){pending=v},setSession(){},setProfile(){},uncertainWrite,errorMessage:e=>e.message}
  try {
   setPrivateWritesSuspended(false);const run=build(h);assert.equal((await run(intent)).status,'unknown')
   stage='reject';for(let i=0;i<2;i++){assert.equal((await run(pending)).status,'unknown');assert.equal(pending,intent);assert.equal(h.uncertainIntent.current,intent);assert.match(lastError,/仍未确认/)}
   assert.equal(reads,0);assert.equal(sent.length,3);assert.ok(sent.every(x=>x.key===intent.key && x.payload===intent.payload && x.version===intent.version))
   stage='success';assert.equal((await run(pending)).status,'confirmed');assert.equal(pending,null);assert.equal(sent.length,4)
  } finally {setPrivateWritesSuspended(false)}
 }
})

test('first-attempt ordinary 4xx stays definitive, with no unknown recovery', async () => {
 for (const [code,status] of [['FORBIDDEN',403],['NOT_FOUND',404],['RATE_LIMITED',429]]) {
  const intent={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{},key:'first-key'}, context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'synthetic-profile',session:{state_version:1,profile_id:'synthetic-profile'}}}
  let pending=null, writes=0
  const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},setPendingCommand(){},setBusy(){},setError(){},trainingApi:{async command(){writes++;throw new RequestError(code,status)}},RequestError,uncertainIntent:{current:null},setUncertainCommand(v){pending=v},setSession(){},setProfile(){},uncertainWrite,errorMessage:e=>e.message}
  try {setPrivateWritesSuspended(false);assert.equal((await build(h)(intent)).status,'definitive_failure');assert.equal(pending,null);assert.equal(writes,1)} finally {setPrivateWritesSuspended(false)}
 }
})

test('a replay result arriving after identity unmount or session change cannot publish or clear another tree', async () => {
 for (const code of ['AUTH_REQUIRED','SESSION_CHANGED']) {
  const intent={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{},key:'old-identity-key'}, context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'old-profile',session:{state_version:1,profile_id:'old-profile'}}}
  let pending=intent, published=0
  const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},setPendingCommand(){},setBusy(){},setError(){published++},trainingApi:{async command(){h.mounted.current=false;throw new RequestError(code,code==='AUTH_REQUIRED'?401:409)}},RequestError,uncertainIntent:{current:intent},setUncertainCommand(){published++},setSession(){published++},setProfile(){published++},uncertainWrite,errorMessage:e=>e.message}
  try {setPrivateWritesSuspended(false);assert.equal((await build(h)(pending)).status,'stale');assert.equal(published,1,'only initial clear-error callback occurs before request')} finally {setPrivateWritesSuspended(false)}
 }
})

test('first-attempt 409 still performs conflict handling instead of unknown recovery', async () => {
 const intent={sessionId:'synthetic',version:1,type:'SAVE_REASONING',payload:{},key:'first-conflict-key'}, context={current:{page:'training',routeSessionId:'synthetic',sessionId:'synthetic',profileId:'synthetic-profile',session:{state_version:1,profile_id:'synthetic-profile'}}}
 let pending=null, reads=0, writes=0
 const h={privateWritesAreSuspended,executeTrainingCommand,mounted:{current:true},commandContext:context,operationLock:{current:false},commandOwner:{current:null},setPendingCommand(){},setBusy(){},setError(){},trainingApi:{async command(){writes++;throw new RequestError('VERSION_CONFLICT',409)},async getSession(){reads++;return {session:{state_version:2,profile_id:'synthetic-profile'}}}},RequestError,uncertainIntent:{current:null},setUncertainCommand(v){pending=v},setSession(){},setProfile(){},uncertainWrite,errorMessage:e=>e.message}
 try {setPrivateWritesSuspended(false);assert.equal((await build(h)(intent)).status,'definitive_failure');assert.equal(pending,null);assert.equal(writes,1);assert.equal(reads,1)} finally {setPrivateWritesSuspended(false)}
})

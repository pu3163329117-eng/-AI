import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { importSource } from './import-source.mjs'
const { RequestError, uncertainWrite, privateWritesAreSuspended, setPrivateWritesSuspended, setCreationWritesBlocked } = await importSource('http.ts')
const src=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8')
const tree=ts.createSourceFile('App.tsx',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
let callback
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)==='start'&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(tree)==='useCallback')callback=n.initializer.arguments[0];ts.forEachChild(n,visit)}
visit(tree);assert.ok(callback)
const wrapper=`export function build(h) { const {operationLock, profile, setPage, exitRisk, startConfirmation, setBusy, setError, trainingApi, setSessionId, setSession, uncertainWrite, RequestError, privateWritesAreSuspended, authResponseCheckpoint, mounted, commandContext, createPendingRef, setCreatePending, setCreateSessions, setCreateReadError, errorMessage, profilePendingRef, setCreationWritesBlocked} = h; const start=${callback.getText(tree)};return start }`
const js=ts.transpileModule(wrapper,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {build}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))
function host(){let pending=null,posts=0;const profile={id:'synthetic-profile'};const h={operationLock:{current:false},profile,setPage(){},exitRisk:{current:null},startConfirmation:{ask(){}},setBusy(){},setError(){},trainingApi:{async createSession(){posts++;throw new RequestError('NETWORK_ERROR')}},setSessionId(){},setSession(){},uncertainWrite,RequestError,privateWritesAreSuspended,authResponseCheckpoint:()=>()=>{},mounted:{current:true},commandContext:{current:{profileId:profile.id}},createPendingRef:{current:null},profilePendingRef:{current:null},setCreationWritesBlocked,setCreatePending(v){pending=v},setCreateSessions(){},setCreateReadError(){},errorMessage:e=>e.message};return {h,get posts(){return posts},get pending(){return pending}}}
test('lost create response must lock subsequent start attempts without retry',async()=>{const f=host();setPrivateWritesSuspended(false);const start=build(f.h);await start('synthetic-lesson');await start('synthetic-lesson');assert.equal(f.posts,1);assert.equal(f.pending?.lessonId,'synthetic-lesson')})


test('unknown errors and retryable HTTP outcomes retain intent and block every new create', async () => {
 for (const [code,status] of [['NETWORK_ERROR',0],['REQUEST_TIMEOUT',0],['INVALID_RESPONSE',200],['SERVER_UNAVAILABLE',503],['REQUEST_FAILED',408],['REQUEST_FAILED',429]]) {
  const f=host();let posts=0;f.h.trainingApi.createSession=async()=>{posts++;throw new RequestError(code,status)}
  const start=build(f.h);setPrivateWritesSuspended(false);await start('synthetic-lesson');await start('other-lesson');assert.equal(posts,1);assert.equal(f.pending.profileId,'synthetic-profile');assert.equal(f.pending.lessonId,'synthetic-lesson');assert.equal(f.h.exitRisk.current,'uncertain')
 }
})
test('first definitive 4xx releases the start lock without inventing an unknown operation',async()=>{
 for (const status of [400,403,404,409]) { const f=host();let calls=0;f.h.trainingApi.createSession=async()=>{calls++;throw new RequestError('REJECTED',status)};const start=build(f.h);await start('a');await start('a');assert.equal(calls,2);assert.equal(f.pending,null);assert.equal(f.h.operationLock.current,false) }
})
test('identity change and unmount ignore late success and errors without displaying private results',async()=>{
 for (const fail of [false,true]) {const f=host();let done;f.h.trainingApi.createSession=()=>new Promise((resolve,reject)=>{done=fail?()=>reject(new RequestError('NETWORK_ERROR')):()=>resolve({session_id:'old',session:{profile_id:'synthetic-profile',lesson:{id:'a'}}})});let stateWrites=0;f.h.setSession=()=>stateWrites++;f.h.setSessionId=()=>stateWrites++;const start=build(f.h),pending=start('a');f.h.mounted.current=false;f.h.commandContext.current.profileId='other-profile';done();await pending;assert.equal(stateWrites,0);assert.equal(f.pending,null)}
})
test('a success arriving while identity is sealed becomes unknown and cannot navigate or post again',async()=>{
 const f=host();let done,writes=0;f.h.trainingApi.createSession=()=>{writes++;return new Promise(resolve=>{done=resolve})};let navigation=0;f.h.setPage=()=>navigation++;const start=build(f.h),pending=start('a');setPrivateWritesSuspended(true);done({session_id:'synthetic-session',session:{profile_id:'synthetic-profile',lesson:{id:'a'}}});await pending;assert.equal(f.pending.lessonId,'a');assert.equal(navigation,0);setPrivateWritesSuspended(false);await start('a');assert.equal(writes,1)
})
test('a structurally successful response for another profile or lesson stays unknown',async()=>{
 for(const session of [{profile_id:'other',lesson:{id:'a'}},{profile_id:'synthetic-profile',lesson:{id:'other'}}]) {const f=host();f.h.trainingApi.createSession=async()=>({session_id:'synthetic',session});await build(f.h)('a');assert.equal(f.pending.lessonId,'a')}
})

function getArrow(name) { let out;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name&&n.initializer&&ts.isArrowFunction(n.initializer))out=n.initializer;ts.forEachChild(n,visit)}visit(tree);assert.ok(out,name);return out.getText(tree) }
const actionWrapper=`export function buildActions(h){const {createPendingRef,createReadLock,privateWritesAreSuspended,authResponseCheckpoint,mounted,commandContext,setCreateChecking,setCreateReadError,profileApi,setCreateSessions,errorMessage,startConfirmation,setCreatePending,exitRisk,setError,profilePendingRef,setCreationWritesBlocked}=h;return {check:${getArrow('checkCreatedTraining')},release:${getArrow('releaseCreatedTraining')}}}`
const {buildActions}=await import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(actionWrapper,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64'))
function recoveryHost() {
 const pending={profileId:'synthetic-profile',lessonId:'synthetic-lesson',previousRisk:'dirty'},ref={current:pending},context={current:{profileId:pending.profileId}},lock={current:false};let shown=null,rows=null,readError=null,writes=0,confirm=null,generation=0,checks=0
 const h={createPendingRef:ref,profilePendingRef:{current:null},setCreationWritesBlocked,createReadLock:lock,privateWritesAreSuspended,authResponseCheckpoint:()=>{const token=generation;return ()=>{if(token!==generation)throw Error('SESSION_CHANGED')}},mounted:{current:true},commandContext:context,setCreateChecking(){},setCreateReadError(v){readError=v},profileApi:{async listSessions(){checks++;return {sessions:[]}}},setCreateSessions(v){rows=v},errorMessage:e=>e.message,startConfirmation:{ask(v){confirm=v}},setCreatePending(v){shown=v},exitRisk:{current:'uncertain'},setError(){},trainingApi:{async createSession(){writes++}}}
 return {h,pending,get rows(){return rows},get readError(){return readError},get shown(){return shown},get checks(){return checks},get writes(){return writes},get confirm(){return confirm},expire(){generation++}}
}
test('only explicit reads list recent sessions; empty, nonempty, and failed reads never clear unknown creation',async()=>{
 const f=recoveryHost(),a=buildActions(f.h);setPrivateWritesSuspended(false);await a.check();assert.deepEqual(f.rows,[]);assert.equal(f.h.createPendingRef.current,f.pending);assert.equal(f.checks,1)
 f.h.profileApi.listSessions=async()=>({sessions:[{session_id:'synthetic-other',source:'synthetic'}]});await a.check();assert.equal(f.rows.length,1);assert.equal(f.h.createPendingRef.current,f.pending)
 f.h.profileApi.listSessions=async()=>{throw Error('NETWORK_ERROR')};await a.check();assert.equal(f.readError,'NETWORK_ERROR');assert.equal(f.h.createPendingRef.current,f.pending);assert.equal(f.writes,0)
})
test('risk acknowledgement is required; cancel and stale identity preserve protection, and accept never creates',()=>{
 const f=recoveryHost(),a=buildActions(f.h);setPrivateWritesSuspended(false);a.release();assert.ok(f.confirm);assert.match(f.confirm.message,/重复/);assert.equal(f.h.createPendingRef.current,f.pending)
 const stale=f.confirm.onConfirm;f.expire();stale();assert.equal(f.h.createPendingRef.current,f.pending)
 a.release();f.confirm.onConfirm();assert.equal(f.h.createPendingRef.current,null);assert.equal(f.h.exitRisk.current,'dirty');assert.equal(f.writes,0)
})
test('late reads and confirmations cannot modify a changed identity or active replacement',async()=>{
 const f=recoveryHost(),a=buildActions(f.h);let resolve;f.h.profileApi.listSessions=()=>new Promise(r=>{resolve=r});const pending=a.check();f.expire();f.h.commandContext.current.profileId='other-profile';resolve({sessions:[{session_id:'old-private'}]});await pending;assert.equal(f.rows,null);assert.equal(f.h.createPendingRef.current,f.pending)
 f.h.commandContext.current.profileId='synthetic-profile';a.release();const confirm=f.confirm;f.h.createPendingRef.current={profileId:'synthetic-profile',lessonId:'new'};confirm.onConfirm();assert.notEqual(f.h.createPendingRef.current,null)
})

test('an old route confirmation cannot start a request after identity changes',async()=>{
 const f=host();let generation=0,confirm;f.h.exitRisk.current='dirty';f.h.authResponseCheckpoint=()=>{const saved=generation;return()=>{if(saved!==generation)throw Error('SESSION_CHANGED')}};f.h.startConfirmation.ask=x=>{confirm=x};const start=build(f.h);await start('synthetic-lesson');assert.ok(confirm);generation++;confirm.onConfirm();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.posts,0)
})
test('401 is not treated as an unresolved creation in the old identity',async()=>{
 const f=host();f.h.trainingApi.createSession=async()=>{throw new RequestError('AUTH_REQUIRED',401)};await build(f.h)('synthetic-lesson');assert.equal(f.pending,null)
})

test('in-flight creation immediately blocks bypass from a stale recommendation or profile callback',async()=>{
 const {requestJson}=await importSource('http.ts'),f=host();let reject;f.h.trainingApi.createSession=()=>new Promise((resolve,fail)=>{reject=fail});let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;return new Response('{}',{status:200})}
 try {setCreationWritesBlocked(false);const request=build(f.h)('synthetic-lesson');for(const url of ['/api/v1/profiles','/api/v1/profiles/synthetic/recommendations/task/start'])await assert.rejects(requestJson(url,{method:'POST'}),e=>e instanceof RequestError&&e.message==='CREATION_OUTCOME_PENDING');assert.equal(calls,0);reject(new RequestError('NETWORK_ERROR'));await request;assert.equal(f.pending.lessonId,'synthetic-lesson')} finally {setCreationWritesBlocked(false);globalThis.fetch=original}
})

test('a valid first create success installs the matching training once and releases creation gate',async()=>{
 const {requestJson}=await importSource('http.ts'),f=host();let installed=null,navigations=0,fetches=0;f.h.trainingApi.createSession=async()=>({session_id:'synthetic-session',session:{profile_id:'synthetic-profile',lesson:{id:'synthetic-lesson'}}});f.h.setSessionId=id=>{installed=id};f.h.setPage=()=>{navigations++};const oldWindow=globalThis.window,oldFetch=globalThis.fetch;globalThis.window={localStorage:{setItem(){}}};globalThis.fetch=async()=>{fetches++;return new Response('{}',{status:200})}
 try {setCreationWritesBlocked(false);await build(f.h)('synthetic-lesson');assert.equal(installed,'synthetic-session');assert.equal(navigations,1);assert.equal(f.pending,null);await requestJson('/api/v1/profiles',{method:'POST'});assert.equal(fetches,1)} finally {setCreationWritesBlocked(false);globalThis.fetch=oldFetch;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow}
})

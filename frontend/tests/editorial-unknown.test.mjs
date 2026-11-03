import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const ts = createRequire(import.meta.url)('typescript')

const read=name=>readFile(new URL(`../src/${name}`,import.meta.url),'utf8')
const data=value=>`data:text/javascript;base64,${Buffer.from(value).toString('base64')}`
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const hooksUrl=data(['useState','useEffect','useLayoutEffect','useRef','useCallback','useId'].map(name=>`export const ${name}=(...args)=>globalThis.__waterinkContentHost.${name}(...args)`).join(';'))
const jsxUrl=data('export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment="fragment";')
const controllerUrl=data(compile(await read('components/confirmation.ts')))
const httpUrl=data(compile(await read('http.ts')))
const observationsUrl=data(compile(await read('observations.ts')))
const contractsUrl=data(compile(await read('contracts.ts')).replaceAll("'./observations'",JSON.stringify(observationsUrl)).replaceAll('"./observations"',JSON.stringify(observationsUrl)))
const { RequestError } = await import(httpUrl)
const { validateResponse } = await import(contractsUrl)
let dialogCode=compile(await read('components/ConfirmationDialog.tsx')).replace(/import ['"][^'"]+\.css['"];?/g,'')
for(const[from,to]of [['react',hooksUrl],['react/jsx-runtime',jsxUrl],['./confirmation',controllerUrl]])dialogCode=dialogCode.replaceAll(`'${from}'`,JSON.stringify(to)).replaceAll(`"${from}"`,JSON.stringify(to))
const dialogUrl=data(dialogCode)
const original=await read('App.tsx')
const ast=ts.createSourceFile('App.tsx',original,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const required=['emptyContentForm','lines','uncertainEditorialWrite','contentFormFromLesson','parseEditorialContent','ContentAdminPage']
const selected=ast.statements.filter(node=>ts.isFunctionDeclaration(node)?required.includes(node.name?.text):ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>required.includes(item.name.getText(ast))))
assert.equal(selected.length,required.length,'extract actual component and exact public helpers, not rewritten behavior')
const extracted=selected.map(node=>node.getText(ast)).join('\n')
let componentCode=compile(`import {useState,useEffect,useLayoutEffect,useRef,useCallback} from 'react';
import {useConfirmationDialog} from './ConfirmationDialog';
import {uncertainWrite, errorMessage, RequestError, authResponseCheckpoint} from './http';
import {validateResponse} from './contracts';
const adminLessonApi=new Proxy({},{get:(_,name)=>(...args)=>globalThis.__waterinkContentApi[name](...args)});
const EditorialSources=()=>null;
${extracted}\nexport {ContentAdminPage};`)
for(const[from,to]of [['react',hooksUrl],['react/jsx-runtime',jsxUrl],['./ConfirmationDialog',dialogUrl],['./http',httpUrl],['./contracts',contractsUrl]])componentCode=componentCode.replaceAll(`'${from}'`,JSON.stringify(to)).replaceAll(`"${from}"`,JSON.stringify(to))
const {ContentAdminPage}=await import(data(componentCode))
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)]
const text=node=>Array.isArray(node)?node.map(text).join(''):node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):text(node.props?.children)
const find=(tree,predicate)=>all(tree).find(predicate)
const button=(tree,label)=>{const node=find(tree,node=>node.type==='button'&&text(node).trim().startsWith(label));assert.ok(node,label);return node}
const input=(tree,placeholder)=>{const node=find(tree,node=>['input','textarea'].includes(node.type)&&node.props.placeholder===placeholder);assert.ok(node,placeholder);return node}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve}}
const hosts=[]
const globals=Object.fromEntries(['window','document','HTMLElement'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))

// Actual extracted ContentAdminPage and real confirmation/controller, using a
// deterministic lifecycle/native-element adapter, not a browser layout test.
function host(){
  const slots=[],effects=[],events=[];let cursor=0,changed=true,tree,disposed=false
  class Element{isConnected=true;focus(){document.activeElement=this}getClientRects(){return [{}]}}
  const cancel=new Element(),accept=new Element(),body=new Element(),trigger=new Element()
  const dialog=Object.assign(new Element(),{open:false,showModal(){this.open=true},close(){this.open=false;events.push(()=>find(tree,n=>n.type==='dialog')?.props.onClose())},contains(node){return node===cancel||node===accept},querySelectorAll(){return[cancel,accept]}})
  globalThis.HTMLElement=Element;globalThis.document={body,activeElement:trigger,querySelector:()=>dialog.open?dialog:null}
  globalThis.window={matchMedia:()=>({matches:true}),clearTimeout(){},setTimeout(){throw Error('reduced motion should avoid timer')}}
  const reports=[]; const report=r=>reports.push(r); const h={dialog,reports,
    useState(initial){const at=cursor++;if(!(at in slots))slots[at]={value:typeof initial==='function'?initial():initial};return[slots[at].value,value=>{if(disposed)return;const next=typeof value==='function'?value(slots[at].value):value;if(!Object.is(next,slots[at].value)){slots[at].value=next;changed=true}}]},
    useRef(initial){return slots[cursor++]??={current:initial}},
    useId(){return 'waterink-content-'+cursor++},
    useCallback(fn,deps){const at=cursor++,old=slots[at];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index])))slots[at]={fn,deps};return slots[at].fn},
    useEffect(fn,deps){const at=cursor++,old=slots[at];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index]))){slots[at]={deps};effects.push(()=>{old?.cleanup?.();slots[at].cleanup=fn()})}},
    useLayoutEffect(fn,deps){return h.useEffect(fn,deps)},
    renderNoEffects(){cursor=0;globalThis.__waterinkContentHost=h;tree=ContentAdminPage({onExitRiskChange:report});const modal=find(tree,n=>n.type==='dialog');modal.props.ref.current=dialog;const controls=all(modal).filter(n=>n.type==='button');controls[0].props.ref.current=cancel;return tree},
    flush(){let passes=0;do{assert.ok(++passes<25);changed=false;h.renderNoEffects();while(effects.length)effects.shift()();while(events.length)events.shift()()}while(changed);return tree},
    async settle(){await tick();return h.flush()},
    dispose(){if(disposed)return;disposed=true;for(const slot of slots)slot?.cleanup?.();while(events.length)events.shift()()},
    accept(view=tree){all(find(view,n=>n.type==='dialog')).filter(n=>n.type==='button')[1].props.onClick();return disposed?tree:h.flush()},
    cancel(){all(find(tree,n=>n.type==='dialog')).filter(n=>n.type==='button')[0].props.onClick();return h.flush()},
    get tree(){return tree},
  };hosts.push(h);h.flush();return h
}
const lesson=id=>({id,title:`合成课程${id}`,source:'合成原典',school_stage:'JUNIOR',difficulty:'基础',estimated_minutes:10,summary:'合成课程说明',status:'DRAFT',textbook_tags:[],theme:'测试',accumulation_points:[],reasoning_points:[],reasoning_level:'L1',content:{},review:{status:'UNREVIEWED',content_version:'abcdef012345',reviewer:null,note:null,reviewed_at:null,issues:[]}})
const titlePlaceholder='例如：从人物关系推断词义'
test.beforeEach(()=>{globalThis.__waterinkContentApi={list:async()=>({lessons:[lesson('one'),lesson('two')]}),get:async id=>({lesson:lesson(id)})}})
test.afterEach(()=>{while(hosts.length)hosts.pop().dispose();for(const[key,descriptor]of Object.entries(globals)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}delete globalThis.__waterinkContentApi;delete globalThis.__waterinkContentHost})
async function opened(){const h=host();await h.settle();queue(h,0).props.onClick();await h.settle();return h}
const queue=(h,index)=>all(find(h.tree,n=>n.props?.className==='admin-lesson-list')).filter(n=>n.type==='button')[index]
function dirty(h){input(h.tree,titlePlaceholder).props.onChange({target:{value:'需要保留的合成草稿'}});return h.flush()}

const click = (h, label) => { const n = button(h.tree, label); n.props.onClick(); return h.flush() }
const submit = h => find(h.tree,n=>n.type==='form').props.onSubmit({preventDefault(){}})
const change = (h, placeholder, value) => { input(h.tree,placeholder).props.onChange({target:{value}}); h.flush() }
const pendingRead = tree => find(tree,n=>n.type==='button' && /核对/.test(text(n)) && /读取/.test(text(n)))
async function newDraft() {
  const h=host(); await h.settle(); click(h,'创建新关卡')
  change(h,titlePlaceholder,'合成待核对草稿')
  const duration=find(h.tree,n=>n.type==='input' && n.props.type==='number')
  duration.props.onChange({target:{value:'5'}}); h.flush()
  return h
}

test('creation unknown freezes old draft and all writes, even stale submit; read is explicit and never a retry',async()=>{
  let creates=0, reads=0
  globalThis.__waterinkContentApi.create=async()=>{creates++; throw new RequestError('NETWORK_ERROR')}
  globalThis.__waterinkContentApi.list=async()=>{reads++; return {lessons:[lesson('one'),lesson('two')]}}
  const h=await newDraft(), old=h.tree
  submit(h); submit(h); await h.settle()
  assert.equal(creates,1,'same-tick submission must be synchronously locked')
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
  assert.equal(h.reports.at(-1),'uncertain')
  assert.match(text(h.tree),/可能|尚未确认/)
  assert.match(text(h.tree),/不会自动重试|没有自动重试/)
  const read=pendingRead(h.tree); assert.ok(read,'explicit read-and-check action')
  const before=reads; read.props.onClick(); await h.settle()
  assert.equal(reads,before+1); assert.equal(creates,1)
  assert.equal(h.reports.at(-1),'uncertain','a read cannot prove the write outcome')
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
  find(old,n=>n.type==='form').props.onSubmit({preventDefault(){}}); await h.settle()
  assert.equal(creates,1,'stale submit cannot bypass the lock')
})

test('unknown review remains locked after matching latest signature and no write is replayed',async()=>{
  let reviews=0, reads=0
  globalThis.__waterinkContentApi.review=async()=>{reviews++; throw new RequestError('REQUEST_TIMEOUT')}
  globalThis.__waterinkContentApi.get=async id=>{reads++;return{lesson:{...lesson(id),review:{status:'APPROVED',content_version:'abcdef012345',issues:[],reviewer:'合成审核人',note:'合成说明',reviewed_at:'2026-01-01T00:00:00Z'}}}}
  const h=await opened()
  change(h,'填写实际审核人的署名','合成审核人')
  change(h,'例如：核对原文版本、题源和词义注释','合成说明')
  const review=button(h.tree,'确认审核当前版本'); review.props.onClick(); review.props.onClick(); await h.settle()
  assert.equal(reviews,1); assert.equal(h.reports.at(-1),'uncertain')
  const check=pendingRead(h.tree); assert.ok(check)
  const before=reads; check.props.onClick(); await h.settle()
  assert.equal(reads,before+1); assert.equal(reviews,1)
  assert.equal(h.reports.at(-1),'uncertain','matching signature is not a receipt')
  assert.equal(input(h.tree,'填写实际审核人的署名').props.value,'合成审核人')
  review.props.onClick(); await h.settle(); assert.equal(reviews,1)
})

test('definitive 4xx does not enter unknown state and preserves editable form',async()=>{
  let writes=0
  globalThis.__waterinkContentApi.create=async()=>{writes++;throw new RequestError('LESSON_SLUG_CONFLICT',409)}
  const h=await newDraft(); submit(h); await h.settle()
  assert.equal(writes,1); assert.equal(h.reports.at(-1),'dirty')
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
  assert.notEqual(input(h.tree,titlePlaceholder).props.readOnly,true)
})

for (const [code,status] of [['REQUEST_TIMEOUT',0],['SERVER_UNAVAILABLE',503],['INVALID_RESPONSE',200],['REQUEST_FAILED',408],['REQUEST_FAILED',429]]) {
  test(`create result ${code}/${status} is uncertain, not silently retried`,async()=>{
    let writes=0
    globalThis.__waterinkContentApi.create=async()=>{writes++;throw new RequestError(code,status)}
    const h=await newDraft(); submit(h); await h.settle()
    assert.equal(writes,1)
    assert.equal(h.reports.at(-1),'uncertain')
    assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
    submit(h); await h.settle(); assert.equal(writes,1)
  })
}

test('failed read does not unlock unknown creation or erase draft',async()=>{
  let writes=0, lists=0
  globalThis.__waterinkContentApi.create=async()=>{writes++;throw new RequestError('NETWORK_ERROR')}
  globalThis.__waterinkContentApi.list=async()=>{if(++lists===1)return {lessons:[]};throw new RequestError('NETWORK_ERROR')}
  const h=await newDraft(); submit(h); await h.settle()
  const check=pendingRead(h.tree); assert.ok(check); check.props.onClick(); await h.settle()
  assert.equal(lists,2); assert.equal(writes,1); assert.equal(h.reports.at(-1),'uncertain')
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
  assert.ok(pendingRead(h.tree),'read failure can be retried without replaying the write')
})

test('explicit abandonment confirmation warns, cancel preserves, accept unlocks without writing',async()=>{
  let writes=0
  globalThis.__waterinkContentApi.create=async()=>{writes++;throw new RequestError('NETWORK_ERROR')}
  const h=await newDraft(); submit(h); await h.settle()
  click(h,'结束本次核对'); assert.equal(h.dialog.open,true)
  assert.match(text(find(h.tree,n=>n.type==='dialog')),/不会撤销/)
  assert.match(text(find(h.tree,n=>n.type==='dialog')),/可能产生重复/)
  h.cancel(); assert.equal(h.reports.at(-1),'uncertain'); assert.equal(writes,1)
  click(h,'结束本次核对'); const stale=h.tree; h.accept(); h.accept(stale)
  assert.equal(writes,1); assert.notEqual(h.reports.at(-1),'uncertain')
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
  assert.match(text(h.tree),/此前提交结果仍未知/)
})

test('mismatched read identity cannot overwrite draft or resolve unknown review',async()=>{
  let count=0
  globalThis.__waterinkContentApi.get=async id=>({lesson:lesson(++count===1?id:'wrong-id')})
  globalThis.__waterinkContentApi.review=async()=>{throw new RequestError('NETWORK_ERROR')}
  const h=await opened(); change(h,'填写实际审核人的署名','合成审核人')
  click(h,'确认审核当前版本'); await h.settle(); pendingRead(h.tree).props.onClick(); await h.settle()
  assert.equal(h.reports.at(-1),'uncertain'); assert.match(text(h.tree),/读取失败/)
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成课程one')
  assert.equal(input(h.tree,'填写实际审核人的署名').props.value,'合成审核人')
})

test('in-flight read blocks release; completion after unmount cannot report or send writes',async()=>{
  let writes=0, reads=0; const held=deferred()
  globalThis.__waterinkContentApi.create=async()=>{writes++;throw new RequestError('NETWORK_ERROR')}
  globalThis.__waterinkContentApi.list=async()=>{reads++;return reads===1?{lessons:[]}:held.promise}
  const h=await newDraft(); submit(h); await h.settle()
  pendingRead(h.tree).props.onClick(); h.flush()
  assert.equal(h.reports.at(-1),'working')
  const release=button(h.tree,'结束本次核对'); assert.equal(release.props.disabled,true)
  release.props.onClick(); h.flush(); assert.equal(h.dialog.open,false)
  h.dispose(); const after=h.reports.length
  held.resolve({lessons:[lesson('late')]}); await tick()
  assert.equal(h.reports.length,after); assert.equal(writes,1)
})

test('stale release consent cannot unlock while a newer check is in flight',async()=>{
  const held=deferred(); let lists=0, writes=0
  globalThis.__waterinkContentApi.list=async()=>++lists===1?{lessons:[]}:held.promise
  globalThis.__waterinkContentApi.create=async()=>{writes++;throw new RequestError('NETWORK_ERROR')}
  const h=await newDraft(); submit(h); await h.settle()
  click(h,'结束本次核对'); const prior=h.tree
  pendingRead(prior).props.onClick(); h.renderNoEffects(); h.accept(prior); h.flush()
  assert.equal(h.reports.at(-1),'working'); assert.equal(writes,1)
  held.resolve({lessons:[]}); await h.settle()
  assert.equal(h.reports.at(-1),'uncertain'); assert.equal(writes,1)
})

test('identity change failure does not adopt old response as an unknown write',async()=>{
  globalThis.__waterinkContentApi.create=async()=>{throw new RequestError('SESSION_CHANGED',409)}
  const h=await newDraft(); submit(h); await h.settle()
  assert.notEqual(h.reports.at(-1),'uncertain'); assert.ok(!pendingRead(h.tree))
  // The AuthBoundary owns identity disposal; this component never writes this draft to storage.
})

test('acknowledged successful create and review retain ordinary flow',async()=>{
  let creates=0, reviews=0
  globalThis.__waterinkContentApi.create=async()=>{creates++;return{lesson:lesson('created')}}
  globalThis.__waterinkContentApi.review=async id=>{reviews++;return{lesson:{...lesson(id),review:{status:'APPROVED',content_version:'abcdef012345',issues:[],reviewer:'合成审核人',note:'',reviewed_at:'2026-01-01T00:00:00Z'}}}}
  const h=await newDraft(); submit(h); await h.settle()
  assert.equal(creates,1); assert.match(text(h.tree),/草稿已创建/); assert.ok(!pendingRead(h.tree))
  change(h,'填写实际审核人的署名','合成审核人')
  click(h,'确认审核当前版本'); await h.settle()
  assert.equal(reviews,1); assert.match(text(h.tree),/已记录本地教研审核/); assert.ok(!pendingRead(h.tree))
})

test('malformed create success freezes instead of adopting undefined lesson',async()=>{
  let commits=0
  globalThis.__waterinkContentApi.create=async()=>{commits++;return{lessons:[]}}
  const h=await newDraft(); submit(h); await h.settle()
  assert.equal(commits,1); assert.equal(h.reports.at(-1),'uncertain')
  assert.equal(input(h.tree,titlePlaceholder).props.value,'合成待核对草稿')
  assert.doesNotMatch(text(h.tree),/草稿已创建/)
  submit(h); await h.settle(); assert.equal(commits,1)
})

test('malformed signed receipt cannot report success or permit duplicate signing',async()=>{
  let commits=0
  globalThis.__waterinkContentApi.review=async()=>{commits++;const item=lesson('one');delete item.review;return{lesson:item}}
  const h=await opened();change(h,'填写实际审核人的署名','合成审核人')
  const action=button(h.tree,'确认审核当前版本'); action.props.onClick(); await h.settle()
  assert.equal(commits,1); assert.equal(h.reports.at(-1),'uncertain')
  assert.doesNotMatch(text(h.tree),/已记录本地教研审核/)
  assert.equal(input(h.tree,'填写实际审核人的署名').props.value,'合成审核人')
  action.props.onClick(); await h.settle(); assert.equal(commits,1)
})

test('same-path GET list and POST create use distinct strict response contracts',()=>{
  const draft=lesson('one')
  assert.equal(validateResponse('/api/v1/admin/lessons',{lessons:[draft]},'GET'),true)
  assert.equal(validateResponse('/api/v1/admin/lessons',{lesson:draft},'POST'),true)
  assert.equal(validateResponse('/api/v1/admin/lessons',{lessons:[draft]},'POST'),false)
  assert.equal(validateResponse('/api/v1/admin/lessons',{lesson:draft},'GET'),false)
  const missing={...draft};delete missing.review
  assert.equal(validateResponse('/api/v1/admin/lessons',{lesson:missing},'POST'),false)
  assert.equal(validateResponse('/api/v1/admin/lessons',{lesson:{...draft,content:{CORE:'bad'}}},'POST'),false)
})

test('signed POST requires complete approved review and timestamp; GET compatibility is retained',()=>{
  const path='/api/v1/admin/lessons/one/review', signed={...lesson('one'),review:{status:'APPROVED',content_version:'abcdef012345',reviewer:'合成审核人',note:'',reviewed_at:'2026-01-01T00:00:00Z',issues:[]}}
  assert.equal(validateResponse(path,{lesson:signed},'POST'),true)
  for(const review of [undefined,{...signed.review,status:'UNREVIEWED'},{...signed.review,content_version:'bad'},{...signed.review,reviewer:''},{...signed.review,reviewed_at:null},{...signed.review,reviewed_at:'yesterday'}]){
    assert.equal(validateResponse(path,{lesson:{...signed,review}},'POST'),false)
  }
  const legacy={...lesson('one')};delete legacy.review
  assert.equal(validateResponse('/api/v1/admin/lessons/one',{lesson:legacy},'GET'),true)
})


test('uncertain existing lesson update retains draft and blocks duplicate write',async()=>{
 let updates=0;globalThis.__waterinkContentApi.update=async()=>{updates++;throw new RequestError('NETWORK_ERROR')};const h=await opened();dirty(h);submit(h);await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.equal(input(h.tree,titlePlaceholder).props.value,'需要保留的合成草稿');submit(h);await h.settle();assert.equal(updates,1)
})
test('uncertain publish retains original intent and blocks duplicate publish',async()=>{
 let writes=0;globalThis.__waterinkContentApi.get=async id=>({lesson:{...lesson(id),review:{...lesson(id).review,status:'APPROVED'}}});globalThis.__waterinkContentApi.publish=async()=>{writes++;throw new RequestError('REQUEST_TIMEOUT')};const h=await opened();click(h,'发布关卡');await h.settle();assert.equal(h.reports.at(-1),'uncertain');click(h,'发布关卡');await h.settle();assert.equal(writes,1)
})

for(const [kind,status,code] of [['update',503,'SERVER_UNAVAILABLE'],['update',200,'INVALID_RESPONSE'],['publish',503,'SERVER_UNAVAILABLE'],['publish',200,'INVALID_RESPONSE']]){
 test(`${kind} ${code} keeps original intent until explicit risk confirmation`,async()=>{
  let writes=0,reads=0;globalThis.__waterinkContentApi.get=async id=>{reads++;return{lesson:{...lesson(id),review:{...lesson(id).review,status:'APPROVED'}}}};globalThis.__waterinkContentApi[kind]=async()=>{writes++;throw new RequestError(code,status)}
  const h=await opened();if(kind==='update'){dirty(h);submit(h)}else click(h,'发布关卡');await h.settle()
  assert.equal(writes,1);assert.equal(h.reports.at(-1),'uncertain');assert.match(text(h.tree),kind==='update'?/保存修改/:/发布课程/)
  const before=reads;pendingRead(h.tree).props.onClick();await h.settle();assert.equal(reads,before+1);assert.equal(h.reports.at(-1),'uncertain');assert.equal(writes,1)
  click(h,'结束本次核对');h.cancel();assert.equal(h.reports.at(-1),'uncertain');assert.equal(writes,1)
  click(h,'结束本次核对');h.accept();assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(writes,1)
 })
}
for(const kind of ['update','publish']) test(`${kind} first definite 409 does not claim unknown`,async()=>{
 globalThis.__waterinkContentApi.get=async id=>({lesson:{...lesson(id),review:{...lesson(id).review,status:'APPROVED'}}});let writes=0;globalThis.__waterinkContentApi[kind]=async()=>{writes++;throw new RequestError('VERSION_CONFLICT',409)};const h=await opened();if(kind==='update'){dirty(h);submit(h)}else click(h,'发布关卡');await h.settle();assert.equal(writes,1);assert.notEqual(h.reports.at(-1),'uncertain');assert.ok(!pendingRead(h.tree))
})
test('update and publish wrong-id or unconfirmed publish success freeze instead of misattributing',async()=>{
 for(const kind of ['update','publish']){globalThis.__waterinkContentApi.get=async id=>({lesson:{...lesson(id),review:{...lesson(id).review,status:'APPROVED'}}});globalThis.__waterinkContentApi[kind]=async()=>({lesson:lesson('wrong')});const h=await opened();if(kind==='update'){dirty(h);submit(h)}else click(h,'发布关卡');await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.ok(pendingRead(h.tree));h.dispose()}
})

test('valid update and publish receipts preserve ordinary successful flow',async()=>{
 let writes=0;globalThis.__waterinkContentApi.get=async id=>({lesson:{...lesson(id),review:{...lesson(id).review,status:'APPROVED'}}});globalThis.__waterinkContentApi.update=async(id,payload)=>{writes++;return{lesson:{...lesson(id),...payload,review:{...lesson(id).review,status:'APPROVED'}}}};const first=await opened();dirty(first);submit(first);await first.settle();assert.equal(writes,1);assert.match(text(first.tree),/修改已保存/);assert.ok(!pendingRead(first.tree));first.dispose()
 globalThis.__waterinkContentApi.publish=async id=>{writes++;return {lesson:{...lesson(id),status:'PUBLISHED',review:{...lesson(id).review,status:'APPROVED'}}}};const second=await opened();click(second,'发布关卡');await second.settle();assert.equal(writes,2);assert.match(text(second.tree),/关卡已发布/);assert.ok(!pendingRead(second.tree))
})

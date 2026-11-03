import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root=dirname(fileURLToPath(new URL('../src/',import.meta.url)))
class TestError extends Error { constructor(code,status=0){super(code);this.status=status} }
globalThis.__recoveryError=TestError
const stubs={
  react:`export const useState=(...x)=>globalThis.__recoveryHost.useState(...x);export const useRef=(...x)=>globalThis.__recoveryHost.useRef(...x);export const useEffect=(...x)=>globalThis.__recoveryHost.useEffect(...x);export const useCallback=(...x)=>globalThis.__recoveryHost.useCallback(...x);export const useId=()=>globalThis.__recoveryHost.useId();`,
  jsx:`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='fragment';`,
  confirmation:`export const useConfirmationDialog=()=>({modal:null,ask:q=>{globalThis.__recoveryHost.question=q}});`,
  http:`export const RequestError=globalThis.__recoveryError;export const authResponseCheckpoint=()=>{const generation=globalThis.__recoveryGeneration;return()=>{if(generation!==globalThis.__recoveryGeneration)throw new RequestError('SESSION_CHANGED',409)}};export const uncertainWrite=e=>e instanceof RequestError&&(e.status>=500||['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE'].includes(e.message));export const errorMessage=e=>e instanceof Error?e.message:String(e);export const requestJson=(...x)=>globalThis.__recoveryApi.requestJson(...x);`,
  learningPathApi:`export const learningPathApi=new Proxy({},{get:(_,x)=>(...a)=>globalThis.__recoveryApi[x](...a)});export const pathRequestId=()=>globalThis.__recoveryApi.key();`,
  assessmentApi:`export const assessmentApi=new Proxy({},{get:(_,x)=>(...a)=>globalThis.__recoveryApi[x](...a)});export const assessmentRequestId=()=>globalThis.__recoveryApi.key();`,
  assessmentEditorialApi:`export const assessmentEditorialApi=new Proxy({},{get:(_,x)=>(...a)=>globalThis.__recoveryApi[x](...a)});export const editorialRequestId=()=>globalThis.__recoveryApi.key();`,
  aiReasonReviewApi:`export const aiReasonReviewApi=new Proxy({},{get:(_,x)=>(...a)=>globalThis.__recoveryApi[x](...a)});`,
  api:`export const adminLessonApi=new Proxy({},{get:(_,x)=>(...a)=>globalThis.__recoveryApi['admin_'+x](...a)});`,
}
const plugin={name:'synthetic-api',setup(b){
  b.onResolve({filter:/.*/},args=>{
    if(args.path==='react')return{path:'react',namespace:'stub'}
    if(args.path==='react/jsx-runtime')return{path:'jsx',namespace:'stub'}
    if(args.path.endsWith('/ConfirmationDialog'))return{path:'confirmation',namespace:'stub'}
    for(const name of ['learningPathApi','assessmentApi','assessmentEditorialApi','aiReasonReviewApi','http','api'])if(args.path===`../${name}`)return{path:name,namespace:'stub'}
  })
  b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:stubs[args.path],loader:'js'}))
  b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}))
}}
async function load(name){const result=await build({entryPoints:[join(root,'src','components',`${name}.tsx`)],bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[plugin],define:{'import.meta.env.VITE_API_ROOT':'""'},logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))}
const modules=Object.fromEntries(await Promise.all(['RecommendationQueue','AssessmentPage','AssessmentQuestionWorkbench','AIReasonReviewWorkbench','CourseAbilityWorkbench'].map(async n=>[n,await load(n)])))
const all=n=>Array.isArray(n)?n.flatMap(all):!n||typeof n!=='object'?[]:[n,...all(n.props?.children)]
const text=n=>Array.isArray(n)?n.map(text).join(''):n==null||typeof n==='boolean'?'':typeof n!=='object'?String(n):text(n.props?.children)
const find=(tree,fn)=>all(tree).find(fn)
const button=(h,label)=>{const n=find(h.tree,x=>x.type==='button'&&text(x).includes(label));assert.ok(n,`button: ${label}`);return n}
const click=(h,label)=>{button(h,label).props.onClick({currentTarget:{focus(){}}});h.flush()}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function storage(){const values=new Map();return{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear()}}
const prior=Object.fromEntries(['sessionStorage','localStorage','window','requestAnimationFrame'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]))
const hosts=[]
test.beforeEach(()=>{globalThis.__recoveryGeneration=0;globalThis.sessionStorage=storage();globalThis.localStorage=storage();globalThis.window={matchMedia:()=>({matches:false})};globalThis.requestAnimationFrame=()=>0})
test.afterEach(()=>{for(const h of hosts.splice(0))h.dispose();for(const[k,v]of Object.entries(prior)){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}delete globalThis.__recoveryApi;delete globalThis.__recoveryHost})
function host(Component,props){
  const slots=[],effects=[],reports=[];let cursor=0,changed=true,disposed=false,tree
  const report=value=>reports.push(value)
  const h={question:null,reports,
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,v=>{if(disposed)return;const next=typeof v==='function'?v(slots[i].value):v;if(!Object.is(next,slots[i].value)){slots[i].value=next;changed=true}}]},
    useRef(initial){return slots[cursor++]??={current:initial}},useId(){return 'test-'+cursor++},
    useCallback(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j])))slots[i]={fn,deps};return slots[i].fn},
    useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps?.[j]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn()})}},
    flush(){let times=0;do{assert.ok(++times<30);changed=false;cursor=0;globalThis.__recoveryHost=h;tree=Component({...props,onRiskChange:report,onExitRiskChange:report});while(effects.length)effects.shift()()}while(changed);return tree},
    async settle(){await tick();return h.flush()},
    accept(){const q=h.question;h.question=null;assert.ok(q);q.onConfirm();return h.flush()},
    cancel(){h.question=null;return h.flush()},
    dispose(){if(disposed)return;disposed=true;for(const x of slots)x?.cleanup?.()},get tree(){return tree},
  };hosts.push(h);h.flush();return h
}
function wrapped(name,props){const component=modules[name][name];const node=component(props);assert.equal(typeof node.type,'function');return host(node.type,props)}

const plan={id:'plan',profile_id:'p',practice_level:'L1',level_source:'FOUNDATION_DEFAULT',created_at:'2026-01-01',tasks:[],gaps:[],explanation:'合成'}
test('recommendation: unknown then 409 retains same request until receipt arrives',async()=>{
  const calls=[];globalThis.__recoveryApi={key:()=> 'same-key',recommendations:async()=>null,generate:async(...args)=>{calls.push(args);if(calls.length===1)throw new TestError('NETWORK_ERROR');if(calls.length===2)throw new TestError('RECOMMENDATION_CONFLICT',409);return plan}}
  const h=wrapped('RecommendationQueue',{profileId:'p',onStartSession(){}});await h.settle();click(h,'确认起点并生成学习队列');await h.settle();assert.equal(h.reports.at(-1),'uncertain')
  click(h,'恢复上一次提交');await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.equal(button(h,'确认起点并生成学习队列').props.disabled,true)
  click(h,'恢复上一次提交');await h.settle();assert.equal(calls.length,3);assert.ok(calls.every(args=>args[2]==='same-key'));assert.notEqual(h.reports.at(-1),'uncertain')
})

const question={id:'q',version:'seed',dimension:'vocabulary',difficulty:'L1',type:'choice',stem:'测试',source:'测试',source_url:'https://example.org',passage:'甲从乙学',text_version:'v1',material_extent:'EXCERPT',passage_extent:'EXCERPT',paragraph_index:0,start:0,end:4,full_text_start:0,full_text_end:4,options:[{id:'a',text:'甲'},{id:'b',text:'乙'}],answer_id:'a',explanation:'测试',tags:[],review_status:'DRAFT',reviewer:null,reviewed_at:null}
const detail={question,version:1,revision_version:'v1',actor:'测试',note:'测试',updated_at:'2026-01-01',history:[],reviewer_is_authenticated:false}
test('assessment editorial: stored original survives retry 409 and success uses same key',async()=>{
  const op={id:'q',key:'same-key',method:'POST',body:{expected_version:0,actor:'测试',note:'测试',decision:'APPROVE'}}
  sessionStorage.setItem('wenyan-assessment-editorial-pending-v1',JSON.stringify(op));const keys=[]
  globalThis.__recoveryApi={key:()=> 'new-key',list:async()=>({items:[],total:0,offset:0,limit:12}),write:async o=>{keys.push(o.key);if(keys.length===1)throw new TestError('ASSESSMENT_QUESTION_VERSION_CONFLICT',409);return detail}}
  const h=host(modules.AssessmentQuestionWorkbench.AssessmentQuestionWorkbench,{});await h.settle();click(h,'使用原提交标识恢复结果');await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.equal(JSON.parse(sessionStorage.getItem('wenyan-assessment-editorial-pending-v1')).key,'same-key')
  click(h,'使用原提交标识恢复结果');await h.settle();assert.deepEqual(keys,['same-key','same-key']);assert.equal(sessionStorage.getItem('wenyan-assessment-editorial-pending-v1'),null)
})

test('AI review: stored original survives retry 409 and confirmed receipt followed by failing GET stays cleared',async()=>{
  const fields={reviewer:'合成',decision:'UNCERTAIN',context_sufficiency:'UNCERTAIN',source_basis:'合成依据',rationale:'合成说明',alternatives:null,suggested_labels:['UNSCORABLE']}
  const op={key:'same-key-12345678',case_id:'case',body:{expected_suite_digest:'a'.repeat(64),expected_input_digest:'b'.repeat(64),expected_revision:0,fields}}
  sessionStorage.setItem('wenyan-ai-review-pending-v1',JSON.stringify(op));const keys=[]
  globalThis.__recoveryApi={key:()=> 'new-key',list:async()=>({items:[],recorded_cases:0,total:0,notes_total:0}),write:async o=>{keys.push(o.key);if(keys.length===1)throw new TestError('AI_REVIEW_VERSION_CONFLICT',409);return{saved:{revision:1},replayed:true}},get:async()=>{throw new TestError('NETWORK_ERROR')}}
  const h=host(modules.AIReasonReviewWorkbench.AIReasonReviewWorkbench,{});await h.settle();click(h,'按原标识确认保存');await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.equal(JSON.parse(sessionStorage.getItem('wenyan-ai-review-pending-v1')).key,op.key)
  click(h,'按原标识确认保存');await h.settle();assert.deepEqual(keys,[op.key,op.key]);assert.equal(sessionStorage.getItem('wenyan-ai-review-pending-v1'),null);assert.notEqual(h.reports.at(-1),'uncertain')
})

const availability={pilot_available:true,formal_available:false,approved_question_count:0,pilot_question_count:24,reason:'合成测试'}
const session=()=>({id:'assess',profile_id:'p',mode:'PILOT',status:'IN_PROGRESS',state_version:0,current_index:0,answers:{},questions:Array.from({length:24},(_,i)=>({id:'q'+i,source:'合成',passage:'合成原文',stem:'合成题',options:[{id:'a',text:'甲'},{id:'b',text:'乙'}]}))})
const summary={id:'assess',mode:'PILOT',status:'IN_PROGRESS',updated_at:'2026-01-01',answered_count:0,skipped_count:0,question_count:24}
function selectLabel(h,label){const parent=find(h.tree,n=>n.type==='label'&&text(n).includes(label));assert.ok(parent,label);const input=find(parent,n=>n.type==='input');assert.ok(input);input.props.onChange({target:{checked:true}});h.flush()}
test('assessment create: empty and active reads cannot prove unknown write or erase survey',async()=>{
  let creates=0,reads=0;globalThis.__recoveryApi={key:()=> 'create-key',availability:async()=>availability,list:async()=>{reads++;return reads<3?[]:[summary]},get:async()=>session(),create:async()=>{creates++;throw new TestError('NETWORK_ERROR')}}
  const h=wrapped('AssessmentPage',{profileId:'p',onCreateProfile(){},onHome(){}});await h.settle();click(h,'先做四道轻自评')
  for(const x of ['基础起步','独立读懂文章','先联系上下文推断','会尝试独立阅读'])selectLabel(h,x)
  click(h,'创建 24 题试测');await h.settle();assert.equal(creates,1);assert.equal(h.reports.at(-1),'uncertain')
  click(h,'读取当前试卷核对');await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.match(text(h.tree),/不能证明原请求未保存/)
  click(h,'读取当前试卷核对');await h.settle();assert.equal(h.reports.at(-1),'uncertain');assert.match(text(h.tree),/不能证明它由本次创建产生/);assert.equal(creates,1)
  click(h,'结束核对');assert.match(h.question.message,/可能重复/);h.cancel();assert.equal(h.reports.at(-1),'uncertain');click(h,'结束核对');h.accept();assert.notEqual(h.reports.at(-1),'uncertain');assert.match(text(h.tree),/原提交结果仍未知/);assert.equal(creates,1)
})
test('assessment command: unknown then 409 preserves same key and draft until receipt',async()=>{
  const calls=[];globalThis.__recoveryApi={key:()=> 'answer-key',availability:async()=>availability,list:async()=>[summary],get:async()=>session(),command:async(id,command,key)=>{calls.push({id,command,key});if(calls.length===1)throw new TestError('NETWORK_ERROR');if(calls.length===2)throw new TestError('VERSION_CONFLICT',409);return{...session(),state_version:1,answers:{q0:'a'}}}}
  const h=wrapped('AssessmentPage',{profileId:'p',onCreateProfile(){},onHome(){}});await h.settle();selectLabel(h,'甲');click(h,'保存并下一题');await h.settle();assert.equal(h.reports.at(-1),'uncertain')
  click(h,'恢复上一次提交');await h.settle();assert.equal(h.reports.at(-1),'uncertain');click(h,'恢复上一次提交');await h.settle()
  assert.equal(calls.length,3);assert.ok(calls.every(x=>x.key==='answer-key'&&x.command.payload.option_id==='a'));assert.notEqual(h.reports.at(-1),'uncertain')
})

test('course ability: current unchanged read never unlocks the lost write',async()=>{
  const lesson={id:'lesson',title:'合成课程',source:'合成原文',status:'DRAFT'}
  const row={lesson_id:'lesson',ability_level:null,dimension_tags:[],version:0,actor:null,note:'',updated_at:null,content_version:null,current_content_version:'abcdef012345',valid_for_content:false}
  let patches=0,reads=0;globalThis.__recoveryApi={admin_list:async()=>({lessons:[lesson]}),requestJson:async(_url,init={})=>{if(init.method==='PATCH'){patches++;throw new TestError('NETWORK_ERROR')}reads++;return{ability:row}}}
  const h=host(modules.CourseAbilityWorkbench.CourseAbilityWorkbench,{});await h.settle();click(h,'合成课程');await h.settle()
  const select=find(h.tree,n=>n.type==='select');select.props.onChange({target:{value:'L1'}});h.flush()
  for(const [placeholder,value] of [['填写实际标定人','合成'],['说明题目要求、目标能力及难度依据；仅材料长短不足以判断','合成依据']]){const field=find(h.tree,n=>n.props?.placeholder===placeholder);assert.ok(field);field.props.onChange({target:{value}});h.flush()}
  const form=find(h.tree,n=>n.type==='form');form.props.onSubmit({preventDefault(){}});await h.settle();assert.equal(patches,1);assert.equal(h.reports.at(-1),'uncertain')
  click(h,'读取当前标定核对');await h.settle();assert.equal(reads,2);assert.equal(h.reports.at(-1),'uncertain');assert.match(text(h.tree),/不能确认原提交/)
  click(h,'结束核对');assert.match(h.question.message,/可能产生重复/);h.cancel();assert.equal(h.reports.at(-1),'uncertain');click(h,'结束核对');h.accept();assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(patches,1)
})

test('late old-identity editorial response cannot delete new identity pending before unmount',async()=>{
  const old={id:'q',key:'old-key',method:'POST',body:{expected_version:0,actor:'测试',note:'测试',decision:'APPROVE'}}
  let resolve;const result=new Promise(ok=>{resolve=ok});sessionStorage.setItem('wenyan-assessment-editorial-pending-v1',JSON.stringify(old))
  globalThis.__recoveryApi={list:async()=>({items:[],total:0,offset:0,limit:12}),write:()=>result}
  const h=host(modules.AssessmentQuestionWorkbench.AssessmentQuestionWorkbench,{});await h.settle();click(h,'使用原提交标识恢复结果')
  globalThis.__recoveryGeneration++;const next={...old,key:'new-user-key'};sessionStorage.setItem('wenyan-assessment-editorial-pending-v1',JSON.stringify(next));resolve(detail);await tick();h.flush()
  assert.equal(JSON.parse(sessionStorage.getItem('wenyan-assessment-editorial-pending-v1')).key,'new-user-key')
})

test('first deterministic recommendation 409 does not create an unknown operation',async()=>{
  let calls=0;globalThis.__recoveryApi={key:()=> 'first-key',recommendations:async()=>null,generate:async()=>{calls++;throw new TestError('RECOMMENDATION_CONFLICT',409)}}
  const h=wrapped('RecommendationQueue',{profileId:'p',onStartSession(){}});await h.settle();click(h,'确认起点并生成学习队列');await h.settle()
  assert.equal(calls,1);assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(find(h.tree,n=>n.type==='button'&&text(n).includes('恢复上一次提交')),undefined)
})
test('recommendation release requires explicit confirmation and never replays',async()=>{
  let calls=0;globalThis.__recoveryApi={key:()=> 'first-key',recommendations:async()=>null,generate:async()=>{calls++;throw new TestError('NETWORK_ERROR')}}
  const h=wrapped('RecommendationQueue',{profileId:'p',onStartSession(){}});await h.settle();click(h,'确认起点并生成学习队列');await h.settle()
  click(h,'结束核对');assert.match(text(h.tree),/重新提交可能产生重复/);click(h,'保留选择');assert.equal(h.reports.at(-1),'uncertain')
  click(h,'结束核对');click(h,'了解风险');assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(calls,1)
})
test('editorial release preserves pending when browser cannot clear stored operation',async()=>{
  const op={id:'q',key:'same-key',method:'POST',body:{expected_version:0,actor:'测试',note:'测试',decision:'APPROVE'}}
  sessionStorage.setItem('wenyan-assessment-editorial-pending-v1',JSON.stringify(op));globalThis.__recoveryApi={list:async()=>({items:[],total:0,offset:0,limit:12})}
  const h=host(modules.AssessmentQuestionWorkbench.AssessmentQuestionWorkbench,{});await h.settle();sessionStorage.removeItem=()=>{throw Error('storage unavailable')}
  click(h,'结束核对');assert.match(h.question.message,/可能重复/);h.accept();assert.equal(h.reports.at(-1),'uncertain');assert.match(text(h.tree),/无法清除原核对信息/)
})
test('AI release cancel preserves operation; explicit consent removes it without writing',async()=>{
  const fields={reviewer:'合成',decision:'UNCERTAIN',context_sufficiency:'UNCERTAIN',source_basis:'合成依据',rationale:'合成说明',alternatives:null,suggested_labels:['UNSCORABLE']}
  const op={key:'same-key-12345678',case_id:'case',body:{expected_suite_digest:'a'.repeat(64),expected_input_digest:'b'.repeat(64),expected_revision:0,fields}}
  sessionStorage.setItem('wenyan-ai-review-pending-v1',JSON.stringify(op));let writes=0
  globalThis.__recoveryApi={list:async()=>({items:[],recorded_cases:0,total:0,notes_total:0}),write:async()=>{writes++}}
  const h=host(modules.AIReasonReviewWorkbench.AIReasonReviewWorkbench,{});await h.settle();click(h,'结束核对');assert.match(h.question.message,/可能重复/);h.cancel();assert.equal(h.reports.at(-1),'uncertain')
  click(h,'结束核对');h.accept();assert.equal(sessionStorage.getItem('wenyan-ai-review-pending-v1'),null);assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(writes,0)
})
test('course ability malformed success does not discard original draft',async()=>{
  const lesson={id:'lesson',title:'合成课程',source:'合成原文',status:'DRAFT'}
  const row={lesson_id:'lesson',ability_level:null,dimension_tags:[],version:0,actor:null,note:'',updated_at:null,content_version:null,current_content_version:'abcdef012345',valid_for_content:false}
  let writes=0;globalThis.__recoveryApi={admin_list:async()=>({lessons:[lesson]}),requestJson:async(_url,init={})=>{if(init.method==='PATCH'){writes++;return{ability:row}}return{ability:row}}}
  const h=host(modules.CourseAbilityWorkbench.CourseAbilityWorkbench,{});await h.settle();click(h,'合成课程');await h.settle()
  find(h.tree,n=>n.type==='select').props.onChange({target:{value:'L1'}});h.flush()
  for(const [placeholder,value] of [['填写实际标定人','合成'],['说明题目要求、目标能力及难度依据；仅材料长短不足以判断','合成依据']]){find(h.tree,n=>n.props?.placeholder===placeholder).props.onChange({target:{value}});h.flush()}
  find(h.tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await h.settle()
  assert.equal(writes,1);assert.equal(h.reports.at(-1),'uncertain');assert.match(text(h.tree),/复制原标定请求/)
})
test('late AI receipt after identity generation changes cannot clear new identity operation',async()=>{
  const fields={reviewer:'合成',decision:'UNCERTAIN',context_sufficiency:'UNCERTAIN',source_basis:'合成依据',rationale:'合成说明',alternatives:null,suggested_labels:['UNSCORABLE']}
  const old={key:'old-key-123456789',case_id:'case',body:{expected_suite_digest:'a'.repeat(64),expected_input_digest:'b'.repeat(64),expected_revision:0,fields}}
  let resolve, reads=0;const response=new Promise(ok=>{resolve=ok});sessionStorage.setItem('wenyan-ai-review-pending-v1',JSON.stringify(old))
  globalThis.__recoveryApi={list:async()=>({items:[],recorded_cases:0,total:0,notes_total:0}),write:()=>response,get:async()=>{reads++;return {}}}
  const h=host(modules.AIReasonReviewWorkbench.AIReasonReviewWorkbench,{});await h.settle();click(h,'按原标识确认保存')
  globalThis.__recoveryGeneration++;const next={...old,key:'new-key-123456789'};sessionStorage.setItem('wenyan-ai-review-pending-v1',JSON.stringify(next));resolve({saved:{revision:1},replayed:true});await tick();h.flush()
  assert.equal(JSON.parse(sessionStorage.getItem('wenyan-ai-review-pending-v1')).key,next.key);assert.equal(reads,0)
})
test('late recommendation success after identity changes does not install old queue',async()=>{
  let resolve;const result=new Promise(ok=>{resolve=ok})
  globalThis.__recoveryApi={key:()=> 'old-key',recommendations:async()=>null,generate:()=>result}
  const h=wrapped('RecommendationQueue',{profileId:'p',onStartSession(){}});await h.settle();click(h,'确认起点并生成学习队列')
  globalThis.__recoveryGeneration++;resolve(plan);await tick();h.flush()
  assert.doesNotMatch(text(h.tree),/队列已由服务端确认/)
})
test('late assessment creation after identity changes cannot display old session',async()=>{
  let resolve;const result=new Promise(ok=>{resolve=ok})
  globalThis.__recoveryApi={key:()=> 'old-key',availability:async()=>availability,list:async()=>[],create:()=>result}
  const h=wrapped('AssessmentPage',{profileId:'p',onCreateProfile(){},onHome(){}});await h.settle();click(h,'先做四道轻自评')
  for(const x of ['基础起步','独立读懂文章','先联系上下文推断','会尝试独立阅读'])selectLabel(h,x)
  click(h,'创建 24 题试测');globalThis.__recoveryGeneration++;resolve(session());await tick();h.flush()
  assert.doesNotMatch(text(h.tree),/在原文中，独立作判断/);assert.equal(localStorage.getItem('wenyan-assessment:p'),null)
})
test('first deterministic assessment editorial 409 clears pending and preserves draft',async()=>{
  const original={...detail,version:0,validation_valid:true,question:{...question}}
  let writes=0;globalThis.__recoveryApi={key:()=> 'first-key',list:async()=>({items:[original],total:1,offset:0,limit:12}),get:async()=>original,write:async()=>{writes++;throw new TestError('ASSESSMENT_QUESTION_VERSION_CONFLICT',409)}}
  const h=host(modules.AssessmentQuestionWorkbench.AssessmentQuestionWorkbench,{});await h.settle();click(h,'测试');await h.settle()
  const stemLabel=find(h.tree,n=>n.type==='label'&&text(n).startsWith('题干'));assert.ok(stemLabel);find(stemLabel,n=>n.type==='textarea').props.onChange({target:{value:'合成修改'}});h.flush()
  for(const [placeholder,value] of [['填写实际核对者，不填系统代审','合成'],['填写实际核对的注本、页码、链接和判断依据；退回时说明具体问题','合成依据']]){find(h.tree,n=>n.props?.placeholder===placeholder).props.onChange({target:{value}});h.flush()}
  find(h.tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await h.settle()
  assert.equal(writes,1);assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(sessionStorage.getItem('wenyan-assessment-editorial-pending-v1'),null);assert.equal(find(stemLabel,n=>n.type==='textarea').props.value,'测试')
  assert.equal(find(h.tree,n=>n.type==='textarea'&&n.props.value==='合成修改')?.props.value,'合成修改')
})
test('first deterministic AI review 409 clears pending and preserves draft',async()=>{
  const aiDetail={case_id:'case',source:'合成样例',suite_digest:'a'.repeat(64),input_digest:'b'.repeat(64),revision:0,notes:[],historical_note_count:0,payload:{stage:'CORE',target:'从',student_conclusion:'合成',student_reason:'合成',visible_evidence:[],rubric:[]},development_expectation:{labels:[],note:'',required_evidence:[],required_criteria:[]}}
  const queue={items:[{case_id:'case',target:'从',stage:'CORE',source:'合成样例',revision:0,decision:null}],recorded_cases:0,total:1,notes_total:0}
  let writes=0;globalThis.__recoveryApi={key:()=> 'first-key-12345678',list:async()=>queue,get:async()=>aiDetail,write:async()=>{writes++;throw new TestError('AI_REVIEW_VERSION_CONFLICT',409)}}
  const h=host(modules.AIReasonReviewWorkbench.AIReasonReviewWorkbench,{});await h.settle();click(h,'合成样例');await h.settle()
  const label=find(h.tree,n=>n.type==='label'&&text(n).startsWith('实际核对人署名'));find(label,n=>n.type==='input').props.onChange({target:{value:'合成'}});h.flush()
  for(const [placeholder,value] of [['填写所用注本、页码、解释版本和依据；不要填写个人联系方式','合成依据'],['哪条原文线索支持或反驳这份理由？是否存在施受倒置或缺失语境？','合成理由']]){find(h.tree,n=>n.props?.placeholder===placeholder).props.onChange({target:{value}});h.flush()}
  find(h.tree,n=>n.type==='form').props.onSubmit({preventDefault(){}});await h.settle()
  assert.equal(writes,1);assert.notEqual(h.reports.at(-1),'uncertain');assert.equal(sessionStorage.getItem('wenyan-ai-review-pending-v1'),null);assert.ok(find(h.tree,n=>n.type==='textarea'&&n.props.value==='合成理由'))
})

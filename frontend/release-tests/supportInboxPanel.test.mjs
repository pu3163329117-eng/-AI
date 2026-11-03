import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/components/SupportInbox.tsx', import.meta.url), 'utf8')
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const url = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`
const rewrite = (s, from, to) => s.replaceAll(`'${from}'`, JSON.stringify(to)).replaceAll(`"${from}"`, JSON.stringify(to))
const httpUrl = url(compile(await readFile(new URL('../src/http.ts', import.meta.url), 'utf8')))
const contractUrl = url(rewrite(compile(await readFile(new URL('../src/supportInbox.ts', import.meta.url), 'utf8')), './http', httpUrl))
const { RequestError } = await import(httpUrl)
const hookUrl = url(['useEffect','useRef','useState'].map(name => `export const ${name}=(...a)=>globalThis.__supportHooks.${name}(...a);`).join('\n'))
const apiUrl = url('export const supportInboxApi={list:(...a)=>globalThis.__supportApi.list(...a),detail:(...a)=>globalThis.__supportApi.detail(...a),reply:(...a)=>globalThis.__supportApi.reply(...a),status:(...a)=>globalThis.__supportApi.status(...a)};')
const feedbackUrl = url('export const feedbackDate=x=>x;export const feedbackRequestId=()=>globalThis.__supportKey();')
const confirmationUrl = url('export const useConfirmationDialog=()=>({ask:r=>globalThis.__supportAsk(r),modal:null});')
let js = compile(source).replace(/import ['"]\.\/supportInbox\.css['"];?/, '')
for (const [from,to] of [['react',hookUrl],['react/jsx-runtime',import.meta.resolve('react/jsx-runtime')],['../supportInboxApi',apiUrl],['../feedback',feedbackUrl],['../http',httpUrl],['../supportInbox',contractUrl],['./ConfirmationDialog',confirmationUrl]]) js=rewrite(js,from,to)
const { SupportInbox } = await import(url(js))
const id = '00000000-0000-4000-8000-000000000001', otherId = '00000000-0000-4000-8000-000000000002', replyId = '00000000-0000-4000-8000-000000000003'
const meta = (chosen=id, extra={}) => ({ id:chosen, reference:chosen===id?'WY-0123456789ABCDEF':'WY-FEDCBA9876543210', kind:'feedback', category:'bug', page:'#/training', build_version:'synthetic-inbox', status:'received', created_at:'2026-10-25T00:00:00.000000Z', updated_at:'2026-10-25T00:00:00.000001Z', ...extra })
const detail = (chosen=id,extra={}) => ({ item:meta(chosen), message:'合成反馈正文不少于十个汉字。', device:'合成手机测试', replies:[], ...extra })
const page = (extra={}) => ({ items:[meta(),meta(otherId)], total:2, offset:0, limit:20, ...extra })
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function all(node){if(!node||typeof node!=='object')return [];return [node,...(Array.isArray(node.props?.children)?node.props.children.flat(Infinity):[node.props?.children]).flatMap(all)]}
function text(node){if(node==null||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);return (Array.isArray(node.props?.children)?node.props.children.flat(Infinity):[node.props?.children]).map(text).join('')}
const button=(tree,name)=>{const found=all(tree).find(n=>n.type==='button'&&text(n)===name);assert.ok(found,name);return found}
const field=(tree,label)=>{const found=all(tree).find(n=>n.type==='label'&&text(n).startsWith(label));assert.ok(found,label);return all(found).find(n=>['input','select','textarea'].includes(n.type))}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const event={preventDefault(){}}
function host(overrides={}){
  const calls=[],risks=[],asks=[],slots=[],effects=[]
  let changed=true,cursor=0,disposed=false,lateWrites=0,keyCount=0,tree
  const api={list:async q=>page({offset:q.offset}),detail:async chosen=>detail(chosen),reply:async(chosen,payload)=>detail(chosen,{item:meta(chosen,{updated_at:'2026-10-25T00:00:01.000000Z'}),replies:[{id:replyId,message:payload.message,created_at:'2026-10-25T00:00:01.000000Z'}]}),status:async(chosen,payload)=>detail(chosen,{item:meta(chosen,{status:payload.status,updated_at:'2026-10-25T00:00:01.000000Z'})}),...overrides}
  globalThis.__supportApi=Object.fromEntries(Object.keys(api).map(name=>[name,(...args)=>{calls.push({name,args});return api[name](...args)}]))
  globalThis.__supportAsk=request=>{if(!asks.length)asks.push(request)}
  globalThis.__supportKey=()=>{keyCount++;return `00000000-0000-4000-8000-${String(keyCount).padStart(12,'0')}`}
  const hooks={
    useState(initial){const at=cursor++;if(!(at in slots))slots[at]=typeof initial==='function'?initial():initial;return [slots[at],next=>{if(disposed){lateWrites++;return}next=typeof next==='function'?next(slots[at]):next;if(!Object.is(next,slots[at])){slots[at]=next;changed=true}}]},
    useRef(initial){return slots[cursor++]??={current:initial}},
    useEffect(effect,deps){const at=cursor++,old=slots[at];if(!old||deps.some((v,i)=>!Object.is(v,old.deps[i]))){const next={deps,cleanup:old?.cleanup};slots[at]=next;effects.push(()=>{next.cleanup?.();next.cleanup=effect()})}},
  }
  const ui={calls,risks,asks,get keys(){return keyCount},get lateWrites(){return lateWrites},
    flush(){let turns=0;do{assert.ok(++turns<25);changed=false;cursor=0;globalThis.__supportHooks=hooks;tree=SupportInbox({onRiskChange:r=>risks.push(r)});for(const node of all(tree))if(node.ref)node.ref.current={scrollIntoView(){},focus(){}};while(effects.length)effects.shift()()}while(changed);return tree},
    async settle(){await tick();return ui.flush()},
    confirm(){const request=asks.shift();assert.ok(request,'confirmation requested');request.onConfirm();return request},cancel(){assert.ok(asks.shift(),'confirmation requested')},
    dispose(){disposed=true;for(const slot of slots)slot?.cleanup?.()},
  };return ui
}
async function opened(ui){ui.flush();let tree=await ui.settle();button(tree,'WY-0123456789ABCDEF使用反馈 · 已收到2026-10-25T00:00:00.000000Z').props.onClick();ui.flush();return ui.settle()}
function editMessage(tree,value='这是一份合法长度的合成站内回复。'){field(tree,'公开站内回复').props.onChange({target:{value}})}
function submit(tree){const form=all(tree).find(n=>n.type==='form'&&n.props.className==='support-inbox-reply');assert.ok(form);form.props.onSubmit(event)}

test('initial loading reads metadata once and detail/body are only fetched after an explicit record click',async()=>{
  const ui=host();try{let tree=ui.flush();assert.match(text(tree),/正在读取反馈列表/);tree=await ui.settle();assert.deepEqual(ui.calls.map(c=>c.name),['list']);assert.doesNotMatch(text(tree),/合成反馈正文|合成手机测试/);tree=await opened(ui);assert.deepEqual(ui.calls.map(c=>c.name),['list','detail']);assert.match(text(tree),/合成反馈正文/);assert.match(text(tree),/合成手机测试/)}finally{ui.dispose()}
})

test('list failure is not zero, cancellation aborts and an ignored late response cannot replace the new result',async()=>{
  const old=deferred(),ui=host({list:q=>q.offset===0&&ui.calls.filter(c=>c.name==='list').length===1?old.promise:Promise.resolve(page({items:[],total:0}))})
  try{let tree=ui.flush();const signal=ui.calls[0].args[1];button(tree,'取消当前读取').props.onClick();tree=ui.flush();assert.equal(signal.aborted,true);assert.match(text(tree),/读取已取消/);button(tree,'重新读取列表').props.onClick();ui.flush();tree=await ui.settle();assert.match(text(tree),/没有符合当前条件/);old.resolve(page());tree=await ui.settle();assert.doesNotMatch(text(tree),/WY-0123456789ABCDEF/)}finally{ui.dispose()}
})

test('draft guards record/filter/page/reload changes, cancellation preserves and confirmation resets only on accepted navigation',async()=>{
  const ui=host();try{let tree=await opened(ui);editMessage(tree);tree=ui.flush();assert.equal(ui.risks.at(-1),'dirty');field(tree,'处理状态').props.onChange({target:{value:'resolved'}});ui.cancel();tree=ui.flush();assert.equal(field(tree,'公开站内回复').props.value,'这是一份合法长度的合成站内回复。');assert.equal(ui.calls.filter(c=>c.name==='list').length,1)
    button(tree,'重新读取列表').props.onClick();ui.confirm();ui.flush();tree=await ui.settle();assert.equal(ui.calls.filter(c=>c.name==='list').length,2);assert.doesNotMatch(text(tree),/合成反馈正文/);assert.equal(ui.risks.at(-1),null)
  }finally{ui.dispose()}
})

test('stale confirmation cannot discard a later draft or bypass a synchronous operation lock',async()=>{
  const ui=host();try{let tree=await opened(ui);editMessage(tree);tree=ui.flush();button(tree,'重新读取列表').props.onClick();editMessage(tree,'确认弹窗后程序性变更的合成回复。');ui.flush();ui.confirm();await ui.settle();assert.equal(ui.calls.filter(c=>c.name==='list').length,1);assert.equal(field(ui.flush(),'公开站内回复').props.value,'确认弹窗后程序性变更的合成回复。')}finally{ui.dispose()}
})

test('exact search is normalized and no account or fuzzy search channel is transmitted',async()=>{
  const ui=host({list:async q=>page({items:q.reference?[meta()]:[meta(),meta(otherId)],total:q.reference?1:2})});try{ui.flush();let tree=await ui.settle();field(tree,'完整受理编号').props.onChange({target:{value:' user@example.com '}});tree=ui.flush();all(tree).find(n=>n.type==='form').props.onSubmit(event);tree=ui.flush();assert.match(text(tree),/不支持模糊或邮箱搜索/);assert.equal(ui.calls.length,1)
    field(tree,'完整受理编号').props.onChange({target:{value:' wy-0123456789abcdef '}});tree=ui.flush();all(tree).find(n=>n.type==='form').props.onSubmit(event);ui.flush();await ui.settle();assert.equal(ui.calls.at(-1).args[0].reference,'WY-0123456789ABCDEF')
  }finally{ui.dispose()}
})

test('list failure remains unavailable instead of displaying zero and retries only by explicit action',async()=>{
  let count=0;const ui=host({list:async()=>{if(++count===1)throw new RequestError('NETWORK_ERROR');return page()}})
  try{ui.flush();let tree=await ui.settle();assert.match(text(tree),/列表暂不可用/);assert.doesNotMatch(text(tree),/没有符合当前条件|共 0 条/);await ui.settle();assert.equal(count,1);button(tree,'重新读取列表').props.onClick();ui.flush();tree=await ui.settle();assert.equal(count,2);assert.match(text(tree),/共 2 条/)}finally{ui.dispose()}
})

test('normal reply waits for confirmation/receipt, rejects reentry and clears only its confirmed reply draft',async()=>{
  const pending=deferred(),ui=host({reply:()=>pending.promise});try{let tree=await opened(ui);editMessage(tree);field(tree,'新的处理状态').props.onChange({target:{value:'in_progress'}});tree=ui.flush();submit(tree);assert.equal(ui.calls.filter(c=>c.name==='reply').length,0);const request=ui.confirm();request.onConfirm();tree=ui.flush();assert.equal(ui.calls.filter(c=>c.name==='reply').length,1);assert.equal(ui.risks.at(-1),'working');assert.equal(field(tree,'公开站内回复').props.disabled,true);assert.doesNotMatch(text(tree),/服务器已确认站内回复/)
    pending.resolve(detail(id,{item:meta(id,{updated_at:'2026-10-25T00:00:01.000000Z'}),replies:[{id:replyId,message:'这是一份合法长度的合成站内回复。',created_at:'2026-10-25T00:00:01.000000Z'}]}));tree=await ui.settle();assert.match(text(tree),/服务器已确认站内回复/);assert.equal(field(tree,'公开站内回复').props.value,'');assert.equal(field(tree,'新的处理状态').props.value,'in_progress');assert.equal(ui.risks.at(-1),'dirty')
  }finally{ui.dispose()}
})

test('CAS conflict preserves copyable draft, blocks repeat writes and requires explicit confirmed reread',async()=>{
  const ui=host({reply:async()=>{throw new RequestError('SUPPORT_CASE_CHANGED_REFRESH_REQUIRED',409)}});try{let tree=await opened(ui);editMessage(tree);tree=ui.flush();submit(tree);ui.confirm();ui.flush();tree=await ui.settle();assert.match(text(tree),/版本冲突/);assert.equal(field(tree,'公开站内回复').props.value,'这是一份合法长度的合成站内回复。');assert.equal(button(tree,'发送站内回复').props.disabled,true);button(tree,'重新读取当前详情').props.onClick();ui.cancel();tree=ui.flush();assert.equal(field(tree,'公开站内回复').props.value,'这是一份合法长度的合成站内回复。');button(tree,'重新读取当前详情').props.onClick();ui.confirm();ui.flush();tree=await ui.settle();assert.equal(field(tree,'公开站内回复').props.value,'')
  }finally{ui.dispose()}
})

test('unknown reply freezes editing/navigation and only explicit original key/payload verification can confirm it',async()=>{
  let attempts=0;const ui=host({reply:async(chosen,payload)=>{if(++attempts===1)throw new RequestError('REQUEST_TIMEOUT');return detail(chosen,{item:meta(chosen,{status:'resolved',updated_at:'2026-10-25T00:00:01.000000Z'}),replies:[{id:replyId,message:payload.message,created_at:'2026-10-25T00:00:01.000000Z'}]})}})
  try{let tree=await opened(ui);editMessage(tree,'\u0085\u001c 这是一份合法长度的合成站内回复。 \u0085');tree=ui.flush();submit(tree);ui.confirm();ui.flush();tree=await ui.settle();assert.equal(ui.risks.at(-1),'uncertain');assert.match(text(tree),/提交结果尚未确认/);assert.equal(field(tree,'公开站内回复').props.disabled,true);const calls=ui.calls.length;button(tree,'重新读取列表').props.onClick();field(tree,'处理状态').props.onChange({target:{value:'resolved'}});editMessage(tree,'不该改动未知结果原内容');await ui.settle();assert.equal(ui.calls.length,calls)
    button(tree,'重新读取原记录核对').props.onClick();ui.flush();tree=await ui.settle();assert.equal(ui.calls.at(-1).args[0],id);assert.equal(ui.risks.at(-1),'uncertain');assert.equal(attempts,1)
    button(tree,'核对原回复提交').props.onClick();ui.cancel();await ui.settle();assert.equal(attempts,1);button(tree,'核对原回复提交').props.onClick();ui.confirm();ui.flush();tree=await ui.settle();const writes=ui.calls.filter(c=>c.name==='reply');assert.equal(ui.keys,1);assert.deepEqual(writes[0].args[1],writes[1].args[1]);assert.equal(writes[0].args[1].message,'这是一份合法长度的合成站内回复。');assert.equal(ui.risks.at(-1),null);assert.match(text(tree),/服务器已确认站内回复/)
  }finally{ui.dispose()}
})

test('a successful HTTP-shaped old reply body is not accepted as receipt and keeps the draft frozen',async()=>{
  const ui=host({reply:async()=>detail()});try{let tree=await opened(ui);editMessage(tree);tree=ui.flush();submit(tree);ui.confirm();ui.flush();tree=await ui.settle();assert.match(text(tree),/提交结果尚未确认/);assert.equal(ui.risks.at(-1),'uncertain');assert.equal(field(tree,'公开站内回复').props.value,'这是一份合法长度的合成站内回复。');assert.doesNotMatch(text(tree),/服务器已确认站内回复/)}finally{ui.dispose()}
})

test('unknown status only reads its original ID, does not POST again or attribute the current state to this action',async()=>{
  let checks=0;const ui=host({status:async()=>{throw new RequestError('NETWORK_ERROR')},detail:async chosen=>++checks===1?detail(chosen):detail(chosen,{item:meta(chosen,{status:'resolved'})})});try{let tree=await opened(ui);field(tree,'新的处理状态').props.onChange({target:{value:'in_progress'}});tree=ui.flush();button(tree,'更新处理状态').props.onClick();ui.confirm();ui.flush();tree=await ui.settle();assert.equal(ui.risks.at(-1),'uncertain');assert.equal(all(tree).some(n=>n.type==='button'&&text(n)==='核对原回复提交'),false)
    button(tree,'重新读取原记录核对').props.onClick();ui.flush();tree=await ui.settle();assert.match(text(tree),/无法据此认定是本次操作产生/);assert.equal(ui.calls.filter(c=>c.name==='status').length,1);assert.equal(ui.calls.at(-1).args[0],id);assert.equal(ui.risks.at(-1),null)
  }finally{ui.dispose()}
})

test('confirmed workflow writes invalidate all filtered rows/counts but preserve detail and never auto-refresh',async()=>{
  const ui=host();try{ui.flush();let tree=await ui.settle();field(tree,'处理状态').props.onChange({target:{value:'received'}});ui.flush();tree=await ui.settle();button(tree,'WY-0123456789ABCDEF使用反馈 · 已收到2026-10-25T00:00:00.000000Z').props.onClick();ui.flush();tree=await ui.settle();field(tree,'新的处理状态').props.onChange({target:{value:'in_progress'}});tree=ui.flush();button(tree,'更新处理状态').props.onClick();ui.confirm();ui.flush();tree=await ui.settle()
    assert.match(text(tree),/列表快照已过期/);assert.match(text(tree),/合成反馈正文/);assert.doesNotMatch(text(all(tree).find(n=>n.type==='aside')),/WY-0123456789ABCDEF|共 2 条/);assert.equal(ui.calls.filter(c=>c.name==='list').length,2);assert.equal(field(tree,'处理状态').props.value,'received')
    await ui.settle();assert.equal(ui.calls.filter(c=>c.name==='list').length,2);button(tree,'按原筛选重新读取第一页').props.onClick();ui.flush();await ui.settle();assert.equal(ui.calls.at(-1).args[0].status,'received');assert.equal(ui.calls.at(-1).args[0].offset,0)
  }finally{ui.dispose()}
})

test('busy write disables filters and reentrant stale callbacks cannot read another record',async()=>{
  const wait=deferred(),ui=host({reply:()=>wait.promise});try{let tree=await opened(ui);const other=button(tree,'WY-FEDCBA9876543210使用反馈 · 已收到2026-10-25T00:00:00.000000Z');editMessage(tree);tree=ui.flush();submit(tree);ui.confirm();tree=ui.flush();other.props.onClick();button(tree,'重新读取列表').props.onClick();assert.equal(ui.calls.filter(c=>c.name==='detail').length,1);assert.equal(field(tree,'完整受理编号').props.disabled,true)}finally{ui.dispose();wait.resolve(detail());await tick();assert.equal(ui.lateWrites,0)}
})

test('unmount aborts active reads and late success/error never update state or reopen content',async()=>{
  for(const fail of [false,true]){const wait=deferred(),ui=host({list:()=>wait.promise});ui.flush();const sig=ui.calls[0].args[1];ui.dispose();assert.equal(sig.aborted,true);if(fail)wait.reject(new Error('late synthetic failure'));else wait.resolve(page());await tick();assert.equal(ui.lateWrites,0)}
})

test('shrunk and empty non-first pages show honest empty-page guidance with explicit first-page recovery',async()=>{
  for(const remaining of [1,0]){const ui=host({list:async q=>q.offset===20?page({items:[],total:remaining,offset:20}):page({total:21})});try{ui.flush();let tree=await ui.settle();button(tree,'下一页反馈').props.onClick();ui.flush();tree=await ui.settle();assert.match(text(tree),/本页已无记录/);assert.doesNotMatch(text(tree),/第 21–20/);button(tree,'返回第一页反馈').props.onClick();ui.flush();await ui.settle();assert.equal(ui.calls.at(-1).args[0].offset,0)}finally{ui.dispose()}}
})

test('body/device/replies are plain text with no identity, storage, export or deletion implementation',async()=>{
  const ui=host({detail:async()=>detail(id,{message:'<script>synthetic plain text only</script>',device:'https://example.invalid/not-clickable'})});try{const tree=await opened(ui);assert.match(text(tree),/<script>synthetic plain text only<\/script>/);assert.equal(all(tree).some(n=>n.type==='a'||n.type==='script'),false)}finally{ui.dispose()}
  assert.doesNotMatch(source,/dangerouslySetInnerHTML|window\.(confirm|alert)|localStorage|sessionStorage|document\.cookie|console\.|fetch\(|\.delete\(|\.export\(/)
  const css=await readFile(new URL('../src/components/supportInbox.css',import.meta.url),'utf8');assert.match(css,/min-height: 44px/);assert.match(css,/font-size: 16px/);assert.match(css,/white-space: pre-wrap/);assert.match(css,/prefers-reduced-motion/);assert.match(css,/@media \(max-width:48rem\)/)
})

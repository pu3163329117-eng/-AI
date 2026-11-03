import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const read=name=>readFile(new URL(`../src/${name}`,import.meta.url),'utf8')
const data=value=>`data:text/javascript;base64,${Buffer.from(value).toString('base64')}`
const compile=value=>ts.transpileModule(value,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const observations=data(compile(await read('observations.ts')))
const http=data(compile(await read('http.ts')))
const contracts=data(compile(await read('contracts.ts')).replaceAll("'./observations'",JSON.stringify(observations)).replaceAll('"./observations"',JSON.stringify(observations)))
const annotationQueue=data(compile(await read('annotationQueue.ts')))
let code=compile((await read('api.ts')).replace("import.meta.env.VITE_API_ROOT ?? ''",JSON.stringify('http://127.0.0.1:18761')))
for(const[from,to]of [['./http',http],['./contracts',contracts],['./annotationQueue',annotationQueue]])code=code.replaceAll(`'${from}'`,JSON.stringify(to)).replaceAll(`"${from}"`,JSON.stringify(to))
const {adminLessonApi}=await import(data(code))
const oldFetch=globalThis.fetch
test.after(()=>{globalThis.fetch=oldFetch})
const payload=()=>({school_stage:'JUNIOR',title:'合成课程',source:'合成原典',difficulty:'基础',estimated_minutes:5,summary:'测试',textbook_tags:['QA'],theme:'测试',accumulation_points:['从'],reasoning_points:['关系'],reasoning_level:'L1'})
const reviewed=()=>({status:'UNREVIEWED',content_version:'abcdef012345',reviewer:null,note:null,reviewed_at:null,issues:[]})
const draft=(data,content={})=>({id:'synthetic-id',...data,status:'DRAFT',content,review:reviewed()})
const respond=lesson=>{globalThis.fetch=async(url,init)=>{assert.equal(new URL(url).hostname,'127.0.0.1');assert.equal(init.method,'POST');return new Response(JSON.stringify({lesson}),{status:201})}}
const stage=()=>({source:'合成原典',passage:'甲从乙学。',variable:'从',question:'从是什么意思？',choices:['跟随','归还'],evidence:'乙',correct_answer:'跟随',hints:['看关系'],validated_feedback:'有证据'})
const normalized=paragraph=>({paragraphs:[paragraph],full_text:paragraph,author:'作者信息待教研补充',era:'时代信息待教研补充',work_note:'当前课内原文',extent:'EXCERPT',text_version:'课内资料 · 待教研逐篇校订',source_url:'',terms:[]})

test('create accepts exact skeleton receipt with extra server fields',async()=>{
  const sent=payload(), result=draft(sent);result.slug='server-generated';respond(result)
  assert.equal((await adminLessonApi.create(sent)).lesson.id,'synthetic-id')
})
test('supplied context is checked against documented server normalization',async()=>{
  const one={...stage(),reading_context:{paragraphs:['甲从乙学。'],author:'',era:'',text_version:'',ignored:'discarded'}}
  const sent={...payload(),content:{CORE:one,TRANSFER:structuredClone(one)}}
  const resolved={...stage(),reading_context:normalized(one.passage)}
  respond(draft(sent,{CORE:resolved,TRANSFER:structuredClone(resolved)}))
  assert.ok((await adminLessonApi.create(sent)).lesson.id)
})
test('omitted context allows server source-based enrichment while preserving authored stage',async()=>{
  const sent={...payload(),content:{CORE:stage(),TRANSFER:stage()}}
  const enriched={...stage(),reading_context:{paragraphs:['任意后端来源'],author:'来源提供'}}
  respond(draft(sent,{CORE:enriched,TRANSFER:structuredClone(enriched)}))
  assert.ok((await adminLessonApi.create(sent)).lesson.id)
})
for(const [name,alter]of [
  ['title',x=>x.title='另一课'],['source',x=>x.source='另一个来源'],['school stage',x=>x.school_stage='SENIOR'],
  ['summary',x=>x.summary='不同摘要'],['tags',x=>x.textbook_tags=['OTHER']],['passage',x=>x.content.CORE.passage='不同原文'],
  ['answer',x=>x.content.CORE.correct_answer='归还'],['reading context',x=>x.content.CORE.reading_context.paragraphs=['不同段落']],
]) test(`same-shape create receipt with different ${name} is unknown`,async()=>{
  const input={...stage(),reading_context:{paragraphs:['甲从乙学。']}}
  const sent={...payload(),content:{CORE:input,TRANSFER:structuredClone(input)}}
  const resolved={...stage(),reading_context:normalized(input.passage)}
  const result=draft(sent,{CORE:resolved,TRANSFER:structuredClone(resolved)});alter(result);respond(result)
  await assert.rejects(adminLessonApi.create(sent),error=>error.message==='INVALID_RESPONSE')
})

const respondUpdate=lesson=>{globalThis.fetch=async(url,init)=>{assert.equal(new URL(url).hostname,'127.0.0.1');assert.equal(init.method,'PATCH');return new Response(JSON.stringify({lesson}),{status:200})}}
test('update accepts exact returned fields while retaining unsubmitted existing content',async()=>{const sent=payload(),result=draft(sent,{CORE:stage(),TRANSFER:stage()});respondUpdate(result);assert.equal((await adminLessonApi.update('synthetic-id',sent,'abcdef012345')).lesson.id,'synthetic-id')})
for(const [name,alter]of [['id',x=>x.id='other-id'],['title',x=>x.title='不同标题'],['summary',x=>x.summary='不同摘要'],['tags',x=>x.textbook_tags=['OTHER']],['passage',x=>x.content.CORE.passage='不同原文']]) test(`same-shape update receipt with different ${name} remains unknown`,async()=>{
 const sent={...payload(),content:{CORE:stage(),TRANSFER:stage()}}, resolved={...stage(),reading_context:{paragraphs:['来源数据']}}, result=draft(sent,{CORE:resolved,TRANSFER:structuredClone(resolved)});alter(result);respondUpdate(result);await assert.rejects(adminLessonApi.update('synthetic-id',sent,'abcdef012345'),error=>error.message==='INVALID_RESPONSE')
})

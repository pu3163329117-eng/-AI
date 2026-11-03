import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import ts from 'typescript'
const require=createRequire(import.meta.url)
const source=await readFile(new URL('../src/components/ReasonFeedback.tsx',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const flatten=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(flatten)]
function render(callback){
  let index=0; const calls=[],exports={}
  const feedback={status:'OK',cached:false,summary:'合成意见',matched_criteria:[],cited_evidence:[],next_step:'回原文'}
  const hooks={useState(initial){const i=index++;return[i===0?true:i===5?feedback:initial,()=>{}]},useEffect(){},useRef(){return{current:null}}}
  new Function('require','exports',compiled)(path=>{
    if(path==='react')return hooks
    if(path==='react/jsx-runtime')return require(path)
    if(path==='../navigation')return{jumpTo:id=>calls.push(['legacy',id])}
    if(path==='../aiFeedbackApi')return{aiFeedbackApi:{available(){throw Error('NO_NETWORK')},preview(){throw Error('NO_PROVIDER')}}}
    if(path==='../aiFeedback')return{previewMatches:()=>true,previewMessages:{}}
    if(path==='../http')return{errorMessage:String}
    throw Error(path)
  },exports)
  const tree=exports.ReasonFeedback({sessionId:'synthetic',session:{stage:'CORE',reasoning_graph:{reason:'自己补充'},learning_trace:{stages:{CORE:{first_attempt:{}}}}},disabled:false,dirty:false,onRequestContext:callback?()=>calls.push(['drawer']):undefined})
  return{tree,calls}
}
test('actual feedback result handler opens parent reader drawer; legacy caller keeps original navigation',()=>{
  for(const callback of [true,false]){
    const {tree,calls}=render(callback)
    const button=flatten(tree).find(n=>n.type==='button'&&n.props.children==='回到原文核对')
    assert.ok(button);assert.equal(button.props.disabled,false);button.props.onClick()
    assert.deepEqual(calls,callback?[['drawer']]:[['legacy','fulltext-title']])
  }
})

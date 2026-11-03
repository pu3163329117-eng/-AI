import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Resolve dependencies from this project, not a machine-specific path.
const require = createRequire(import.meta.url)
const ts = require('typescript')
const jsx = pathToFileURL(require.resolve('react/jsx-runtime')).href
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const auth = await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8')
const file = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'DualAdminWorkbench')
assert.ok(component, 'actual candidate component exists')
let adminExpression
function visit(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node.left.getText(file) === "page === 'admin'") adminExpression = node.getText(file)
  ts.forEachChild(node, visit)
}
visit(file)
assert.ok(adminExpression, 'actual App admin branch exists')
const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(jsx))
const moduleUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const { canManage, canManageSupport } = await import(moduleUrl(compile(auth)))
globalThis.__dualAuth = { canManage, canManageSupport }
const componentCode = compile('export ' + component.getText(file))
const { DualAdminWorkbench } = await import(moduleUrl(`const useState=(...x)=>globalThis.__dualHost.useState(...x),useRef=(...x)=>globalThis.__dualHost.useRef(...x),useCallback=f=>f;const useConfirmationDialog=()=>({modal:null,ask:q=>globalThis.__dualHost.ask(q)});function SupportInbox(){};\n${componentCode}`))
const branchCode = compile(`export function renderBranch(auth, onExitRiskChange) { const page='admin', profile=null, setPage=()=>{}; const adminAllowed=canManage(auth)||canManageSupport(auth); return (${adminExpression}); }`)
const { renderBranch } = await import(moduleUrl(`const canManage=globalThis.__dualAuth.canManage,canManageSupport=globalThis.__dualAuth.canManageSupport;function SupportInbox(){};function DualAdminWorkbench(){};function AdminWorkbench(){};function ContentAdminPage(){};function CourseAbilityWorkbench(){};function AssessmentQuestionWorkbench(){};function AIReasonReviewWorkbench(){};\n${branchCode}`))

const session = (admin, support, role = 'admin') => ({ mode:'invite', authenticated:true, admin_enabled:admin, support_admin_enabled:support, user:{ id:'synthetic', role } })
function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(nodes)] }
function host(supportAllowed=true) {
  const slots=[]; let cursor=0; const reports=[]
  const h={ supportAllowed, question:null, reports, childReport:null,
    useState(initial){ const i=cursor++; if(!(i in slots)) slots[i]=initial; return [slots[i], value=>{slots[i]=typeof value==='function'?value(slots[i]):value}] },
    useRef(initial){ const i=cursor++; return slots[i]??={current:initial} },
    ask(q){ if(!h.question)h.question=q },
    finish(accepted){ const q=h.question;h.question=null;if(accepted)q?.onConfirm() },
    render(){ cursor=0; globalThis.__dualHost=h; return DualAdminWorkbench({supportAllowed:h.supportAllowed,onExitRiskChange:r=>reports.push(r),children:report=>{h.childReport=report;return 'EDITORIAL'}}) },
    button(label){return nodes(h.render()).find(n=>n.type==='button' && n.props.children===label)},
    inbox(){return nodes(h.render()).find(n=>typeof n.type==='function' && n.type.name==='SupportInbox')},
  }
  h.render(); return h
}
test('real permission branch selects forbidden, support-only, admin-only and dual paths', () => {
  const a=renderBranch(session(false,false),()=>{}); assert.ok(nodes(a).some(n=>n.type==='main'&&n.props.className==='auth-forbidden'))
  const b=renderBranch(session(false,true),()=>{}); assert.ok(nodes(b).some(n=>typeof n.type==='function'&&n.type.name==='SupportInbox'))
  const c=renderBranch(session(true,false),()=>{}); assert.equal(c.type.name,'DualAdminWorkbench'); assert.equal(c.props.supportAllowed,false)
  const d=renderBranch(session(true,true),()=>{}); assert.equal(d.type.name,'DualAdminWorkbench'); assert.equal(d.props.supportAllowed,true)
  const student=renderBranch(session(true,true,'student'),()=>{}); assert.ok(nodes(student).some(n=>n.type==='main'&&n.props.className==='auth-forbidden'))
})
test('dual permissions expose both views; admin-only never renders support', () => {
  const h=host(); assert.equal(h.inbox(),undefined); assert.ok(h.button('用户反馈')); h.button('用户反馈').props.onClick(); assert.ok(h.inbox());
  h.button('教研工作台').props.onClick(); assert.equal(h.inbox(),undefined)
  const single=host(false); assert.equal(single.button('用户反馈'),undefined); assert.equal(single.inbox(),undefined)
})
test('dirty cancellation preserves editor and confirmation switches once', () => {
  const h=host(); h.childReport('dirty'); h.button('用户反馈').props.onClick(); assert.ok(h.question); assert.equal(h.inbox(),undefined); h.finish(false); assert.equal(h.inbox(),undefined)
  h.button('用户反馈').props.onClick(); h.finish(true); assert.ok(h.inbox()); assert.equal(h.reports.at(-1),null)
})
test('working and changing risk block stale confirmation; uncertain warns and can be cancelled', () => {
  const h=host(); h.childReport('working'); h.button('用户反馈').props.onClick(); assert.equal(h.question,null); assert.equal(h.inbox(),undefined)
  h.childReport('dirty'); h.button('用户反馈').props.onClick(); h.childReport('working'); h.finish(true); assert.equal(h.inbox(),undefined)
  h.childReport('uncertain'); h.button('用户反馈').props.onClick(); assert.match(h.question.message,/不撤销服务端写入/); h.finish(false); assert.equal(h.inbox(),undefined)
  h.button('用户反馈').props.onClick(); h.childReport(null); h.finish(true); assert.equal(h.inbox(),undefined)
})
test('support to editorial applies the same guard, and revoked support is hidden', () => {
  const h=host(); h.button('用户反馈').props.onClick(); const inbox=h.inbox(); assert.ok(inbox); inbox.props.onRiskChange('dirty'); h.button('教研工作台').props.onClick(); assert.ok(h.question);h.finish(false);assert.ok(h.inbox());
  h.button('教研工作台').props.onClick();h.finish(true);assert.equal(h.inbox(),undefined)
  h.button('用户反馈').props.onClick();assert.ok(h.inbox());h.supportAllowed=false;assert.equal(h.inbox(),undefined);assert.equal(h.button('用户反馈'),undefined)
  h.supportAllowed=true;assert.equal(h.inbox(),undefined);assert.ok(h.button('用户反馈'))
})
test('a stale confirmation cannot reopen support after permission revocation', () => {
  const h=host(); h.childReport('dirty'); h.button('用户反馈').props.onClick(); assert.ok(h.question)
  h.supportAllowed=false; h.render(); h.finish(true); assert.equal(h.inbox(),undefined); assert.equal(h.button('用户反馈'),undefined)
})

const home = document.querySelector('#home');
const training = document.querySelector('#training');
let sessionId, session, selected;
const $ = (s) => document.querySelector(s);
const feedback = (message) => $('#feedback').textContent = message || '';
async function api(path, options = {}) { const r = await fetch(path, options); const data = await r.json(); if (!r.ok) throw new Error(data.error?.code || 'REQUEST_FAILED'); return data; }
async function start() { const data = await api('/api/v1/training/sessions', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); sessionId=data.session_id; session=data.session; home.hidden=true;training.hidden=false; render(); }
function render(){ $('#choices').innerHTML=''; session.choices.forEach(answer=>{const b=document.createElement('button'); b.textContent=answer; if(selected===answer)b.className='selected';b.onclick=()=>{selected=answer;render()};$('#choices').append(b)}); feedback(session.feedback); $('#hintbox').hidden=!session.hint;$('#hintbox').textContent=session.hint||'';$('#evidence').classList.toggle('selected',session.evidence_selected);$('#transfer').hidden=!session.transfer_ready; $('#submit').disabled=!selected; $('#submit').textContent=session.completed?'已完成':'提交判断'; }
async function command(type,payload={}){try{const data=await api(`/api/v1/training/sessions/${sessionId}/commands`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({type,payload,expected_state_version:session.state_version})});session=data.session;render()}catch(e){feedback('操作未完成：'+e.message)}}
$('#start').onclick=start;$('#evidence').onclick=()=>command('SELECT_EVIDENCE');$('#defer').onclick=()=>command('DEFER_VARIABLE');$('#hint').onclick=()=>command('REQUEST_HINT');$('#submit').onclick=()=>selected&&command('SUBMIT_ATTEMPT',{answer:selected});$('#transfer').onclick=()=>command('CONTINUE_TO_TRANSFER');

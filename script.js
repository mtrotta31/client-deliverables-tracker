// script.js — weekly model + clients CRUD + addresses/EMRs + dashboard + client detail
import { getSupabase } from './supabaseClient.js';

const DEBUG = true; // flip to false to silence console logs

/* ===== Utilities ===== */
const fmt = (n)=> Number(n||0).toLocaleString();
function log(...a){ if (DEBUG) console.log('[DT]', ...a); }

function mondayOf(date){ const d=new Date(date); const day=d.getDay(); const back=(day+6)%7; d.setHours(0,0,0,0); d.setDate(d.getDate()-back); return d; }
function fridayEndOf(monday){ const f=new Date(monday); f.setDate(f.getDate()+5); f.setHours(0,0,0,0); f.setMilliseconds(-1); return f; }
function daysLeftThisWeek(today){ const dow=today.getDay(); if(dow===6||dow===0) return 5; return Math.max(1,6-dow); }
function yScaleFor(values, pad=0.06){ const nums=(values||[]).map(v=>+v||0); const mx=Math.max(...nums,0); if(mx<=0)return{min:0,max:1,stepSize:1}; const top=Math.ceil(mx*(1+pad)); const rough=top/5, pow=10**Math.floor(Math.log10(rough)); const step=Math.max(5,Math.ceil(rough/pow)*pow); return {min:0,max:Math.ceil(top/step)*step,stepSize:step}; }
function statusColors(s,a=0.72){ const map={green:{r:34,g:197,b:94,stroke:'#16a34a'},yellow:{r:234,g:179,b:8,stroke:'#d97706'},red:{r:239,g:68,b:68,stroke:'#b91c1c'}}; const k=map[s]||map.green; return {fill:`rgba(${k.r},${k.g},${k.b},${a})`,hover:`rgba(${k.r},${k.g},${k.b},${Math.min(1,a+0.15)})`,stroke:k.stroke}; }

/* ===== Optional DOM refs (page-aware) ===== */
// Dashboard
const kpiTotal = document.querySelector('#kpi-total');
const kpiCompleted = document.querySelector('#kpi-completed');
const kpiRemaining = document.querySelector('#kpi-remaining');
const dueBody = document.querySelector('#dueThisWeekBody');
let byClientChart;
// Log modal (on index & client-detail)
const logModal = document.getElementById('logModal');
const logForm  = document.getElementById('logForm');
const logClose = document.getElementById('logClose');
const logCancel= document.getElementById('logCancel');
const logClientName = document.getElementById('logClientName');
// Clients page modal bits
const modal = document.getElementById('clientModal');
const modalTitle = document.getElementById('clientModalTitle');
const btnOpen = document.getElementById('btnAddClient');
const btnClose = document.getElementById('clientModalClose');
const btnCancel = document.getElementById('clientCancel');
const clientForm = document.getElementById('clientForm');
const addressesList = document.getElementById('addressesList');
const emrsList = document.getElementById('emrsList');
const addrTpl = document.getElementById('addrRowTpl');
const emrTpl  = document.getElementById('emrRowTpl');
const btnAddAddr = document.getElementById('btnAddAddr');
const btnAddEmr  = document.getElementById('btnAddEmr');
const clientsTableBody = document.getElementById('clientsBody');

/* ===== Clients modal helpers ===== */
function weeklyEls(){ const qtyEl=clientForm?.querySelector('[name="weekly_qty"], #weekly_qty'); const startEl=clientForm?.querySelector('[name="start_week"], #start_week'); return { qtyEl, startEl }; }
function setWeeklyInputValues({weekly_qty,start_week}){ const {qtyEl,startEl}=weeklyEls(); if(qtyEl) qtyEl.value=weekly_qty??''; if(startEl) startEl.value=start_week?String(start_week).slice(0,10):''; }
function openClientModalBlank(){ if(!modal)return; modal.classList.remove('hidden'); modalTitle.textContent='Add Client'; clientForm.reset(); clientForm.client_id.value=''; addressesList.innerHTML=''; emrsList.innerHTML=''; addAddressRow(); addEmrRow(); setWeeklyInputValues({weekly_qty:'',start_week:''}); }
function openClientModalPrefilled(client, addrs=[], emrs=[], activeCommit=null){ if(!modal)return; modal.classList.remove('hidden'); modalTitle.textContent='Edit Client'; clientForm.reset(); clientForm.client_id.value=client?.id||''; clientForm.name.value=client?.name||''; clientForm.total_lives.value=client?.total_lives||''; clientForm.contact_name.value=client?.contact_name||''; clientForm.contact_email.value=client?.contact_email||''; clientForm.instructions.value=client?.instructions||''; document.getElementById('contract_executed').checked=!!client?.contract_executed; addressesList.innerHTML=''; (addrs.length?addrs:[{}]).forEach(a=>addAddressRow(a)); emrsList.innerHTML=''; (emrs.length?emrs:[{}]).forEach(e=>addEmrRow(e)); setWeeklyInputValues(activeCommit?{weekly_qty:activeCommit.weekly_qty,start_week:activeCommit.start_week}:{weekly_qty:'',start_week:''}); }
function closeClientModal(){ modal?.classList.add('hidden'); }

function addAddressRow(a={}){ if(!addrTpl||!addressesList)return; const node=addrTpl.content.cloneNode(true); const row=node.querySelector('.grid'); row.querySelector('[name=line1]').value=a.line1||''; row.querySelector('[name=line2]').value=a.line2||''; row.querySelector('[name=city]').value=a.city||''; row.querySelector('[name=state]').value=a.state||''; row.querySelector('[name=zip]').value=a.zip||''; row.querySelector('.remove').onclick=()=>row.remove(); addressesList.appendChild(node); }
function addEmrRow(e={}){ if(!emrTpl||!emrsList)return; const node=emrTpl.content.cloneNode(true); const row=node.querySelector('.grid'); row.querySelector('[name=vendor]').value=e.vendor||''; row.querySelector('[name=details]').value=e.details||''; row.querySelector('.remove').onclick=()=>row.remove(); emrsList.appendChild(node); }

btnOpen?.addEventListener('click', openClientModalBlank);
btnClose?.addEventListener('click', closeClientModal);
btnCancel?.addEventListener('click', closeClientModal);
btnAddAddr?.addEventListener('click', ()=>addAddressRow());
btnAddEmr?.addEventListener('click', ()=>addEmrRow());

async function openClientModalById(id){
  const supabase = await getSupabase(); if(!supabase) return alert('Supabase not configured.');
  const { data: client } = await supabase.from('clients').select('*').eq('id', id).single();
  const [{ data:addrs }, { data:emrs }, { data:commits }] = await Promise.all([
    supabase.from('client_addresses').select('line1,line2,city,state,zip').eq('client_fk', id).order('created_at'),
    supabase.from('client_emrs').select('vendor,details').eq('client_fk', id).order('created_at'),
    supabase.from('weekly_commitments').select('weekly_qty,start_week,active').eq('client_fk', id).order('start_week', {ascending:false}).limit(1)
  ]);
  openClientModalPrefilled(client, addrs||[], emrs||[], commits?.[0]||null);
}

/* ===== Save client (CREATE & UPDATE) — addresses + EMRs always written ===== */
clientForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const supabase = await getSupabase(); if(!supabase) return alert('Supabase not configured.');

  const payload = {
    name: clientForm.name.value.trim(),
    total_lives: Number(clientForm.total_lives.value||0),
    contact_name: clientForm.contact_name.value.trim() || null,
    contact_email: clientForm.contact_email.value.trim() || null,
    instructions: clientForm.instructions.value.trim() || null,
    contract_executed: !!document.getElementById('contract_executed')?.checked
  };

  // gather rows from UI
  const addrs = addressesList ? [...addressesList.querySelectorAll('.grid')].map(r=>{
    const line1=r.querySelector('[name=line1]')?.value?.trim()||'';
    const line2=r.querySelector('[name=line2]')?.value?.trim()||'';
    const city =r.querySelector('[name=city]') ?.value?.trim()||'';
    const state=r.querySelector('[name=state]')?.value?.trim()||'';
    const zip  =r.querySelector('[name=zip]')  ?.value?.trim()||'';
    return { line1,line2,city,state,zip };
  }).filter(a=> a.line1||a.line2||a.city||a.state||a.zip ) : [];

  const emrs = emrsList ? [...emrsList.querySelectorAll('.grid')].map(r=>{
    const vendor = r.querySelector('[name=vendor]') ?.value?.trim()||'';
    const details= r.querySelector('[name=details]')?.value?.trim()||'';
    return { vendor, details };
  }).filter(e=> e.vendor || e.details ) : [];

  log('Saving client payload', payload);
  log('Addresses', addrs);
  log('EMRs', emrs);

  let clientId = clientForm.client_id.value?.trim() || null;

  if (clientId){
    const { error:upErr } = await supabase.from('clients').update(payload).eq('id', clientId);
    if (upErr){ console.error(upErr); return alert('Failed to update client.'); }
  } else {
    const { data:newRow, error:insErr } = await supabase.from('clients').insert(payload).select('id').single();
    if (insErr){ console.error(insErr); return alert('Failed to create client.'); }
    clientId = newRow.id;
  }

  // wipe + insert addresses
  if (addressesList){
    const { error:da } = await supabase.from('client_addresses').delete().eq('client_fk', clientId);
    if (da){ console.error(da); return alert('Failed to clear addresses.'); }
    if (addrs.length){
      const rows = addrs.map(a => ({ client_fk: clientId, ...a }));
      const { error:ia } = await supabase.from('client_addresses').insert(rows);
      if (ia){ console.error(ia); return alert('Failed to save addresses.'); }
    }
  }

  // wipe + insert emrs
  if (emrsList){
    const { error:de } = await supabase.from('client_emrs').delete().eq('client_fk', clientId);
    if (de){ console.error(de); return alert('Failed to clear EMRs.'); }
    if (emrs.length){
      const rows = emrs.map(e => ({ client_fk: clientId, ...e }));
      const { error:ie } = await supabase.from('client_emrs').insert(rows);
      if (ie){ console.error(ie); return alert('Failed to save EMRs.'); }
    }
  }

  // weekly commitment
  const qtyEl = clientForm.querySelector('[name="weekly_qty"], #weekly_qty');
  const startEl = clientForm.querySelector('[name="start_week"], #start_week');
  const inputQty   = qtyEl?.value?.trim();   // string
  const inputStart = startEl?.value?.trim();

  if (inputQty || inputStart){
    const { data: existing } = await supabase
      .from('weekly_commitments')
      .select('weekly_qty,start_week,active').eq('client_fk', clientId)
      .eq('active', true).order('start_week', {ascending:false}).limit(1);

    const current = existing?.[0] || null;
    const newQty  = inputQty ? Number(inputQty) : (current?.weekly_qty ?? 0);
    let newStart  = inputStart || (current?.start_week ? String(current.start_week).slice(0,10) : null);
    if (!newStart) newStart = mondayOf(new Date()).toISOString().slice(0,10);

    const unchanged = current && Number(current.weekly_qty)===newQty &&
                      String(current.start_week).slice(0,10)===String(newStart).slice(0,10);

    if (!unchanged && newQty>0){
      if (current){
        const { error:deact } = await supabase.from('weekly_commitments')
          .update({active:false}).eq('client_fk', clientId).eq('active', true);
        if (deact){ console.error(deact); return alert('Failed to retire current commitment.'); }
      }
      const { error:insC } = await supabase.from('weekly_commitments').insert({
        client_fk: clientId, weekly_qty: newQty, start_week: newStart, active: true
      });
      if (insC){ console.error(insC); return alert('Failed to save weekly commitment.'); }
    }
  }

  closeClientModal();
  await loadClientsList();
  await loadDashboard(); // safe on this page
  alert('Saved.');
});

/* ===== Dashboard ===== */
function pickActiveQtyForWeek(wkRows, clientId, refDate){
  const rows=(wkRows||[]).filter(r=>r.client_fk===clientId && r.active && new Date(r.start_week)<=refDate)
                         .sort((a,b)=> new Date(b.start_week)-new Date(a.start_week));
  return rows[0]?.weekly_qty || 0;
}

async function loadDashboard(){
  if (!kpiTotal) return;
  const supabase = await getSupabase();
  if (!supabase){ kpiTotal.setAttribute('value','—'); kpiCompleted.setAttribute('value','—'); kpiRemaining.setAttribute('value','—'); return; }

  const [{data:clients},{data:wk},{data:comps}] = await Promise.all([
    supabase.from('clients').select('id,name,total_lives,contract_executed').order('name'),
    supabase.from('weekly_commitments').select('id,client_fk,weekly_qty,start_week,active'),
    supabase.from('completions').select('client_fk,occurred_on,qty_completed')
  ]);

  const today=new Date(); const mon=mondayOf(today); const fri=fridayEndOf(mon);
  const lastMon=new Date(mon); lastMon.setDate(lastMon.getDate()-7); const lastFri=fridayEndOf(lastMon);

  const contractedOnly = document.getElementById('filterContracted')?.checked ?? true;

  const completedFor=(clientId, from,to)=> (comps||[]).reduce((s,c)=>{
    if(c.client_fk!==clientId) return s; const d=new Date(c.occurred_on); return (d>=from&&d<=to) ? s+(c.qty_completed||0) : s;
  },0);

  const rows=(clients||[]).filter(c=>!contractedOnly || c.contract_executed).map(c=>{
    const qtyThis=pickActiveQtyForWeek(wk,c.id,mon); const qtyLast=pickActiveQtyForWeek(wk,c.id,lastMon);
    const doneLast=completedFor(c.id,lastMon,lastFri); const carryIn=qtyLast-doneLast;
    const required=Math.max(0,qtyThis+carryIn);
    const doneThis=completedFor(c.id,mon,fri); const remaining=Math.max(0,required-doneThis);
    const needPerDay=remaining/Math.max(1,daysLeftThisWeek(today));
    const status = carryIn>0 ? 'red' : (needPerDay>100 ? 'yellow' : 'green');
    return { id:c.id, name:c.name, required, remaining, doneThis, carryIn, status };
  });

  const totalReq=rows.reduce((s,r)=>s+r.required,0);
  const totalDone=rows.reduce((s,r)=>s+r.doneThis,0);
  const totalRem=Math.max(0,totalReq-totalDone);
  kpiTotal.setAttribute('value',fmt(totalReq)); kpiCompleted.setAttribute('value',fmt(totalDone)); kpiRemaining.setAttribute('value',fmt(totalRem));

  renderByClientChart(rows);
  renderDueThisWeek(rows);
}

function renderByClientChart(rows){
  const labels=rows.map(r=>r.name);
  const completes=rows.map(r=>Math.max(0,r.required-r.remaining));
  const remains=rows.map(r=>r.remaining);
  const statuses=rows.map(r=>r.status);

  const widthPx=Math.max(1100, labels.length*140);
  const widthDiv=document.getElementById('chartWidth'); const canvas=document.getElementById('byClientChart');
  if(widthDiv) widthDiv.style.width=widthPx+'px'; if(canvas) canvas.width=widthPx;

  const totals=labels.map((_,i)=>completes[i]+remains[i]); const yCfg=yScaleFor(totals,0.05);
  if(byClientChart) byClientChart.destroy();
  if(!canvas || !window.Chart) return;

  byClientChart = new Chart(canvas.getContext('2d'), {
    type:'bar',
    data:{
      labels,
      datasets:[
        { label:'Completed', data:completes, backgroundColor:'rgba(107,114,128,0.50)', borderColor:'#6b7280',
          borderWidth:1, borderRadius:10, borderSkipped:false, maxBarThickness:44, stack:'totals' },
        { label:'Remaining', data:remains, backgroundColor:statuses.map(s=>statusColors(s).fill),
          hoverBackgroundColor:statuses.map(s=>statusColors(s).hover),
          borderColor:statuses.map(s=>statusColors(s).stroke),
          borderWidth:1.5, borderRadius:10, borderSkipped:false, maxBarThickness:44, stack:'totals' }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:400},
      plugins:{ legend:{display:true}, tooltip:{padding:12,displayColors:false} },
      scales:{
        x:{ stacked:true, grid:{display:false}, ticks:{autoSkip:false, maxRotation:0, minRotation:0, font:{size:11},
            callback:(v,i)=> (labels[i]||'').length>16 ? (labels[i].slice(0,16)+'…') : labels[i]} },
        y:{ stacked:true, min:yCfg.min, max:yCfg.max, ticks:{stepSize:yCfg.stepSize}, grid:{color:'rgba(17,24,39,0.08)'} }
      }
    }
  });
}

function renderDueThisWeek(rows){
  if(!dueBody) return;
  const items=rows.filter(r=>r.required>0).sort((a,b)=>b.remaining-a.remaining);
  if(!items.length){ dueBody.innerHTML=`<tr><td colspan="6" class="py-4 text-sm text-gray-500">No active commitments this week.</td></tr>`; return; }
  dueBody.innerHTML = items.map(r=>{
    const done=Math.max(0,r.required-r.remaining);
    return `<tr>
      <td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${r.id}">${r.name}</a></td>
      <td class="text-sm">${fmt(r.required)}</td>
      <td class="text-sm">${fmt(done)}</td>
      <td class="text-sm">${fmt(r.remaining)}</td>
      <td class="text-sm"><status-badge status="${r.status}"></status-badge></td>
      <td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log="${r.id}" data-name="${r.name}">Log</button></td>
    </tr>`;
  }).join('');
  dueBody.onclick=(e)=>{ const b=e.target.closest('button[data-log]'); if(!b) return; openLogModal(b.dataset.log,b.dataset.name); };
}

/* ===== Log modal ===== */
function openLogModal(clientId,name){ if(!logForm) return; logForm.client_id.value=clientId; logForm.qty.value=''; logForm.note.value=''; if(logClientName) logClientName.textContent=name||'—'; logModal?.classList.remove('hidden'); }
function closeLogModal(){ logModal?.classList.add('hidden'); }
logClose?.addEventListener('click', closeLogModal); logCancel?.addEventListener('click', closeLogModal);

logForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const supabase=await getSupabase(); if(!supabase) return alert('Supabase not configured.');
  const qty=Number(logForm.qty.value||0); if(!qty||qty<1) return alert('Enter a valid quantity.');
  const payload={ client_fk: logForm.client_id.value, occurred_on:new Date().toISOString(), qty_completed: qty, note: logForm.note.value?.trim()||null };
  const { error } = await supabase.from('completions').insert(payload);
  if(error){ console.error(error); return alert('Failed to log completion.'); }
  closeLogModal(); await loadDashboard();
});

/* ===== Clients list ===== */
async function loadClientsList(){
  if(!clientsTableBody) return;
  const supabase=await getSupabase();
  if(!supabase){ clientsTableBody.innerHTML=`<tr><td class="py-4 text-sm text-gray-500">Connect Supabase (env.js).</td></tr>`; return; }

  const [{data:clients},{data:wk}] = await Promise.all([
    supabase.from('clients').select('id,name,total_lives,contract_executed').order('name'),
    supabase.from('weekly_commitments').select('client_fk,weekly_qty,start_week,active')
  ]);

  const latestQty=(id)=>{ const rows=(wk||[]).filter(r=>r.client_fk===id && r.active).sort((a,b)=>new Date(b.start_week)-new Date(a.start_week)); return rows[0]?.weekly_qty||0; };

  clientsTableBody.innerHTML='';
  (clients||[]).forEach(c=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td class="text-sm">
        <a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${c.id}">${c.name}</a>
        ${c.contract_executed ? '' : '<span class="ml-2 text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">uncontracted</span>'}
      </td>
      <td class="text-sm">${c.total_lives ?? '—'}</td>
      <td class="text-sm">${latestQty(c.id) ? fmt(latestQty(c.id))+'/wk' : '—'}</td>
      <td class="text-sm"><button class="px-2 py-1 rounded border text-sm" data-edit="${c.id}">Edit</button></td>`;
    clientsTableBody.appendChild(tr);
  });

  clientsTableBody.onclick = async (e)=>{ const b=e.target.closest('button[data-edit]'); if(!b) return; await openClientModalById(b.getAttribute('data-edit')); };
}

/* ===== Client detail page ===== */
async function loadClientDetail(){
  const nameEl=document.getElementById('clientName'); if(!nameEl) return;
  const id=new URL(location.href).searchParams.get('id'); const supabase=await getSupabase(); if(!supabase) return;
  const [{data:client},{data:addrs},{data:emrs},{data:wk},{data:comps}] = await Promise.all([
    supabase.from('clients').select('*').eq('id', id).single(),
    supabase.from('client_addresses').select('*').eq('client_fk', id).order('created_at'),
    supabase.from('client_emrs').select('*').eq('client_fk', id).order('created_at'),
    supabase.from('weekly_commitments').select('*').eq('client_fk', id).order('start_week',{ascending:false}),
    supabase.from('completions').select('*').eq('client_fk', id)
  ]);

  nameEl.textContent=client?.name||'Client';
  const meta=document.getElementById('clientMeta');
  if(meta) meta.textContent = client ? `${client.total_lives?`Lives: ${client.total_lives.toLocaleString()} — `:''}${client.contract_executed?'Contracted':'Uncontracted'}` : '';

  const contact=document.getElementById('contact');
  if(contact) contact.innerHTML = client?.contact_email ? `${client?.contact_name||''} <a class="text-indigo-600 hover:underline" href="mailto:${client.contact_email}">${client.contact_email}</a>` : (client?.contact_name||'—');
  const notes=document.getElementById('notes'); if(notes) notes.textContent=client?.instructions||'—';

  const addrList=document.getElementById('addresses');
  if(addrList) addrList.innerHTML = (addrs?.length? addrs:[]).map(a=>`<li>${[a.line1,a.line2,a.city,a.state,a.zip].filter(Boolean).join(', ')}</li>`).join('') || '<li class="text-gray-500">—</li>';
  const emrList=document.getElementById('emrs');
  if(emrList) emrList.innerHTML = (emrs?.length? emrs:[]).map(e=>`<li>${[e.vendor,e.details].filter(Boolean).join(' — ')}</li>`).join('') || '<li class="text-gray-500">—</li>';

  // weekly viz (same math as dashboard)
  const today=new Date(); const mon=mondayOf(today); const fri=fridayEndOf(mon);
  const lastMon=new Date(mon); lastMon.setDate(lastMon.getDate()-7); const lastFri=fridayEndOf(lastMon);
  const pickActive=(ref)=> (wk||[]).filter(r=>r.active && new Date(r.start_week)<=ref).sort((a,b)=>new Date(b.start_week)-new Date(a.start_week))[0]||null;

  const activeThis=pickActive(mon); const activeLast=pickActive(lastMon);
  const weeklyQty=activeThis?.weekly_qty||0;
  const doneFor=(from,to)=> (comps||[]).reduce((s,c)=>{ const d=new Date(c.occurred_on); return (d>=from&&d<=to)?s+(c.qty_completed||0):s; },0);
  const doneLast=doneFor(lastMon,lastFri); const carryIn=(activeLast?.weekly_qty||0)-doneLast;
  const required=Math.max(0,weeklyQty+carryIn); const doneThis=doneFor(mon,fri); const remaining=Math.max(0,required-doneThis);
  const needPerDay=remaining/Math.max(1,daysLeftThisWeek(today)); const status=carryIn>0?'red':(needPerDay>100?'yellow':'green');

  const setTxt=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  setTxt('wkQty', weeklyQty?weeklyQty.toLocaleString()+'/wk':'—');
  setTxt('startWeek', activeThis?.start_week ? new Date(activeThis.start_week).toISOString().slice(0,10) : '—');
  setTxt('carryIn', (carryIn||0).toLocaleString());
  setTxt('required', required.toLocaleString());
  setTxt('done', doneThis.toLocaleString());
  setTxt('remaining', remaining.toLocaleString());
  document.getElementById('clientStatus')?.setAttribute('status', status);
  const logBtn=document.getElementById('clientLogBtn'); if(logBtn) logBtn.onclick=()=>openLogModal(id, client?.name||'Client');

  const body=document.getElementById('clientWeekBody');
  if(body){
    if(weeklyQty===0 && carryIn===0){
      body.innerHTML=`<tr><td colspan="8" class="py-4 text-sm text-gray-500">No active commitment.</td></tr>`;
    }else{
      body.innerHTML=`<tr>
        <td class="text-sm">${fri.toISOString().slice(0,10)}</td>
        <td class="text-sm">${fmt(weeklyQty)}</td>
        <td class="text-sm">${fmt(carryIn)}</td>
        <td class="text-sm">${fmt(required)}</td>
        <td class="text-sm">${fmt(doneThis)}</td>
        <td class="text-sm">${fmt(remaining)}</td>
        <td class="text-sm"><status-badge status="${status}"></status-badge></td>
        <td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" onclick="openLogModal('${id}','${(client?.name||'Client').replace(/'/g,'&#39;')}')">Log</button></td>
      </tr>`;
    }
  }

  const canv=document.getElementById('clientWeekChart'); if(canv && window.Chart){
    const yCfg=yScaleFor([required],0.08); const colors=statusColors(status);
    if(window.__clientChart) window.__clientChart.destroy();
    window.__clientChart=new Chart(canv.getContext('2d'),{
      type:'bar',
      data:{ labels:['This week'],
        datasets:[
          { label:'Completed', data:[doneThis], backgroundColor:'rgba(107,114,128,0.50)', borderColor:'#6b7280', borderWidth:1, borderRadius:10, borderSkipped:false, maxBarThickness:56, stack:'totals' },
          { label:'Remaining', data:[remaining], backgroundColor:colors.fill, borderColor:colors.stroke, borderWidth:1.5, borderRadius:10, borderSkipped:false, maxBarThickness:56, stack:'totals' }
        ]},
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{stacked:true, grid:{display:false}}, y:{stacked:true, min:yCfg.min,max:yCfg.max,ticks:{stepSize:yCfg.stepSize},grid:{color:'rgba(17,24,39,0.08)'}}}}
    });
  }
}

/* ===== Boot ===== */
window.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('filterContracted')?.addEventListener('change', loadDashboard);
  loadDashboard();
  loadClientsList();
  loadClientDetail();
  // expose for inline
  window.openLogModal = openLogModal;
});

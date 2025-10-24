// script.js — Weekly model, Add Client UI, all-clients chart (Mon–Fri EST)
import { getSupabase } from './supabaseClient.js';

/* ================= Utilities ================= */
const fmt = (n)=> Number(n||0).toLocaleString();

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();              // 0..6 (Sun..Sat)
  const back = (day + 6) % 7;          // push back to Monday
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - back);
  return d;
}
function fridayEndOf(monday) {
  const f = new Date(monday);
  f.setDate(f.getDate() + 5);          // Saturday 00:00
  f.setHours(0,0,0,0);
  f.setMilliseconds(-1);               // Friday 23:59:59.999
  return f;
}
function daysLeftThisWeek(today){
  // Mon..Fri working days remaining including today
  const dow = today.getDay();          // Mon=1 ... Fri=5
  if (dow === 6 || dow === 0) return 5; // weekend seen early
  return Math.max(1, 6 - dow);         // e.g., Tue=2 -> 4 days left
}
function yScaleFor(values, pad=0.06){
  const nums = (values||[]).map(v=>+v||0);
  const max = Math.max(...nums, 0);
  if (max <= 0) return { min:0, max:1, stepSize:1 };
  const top = Math.ceil(max * (1+pad));
  const rough = top/5, pow = 10**Math.floor(Math.log10(rough));
  const step = Math.max(5, Math.ceil(rough/pow)*pow);
  return { min:0, max: Math.ceil(top/step)*step, stepSize: step };
}
function statusColors(s, a=0.72){
  const map = {
    green:  { r: 34, g:197, b:94,  stroke:'#16a34a' },
    yellow: { r:234, g:179, b: 8,  stroke:'#d97706' },
    red:    { r:239, g: 68, b:68,  stroke:'#b91c1c' },
  };
  const k = map[s] || map.green;
  return {
    fill:  `rgba(${k.r},${k.g},${k.b},${a})`,
    hover: `rgba(${k.r},${k.g},${k.b},${Math.min(1,a+0.15)})`,
    stroke: k.stroke
  };
}

/* =============== Percent labels (hide 0 & 100) =============== */
const barPercentPlugin = {
  id: 'barPercent',
  afterDatasetsDraw(chart) {
    if (!chart?.data?.labels?.length) return;
    const { ctx } = chart;
    const m0 = chart.getDatasetMeta(0), m1 = chart.getDatasetMeta(1);
    if (!m0 || !m1) return;
    const d0 = chart.data.datasets[0].data, d1 = chart.data.datasets[1].data;

    chart.data.labels.forEach((_, i) => {
      const done = Number(d0[i]||0), rem = Number(d1[i]||0), tot = done+rem;
      if (!tot) return;
      const pct = Math.round(done/Math.max(1,tot)*100);
      if (pct===0 || pct===100) return;

      const el = m1.data[i] || m0.data[i];
      if (!el) return;
      const { x, y } = el;
      ctx.save();
      ctx.fillStyle = 'rgba(17,24,39,0.85)';
      ctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${pct}%`, x, y-8);
      ctx.restore();
    });
  }
};

/* =============== DOM refs =============== */
const kpiTotal     = document.querySelector('#kpi-total');
const kpiCompleted = document.querySelector('#kpi-completed');
const kpiRemaining = document.querySelector('#kpi-remaining');
const fridayBody   = document.querySelector('#friday-body');
const dueSoonBody  = document.querySelector('#due-soon-body') || document.querySelector('#upcomingBody');
let byClientChart;

/* Add Client modal refs */
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

/* =============== Add/Edit Client UI =============== */
function openClientModal(edit=null){
  if (!modal) return;
  modal.classList.remove('hidden');
  modalTitle.textContent = edit ? 'Edit Client' : 'Add Client';
  clientForm.reset();
  clientForm.client_id.value = edit?.id || '';
  addressesList.innerHTML = ''; emrsList.innerHTML = '';
  addAddressRow(); addEmrRow();
  if (edit){
    clientForm.name.value = edit.name||'';
    clientForm.total_lives.value = edit.total_lives||'';
    clientForm.contact_name.value = edit.contact_name||'';
    clientForm.contact_email.value = edit.contact_email||'';
    clientForm.instructions.value = edit.instructions||'';
  }
}
function closeClientModal(){ modal?.classList.add('hidden'); }
function addAddressRow(a={}){
  if (!addrTpl) return;
  const node = addrTpl.content.cloneNode(true);
  const row = node.querySelector('.grid');
  row.querySelector('[name=line1]').value = a.line1||'';
  row.querySelector('[name=line2]').value = a.line2||'';
  row.querySelector('[name=city]').value  = a.city||'';
  row.querySelector('[name=state]').value = a.state||'';
  row.querySelector('[name=zip]').value   = a.zip||'';
  row.querySelector('.remove').onclick = ()=> row.remove();
  addressesList.appendChild(node);
}
function addEmrRow(e={}){
  if (!emrTpl) return;
  const node = emrTpl.content.cloneNode(true);
  const row = node.querySelector('.grid');
  row.querySelector('[name=vendor]').value  = e.vendor||'';
  row.querySelector('[name=details]').value = e.details||'';
  row.querySelector('.remove').onclick = ()=> row.remove();
  emrsList.appendChild(node);
}
btnOpen?.addEventListener('click', ()=> openClientModal());
btnClose?.addEventListener('click', closeClientModal);
btnCancel?.addEventListener('click', closeClientModal);
btnAddAddr?.addEventListener('click', ()=> addAddressRow());
btnAddEmr?.addEventListener('click',  ()=> addEmrRow());

clientForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const supabase = await getSupabase();
  if (!supabase) return alert('Supabase not configured.');

  const payload = {
    name: clientForm.name.value.trim(),
    total_lives: Number(clientForm.total_lives.value||0),
    contact_name: clientForm.contact_name.value.trim() || null,
    contact_email: clientForm.contact_email.value.trim() || null,
    instructions: clientForm.instructions.value.trim() || null,
    contract_executed: true
  };
  let clientId = clientForm.client_id.value || null;

  if (clientId){
    const { error } = await supabase.from('clients').update(payload).eq('id', clientId);
    if (error) { console.error(error); return alert('Failed to update client.'); }
    await supabase.from('client_addresses').delete().eq('client_fk', clientId);
    await supabase.from('client_emrs').delete().eq('client_fk', clientId);
  } else {
    const { data, error } = await supabase.from('clients').insert(payload).select('id').single();
    if (error) { console.error(error); return alert('Failed to create client.'); }
    clientId = data.id;
  }

  // addresses
  const addrs = [...addressesList.querySelectorAll('.grid')].map(r=>({
    client_fk: clientId,
    line1:  r.querySelector('[name=line1]').value.trim() || null,
    line2:  r.querySelector('[name=line2]').value.trim() || null,
    city:   r.querySelector('[name=city]').value.trim()  || null,
    state:  r.querySelector('[name=state]').value.trim() || null,
    zip:    r.querySelector('[name=zip]').value.trim()   || null,
  })).filter(a=>a.line1);
  if (addrs.length) await supabase.from('client_addresses').insert(addrs);

  // emrs
  const emrs = [...emrsList.querySelectorAll('.grid')].map(r=>({
    client_fk: clientId,
    vendor:  r.querySelector('[name=vendor]').value.trim(),
    details: r.querySelector('[name=details]').value.trim() || null
  })).filter(e=>e.vendor);
  if (emrs.length) await supabase.from('client_emrs').insert(emrs);

  // optional commitment
  const weekly_qty = Number(clientForm.weekly_qty.value||0);
  const start_week = clientForm.start_week.value ? new Date(clientForm.start_week.value) : null;
  if (weekly_qty && start_week){
    // normalize to Monday
    const mon = mondayOf(start_week);
    const iso = mon.toISOString().slice(0,10);
    // deactivate existing client-level actives
    await supabase.from('weekly_commitments')
      .update({ active:false })
      .eq('client_fk', clientId)
      .eq('active', true);
    await supabase.from('weekly_commitments').insert({
      client_fk: clientId, weekly_qty, start_week: iso, active: true
    });
  }

  closeClientModal();
  await loadClientsList();
  await loadDashboard();
  alert('Saved.');
});

/* =============== Dashboard Weekly Model =============== */
async function loadDashboard(){
  if (!kpiTotal) return;
  const supabase = await getSupabase();
  if (!supabase){ kpiTotal.setAttribute('value','—'); kpiCompleted.setAttribute('value','—'); kpiRemaining.setAttribute('value','—'); return; }

  const [{ data: clients }, { data: wk }, { data: comps }] = await Promise.all([
    supabase.from('clients').select('id,name,total_lives,contract_executed').order('name'),
    supabase.from('weekly_commitments').select('id,client_fk,site_fk,weekly_qty,start_week,active'),
    supabase.from('completions').select('client_fk,site_fk,occurred_on,qty_completed')
  ]);

  const today = new Date();
  const mon = mondayOf(today), fri = fridayEndOf(mon);
  const monISO = mon.toISOString().slice(0,10);
  const lastMon = new Date(mon); lastMon.setDate(lastMon.getDate()-7);
  const lastFri = fridayEndOf(lastMon);
  const lastMonISO = lastMon.toISOString().slice(0,10);

  // commitment lookup (client-level first; site-level UI next phase)
  const latestQtyFor = (clientId, weekISO)=>{
    const rows = wk.filter(r => r.client_fk===clientId && r.active && r.start_week <= weekISO)
                   .sort((a,b)=> b.start_week.localeCompare(a.start_week));
    return rows[0]?.weekly_qty || 0;
  };

  const completedForWeek = (clientId, weekMon, weekFri)=> comps
    .filter(c => c.client_fk===clientId)
    .reduce((sum,c)=>{
      const d = new Date(c.occurred_on);
      if (d>=weekMon && d<=weekFri) return sum + (c.qty_completed||0);
      return sum;
    }, 0);

  const rows = (clients||[]).map(c=>{
    const qtyThis  = latestQtyFor(c.id, monISO);
    const qtyLast  = latestQtyFor(c.id, lastMonISO);
    const doneLast = completedForWeek(c.id, lastMon, lastFri);
    const carryIn  = qtyLast - doneLast;                 // may be negative (overage)
    const required = Math.max(0, qtyThis + carryIn);     // don’t go below 0
    const doneThis = completedForWeek(c.id, mon, fri);
    const remaining= Math.max(0, required - doneThis);

    // status: RED if last week had positive carry (missed); else YELLOW if behind pace
    const needPerDay = remaining / Math.max(1, daysLeftThisWeek(today));
    const status = carryIn > 0 ? 'red' : (needPerDay > 100 ? 'yellow' : 'green');

    return {
      id: c.id,
      name: c.name,
      weekly_qty: qtyThis,
      carryIn, required, doneThis, remaining, status
    };
  });

  // KPIs (this week)
  const totalRequired = rows.reduce((s,r)=> s + r.required, 0);
  const totalDone     = rows.reduce((s,r)=> s + r.doneThis, 0);
  const totalRemain   = Math.max(0, totalRequired - totalDone);
  kpiTotal?.setAttribute('value', fmt(totalRequired));
  kpiCompleted?.setAttribute('value', fmt(totalDone));
  kpiRemaining?.setAttribute('value', fmt(totalRemain));

  // Build all-clients stacked bar with horizontal scroll
  const labels    = rows.map(r=> r.name);
  const completes = rows.map(r=> Math.max(0, r.required - r.remaining));
  const remains   = rows.map(r=> r.remaining);
  const statuses  = rows.map(r=> r.status);

  const compFill   = 'rgba(107,114,128,0.50)';
  const compHover  = 'rgba(107,114,128,0.70)';
  const compBorder = '#6b7280';
  const remFills   = statuses.map(s=> statusColors(s).fill);
  const remHovers  = statuses.map(s=> statusColors(s).hover);
  const remBorders = statuses.map(s=> statusColors(s).stroke);

  const widthPx = Math.max(1100, labels.length * 140);
  const scroller = document.querySelector('#allClientsScroller canvas');
  if (scroller) scroller.style.width = widthPx + 'px';

  const totalsForAxis = labels.map((_,i)=> completes[i]+remains[i]);
  const yCfg = yScaleFor(totalsForAxis, 0.05);

  if (byClientChart) byClientChart.destroy();
  const ctx = document.getElementById('byClientChart')?.getContext('2d');
  if (ctx && window.Chart){
    byClientChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label:'Completed', data: completes, backgroundColor: compFill, hoverBackgroundColor: compHover, borderColor: compBorder, borderWidth: 1, borderRadius: 10, borderSkipped:false, maxBarThickness: 44, stack:'totals' },
          { label:'Remaining', data: remains,   backgroundColor: remFills, hoverBackgroundColor: remHovers, borderColor: remBorders, borderWidth: 1.5, borderRadius: 10, borderSkipped:false, maxBarThickness: 44, stack:'totals' }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false, animation:{ duration: 450 },
        plugins:{
          legend:{ display:true },
          tooltip:{
            padding:12, displayColors:false,
            callbacks:{
              title:(items)=> labels[items[0].dataIndex] || '',
              label:(ctx)=> `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`,
              afterBody:(items)=>{
                const i = items[0].dataIndex;
                const total = completes[i] + remains[i];
                const pct = Math.round(completes[i]/Math.max(1,total)*100);
                return [
                  `Total this week: ${fmt(total)}`,
                  `Last week carry: ${fmt(rows[i].carryIn)}`,
                  `Percent complete: ${pct}%`
                ];
              }
            }
          }
        },
        scales:{
          x:{ stacked:true, grid:{display:false}, ticks:{ autoSkip:false, maxRotation:0, minRotation:0, font:{size:11} } },
          y:{ stacked:true, min:yCfg.min, max:yCfg.max, ticks:{ stepSize:yCfg.stepSize }, grid:{ color:'rgba(17,24,39,0.08)' } }
        }
      },
      plugins: [barPercentPlugin]
    });
  }
}

/* =============== Clients list (name + lives + commitment) =============== */
async function loadClientsList(){
  if (!clientsTableBody) return;
  const supabase = await getSupabase();
  if (!supabase){ clientsTableBody.innerHTML = `<tr><td class="py-4 text-sm text-gray-500">Connect Supabase (env.js).</td></tr>`; return; }

  const [{ data: clients }, { data: wk }] = await Promise.all([
    supabase.from('clients').select('id,name,total_lives,contract_executed').order('name'),
    supabase.from('weekly_commitments').select('client_fk,weekly_qty,start_week,active')
  ]);

  const latestQty = (id)=>{
    const rows = wk.filter(r=> r.client_fk===id && r.active)
                   .sort((a,b)=> b.start_week.localeCompare(a.start_week));
    return rows[0]?.weekly_qty || 0;
  };

  clientsTableBody.innerHTML = '';
  (clients||[]).forEach(c=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${c.id}">${c.name}</a></td>
      <td class="text-sm">${c.total_lives ?? '—'}</td>
      <td class="text-sm">${latestQty(c.id) ? fmt(latestQty(c.id)) + '/wk' : '—'}</td>
      <td class="text-sm">
        <button class="px-2 py-1 rounded border text-sm" data-edit="${c.id}">Edit</button>
      </td>`;
    clientsTableBody.appendChild(tr);
  });

  clientsTableBody.onclick = async (e)=>{
    const btn = e.target.closest('button[data-edit]');
    if (!btn) return;
    const id = btn.getAttribute('data-edit');
    const supabase = await getSupabase();
    const { data: c } = await supabase.from('clients').select('*').eq('id', id).single();
    openClientModal(c);
  };
}

/* =============== Client detail (basic: table + remaining-by-week later) =============== */
async function loadClientDetail(){
  const nameEl = document.getElementById('clientName');
  if (!nameEl) return; // not on detail page
  const id = new URL(location.href).searchParams.get('id');
  const supabase = await getSupabase(); if (!supabase) return;

  const { data: client } = await supabase.from('clients').select('*').eq('id', id).single();
  nameEl.textContent = client?.name || 'Client';

  // (Timeline chart by week can be added next; core weekly model is live on dashboard)
}

/* =============== Boot =============== */
window.addEventListener('DOMContentLoaded', ()=>{
  loadDashboard();
  loadClientsList();
  loadClientDetail();
  console.log('Weekly build loaded');
});

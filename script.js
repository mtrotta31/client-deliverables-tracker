// script.js — unified logic for Dashboard, Clients, and Client Detail pages.
// Includes: weekly model, date-aware commitments, addresses/EMRs CRUD, charts, and log modal.

import { getSupabase } from './supabaseClient.js';

/* ================= Utilities ================= */
const fmt = (n)=> Number(n||0).toLocaleString();

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();                // 0..6 (Sun..Sat)
  const back = (day + 6) % 7;            // push back to Monday
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - back);
  return d;
}
function fridayEndOf(monday) {
  const f = new Date(monday);
  f.setDate(f.getDate() + 5);            // Saturday 00:00
  f.setHours(0,0,0,0);
  f.setMilliseconds(-1);                 // Friday 23:59:59.999
  return f;
}
function daysLeftThisWeek(today){
  const dow = today.getDay();
  if (dow === 6 || dow === 0) return 5;  // weekend → show full 5 days for planning
  return Math.max(1, 6 - dow);
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

/* =============== DOM refs (optional per page) =============== */
// Dashboard KPIs
const kpiTotal     = document.querySelector('#kpi-total');
const kpiCompleted = document.querySelector('#kpi-completed');
const kpiRemaining = document.querySelector('#kpi-remaining');
// Dashboard table for “Due this week”
const dueBody      = document.querySelector('#dueThisWeekBody');
// Dashboard chart
let byClientChart;

// Global Log modal (present on index.html and client-detail.html)
const logModal = document.getElementById('logModal');
const logForm  = document.getElementById('logForm');
const logClose = document.getElementById('logClose');
const logCancel= document.getElementById('logCancel');
const logClientName = document.getElementById('logClientName');

// Clients page modal + widgets
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

/* --- resilient weekly field finders (works with name OR id) --- */
function weeklyEls() {
  if (!clientForm) return { qtyEl:null, startEl:null };
  const qtyEl   = clientForm.querySelector('[name="weekly_qty"], #weekly_qty');
  const startEl = clientForm.querySelector('[name="start_week"], #start_week');
  return { qtyEl, startEl };
}
function getWeeklyInputValues() {
  const { qtyEl, startEl } = weeklyEls();
  const rawQty   = qtyEl?.value?.trim();
  const rawStart = startEl?.value?.trim();
  const inputQty   = rawQty==='' || rawQty==null ? null : Number(rawQty);
  const inputStart = rawStart ? rawStart : null;           // expect YYYY-MM-DD
  return { inputQty, inputStart, qtyEl, startEl };
}
function setWeeklyInputValues({ weekly_qty, start_week }) {
  const { qtyEl, startEl } = weeklyEls();
  if (qtyEl)   qtyEl.value   = weekly_qty ?? '';
  if (startEl) startEl.value = start_week ? String(start_week).slice(0,10) : '';
}

/* ---------- Add/Edit Client modal helpers ---------- */
function openClientModalBlank() {
  if (!modal) return;
  modal.classList.remove('hidden');
  modalTitle.textContent = 'Add Client';
  clientForm.reset();
  clientForm.client_id.value = '';
  document.getElementById('contract_executed')?.removeAttribute('checked');
  if (addressesList) { addressesList.innerHTML = ''; addAddressRow(); }
  if (emrsList)      { emrsList.innerHTML = ''; addEmrRow(); }
  setWeeklyInputValues({ weekly_qty:'', start_week:'' });
}
function openClientModalPrefilled(client, addrs=[], emrs=[], activeCommit=null) {
  if (!modal) return;
  modal.classList.remove('hidden');
  modalTitle.textContent = 'Edit Client';
  clientForm.reset();

  clientForm.client_id.value = client?.id || '';
  clientForm.name.value = client?.name || '';
  clientForm.total_lives.value = client?.total_lives || '';
  clientForm.contact_name.value = client?.contact_name || '';
  clientForm.contact_email.value = client?.contact_email || '';
  clientForm.instructions.value = client?.instructions || '';
  const chk = document.getElementById('contract_executed');
  if (chk) chk.checked = !!client?.contract_executed;

  if (addressesList) { addressesList.innerHTML = ''; (addrs.length?addrs:[{}]).forEach(a=>addAddressRow(a)); }
  if (emrsList)      { emrsList.innerHTML = ''; (emrs.length?emrs:[{}]).forEach(e=>addEmrRow(e)); }

  setWeeklyInputValues(activeCommit ? {
    weekly_qty: activeCommit.weekly_qty,
    start_week: activeCommit.start_week
  } : { weekly_qty:'', start_week:'' });
}
function closeClientModal(){ modal?.classList.add('hidden'); }

function addAddressRow(a = {}) {
  if (!addrTpl || !addressesList) return;
  const node = addrTpl.content.cloneNode(true);
  const row  = node.querySelector('.grid');
  row.querySelector('[name=line1]').value = a.line1 || '';
  row.querySelector('[name=line2]').value = a.line2 || '';
  row.querySelector('[name=city]').value  = a.city  || '';
  row.querySelector('[name=state]').value = a.state || '';
  row.querySelector('[name=zip]').value   = a.zip   || '';
  row.querySelector('.remove').onclick = () => row.remove();
  addressesList.appendChild(node);
}
function addEmrRow(e = {}) {
  if (!emrTpl || !emrsList) return;
  const node = emrTpl.content.cloneNode(true);
  const row  = node.querySelector('.grid');
  row.querySelector('[name=vendor]').value  = e.vendor  || '';
  row.querySelector('[name=details]').value = e.details || '';
  row.querySelector('.remove').onclick = () => row.remove();
  emrsList.appendChild(node);
}

btnOpen?.addEventListener('click', openClientModalBlank);
btnClose?.addEventListener('click', closeClientModal);
btnCancel?.addEventListener('click', closeClientModal);
btnAddAddr?.addEventListener('click', ()=> addAddressRow());
btnAddEmr?.addEventListener('click',  ()=> addEmrRow());

/* Load client data for Edit */
async function openClientModalById(id){
  const supabase = await getSupabase(); if (!supabase) return alert('Supabase not configured.');
  const { data: client, error:e1 } = await supabase.from('clients').select('*').eq('id', id).single();
  if (e1 || !client){ console.error(e1); return alert('Unable to load client.'); }
  const [{ data:addrs }, { data:emrs }, { data:commits }] = await Promise.all([
    supabase.from('client_addresses').select('line1,line2,city,state,zip').eq('client_fk', id).order('created_at'),
    supabase.from('client_emrs').select('vendor,details').eq('client_fk', id).order('created_at'),
    supabase.from('weekly_commitments').select('weekly_qty,start_week,active').eq('client_fk', id)
      .order('start_week', { ascending:false }).limit(1)
  ]);
  const activeCommit = commits?.[0] || null;
  if (activeCommit && activeCommit.start_week) activeCommit.start_week = String(activeCommit.start_week).slice(0,10);
  openClientModalPrefilled(client, addrs||[], emrs||[], activeCommit);
}

/* Save (create/update) — REPLACE the whole existing submit handler with this one */
clientForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const supabase = await getSupabase();
  if (!supabase) return alert('Supabase not configured.');

  // 1) Core client fields
  const payload = {
    name: clientForm.name.value.trim(),
    total_lives: Number(clientForm.total_lives.value || 0),
    contact_name: clientForm.contact_name.value.trim() || null,
    contact_email: clientForm.contact_email.value.trim() || null,
    instructions: clientForm.instructions.value.trim() || null,
    contract_executed: !!document.getElementById('contract_executed')?.checked
  };

  // 2) Weekly inputs (can be blank)
  const { inputQty, inputStart } = (function getWeeklyInputValuesLocal() {
    const qtyEl   = clientForm.querySelector('[name="weekly_qty"], #weekly_qty');
    const startEl = clientForm.querySelector('[name="start_week"], #start_week');
    const rawQty   = qtyEl?.value?.trim();
    const rawStart = startEl?.value?.trim();
    return {
      inputQty:   rawQty==='' || rawQty==null ? null : Number(rawQty),
      inputStart: rawStart ? rawStart : null
    };
  })();

  // 3) Collect addresses & EMRs from the modal rows
  const addrs = addressesList ? [...addressesList.querySelectorAll('.grid')].map(r => {
    const line1 = r.querySelector('[name=line1]')?.value?.trim() || '';
    const line2 = r.querySelector('[name=line2]')?.value?.trim() || '';
    const city  = r.querySelector('[name=city]') ?.value?.trim() || '';
    const state = r.querySelector('[name=state]')?.value?.trim() || '';
    const zip   = r.querySelector('[name=zip]')  ?.value?.trim() || '';
    return { line1, line2, city, state, zip };
  }).filter(a => a.line1 || a.line2 || a.city || a.state || a.zip) : [];

  const emrs = emrsList ? [...emrsList.querySelectorAll('.grid')].map(r => {
    const vendor  = r.querySelector('[name=vendor]') ?.value?.trim() || '';
    const details = r.querySelector('[name=details]')?.value?.trim() || '';
    return { vendor, details };
  }).filter(e => e.vendor || e.details) : [];

  // 4) Create or update client
  let clientId = clientForm.client_id.value?.trim() || null;
  let currentActiveCommit = null;

  if (clientId) {
    // UPDATE
    const { error: upErr } = await supabase.from('clients').update(payload).eq('id', clientId);
    if (upErr) { console.error(upErr); return alert('Failed to update client.'); }

    const { data: existing } = await supabase
      .from('weekly_commitments')
      .select('weekly_qty,start_week,active')
      .eq('client_fk', clientId).eq('active', true)
      .order('start_week', { ascending:false }).limit(1);
    currentActiveCommit = existing?.[0] || null;

  } else {
    // INSERT
    const { data: newClient, error: insErr } =
      await supabase.from('clients').insert(payload).select('id').single();
    if (insErr) { console.error(insErr); return alert('Failed to create client.'); }
    clientId = newClient.id;
  }

  // 5) Upsert addresses
  if (addressesList) {
    // clear previous (safe even for new client)
    const { error: delAddrErr } = await supabase.from('client_addresses').delete().eq('client_fk', clientId);
    if (delAddrErr) { console.error(delAddrErr); return alert('Failed to clear existing addresses.'); }

    if (addrs.length) {
      const rows = addrs.map(a => ({ client_fk: clientId, ...a }));
      const { error: addrErr } = await supabase.from('client_addresses').insert(rows);
      if (addrErr) { console.error(addrErr); return alert('Failed to save addresses.'); }
    }
  }

  // 6) Upsert EMRs
  if (emrsList) {
    const { error: delEmrErr } = await supabase.from('client_emrs').delete().eq('client_fk', clientId);
    if (delEmrErr) { console.error(delEmrErr); return alert('Failed to clear existing EMRs.'); }

    if (emrs.length) {
      const rows = emrs.map(e => ({ client_fk: clientId, ...e }));
      const { error: emrErr } = await supabase.from('client_emrs').insert(rows);
      if (emrErr) { console.error(emrErr); return alert('Failed to save EMRs.'); }
    }
  }

  // 7) Weekly commitment (works for NEW and EDIT)
  const mondayOf = (d) => {
    const x = new Date(d); const day = x.getDay(); const back = (day + 6) % 7;
    x.setHours(0,0,0,0); x.setDate(x.getDate() - back); return x;
  };

  if (inputQty !== null || inputStart !== null) {
    const newQty   = (inputQty !== null)  ? inputQty : (currentActiveCommit?.weekly_qty ?? 0);
    let   newStart = (inputStart !== null) ? inputStart : (currentActiveCommit?.start_week ?? null);
    if (!newStart) newStart = mondayOf(new Date()).toISOString().slice(0,10);

    if (newQty > 0) {
      const unchanged = currentActiveCommit &&
        Number(currentActiveCommit.weekly_qty) === Number(newQty) &&
        String(currentActiveCommit.start_week).slice(0,10) === String(newStart).slice(0,10);

      if (!unchanged) {
        // retire current (only if there is one)
        if (currentActiveCommit) {
          const { error: deactErr } = await supabase
            .from('weekly_commitments').update({ active:false })
            .eq('client_fk', clientId).eq('active', true);
          if (deactErr) { console.error(deactErr); return alert('Failed to retire current commitment.'); }
        }
        // insert new
        const { error: insCmtErr } = await supabase.from('weekly_commitments').insert({
          client_fk: clientId, weekly_qty: newQty, start_week: newStart, active: true
        });
        if (insCmtErr) { console.error(insCmtErr); return alert('Failed to save weekly commitment.'); }
      }
    }
  }

  // 8) Finish
  modal?.classList.add('hidden');
  await loadClientsList();
  await loadDashboard();    // safe no-op on clients page if KPIs aren’t on screen
  alert('Saved.');
});

/* ============================================================
   Date-aware selection of active weekly commitment
   ============================================================ */
function pickActiveQtyForWeek(wkRows, clientId, refDate) {
  const rows = (wkRows || [])
    .filter(r => r.client_fk === clientId && r.active && new Date(r.start_week) <= refDate)
    .sort((a, b) => new Date(b.start_week) - new Date(a.start_week));
  return rows[0]?.weekly_qty || 0;
}

/* ================= Dashboard: Weekly Model ================= */
async function loadDashboard(){
  if (!kpiTotal) return; // Not on dashboard
  const supabase = await getSupabase();
  if (!supabase){
    kpiTotal.setAttribute('value','—');
    kpiCompleted.setAttribute('value','—');
    kpiRemaining.setAttribute('value','—');
    return;
  }

  const [{ data: clients }, { data: wk }, { data: comps }] = await Promise.all([
    supabase.from('clients').select('id,name,total_lives,contract_executed').order('name'),
    supabase.from('weekly_commitments').select('id,client_fk,site_fk,weekly_qty,start_week,active'),
    supabase.from('completions').select('client_fk,site_fk,occurred_on,qty_completed')
  ]);

  const today = new Date();
  const mon = mondayOf(today);
  const fri = fridayEndOf(mon);
  const lastMon = new Date(mon); lastMon.setDate(lastMon.getDate()-7);
  const lastFri = fridayEndOf(lastMon);

  const contractedOnly = document.getElementById('filterContracted')?.checked ?? true;

  const completedForWeek = (clientId, weekMon, weekFri) => (comps || [])
    .filter(c => c.client_fk === clientId)
    .reduce((sum, c) => {
      const d = new Date(c.occurred_on);
      return (d >= weekMon && d <= weekFri) ? sum + (c.qty_completed || 0) : sum;
    }, 0);

  const rows = (clients || [])
    .filter(c => !contractedOnly || c.contract_executed)
    .map(c => {
      const qtyThis  = pickActiveQtyForWeek(wk, c.id, mon);
      const qtyLast  = pickActiveQtyForWeek(wk, c.id, lastMon);

      const doneLast = completedForWeek(c.id, lastMon, lastFri);
      const carryIn  = qtyLast - doneLast;                     // can be negative (overage)
      const required = Math.max(0, qtyThis + carryIn);

      const doneThis = completedForWeek(c.id, mon, fri);
      const remaining = Math.max(0, required - doneThis);

      // Status: RED if carryover from last week; else YELLOW if behind pace
      const needPerDay = remaining / Math.max(1, daysLeftThisWeek(today));
      const status = carryIn > 0 ? 'red' : (needPerDay > 100 ? 'yellow' : 'green');

      return { id: c.id, name: c.name, weekly_qty: qtyThis, carryIn, required, doneThis, remaining, status };
    });

  // KPIs
  const totalRequired = rows.reduce((s, r) => s + r.required, 0);
  const totalDone     = rows.reduce((s, r) => s + r.doneThis, 0);
  const totalRemain   = Math.max(0, totalRequired - totalDone);
  kpiTotal?.setAttribute('value', fmt(totalRequired));
  kpiCompleted?.setAttribute('value', fmt(totalDone));
  kpiRemaining?.setAttribute('value', fmt(totalRemain));

  // Chart + “Due this week” table
  renderByClientChart(rows);
  renderDueThisWeek(rows);
}

/* ================= Chart (scrollable) ================= */
function renderByClientChart(rows){
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

  // width per bar; height fixed by container
  const widthPx = Math.max(1100, labels.length * 140);
  const widthDiv = document.getElementById('chartWidth');
  const canvas   = document.getElementById('byClientChart');
  if (widthDiv) widthDiv.style.width = widthPx + 'px';
  if (canvas)   canvas.width = widthPx;

  const totalsForAxis = labels.map((_,i)=> completes[i]+remains[i]);
  const yCfg = yScaleFor(totalsForAxis, 0.05);

  if (byClientChart) byClientChart.destroy();
  const ctx = canvas?.getContext('2d');
  if (!ctx || !window.Chart) return;

  byClientChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Completed', data: completes,
          backgroundColor: compFill, hoverBackgroundColor: compHover,
          borderColor: compBorder, borderWidth: 1, borderRadius: 10, borderSkipped:false, maxBarThickness: 44, stack:'totals' },
        { label:'Remaining', data: remains,
          backgroundColor: remFills, hoverBackgroundColor: remHovers,
          borderColor: remBorders, borderWidth: 1.5, borderRadius: 10, borderSkipped:false, maxBarThickness: 44, stack:'totals' }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{ duration: 400 },
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
        x:{
          stacked:true, grid:{display:false},
          ticks:{
            autoSkip:false, maxRotation:0, minRotation:0, font:{size:11},
            callback:(value, index)=>{
              const label = labels[index] || '';
              return label.length > 16 ? label.slice(0,16) + '…' : label;
            }
          }
        },
        y:{
          stacked:true, min:yCfg.min, max:yCfg.max, ticks:{ stepSize:yCfg.stepSize },
          grid:{ color:'rgba(17,24,39,0.08)' }
        }
      }
    },
    plugins: [barPercentPlugin]
  });
}

/* ================= Due This Week table ================= */
function renderDueThisWeek(rows){
  if (!dueBody) return;
  const items = rows.filter(r=> r.required>0).sort((a,b)=> b.remaining - a.remaining);
  if (!items.length){
    dueBody.innerHTML = `<tr><td colspan="6" class="py-4 text-sm text-gray-500">No active commitments this week.</td></tr>`;
    return;
  }
  dueBody.innerHTML = items.map(r=>{
    const done = Math.max(0, r.required - r.remaining);
    return `
      <tr>
        <td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${r.id}">${r.name}</a></td>
        <td class="text-sm">${fmt(r.required)}</td>
        <td class="text-sm">${fmt(done)}</td>
        <td class="text-sm">${fmt(r.remaining)}</td>
        <td class="text-sm"><status-badge status="${r.status}"></status-badge></td>
        <td class="text-sm">
          <button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log="${r.id}" data-name="${r.name}">Log</button>
        </td>
      </tr>`;
  }).join('');

  dueBody.onclick = (e)=>{
    const btn = e.target.closest('button[data-log]');
    if (!btn) return;
    openLogModal(btn.getAttribute('data-log'), btn.getAttribute('data-name'));
  };
}

/* ================= Log completion modal ================= */
function openLogModal(clientId, name){
  if (!logForm) return;
  logForm.client_id.value = clientId;
  logForm.qty.value = '';
  logForm.note.value = '';
  if (logClientName) logClientName.textContent = name || '—';
  logModal?.classList.remove('hidden');
}
function closeLogModal(){ logModal?.classList.add('hidden'); }
logClose?.addEventListener('click', closeLogModal);
logCancel?.addEventListener('click', closeLogModal);

logForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const supabase = await getSupabase();
  if (!supabase) return alert('Supabase not configured.');
  const qty = Number(logForm.qty.value||0);
  if (!qty || qty < 1) return alert('Enter a valid quantity.');

  const payload = {
    client_fk: logForm.client_id.value,
    occurred_on: new Date().toISOString(),     // today
    qty_completed: qty,
    note: logForm.note.value?.trim() || null
  };
  const { error } = await supabase.from('completions').insert(payload);
  if (error){ console.error(error); return alert('Failed to log completion.'); }

  closeLogModal();
  await loadDashboard();   // refresh KPIs, chart, and table immediately
});

/* ================= Clients list (clients.html) ================= */
async function loadClientsList(){
  if (!clientsTableBody) return; // not on clients page
  const supabase = await getSupabase();
  if (!supabase){ clientsTableBody.innerHTML = `<tr><td class="py-4 text-sm text-gray-500">Connect Supabase (env.js).</td></tr>`; return; }

  const [{ data: clients }, { data: wk }] = await Promise.all([
    supabase.from('clients').select('id,name,total_lives,contract_executed').order('name'),
    supabase.from('weekly_commitments').select('client_fk,weekly_qty,start_week,active')
  ]);

  const latestQty = (id)=>{
    const rows = (wk||[]).filter(r=> r.client_fk===id && r.active)
                   .sort((a,b)=> new Date(b.start_week) - new Date(a.start_week));
    return rows[0]?.weekly_qty || 0;
  };

  clientsTableBody.innerHTML = '';
  (clients||[]).forEach(c=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-sm">
        <a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${c.id}">${c.name}</a>
        ${c.contract_executed ? '' : '<span class="ml-2 text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">uncontracted</span>'}
      </td>
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
    await openClientModalById(btn.getAttribute('data-edit'));
  };
}

/* ================= Client detail (weekly model) ================= */
async function loadClientDetail(){
  const nameEl = document.getElementById('clientName');
  if (!nameEl) return; // not on detail page

  const id = new URL(location.href).searchParams.get('id');
  const supabase = await getSupabase(); if (!supabase) return;

  const [{ data: client }, { data: addrs }, { data: emrs }, { data: wk }, { data: comps }] = await Promise.all([
    supabase.from('clients').select('*').eq('id', id).single(),
    supabase.from('client_addresses').select('*').eq('client_fk', id).order('created_at'),
    supabase.from('client_emrs').select('*').eq('client_fk', id).order('created_at'),
    supabase.from('weekly_commitments').select('*').eq('client_fk', id).order('start_week', { ascending:false }),
    supabase.from('completions').select('*').eq('client_fk', id)
  ]);

  nameEl.textContent = client?.name || 'Client';
  const metaEl = document.getElementById('clientMeta');
  if (metaEl) metaEl.textContent =
    client ? `${client.total_lives ? `Lives: ${client.total_lives.toLocaleString()} — ` : ''}${client.contract_executed ? 'Contracted' : 'Uncontracted'}` : '';

  // profile panel
  const contactEl = document.getElementById('contact');
  if (contactEl) {
    contactEl.innerHTML = client?.contact_email
      ? `${client?.contact_name || ''} <a class="text-indigo-600 hover:underline" href="mailto:${client.contact_email}">${client.contact_email}</a>`
      : (client?.contact_name || '—');
  }
  const notesEl = document.getElementById('notes'); if (notesEl) notesEl.textContent = client?.instructions || '—';

  const addrList = document.getElementById('addresses');
  if (addrList) addrList.innerHTML = (addrs?.length ? addrs : []).map(a =>
    `<li>${[a.line1, a.line2, a.city, a.state, a.zip].filter(Boolean).join(', ')}</li>`).join('') || '<li class="text-gray-500">—</li>';

  const emrList = document.getElementById('emrs');
  if (emrList) emrList.innerHTML = (emrs?.length ? emrs : []).map(e =>
    `<li>${[e.vendor, e.details].filter(Boolean).join(' — ')}</li>`).join('') || '<li class="text-gray-500">—</li>';

  // weekly math
  const today = new Date();
  const mon = mondayOf(today);
  const fri = fridayEndOf(mon);
  const lastMon = new Date(mon); lastMon.setDate(lastMon.getDate()-7);
  const lastFri = fridayEndOf(lastMon);

  const pickActive = (refDate)=>{
    const rows = (wk||[]).filter(r => r.active && new Date(r.start_week) <= refDate)
                         .sort((a,b)=> new Date(b.start_week) - new Date(a.start_week));
    return rows[0] || null;
  };

  const activeThis = pickActive(mon);
  const activeLast = pickActive(lastMon);

  const weeklyQty = activeThis?.weekly_qty || 0;
  const doneForRange = (from, to)=> (comps||[]).reduce((s,c)=>{
    const d = new Date(c.occurred_on);
    return (d>=from && d<=to) ? s + (c.qty_completed||0) : s;
  }, 0);

  const doneLast = doneForRange(lastMon, lastFri);
  const carryIn  = (activeLast?.weekly_qty || 0) - doneLast;        // may be negative
  const required = Math.max(0, weeklyQty + carryIn);
  const doneThis = doneForRange(mon, fri);
  const remaining= Math.max(0, required - doneThis);
  const needPerDay = remaining / Math.max(1, daysLeftThisWeek(today));
  const status = carryIn>0 ? 'red' : (needPerDay>100 ? 'yellow' : 'green');

  // commitment panel
  const fmtDate = d => d ? new Date(d).toISOString().slice(0,10) : '—';
  const setTxt = (id, v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  setTxt('wkQty', weeklyQty ? weeklyQty.toLocaleString() + '/wk' : '—');
  setTxt('startWeek', activeThis?.start_week ? fmtDate(activeThis.start_week) : '—');
  setTxt('carryIn', (carryIn||0).toLocaleString());
  setTxt('required', required.toLocaleString());
  setTxt('done', doneThis.toLocaleString());
  setTxt('remaining', remaining.toLocaleString());
  const sBadge = document.getElementById('clientStatus'); sBadge?.setAttribute('status', status);

  const logBtn = document.getElementById('clientLogBtn');
  if (logBtn) logBtn.onclick = ()=> openLogModal(id, client?.name || 'Client');

  // "This Week" table (one row)
  const weekBody = document.getElementById('clientWeekBody');
  if (weekBody){
    if (weeklyQty === 0 && carryIn === 0){
      weekBody.innerHTML = `<tr><td colspan="8" class="py-4 text-sm text-gray-500">No active commitment.</td></tr>`;
    } else {
      const friLabel = fri.toISOString().slice(0,10);
      weekBody.innerHTML = `
        <tr>
          <td class="text-sm">${friLabel}</td>
          <td class="text-sm">${weeklyQty.toLocaleString()}</td>
          <td class="text-sm">${carryIn.toLocaleString()}</td>
          <td class="text-sm">${required.toLocaleString()}</td>
          <td class="text-sm">${doneThis.toLocaleString()}</td>
          <td class="text-sm">${remaining.toLocaleString()}</td>
          <td class="text-sm"><status-badge status="${status}"></status-badge></td>
          <td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs"
            onclick="openLogModal('${id}','${(client?.name||'Client').replace(/'/g,'&#39;')}')">Log</button></td>
        </tr>`;
    }
  }

  // chart: one stacked bar (completed vs remaining)
  const canv = document.getElementById('clientWeekChart');
  if (canv && window.Chart){
    const ctx = canv.getContext('2d');
    document.getElementById('clientChartWidth')?.style && (document.getElementById('clientChartWidth').style.width = '560px');
    const yCfg = yScaleFor([required], 0.08);
    const colors = statusColors(status);

    if (window.__clientChart) window.__clientChart.destroy();
    window.__clientChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['This week'],
        datasets: [
          { label:'Completed', data:[doneThis], backgroundColor:'rgba(107,114,128,0.50)', borderColor:'#6b7280',
            borderWidth:1, borderRadius:10, borderSkipped:false, maxBarThickness:56, stack:'totals' },
          { label:'Remaining', data:[remaining], backgroundColor:colors.fill, borderColor:colors.stroke,
            borderWidth:1.5, borderRadius:10, borderSkipped:false, maxBarThickness:56, stack:'totals' }
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false, animation:{duration:400},
        plugins:{ legend:{display:true}, tooltip:{displayColors:false, padding:12} },
        scales:{ x:{ stacked:true, grid:{display:false} },
                 y:{ stacked:true, min:yCfg.min, max:yCfg.max, ticks:{stepSize:yCfg.stepSize},
                     grid:{ color:'rgba(17,24,39,0.08)' } } }
      }
    });
  }
}

/* ================= Boot ================= */
window.addEventListener('DOMContentLoaded', ()=>{
  // Dashboard live filter
  document.getElementById('filterContracted')?.addEventListener('change', loadDashboard);

  // Page inits (safe no-ops when elements aren’t present)
  loadDashboard();
  loadClientsList();
  loadClientDetail();

  console.log('Deliverables Tracker — scripts loaded');
});

// Expose openLogModal for inline button on client-detail row
window.openLogModal = openLogModal;

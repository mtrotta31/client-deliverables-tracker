// script.js
import { getSupabase } from './supabaseClient.js';

/* =========================
   Utilities & status logic
   ========================= */
function fmt(n){ return Number(n||0).toLocaleString(); }
function daysUntil(due){ const ms = new Date(due) - new Date(); return Math.ceil(ms/86400000); }
function simpleStatus(remaining, dueDate){
  if (remaining <= 0) return 'green';
  const days = Math.max(1, daysUntil(dueDate));
  const need = remaining / days; // simple proxy for pace
  if (days <= 3 && remaining > 0) return 'red';
  if (need > 100) return 'yellow';
  return 'green';
}

// Tailwind-ish colors with soft alpha fills
function statusColors(s, a = 0.72){
  const map = {
    green:  { r: 34,  g:197, b: 94,  stroke: '#16a34a' }, // green-500/600
    yellow: { r:234,  g:179, b:  8,  stroke: '#d97706' }, // amber-500/600
    red:    { r:239,  g: 68, b: 68,  stroke: '#b91c1c' }, // red-500/700
  };
  const k = map[s] || map.green;
  return {
    fill: `rgba(${k.r}, ${k.g}, ${k.b}, ${a})`,
    stroke: k.stroke,
    hover: `rgba(${k.r}, ${k.g}, ${k.b}, ${Math.min(1, a + 0.15)})`,
  };
}

/* === Tight y-axis autoscale (bars look long) ===
   Hard max ~8% above tallest bar, nice step size.
   If all values are 0 (or empty), use a tiny axis so the chart isn’t huge.
*/
function yScaleFor(values){
  const nums = (values || []).map(v => Number(v) || 0);
  const rawMax = Math.max(0, ...nums);
  if (!isFinite(rawMax) || rawMax <= 0) {
    return { min: 0, max: 1, stepSize: 1 }; // compact axis for empty/zero data
  }
  const top = Math.ceil(rawMax * 1.08); // ~8% headroom
  const rough = top / 5; // aim ~5 ticks
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const nice = Math.ceil(rough / pow) * pow;
  const step = Math.max(5, nice);
  const max = Math.ceil(top / step) * step; // round up to step multiple
  return { min: 0, max, stepSize: step };
}

function getThisFriday(){
  const d = new Date();
  const day = d.getDay(); // 0 Sun ... 5 Fri
  const diff = (5 - day + 7) % 7; // days until Friday
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0,10);
}

/* =========================
   Global filters & bindings
   ========================= */
const filters = {
  contractedOnly: JSON.parse(localStorage.getItem('contractedOnly') ?? 'true'),
};
function bindContractedCheckbox(){
  const cb = document.querySelector('#filterContracted');
  if (!cb) return;
  cb.checked = filters.contractedOnly;
  cb.onchange = ()=>{
    filters.contractedOnly = cb.checked;
    localStorage.setItem('contractedOnly', JSON.stringify(filters.contractedOnly));
    loadDashboard();
    loadClientsList();
  };
}

/* =========================
   DOM refs
   ========================= */
// Dashboard
const kpiTotal = document.querySelector('#kpi-total');
const kpiCompleted = document.querySelector('#kpi-completed');
const kpiRemaining = document.querySelector('#kpi-remaining');
const kpiFriday = document.querySelector('#kpi-friday');
const dueSoonTbody = document.querySelector('#due-soon-body');
const fridayBody = document.querySelector('#friday-body');
let byClientChart;

// CSV importer
const fileInput = document.querySelector('#csvFile');
const previewBtn = document.querySelector('#previewBtn');
const importBtn = document.querySelector('#importBtn');
const previewTable = document.querySelector('#previewTable');
const previewTbody = document.querySelector('#previewTbody');
const importSummary = document.querySelector('#importSummary');

// Clients list
const clientsTableBody = document.querySelector('#clientsBody');

// Client detail
const clientNameEl = document.querySelector('#clientName');
const clientMetaEl = document.querySelector('#clientMeta');
const deliverablesBody = document.querySelector('#deliverablesBody');
let clientDueChart;

/* =========================
   CSV preview & import
   ========================= */
if (previewBtn) {
  previewBtn.onclick = () => {
    const f = fileInput?.files?.[0];
    if (!f) { alert('Choose a CSV file first.'); return; }
    if (!window.Papa) { alert('CSV parser not loaded.'); return; }
    window.Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: ({data, errors}) => {
        if (errors?.length) console.warn('CSV parse errors', errors);
        previewTbody.innerHTML = '';
        data.slice(0,50).forEach(r => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="text-xs">${r.client_id||''}</td>
            <td class="text-xs">${r.client_name||''}</td>
            <td class="text-xs">${r.due_date||''}</td>
            <td class="text-xs">${r.qty_due||''}</td>
            <td class="text-xs">${r.contract_executed||''}</td>
            <td class="text-xs">${r.total_lives||''}</td>`;
          previewTbody.appendChild(tr);
        });
        previewTable.classList.remove('hidden');
        importSummary.textContent = `${data.length} rows parsed. Ready to import.`;
      }
    });
  };
}

if (importBtn) {
  importBtn.onclick = async () => {
    const supabase = await getSupabase();
    if (!supabase) { alert('Supabase not configured (edit env.js and Supabase CORS).'); return; }
    const f = fileInput?.files?.[0];
    if (!f) { alert('Choose a CSV file first.'); return; }

    importBtn.disabled = true; importBtn.textContent = 'Importing…';
    window.Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: async ({data}) => {
        try {
          const result = await importRows(data, supabase);
          importSummary.textContent = `Imported ${result.clients} clients and ${result.deliverables} deliverables.`;
          await loadDashboard();
          await loadClientsList();
        } catch (e) {
          console.error(e); alert('Import failed. See console.');
        } finally {
          importBtn.disabled = false; importBtn.textContent = 'Import to Supabase';
        }
      }
    });
  };
}

async function importRows(rows, supabase){
  // Build unique set of clients keyed by client_id OR normalized name
  const byKey = new Map();
  for (const r of rows) {
    const key = (r.client_id && r.client_id.trim()) ? r.client_id.trim() : (r.client_name||'').toLowerCase().trim();
    if (!key) continue;
    if (!byKey.has(key)){
      byKey.set(key, {
        client_id: r.client_id?.trim() || null,
        name: (r.client_name||'').trim(),
        addresses: (r.addresses||'').trim(),
        contact_name: (r.contact_name||'').trim(),
        contact_email: (r.contact_email||'').trim(),
        products: (r.products||'').trim(),
        instructions: (r.instructions||'').trim(),
        start_date: r.start_date ? new Date(r.start_date).toISOString().slice(0,10) : null,
        // New fields for Rhonda
        contract_executed: String(r.contract_executed||'').toLowerCase()==='true',
        contract_date: r.contract_date ? new Date(r.contract_date).toISOString().slice(0,10) : null,
        total_lives: r.total_lives ? Number(r.total_lives) : null,
        next_roster_pull: r.next_roster_pull ? new Date(r.next_roster_pull).toISOString().slice(0,10) : null
      });
    }
  }

  // Upsert clients; collect ids
  let insertedClients = 0;
  const keyToId = new Map();
  for (const [key, obj] of byKey.entries()){
    if (obj.client_id){
      const { data, error } = await supabase.from('clients').upsert(obj, { onConflict: 'client_id' }).select('id').single();
      if (error) throw error; keyToId.set(key, data.id); insertedClients++;
    } else {
      const { data: existing, error: findErr } = await supabase.from('clients').select('id').ilike('name', obj.name).maybeSingle();
      if (findErr) throw findErr;
      if (existing) keyToId.set(key, existing.id);
      else {
        const { data: ins, error: insErr } = await supabase.from('clients').insert(obj).select('id').single();
        if (insErr) throw insErr; keyToId.set(key, ins.id); insertedClients++;
      }
    }
  }

  // Upsert deliverables (due-date only fallback)
  let insertedDeliverables = 0;
  for (const r of rows){
    const key = (r.client_id && r.client_id.trim()) ? r.client_id.trim() : (r.client_name||'').toLowerCase().trim();
    const client_fk = keyToId.get(key);
    if (!client_fk) continue;
    const deliverable = {
      deliverable_id: (r.deliverable_id||'').trim() || null,
      client_fk,
      due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0,10) : null,
      qty_due: Number(r.qty_due||0),
      label: null  // MVP ignores ongoing weekly label
    };
    if (deliverable.deliverable_id){
      const { error } = await supabase.from('deliverables').upsert(deliverable, { onConflict: 'deliverable_id' });
      if (error) throw error; insertedDeliverables++;
    } else {
      const { data: ex, error: exErr } = await supabase
        .from('deliverables').select('id')
        .eq('client_fk', client_fk).eq('due_date', deliverable.due_date).maybeSingle();
      if (exErr) throw exErr;
      if (ex) {
        const { error: updErr } = await supabase.from('deliverables').update({ qty_due: deliverable.qty_due }).eq('id', ex.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase.from('deliverables').insert(deliverable);
        if (insErr) throw insErr; insertedDeliverables++;
      }
    }
  }
  return { clients: insertedClients, deliverables: insertedDeliverables };
}

/* =========================
   Dashboard
   ========================= */
async function loadDashboard(){
  bindContractedCheckbox();
  if (!kpiTotal) return; // not on dashboard

  const supabase = await getSupabase();
  if (!supabase){
    kpiTotal.setAttribute('value', '—'); 
    kpiCompleted.setAttribute('value', '—');
    kpiRemaining.setAttribute('value', '—'); 
    if (kpiFriday) kpiFriday.setAttribute('value','—');
    if (fridayBody) fridayBody.innerHTML = `<tr><td colspan="5" class="text-sm text-gray-500 py-4">Connect Supabase in env.js to load live data.</td></tr>`;
    if (dueSoonTbody) dueSoonTbody.innerHTML = `<tr><td colspan="6" class="text-sm text-gray-500 py-4">Connect Supabase in env.js to load live data.</td></tr>`;
    return;
  }

  const { data: progress, error } = await supabase
    .from('deliverable_progress')
    .select('deliverable_id, client_fk, due_date, qty_due, remaining_to_due');
  if (error){ console.error(error); return; }

  // Clients
  const clientIds = [...new Set(progress.map(p => p.client_fk))];
  const { data: clients, error: cErr } = await supabase.from('clients')
    .select('id,name,contract_executed').in('id', clientIds);
  if (cErr){ console.error(cErr); return; }
  const idTo = Object.fromEntries(clients.map(c => [c.id, c]));

  // Filter: contracted only?
  const progressFiltered = filters.contractedOnly
    ? progress.filter(p => idTo[p.client_fk]?.contract_executed)
    : progress.slice();

  // KPIs
  const total = progressFiltered.reduce((a,b)=>a+(b.qty_due||0),0);
  const remaining = progressFiltered.reduce((a,b)=>a+(b.remaining_to_due||0),0);
  const completed = total - remaining;
  kpiTotal.setAttribute('value', fmt(total));
  kpiCompleted.setAttribute('value', fmt(completed));
  kpiRemaining.setAttribute('value', fmt(remaining));

  // "Due This Friday"
  const friday = getThisFriday();
  const dueFri = progressFiltered.filter(p => p.due_date === friday);
  const friTotal = dueFri.reduce((a,b)=>a+(b.qty_due||0),0);
  if (kpiFriday) kpiFriday.setAttribute('value', fmt(friTotal));

  if (fridayBody){
    fridayBody.innerHTML = '';
    if (!dueFri.length){
      fridayBody.innerHTML = `<tr><td colspan="5" class="text-sm text-gray-500 py-4">Nothing due this Friday.</td></tr>`;
    } else {
      const byClient = new Map();
      for (const p of dueFri){
        const cur = byClient.get(p.client_fk) || { qty:0, rem:0 };
        cur.qty += (p.qty_due||0); cur.rem += (p.remaining_to_due||0);
        byClient.set(p.client_fk, cur);
      }
      [...byClient.entries()].sort((a,b)=>b[1].rem - a[1].rem).forEach(([cid, agg])=>{
        const name = idTo[cid]?.name || '—';
        const status = simpleStatus(agg.rem, friday);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${cid}">${name}</a></td>
          <td class="text-sm">${fmt(agg.qty)}</td>
          <td class="text-sm">${fmt(agg.rem)}</td>
          <td class="text-sm"><status-badge status="${status}"></status-badge></td>
          <td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log-friday="${cid}">Log</button></td>`;
        fridayBody.appendChild(tr);
      });
    }
    fridayBody.onclick = async (e)=>{
      const btn = e.target.closest('button[data-log-friday]');
      if (!btn) return;
      const cid = btn.getAttribute('data-log-friday');
      const qty = Number(prompt('Qty completed (distributed across this client’s Friday deliverables)?'));
      if (!qty || qty<=0) return;
      const { data: friDeliverables } = await supabase
        .from('deliverables').select('id').eq('client_fk', cid).eq('due_date', friday);
      const count = Math.max(1, friDeliverables?.length || 1);
      const chunk = Math.ceil(qty / count);
      for (const d of (friDeliverables||[])){
        await supabase.from('completions').insert({
          deliverable_fk: d.id, occurred_on: friday, qty_completed: chunk, note: 'Dashboard Friday quick-log'
        });
      }
      await loadDashboard();
    };
  }

  // Upcoming (first 10)
  if (dueSoonTbody){
    const idToName = Object.fromEntries(clients.map(c => [c.id, c.name]));
    const sorted = progressFiltered.slice().sort((a,b)=> new Date(a.due_date)-new Date(b.due_date));
    dueSoonTbody.innerHTML = '';
    sorted.slice(0,10).forEach(p=>{
      const status = simpleStatus(p.remaining_to_due, p.due_date);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${p.client_fk}">${idToName[p.client_fk] || '—'}</a></td>
        <td class="text-sm">${p.due_date}</td>
        <td class="text-sm">${fmt(p.qty_due)}</td>
        <td class="text-sm">${fmt(p.qty_due - p.remaining_to_due)}</td>
        <td class="text-sm"><status-badge status="${status}"></status-badge></td>
        <td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log="${p.deliverable_id}">Log</button></td>`;
      dueSoonTbody.appendChild(tr);
    });

    dueSoonTbody.onclick = async (e)=>{
      const btn = e.target.closest('button[data-log]');
      if (!btn) return;
      const deliverableId = btn.getAttribute('data-log');
      const qty = Number(prompt('Qty completed?')); if (!qty || qty<=0) return;
      const occurred = new Date().toISOString().slice(0,10);
      const { error: insErr } = await supabase.from('completions').insert({
        deliverable_fk: deliverableId, occurred_on: occurred, qty_completed: qty
      });
      if (insErr){ alert('Failed to log completion.'); console.error(insErr); return; }
      await loadDashboard();
    };
  }

  // ===== Bar: Remaining by Client (Top 10) =====
  const agg = {};
  for (const p of progressFiltered) {
    agg[p.client_fk] = (agg[p.client_fk] || 0) + (p.remaining_to_due || 0);
  }
  const worstByClient = {};
  for (const p of progressFiltered) {
    const s = simpleStatus(p.remaining_to_due, p.due_date);
    const current = worstByClient[p.client_fk] || 'green';
    worstByClient[p.client_fk] =
      (current === 'red' || s === 'red') ? 'red'
      : (current === 'yellow' || s === 'yellow') ? 'yellow'
      : 'green';
  }
  const ranked = Object.entries(agg).sort((a,b)=> b[1]-a[1]).slice(0,10);
  const labels = ranked.map(([id]) => (idTo[id]?.name) || '—');
  const values = ranked.map(([,v]) => v);
  const yCfg = yScaleFor(values);
  const fills  = ranked.map(([id]) => statusColors(worstByClient[id] || 'green').fill);
  const borders= ranked.map(([id]) => statusColors(worstByClient[id] || 'green').stroke);
  const hovers = ranked.map(([id]) => statusColors(worstByClient[id] || 'green', 0.88).hover);

  const ctx = document.getElementById('byClientChart')?.getContext('2d');
  if (ctx && window.Chart){
    if (byClientChart) byClientChart.destroy();
    byClientChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Remaining',
          data: values,
          backgroundColor: fills,
          hoverBackgroundColor: hovers,
          borderColor: borders,
          borderWidth: 1.5,
          borderRadius: 10,
          borderSkipped: false,
          maxBarThickness: 36,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutCubic' },
        plugins: {
          legend: { display: false },
          tooltip: { padding: 10, callbacks: { label: (c) => `Remaining: ${fmt(c.parsed.y)}` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: {
            min: yCfg.min,
            max: yCfg.max,
            ticks: { stepSize: yCfg.stepSize },
            grid: { color: 'rgba(17,24,39,0.08)' }
          }
        }
      }
    });
  }
}

/* =========================
   Clients list
   ========================= */
async function loadClientsList(){
  bindContractedCheckbox();
  if (!clientsTableBody) return;

  const supabase = await getSupabase();
  if (!supabase){
    clientsTableBody.innerHTML = `<tr><td colspan="6" class="text-sm text-gray-500 py-4">Connect Supabase (env.js).</td></tr>`;
    return;
  }

  let { data: clients, error } = await supabase.from('clients')
    .select('id,name,total_lives,next_roster_pull,contract_executed')
    .order('name');
  if (error){ console.error(error); return; }
  if (filters.contractedOnly) clients = clients.filter(c=>c.contract_executed);

  if (!clients?.length){
    clientsTableBody.innerHTML = `<tr><td colspan="6" class="text-sm text-gray-500 py-4">No clients yet. Import a CSV.</td></tr>`;
    return;
  }

  clientsTableBody.innerHTML = '';
  const today = new Date();
  const in14 = new Date(); in14.setDate(today.getDate()+14);
  const toISO = d => d.toISOString().slice(0,10);

  for (const c of clients){
    const { data: delivs } = await supabase.from('deliverables')
      .select('id,due_date,qty_due')
      .eq('client_fk', c.id)
      .order('due_date', { ascending: true });

    let firstDue = '—', firstQty = '—', clientStatus = 'green';
    if (delivs?.length){
      firstDue = delivs[0].due_date;
      firstQty = fmt(delivs[0].qty_due);

      // status window: next 14 days
      const windowed = delivs.filter(d => d.due_date >= toISO(today) && d.due_date <= toISO(in14));
      let worst = 'green';
      for (const d of windowed){
        const { data: prog } = await supabase.from('deliverable_progress')
          .select('remaining_to_due').eq('deliverable_id', d.id).single();
        const s = simpleStatus(prog?.remaining_to_due ?? d.qty_due, d.due_date);
        if (s === 'red') { worst = 'red'; break; }
        if (s === 'yellow' && worst === 'green') worst = 'yellow';
      }
      clientStatus = worst;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${c.id}">${c.name}</a></td>
      <td class="text-sm">${c.total_lives ?? '—'}</td>
      <td class="text-sm">${firstDue}</td>
      <td class="text-sm">${firstQty}</td>
      <td class="text-sm">${c.next_roster_pull ?? '—'}</td>
      <td class="text-sm"><status-badge status="${clientStatus}"></status-badge></td>`;
    clientsTableBody.appendChild(tr);
  }
}

/* =========================
   Client detail
   ========================= */
async function loadClientDetail(){
  if (!clientNameEl) return;
  const id = new URL(window.location.href).searchParams.get('id');
  const supabase = await getSupabase();
  if (!id || !supabase){
    clientNameEl.textContent = 'Client';
    clientMetaEl.textContent = 'Connect Supabase to load details.';
    return;
  }

  const { data: client } = await supabase.from('clients')
    .select('*').eq('id', id).single();
  clientNameEl.textContent = client.name;
  clientMetaEl.textContent =
    `${client.products || ''} — ${client.addresses || ''}` +
    (client.total_lives ? ` — Lives: ${fmt(client.total_lives)}` : '') +
    (client.next_roster_pull ? ` — Next roster pull: ${client.next_roster_pull}` : '') +
    (client.contract_executed ? ` — Contracted` : ' — Not contracted');

  const { data: delivs } = await supabase.from('deliverables')
    .select('id,due_date,qty_due')
    .eq('client_fk', id).order('due_date', {ascending: true});

  deliverablesBody.innerHTML = '';
  const labels = [], values = [], fills = [], borders = [], hovers = [];

  for (const d of (delivs || [])){
    const { data: prog } = await supabase.from('deliverable_progress')
      .select('remaining_to_due').eq('deliverable_id', d.id).single();
    const remaining = prog?.remaining_to_due ?? d.qty_due;
    const status = simpleStatus(remaining, d.due_date);

    const color = statusColors(status);
    labels.push(d.due_date);
    values.push(remaining);
    fills.push(color.fill);
    hovers.push(color.hover);
    borders.push(color.stroke);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-sm">${d.due_date}</td>
      <td class="text-sm">${fmt(d.qty_due)}</td>
      <td class="text-sm">${fmt(d.qty_due - remaining)}</td>
      <td class="text-sm">${fmt(remaining)}</td>
      <td class="text-sm"><status-badge status="${status}"></status-badge></td>
      <td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log="${d.id}">Log completion</button></td>`;
    deliverablesBody.appendChild(tr);
  }

  const yCfg = yScaleFor(values);
  const ctx = document.getElementById('clientDueChart')?.getContext('2d');
  if (ctx && window.Chart){
    if (clientDueChart) clientDueChart.destroy();
    clientDueChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Remaining',
          data: values,
          backgroundColor: fills,
          hoverBackgroundColor: hovers,
          borderColor: borders,
          borderWidth: 1.5,
          borderRadius: 10,
          borderSkipped: false,
          maxBarThickness: 36,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutCubic' },
        plugins: {
          legend: { display: false },
          tooltip: { padding: 10, callbacks: { label: (c) => `Remaining: ${fmt(c.parsed.y)}` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: {
            min: yCfg.min,
            max: yCfg.max,                 // tight cap
            ticks: { stepSize: yCfg.stepSize },
            grid: { color: 'rgba(17,24,39,0.08)' }
          }
        }
      }
    });
  }

  // One-click logger
  deliverablesBody.onclick = async (e)=>{
    const btn = e.target.closest('button[data-log]'); if (!btn) return;
    const deliverableId = btn.getAttribute('data-log');
    const qty = Number(prompt('Qty completed?')); if (!qty || qty<=0) return;
    const occurred = new Date().toISOString().slice(0,10);
    const { error } = await supabase.from('completions').insert({
      deliverable_fk: deliverableId, occurred_on: occurred, qty_completed: qty
    });
    if (error){ alert('Failed to log completion.'); console.error(error); return; }
    alert('Logged! Refreshing…'); location.reload();
  };
}

/* =========================
   Boot
   ========================= */
window.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  loadClientsList();
  loadClientDetail();
  console.log('Deliverables script build: scale-tight v2');
});

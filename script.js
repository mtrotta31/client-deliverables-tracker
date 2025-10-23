import { getSupabase } from './supabaseClient.js';

function fmt(n){ return Number(n||0).toLocaleString(); }
function daysUntil(due){ const ms = new Date(due) - new Date(); return Math.ceil(ms/86400000); }
function simpleStatus(remaining, dueDate){
  if (remaining <= 0) return 'green';
  const days = Math.max(1, daysUntil(dueDate));
  const need = remaining / days;
  if (days <= 3 && remaining > 0) return 'red';
  if (need > 100) return 'yellow';
  return 'green';
}

// Dashboard refs
const kpiTotal = document.querySelector('#kpi-total');
const kpiCompleted = document.querySelector('#kpi-completed');
const kpiRemaining = document.querySelector('#kpi-remaining');
const dueSoonTbody = document.querySelector('#due-soon-body');
let byClientChart;

// CSV importer refs
const fileInput = document.querySelector('#csvFile');
const previewBtn = document.querySelector('#previewBtn');
const importBtn = document.querySelector('#importBtn');
const previewTable = document.querySelector('#previewTable');
const previewTbody = document.querySelector('#previewTbody');
const importSummary = document.querySelector('#importSummary');

// Clients list refs
const clientsTableBody = document.querySelector('#clientsBody');

// Client detail refs
const clientNameEl = document.querySelector('#clientName');
const clientMetaEl = document.querySelector('#clientMeta');
const deliverablesBody = document.querySelector('#deliverablesBody');
let clientDueChart;

/* ---------- CSV Preview (due-date only) ---------- */
if (previewBtn) {
  previewBtn.addEventListener('click', () => {
    const f = fileInput?.files?.[0];
    if (!f) { alert('Choose a CSV file first.'); return; }
    if (!window.Papa) { alert('CSV parser not loaded.'); return; }
    window.Papa.parse(f, {
      header: true,
      skipEmptyLines: true,
      complete: ({data, errors}) => {
        if (errors?.length) console.warn('CSV parse errors', errors);
        renderPreview(data);
      }
    });
  });
}

function renderPreview(rows){
  previewTbody.innerHTML = '';
  rows.slice(0,50).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-xs">${r.client_id||''}</td>
      <td class="text-xs">${r.client_name||''}</td>
      <td class="text-xs">${r.due_date||''}</td>
      <td class="text-xs">${r.qty_due||''}</td>`;
    previewTbody.appendChild(tr);
  });
  previewTable.classList.remove('hidden');
  importSummary.textContent = `${rows.length} rows parsed. Ready to import.`;
}

/* ---------- CSV Import (due-date only upsert) ---------- */
if (importBtn) {
  importBtn.addEventListener('click', async () => {
    const supabase = await getSupabase();
    if (!supabase) { alert('Supabase not configured (edit env.js and Supabase CORS).'); return; }
    const f = fileInput?.files?.[0];
    if (!f) { alert('Choose a CSV file first.'); return; }

    importBtn.disabled = true; importBtn.textContent = 'Importing…';

    window.Papa.parse(f, {
      header: true,
      skipEmptyLines: true,
      complete: async ({data}) => {
        try {
          const result = await importRows(data, supabase);
          importSummary.textContent = `Imported ${result.clients} clients and ${result.deliverables} deliverables.`;
          await loadDashboard();
        } catch (e) {
          console.error(e);
          alert('Import failed. See console.');
        } finally {
          importBtn.disabled = false; importBtn.textContent = 'Import to Supabase';
        }
      }
    });
  });
}

async function importRows(rows, supabase){
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
        start_date: r.start_date ? new Date(r.start_date).toISOString().slice(0,10) : null
      });
    }
  }

  let insertedClients = 0;
  const keyToId = new Map();
  for (const [key, obj] of byKey.entries()){
    if (obj.client_id){
      const { data, error } = await supabase.from('clients').upsert(obj, { onConflict: 'client_id' }).select('id').single();
      if (error) throw error;
      keyToId.set(key, data.id);
      insertedClients++;
    } else {
      const { data: existing, error: findErr } = await supabase.from('clients').select('id').ilike('name', obj.name).maybeSingle();
      if (findErr) throw findErr;
      if (existing) keyToId.set(key, existing.id);
      else {
        const { data: ins, error: insErr } = await supabase.from('clients').insert(obj).select('id').single();
        if (insErr) throw insErr;
        keyToId.set(key, ins.id);
        insertedClients++;
      }
    }
  }

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
      label: null
    };
    if (deliverable.deliverable_id){
      const { error } = await supabase.from('deliverables').upsert(deliverable, { onConflict: 'deliverable_id' });
      if (error) throw error;
      insertedDeliverables++;
    } else {
      const { data: ex, error: exErr } = await supabase
        .from('deliverables')
        .select('id')
        .eq('client_fk', client_fk)
        .eq('due_date', deliverable.due_date)
        .maybeSingle();
      if (exErr) throw exErr;
      if (ex) {
        const { error: updErr } = await supabase.from('deliverables').update({ qty_due: deliverable.qty_due }).eq('id', ex.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase.from('deliverables').insert(deliverable);
        if (insErr) throw insErr;
        insertedDeliverables++;
      }
    }
  }
  return { clients: insertedClients, deliverables: insertedDeliverables };
}

/* ---------- Dashboard rendering (+ quick "Log" + bar chart) ---------- */
async function loadDashboard(){
  if (!kpiTotal) return;
  const supabase = await getSupabase();
  if (!supabase){
    kpiTotal.setAttribute('value', '—');
    kpiCompleted.setAttribute('value', '—');
    kpiRemaining.setAttribute('value', '—');
    if (dueSoonTbody) dueSoonTbody.innerHTML = `<tr><td colspan="6" class="text-sm text-gray-500 py-4">Connect Supabase in env.js to load live data.</td></tr>`;
    return;
  }
  const { data: progress, error } = await supabase.from('deliverable_progress').select('deliverable_id, client_fk, due_date, qty_due, remaining_to_due');
  if (error){ console.error(error); return; }

  const total = progress.reduce((a,b)=>a+(b.qty_due||0),0);
  const remaining = progress.reduce((a,b)=>a+(b.remaining_to_due||0),0);
  const completed = total - remaining;
  kpiTotal.setAttribute('value', fmt(total));
  kpiCompleted.setAttribute('value', fmt(completed));
  kpiRemaining.setAttribute('value', fmt(remaining));

  // table
  const clientIds = [...new Set(progress.map(p => p.client_fk))];
  if (clientIds.length === 0){
    if (dueSoonTbody) dueSoonTbody.innerHTML = `<tr><td colspan="6" class="text-sm text-gray-500 py-4">No deliverables yet. Try importing a CSV.</td></tr>`;
  } else {
    const { data: clients, error: cErr } = await supabase.from('clients').select('id,name').in('id', clientIds);
    if (cErr){ console.error(cErr); return; }
    const idToName = Object.fromEntries(clients.map(c => [c.id, c.name]));
    progress.sort((a,b)=> new Date(a.due_date) - new Date(b.due_date));
    if (dueSoonTbody){
      dueSoonTbody.innerHTML = '';
      progress.slice(0, 10).forEach(p => {
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
      dueSoonTbody.addEventListener('click', async (e)=>{
        const btn = e.target.closest('button[data-log]');
        if (!btn) return;
        const deliverableId = btn.getAttribute('data-log');
        const qty = Number(prompt('Qty completed?'));
        if (!qty || qty <= 0) return;
        const note = prompt('Optional note?') || null;
        const occurred = new Date().toISOString().slice(0,10);
        const { error: insErr } = await supabase.from('completions').insert({ deliverable_fk: deliverableId, occurred_on: occurred, qty_completed: qty, note });
        if (insErr){ alert('Failed to log completion.'); console.error(insErr); return; }
        await loadDashboard();
      });
    }

    // chart
    const agg = {};
    for (const p of progress) agg[p.client_fk] = (agg[p.client_fk] || 0) + (p.remaining_to_due || 0);
    const sorted = Object.entries(agg).sort((a,b)=> b[1]-a[1]).slice(0,10);
    const labels = sorted.map(([id]) => idToName[id] || '—');
    const values = sorted.map(([,v]) => v);
    const ctx = document.getElementById('byClientChart')?.getContext('2d');
    if (ctx && window.Chart){
      if (byClientChart) byClientChart.destroy();
      byClientChart = new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Remaining', data: values }] }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
    }
  }
}

/* ---------- Clients list ---------- */
async function loadClientsList(){
  if (!clientsTableBody) return;
  const supabase = await getSupabase();
  if (!supabase){
    clientsTableBody.innerHTML = `<tr><td colspan="3" class="text-sm text-gray-500 py-4">Connect Supabase to load clients (edit env.js).</td></tr>`;
    return;
  }
  const { data, error } = await supabase.from('clients').select('id,name,start_date').order('name');
  if (error){
    console.error(error);
    clientsTableBody.innerHTML = `<tr><td colspan="3" class="text-sm text-red-600 py-4">Couldn't load clients: ${error.message}</td></tr>`;
    return;
  }
  if (!data || data.length === 0){
    clientsTableBody.innerHTML = `<tr><td colspan="3" class="text-sm text-gray-500 py-4">No clients yet. Import a CSV to create some.</td></tr>`;
    return;
  }
  clientsTableBody.innerHTML = '';
  data.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="text-sm"><a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${c.id}">${c.name}</a></td><td class="text-sm">${c.start_date || '—'}</td><td class="text-sm">—</td>`;
    clientsTableBody.appendChild(tr);
  });
}

/* ---------- Client detail (mini chart + Log) ---------- */
async function loadClientDetail(){
  if (!clientNameEl) return;
  const id = new URL(window.location.href).searchParams.get('id');
  const supabase = await getSupabase();
  if (!id || !supabase){
    clientNameEl.textContent = 'Client';
    clientMetaEl.textContent = 'Connect Supabase to load details.';
    return;
  }
  const { data: client, error: cErr } = await supabase.from('clients').select('*').eq('id', id).single();
  if (cErr){ console.error(cErr); return; }
  clientNameEl.textContent = client.name;
  clientMetaEl.textContent = `${client.products || ''} — ${client.addresses || ''}`;

  const { data: delivs, error: dErr } = await supabase.from('deliverables').select('id,due_date,qty_due').eq('client_fk', id).order('due_date', {ascending: true});
  if (dErr){ console.error(dErr); return; }

  deliverablesBody.innerHTML = '';
  const labels = [], values = [];
  for (const d of delivs){
    const { data: prog, error: pErr } = await supabase.from('deliverable_progress').select('remaining_to_due').eq('deliverable_id', d.id).single();
    if (pErr){ console.error(pErr); continue; }
    const remaining = prog?.remaining_to_due ?? d.qty_due;
    const status = simpleStatus(remaining, d.due_date);
    labels.push(d.due_date);
    values.push(remaining);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="text-sm">${d.due_date}</td><td class="text-sm">${fmt(d.qty_due)}</td><td class="text-sm">${fmt(d.qty_due - remaining)}</td><td class="text-sm">${fmt(remaining)}</td><td class="text-sm"><status-badge status="${status}"></status-badge></td><td class="text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log="${d.id}">Log completion</button></td>`;
    deliverablesBody.appendChild(tr);
  }

  const ctx = document.getElementById('clientDueChart')?.getContext('2d');
  if (ctx && window.Chart){
    if (clientDueChart) clientDueChart.destroy();
    clientDueChart = new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Remaining', data: values }] }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
  }

  deliverablesBody.addEventListener('click', async (e)=>{
    const btn = e.target.closest('button[data-log]');
    if (!btn) return;
    const deliverableId = btn.getAttribute('data-log');
    const qty = Number(prompt('Qty completed?')); if (!qty || qty <= 0) return;
    const note = prompt('Optional note?') || null;
    const occurred = new Date().toISOString().slice(0,10);
    const { error } = await supabase.from('completions').insert({ deliverable_fk: deliverableId, occurred_on: occurred, qty_completed: qty, note });
    if (error){ alert('Failed to log completion.'); console.error(error); return; }
    alert('Logged! Refreshing…'); location.reload();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  loadClientsList();
  loadClientDetail();
});

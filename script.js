// script.js — live progress view by default
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
function statusColors(s, a = 0.72){
  const map = {
    green:  { r: 34,  g:197, b: 94,  stroke: '#16a34a' },
    yellow: { r:234,  g:179, b:  8,  stroke: '#d97706' },
    red:    { r:239,  g: 68, b: 68,  stroke: '#b91c1c' },
  };
  const k = map[s] || map.green;
  return {
    fill:  `rgba(${k.r}, ${k.g}, ${k.b}, ${a})`,
    hover: `rgba(${k.r}, ${k.g}, ${k.b}, ${Math.min(1, a + 0.15)})`,
    stroke: k.stroke,
  };
}
/* Tight y-axis so bars look tall */
function yScaleFor(values, headroom = 0.06){
  const nums = (values || []).map(v => Number(v) || 0);
  const rawMax = Math.max(0, ...nums);
  if (!isFinite(rawMax) || rawMax <= 0) return { min: 0, max: 1, stepSize: 1 };
  const top = Math.ceil(rawMax * (1 + headroom));
  const rough = top / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const nice = Math.ceil(rough / pow) * pow;
  const step = Math.max(5, nice);
  const max = Math.ceil(top / step) * step;
  return { min: 0, max, stepSize: step };
}
function getThisFriday(){
  const d = new Date();
  const diff = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0,10);
}
function setCanvasHeight(id, px){
  const el = document.getElementById(id);
  if (el){ el.height = px; el.style.maxHeight = px + 'px'; }
}

/* =========================
   Percent labels for stacked bars
   ========================= */
const barPercentPlugin = {
  id: 'barPercent',
  afterDatasetsDraw(chart) {
    if (!chart?.data?.labels?.length) return;
    const { ctx } = chart;
    const metaCompleted = chart.getDatasetMeta(0); // Completed
    const metaRemaining = chart.getDatasetMeta(1); // Remaining
    if (!metaCompleted || !metaRemaining) return;

    const dsCompleted = chart.data.datasets[0].data;
    const dsRemaining = chart.data.datasets[1].data;

    chart.data.labels.forEach((_, i) => {
      const done = Number(dsCompleted[i] || 0);
      const rem  = Number(dsRemaining[i] || 0);
      const total = done + rem;
      if (!total) return;
      const pct = Math.round((done / total) * 100);

      // Only show when informative
      if (pct === 0 || pct === 100) return;

      const topEl = metaRemaining.data[i] || metaCompleted.data[i];
      if (!topEl) return;

      const x = topEl.x;
      const y = (metaRemaining.data[i]?.y ?? metaCompleted.data[i]?.y) - 8;

      ctx.save();
      ctx.fillStyle = 'rgba(17, 24, 39, 0.85)'; // gray-900 @ 85%
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${pct}%`, x, y);
      ctx.restore();
    });
  }
};

/* =========================
   Global filters
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
const dueSoonTbody =
  document.querySelector('#due-soon-body') ||
  document.querySelector('#upcomingBody') ||
  document.querySelector('[data-role="due-soon-body"]');
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
    if (!supabase) { alert('Supabase not configured (env.js + CORS).'); return; }
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
        contract_executed: String(r.contract_executed||'').toLowerCase()==='true',
        contract_date: r.contract_date ? new Date(r.contract_date).toISOString().slice(0,10) : null,
        total_lives: r.total_lives ? Number(r.total_lives) : null,
        next_roster_pull: r.next_roster_pull ? new Date(r.next_roster_pull).toISOString().slice(0,10) : null
      });
    }
  }

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
  if (!kpiTotal) return;

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

  const { data: progress } = await supabase
    .from('deliverable_progress')
    .select('deliverable_id, client_fk, due_date, qty_due, remaining_to_due');

  const clientIds = [...new Set(progress.map(p => p.client_fk))];
  const { data: clients } = await supabase.from('clients')
    .select('id,name,contract_executed').in('id', clientIds);
  const idTo = Object.fromEntries(clients.map(c => [c.id, c]));

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

  // Due this Friday
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

  // Upcoming Due Dates (future only)
  if (dueSoonTbody){
    const idToName = Object.fromEntries(clients.map(c => [c.id, c.name]));
    dueSoonTbody.innerHTML = '';
    const todayISO = new Date().toISOString().slice(0,10);
    const upcoming = progressFiltered
      .filter(p => p.due_date >= todayISO)
      .sort((a,b)=> new Date(a.due_date) - new Date(b.due_date))
      .slice(0,10);
    if (!upcoming.length){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="6" class="py-4 text-sm text-gray-500">No upcoming due dates.</td>`;
      dueSoonTbody.appendChild(tr);
    } else {
      upcoming.forEach(p=>{
        const status = simpleStatus(p.remaining_to_due, p.due_date);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="py-2 pr-6 text-sm">
            <a class="text-indigo-600 hover:underline" href="./client-detail.html?id=${p.client_fk}">
              ${idToName[p.client_fk] || '—'}
            </a>
          </td>
          <td class="py-2 pr-6 text-sm">${p.due_date}</td>
          <td class="py-2 pr-6 text-sm">${fmt(p.qty_due)}</td>
          <td class="py-2 pr-6 text-sm">${fmt(p.qty_due - p.remaining_to_due)}</td>
          <td class="py-2 pr-6 text-sm"><status-badge status="${status}"></status-badge></td>
          <td class="py-2 pr-6 text-sm"><button class="px-2 py-1 rounded bg-gray-900 text-white text-xs" data-log="${p.deliverable_id}">Log</button></td>`;
        dueSoonTbody.appendChild(tr);
      });
      dueSoonTbody.onclick = async (e)=>{
        const supabase = await getSupabase();
        const btn = e.target.closest('button[data-log]');
        if (!btn || !supabase) return;
        const deliverableId = btn.getAttribute('data-log');
        const qty = Number(prompt('Qty completed?'));
        if (!qty || qty <= 0) return;
        const occurred = new Date().toISOString().slice(0,10);
        const { error } = await supabase.from('completions').insert({
          deliverable_fk: deliverableId, occurred_on: occurred, qty_completed: qty
        });
        if (error){ alert('Failed to log completion.'); console.error(error); return; }
        await loadDashboard();
      };
    }
  }

  // ===== Work by Client (Top 10) — Stacked progress by default =====
  // Build totals and remaining per client
  const aggTotal = {};
  const aggRemain = {};
  for (const p of progressFiltered) {
    aggTotal[p.client_fk]  = (aggTotal[p.client_fk]  || 0) + (p.qty_due || 0);
    aggRemain[p.client_fk] = (aggRemain[p.client_fk] || 0) + (p.remaining_to_due || 0);
  }

  // Worst status per client (colors for Remaining)
  const worstByClient = {};
  for (const p of progressFiltered) {
    const s = simpleStatus(p.remaining_to_due, p.due_date);
    const cur = worstByClient[p.client_fk] || 'green';
    worstByClient[p.client_fk] =
      (cur === 'red' || s === 'red') ? 'red'
      : (cur === 'yellow' || s === 'yellow') ? 'yellow' : 'green';
  }

  // Earliest due per client (for tooltip context)
  const earliestDueByClient = {};
  for (const p of progressFiltered) {
    const cur = earliestDueByClient[p.client_fk];
    if (!cur || p.due_date < cur) earliestDueByClient[p.client_fk] = p.due_date;
  }

  // Rank by remaining, top 10
  const ranked = Object.keys(aggTotal)
    .map(cid => [cid, aggTotal[cid], aggRemain[cid]])
    .sort((a,b) => (b[2] || 0) - (a[2] || 0))
    .slice(0, 10);

  // Parallel arrays for labels/data
  const labels    = ranked.map(([cid]) => (idTo[cid]?.name || '—'));
  const totals    = ranked.map(([, t]) => t || 0);
  const remains   = ranked.map(([, , r]) => r || 0);
  const completes = totals.map((t, i) => Math.max(0, t - remains[i]));
  const statuses  = ranked.map(([cid]) => worstByClient[cid] || 'green');

  const remFills   = statuses.map(s => statusColors(s).fill);
  const remHovers  = statuses.map(s => statusColors(s).hover);
  const remBorders = statuses.map(s => statusColors(s).stroke);

  // Completed styling (slightly more visible than before)
  const compFill   = 'rgba(107, 114, 128, 0.50)';  // gray-500 @ 50%
  const compHover  = 'rgba(107, 114, 128, 0.70)';
  const compBorder = '#6b7280';

  // Tooltip context: next due & pace
  const nextDue   = ranked.map(([cid]) => earliestDueByClient[cid] || null);
  const daysLeft  = nextDue.map(d => (d ? Math.max(0, daysUntil(d)) : null));
  const needPerDay = remains.map((rem, i) => {
    const d = daysLeft[i];
    return d != null && d > 0 ? Math.ceil(rem / d) : null;
  });

  const yCfg = yScaleFor(totals, 0.05); // stacked → axis should fit totals
  setCanvasHeight('byClientChart', 280);

  const ctx = document.getElementById('byClientChart')?.getContext('2d');
  if (ctx && window.Chart){
    if (byClientChart) byClientChart.destroy();
    byClientChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { // Completed
            label: 'Completed',
            data: completes,
            backgroundColor: compFill,
            hoverBackgroundColor: compHover,
            borderColor: compBorder,
            borderWidth: 1,
            borderRadius: 10,
            borderSkipped: false,
            maxBarThickness: 44,
            stack: 'totals',
          },
          { // Remaining (status colors)
            label: 'Remaining',
            data: remains,
            backgroundColor: remFills,
            hoverBackgroundColor: remHovers,
            borderColor: remBorders,
            borderWidth: 1.5,
            borderRadius: 10,
            borderSkipped: false,
            maxBarThickness: 44,
            stack: 'totals',
          }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 450, easing: 'easeOutCubic' },
        plugins: {
          legend: { display: true },
          tooltip: {
            padding: 12,
            displayColors: false,
            callbacks: {
              title: (items) => labels[items[0].dataIndex] ?? '',
              label: (ctx) => {
                const i = ctx.dataIndex;
                if (ctx.dataset.label === 'Completed') {
                  const pct = Math.round((completes[i] / Math.max(1, totals[i])) * 100);
                  return `Completed: ${fmt(completes[i])} (${pct}%)`;
                }
                if (ctx.dataset.label === 'Remaining') {
                  return `Remaining: ${fmt(remains[i])}`;
                }
                return '';
              },
              afterBody: (items) => {
                const i = items[0].dataIndex;
                const lines = [`Total due: ${fmt(totals[i])}`];
                if (nextDue[i]) {
                  lines.push(`Next due: ${nextDue[i]}`);
                  if (daysLeft[i] != null)  lines.push(`Days to next due: ${daysLeft[i]}`);
                  if (needPerDay[i] != null) lines.push(`Need/day to next due: ${fmt(needPerDay[i])}`);
                }
                return lines;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'category',
            offset: true,
            grid: { display: false },
            ticks: {
              autoSkip: false,
              maxRotation: 0, minRotation: 0,
              font: { size: 11 },
              callback: (val, idx) => {
                const label = labels[idx] ?? '';
                return label.length > 18 ? label.slice(0,16) + '…' : label;
              }
            },
            stacked: true,
          },
          y: {
            min: yCfg.min, max: yCfg.max,
            ticks: { stepSize: yCfg.stepSize },
            grid: { color: 'rgba(17,24,39,0.08)' },
            stacked: true,
          }
        }
      },
      plugins: [barPercentPlugin]
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

  let { data: clients } = await supabase.from('clients')
    .select('id,name,total_lives,next_roster_pull,contract_executed')
    .order('name');
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
  const labels = [];      // due dates
  const values = [];      // remaining
  const statuses = [];    // r/y/g for colors

  for (const d of (delivs || [])){
    const { data: prog } = await supabase.from('deliverable_progress')
      .select('remaining_to_due').eq('deliverable_id', d.id).single();
    const remaining = prog?.remaining_to_due ?? d.qty_due;
    const status = simpleStatus(remaining, d.due_date);

    labels.push(d.due_date);
    values.push(remaining);
    statuses.push(status);

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

  const fills   = statuses.map(s => statusColors(s).fill);
  const hovers  = statuses.map(s => statusColors(s).hover);
  const borders = statuses.map(s => statusColors(s).stroke);
  const yCfg = yScaleFor(values, 0.08);

  setCanvasHeight('clientDueChart', 220);
  const ctx = document.getElementById('clientDueChart')?.getContext('2d');
  if (ctx && window.Chart){
    if (clientDueChart) clientDueChart.destroy();
    clientDueChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,                         // dates here
        datasets: [{
          label: 'Remaining',
          data: values,                 // numbers here
          backgroundColor: fills,
          hoverBackgroundColor: hovers,
          borderColor: borders,
          borderWidth: 1.5,
          borderRadius: 10,
          borderSkipped: false,
          maxBarThickness: 40,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 450, easing: 'easeOutCubic' },
        plugins: { legend: { display: false },
          tooltip: { padding: 10, callbacks: { label: (c)=> `Remaining: ${fmt(c.parsed.y)}` } } },
        scales: {
          x: {
            type: 'category',
            offset: true,
            grid: { display: false },
            ticks: { autoSkip: false, maxRotation: 0, minRotation: 0, font: { size: 11 } }
          },
          y: {
            min: yCfg.min, max: yCfg.max,
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
  console.log('Deliverables script build: live-progress');
});

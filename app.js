// Simple helpers
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const fmtDate = (iso) => {
  try{ const d = new Date(iso); return d.toLocaleString(); }catch{ return iso||"" }
};

async function fetchJSON(url, opts){
  const res = await fetch(url, opts);
  const data = await res.json().catch(()=> null);
  if(!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// Badge by status
function statusClass(status){
  const s = String(status||'').toLowerCase();
  if(s.includes('deliver')) return 'ok';
  if(s.includes('cancel') || s.includes('return') || s.includes('exception')) return 'bad';
  if(s.includes('out for')) return 'warn';
  if(s.includes('ship') || s.includes('transit') || s.includes('pack')) return 'warn';
  return 'info';
}

let liveES = null;
let currentOrderId = null;
let livePoll = null; // polling fallback for external carriers

// Map state
let map = null;
let routing = null; // Leaflet Routing Machine control
const markers = { origin: null, dest: null, truck: null };
let followTruck = true; // controlled by Follow toggle
let keepCentered = false; // dedicated keep-centered mode
let truckAnim = null; // requestAnimationFrame id for smooth animation

function truckDivIcon(){
  const html = `<div class="truck-icon"><div class="truck-pin">🚚</div></div>`;
  try{
    return L.divIcon({ className: '', html, iconSize: [30,30], iconAnchor: [15,15] });
  }catch{ return undefined }
}

function initMap(){
  const mapEl = document.getElementById('map');
  if(!mapEl) return;
  try{
    map = L.map('map', { zoomControl: true, attributionControl: true });
    // Dark basemap to match royal dark theme
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(map);
    map.setView([20, 0], 2);
  }catch{}
}

function toLatLng(p){
  if(!p) return null;
  if(Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
  if(typeof p === 'object' && 'lat' in p && 'lng' in p) return [Number(p.lat), Number(p.lng)];
  return null;
}

function updateTruck(route){
  if(!map || !route) return;
  const cur = toLatLng(route.current);
  if(!cur) return;
  if(markers.truck){
    try{
      if(truckAnim){ try{ cancelAnimationFrame(truckAnim); }catch{} truckAnim = null; }
      const from = markers.truck.getLatLng();
      const to = { lat: Number(cur[0]), lng: Number(cur[1]) };
      const lerp = (a,b,t)=> a+(b-a)*t;
      const duration = 900; // ms
      const start = performance.now();
      const step = (ts)=>{
        const t = Math.min(1, (ts - start)/duration);
        const lat = lerp(from.lat, to.lat, t);
        const lng = lerp(from.lng, to.lng, t);
        try{ markers.truck.setLatLng([lat,lng]); }catch{}
        if(keepCentered){ try{ map.panTo([lat,lng], { animate: true }); }catch{} }
        if(t < 1){ truckAnim = requestAnimationFrame(step); }
        else {
          truckAnim = null;
          // If following but not centering, ensure final pos stays in view
          try{
            if(followTruck && !keepCentered && map && markers.truck){
              const ll = markers.truck.getLatLng();
              const bounds = map.getBounds();
              if(!bounds || !bounds.contains(ll)){
                map.panTo(ll, { animate: true });
              }
            }
          }catch{}
        }
      };
      truckAnim = requestAnimationFrame(step);
    }catch{}
  } else {
    const icon = truckDivIcon();
    const opts = { title: 'Current position' };
    if(icon) opts.icon = icon;
    markers.truck = L.marker(cur, opts).addTo(map);
    // If centering is enabled when marker is first added, center immediately
    try{ if(keepCentered) map.panTo(cur, { animate: true }); }catch{}
  }
  // Keep truck in view when following
  try{
    if(!keepCentered && followTruck && map && markers.truck){
      const ll = markers.truck.getLatLng();
      const bounds = map.getBounds();
      if(!bounds || !bounds.contains(ll)){
        map.panTo(ll, { animate: true });
      }
    }
  }catch{}
}

function updateMapRoute(route){
  if(!map || !route) return;
  const o = toLatLng(route.origin);
  const d = toLatLng(route.dest);
  if(!o || !d) return;

  if(markers.origin){ try{ map.removeLayer(markers.origin); }catch{} }
  if(markers.dest){ try{ map.removeLayer(markers.dest); }catch{} }
  markers.origin = L.marker(o, { title: 'Origin' }).addTo(map);
  markers.dest = L.marker(d, { title: 'Destination' }).addTo(map);

  // Remove previous routing control
  if(routing){ try{ map.removeControl(routing); }catch{} routing = null; }
  // Create accurate route via OSRM through Leaflet Routing Machine
  try{
    routing = L.Routing.control({
      waypoints: [ L.latLng(o[0], o[1]), L.latLng(d[0], d[1]) ],
      addWaypoints: false,
      draggableWaypoints: false,
      routeWhileDragging: false,
      show: false,
      fitSelectedRoutes: true,
      lineOptions: {
        styles: [{ color: '#d4af37', weight: 5, opacity: 0.95 }]
      }
    }).addTo(map);
    try{ routing.on('routesfound', ()=> recenterMap()); }catch{}
  }catch{
    // Fallback: fit to bounds if routing fails
    try{ map.fitBounds(L.latLngBounds([o,d]), { padding: [30,30] }); }catch{}
  }
}

function recenterMap(){
  if(!map) return;
  const pts = [];
  if(markers.origin) pts.push(markers.origin.getLatLng());
  if(markers.dest) pts.push(markers.dest.getLatLng());
  if(markers.truck) pts.push(markers.truck.getLatLng());
  if(pts.length){
    try{ map.fitBounds(L.latLngBounds(pts), { padding: [30,30], maxZoom: 12 }); }catch{}
  }else{
    map.setView([20,0], 2);
  }
}

async function renderAnalytics(){
  try{
    const data = await fetchJSON('/api/analytics');
    const kpis = $('#kpis');
    kpis.innerHTML = '';
    Object.entries(data.byStatus||{}).forEach(([k,v]) => {
      const pill = document.createElement('div');
      pill.className = 'kpi'; pill.textContent = `${k}: ${v}`;
      kpis.appendChild(pill);
    });
  }catch{}
}

function renderTimeline(timeline){
  const box = $('#timeline');
  box.innerHTML = '';
  (timeline||[]).forEach((t) => {
    const div = document.createElement('div');
    div.className = 'step' + (/(packed|ship|transit|deliver)/i.test(t.label) ? ' done' : '');
    div.innerHTML = `<span class="dot"></span><span class="label">${t.label}</span><span class="time">${fmtDate(t.ts)}</span>`;
    box.appendChild(div);
  });
}

function setProgress(p){
  const bar = $('#progress-bar');
  const pct = Math.max(0, Math.min(100, Number(p)||0));
  bar.style.width = pct + '%';
}

function setStatus(status){
  const badge = $('#status-badge');
  const cls = statusClass(status);
  badge.className = 'badge ' + cls;
  badge.textContent = status || '—';
}

function setRoute(route){
  const el = $('#route');
  if(route && route.origin && route.dest){
    const fmt = (p) => {
      if(route.originName && p===route.origin) return route.originName;
      if(route.destName && p===route.dest) return route.destName;
      const lat = p.lat ?? (Array.isArray(p)?p[0]:null);
      const lng = p.lng ?? (Array.isArray(p)?p[1]:null);
      if(lat!=null && lng!=null) return `${Number(lat).toFixed(3)}, ${Number(lng).toFixed(3)}`;
      return '—';
    };
    const from = route.originName || fmt(route.origin);
    const to = route.destName || fmt(route.dest);
    el.textContent = `${from} → ${to}`;
  } else {
    el.textContent = '—';
  }
  // Update map visuals
  try{ updateMapRoute(route); updateTruck(route); }catch{}
}

async function loadOrder(orderId){
  currentOrderId = orderId;
  try{
    // Prefer detailed order endpoint (includes timeline)
    const detail = await fetchJSON(`/api/orders/${encodeURIComponent(orderId)}`);
    setStatus(detail.status);
    setProgress(detail.progress);
    setRoute(detail.route);
    renderTimeline(detail.timeline);
    // ETA
    try{
      const eta = await fetchJSON(`/api/eta/${encodeURIComponent(orderId)}`);
      $('#eta').textContent = eta.etaISO ? new Date(eta.etaISO).toDateString() : '—';
      $('#eta-note').textContent = eta.note || '';
    }catch{ $('#eta').textContent = '—'; $('#eta-note').textContent = '' }
  }catch(err){
    // Fallback to simple track endpoint
    try{
      const t = await fetchJSON(`/api/track/${encodeURIComponent(orderId)}`);
      setStatus(t.status); setProgress(t.progress); setRoute(t.route);
      renderTimeline([]);
      $('#eta').textContent = '—'; $('#eta-note').textContent = '';
    }catch(e){
      // Final fallback: try carrier auto-detect or carrier:tracking
      try{
        const resp = await fetch('/api/track-any', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: orderId }) });
        const any = await resp.json().catch(()=>({}));
        if(resp.ok){
          setStatus(any.status); setProgress(any.progress); setRoute(any.route);
          renderTimeline([]);
          $('#eta').textContent = '—';
          // If free-mode links are provided, show quick open links
          if(Array.isArray(any.links) && any.links.length){
            const note = $('#eta-note');
            note.innerHTML = 'Open official tracking: ' + any.links.slice(0,6).map(l => {
              const a = document.createElement('a'); a.href = l.url; a.textContent = l.carrier; a.target = '_blank'; a.rel='noopener';
              return a.outerHTML;
            }).join(' · ');
          } else {
            $('#eta-note').textContent = any.note || '';
          }
        } else {
          setStatus('Not found'); setProgress(0); setRoute(null); renderTimeline([]);
          $('#eta').textContent = '—'; $('#eta-note').textContent = any && any.error ? any.error : '';
        }
      }catch{
        setStatus('Not found'); setProgress(0); setRoute(null); renderTimeline([]);
      }
    }
  }
}

function startLive(orderId){
  stopLive();
  try{
    followTruck = true;
    liveES = new EventSource(`/api/stream/${encodeURIComponent(orderId)}`);
    liveES.onmessage = (ev) => {
      try{
        const msg = JSON.parse(ev.data);
        if(!msg || msg.id !== currentOrderId) return;
        setStatus(msg.status); setProgress(msg.progress); setRoute(msg.route);
        // smooth truck update on live stream
        try{ updateTruck(msg.route); }catch{}
      }catch{}
    };
    liveES.onerror = () => {
      // SSE not available (likely external carrier) – fallback to polling /api/track-any
      try{ liveES.close(); }catch{}
      liveES = null;
      if(livePoll) clearInterval(livePoll);
      livePoll = setInterval(async ()=>{
        try{
          const any = await fetchJSON('/api/track-any', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: currentOrderId }) });
          if(any){ setStatus(any.status); setProgress(any.progress); setRoute(any.route); }
        }catch{}
      }, 15000);
    };
  }catch{}
}
function stopLive(){ if(liveES){ try{ liveES.close(); }catch{} liveES = null; } if(livePoll){ clearInterval(livePoll); livePoll = null; } followTruck = false; }

async function init(){
  // Map
  initMap();
  // Config flags
  try{
    const cfg = await fetchJSON('/api/config');
    const flagsEl = $('#cfg-flags');
    if(flagsEl){
      flagsEl.textContent = `AI:${cfg.ai?.enabled?'on':'off'} Carrier:${cfg.carrier?.enabled?'on':'off'} Map:${cfg.map?.mode}`;
    }
    // Toggle Gmail scan visibility
    const btnScan = $('#btn-scan-gmail');
    if(btnScan){
      if(!(cfg.email && cfg.email.gmailScan)){
        btnScan.style.display = 'none';
      }
    }
    const follow = $('#follow-toggle');
    if(follow){ follow.checked = true; follow.addEventListener('change', ()=>{ followTruck = !!follow.checked; if(followTruck) recenterMap(); }); }
    const center = $('#center-toggle');
    if(center){ center.checked = false; center.addEventListener('change', ()=>{ keepCentered = !!center.checked; if(keepCentered && markers.truck){ try{ const ll = markers.truck.getLatLng(); map.panTo(ll, { animate: true }); }catch{} } }); }
  }catch{}

  await renderAnalytics();

  // Forms
  $('#btn-open-help').addEventListener('click', ()=> $('#help-dialog').showModal());
  $('#track-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const id = ($('#track-input').value||'').trim();
    if(!id) return;
    await loadOrder(id);
    if($('#live-toggle').checked) startLive(id); else stopLive();
    recenterMap();
  });
  $('#live-toggle').addEventListener('change', ()=>{
    if(currentOrderId){ $('#live-toggle').checked ? startLive(currentOrderId) : stopLive(); }
  });

  // Demo buttons
  const demoIds = ['1001','1002','1003','1004','O_ID_3000034'];
  const btnRandom = $('#btn-random');
  if(btnRandom){
    btnRandom.addEventListener('click', async ()=>{
      const id = demoIds[Math.floor(Math.random()*demoIds.length)];
      $('#track-input').value = id;
      await loadOrder(id);
      if($('#live-toggle').checked) startLive(id); else stopLive();
      recenterMap();
    });
  }

  const btnAdvance = $('#btn-advance');
  if(btnAdvance){
    btnAdvance.addEventListener('click', async ()=>{
      if(!currentOrderId) return alert('Track an order first');
      try{
        await fetchJSON(`/api/admin/advance/${encodeURIComponent(currentOrderId)}`, { method:'POST' });
        await loadOrder(currentOrderId);
        recenterMap();
      }catch{ alert('Advance failed'); }
    });
  }

  const btnRecenter = $('#btn-recenter');
  if(btnRecenter){ btnRecenter.addEventListener('click', recenterMap); }

  // Keyboard shortcuts: F toggle follow, C toggle center, R recenter
  document.addEventListener('keydown', (e)=>{
    const k = (e.key||'').toLowerCase();
    if(k === 'f'){
      const follow = $('#follow-toggle');
      if(follow){ follow.checked = !follow.checked; follow.dispatchEvent(new Event('change')); }
    } else if(k === 'c'){
      const center = $('#center-toggle');
      if(center){ center.checked = !center.checked; center.dispatchEvent(new Event('change')); }
    } else if(k === 'r'){
      recenterMap();
    }
  });

  $('#email-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const email = ($('#email-input').value||'').trim();
    const list = $('#orders-list');
    if(!email) {
      list.innerHTML = '<li style="color: #f59e0b;">⚠️ Please enter an email address</li>';
      return;
    }
    list.innerHTML = '<li style="color: #94a3b8;">⏳ Loading orders...</li>';
    try{
      const data = await fetchJSON(`/api/orders?email=${encodeURIComponent(email)}`);
      list.innerHTML = '';
      if(!data.orders || data.orders.length === 0){
        list.innerHTML = '<li style="color: #94a3b8;">📭 No orders found for this email. Subscribe to an order first!</li>';
        return;
      }
      (data.orders||[]).forEach(o => {
        const li = document.createElement('li');
        li.textContent = `${o.id} · ${o.status}`;
        li.style.cursor = 'pointer';
        li.addEventListener('click', async ()=>{
          $('#track-input').value = o.id;
          await loadOrder(o.id);
          if($('#live-toggle').checked) startLive(o.id); else stopLive();
          recenterMap();
        });
        list.appendChild(li);
      });
    }catch(err){
      list.innerHTML = `<li style="color: #ef4444;">❌ Error: ${err.message || 'Failed to fetch orders'}</li>`;
    }
  });

  $('#sub-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const orderId = ($('#sub-order').value||'').trim();
    const email = ($('#sub-email').value||'').trim();
    const resultDiv = $('#sub-result');
    if(!orderId || !email) {
      resultDiv.textContent = '⚠️ Please enter both Order ID and Email';
      resultDiv.style.color = '#f59e0b';
      return;
    }
    resultDiv.textContent = '⏳ Subscribing...';
    resultDiv.style.color = '#94a3b8';
    try{
      const result = await fetchJSON('/api/subscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ orderId, email }) });
      if(result.emailSent){
        resultDiv.innerHTML = `✅ Subscribed! Confirmation email sent to <strong>${email}</strong>`;
        resultDiv.style.color = '#22c55e';
      } else {
        resultDiv.innerHTML = `✅ Subscribed to order <strong>${orderId}</strong><br><small>💡 Email not configured - subscriptions saved locally</small>`;
        resultDiv.style.color = '#d4af37';
      }
      // Clear form
      $('#sub-order').value = '';
      $('#sub-email').value = '';
      setTimeout(() => { resultDiv.textContent = ''; }, 8000);
    }catch(err){ 
      resultDiv.textContent = `❌ ${err.message || 'Subscription failed. Check order ID and try again.'}`;
      resultDiv.style.color = '#ef4444';
    }
  });

  // Return/Replace UI removed

  // Email import: parse pasted email
  const btnParseEmail = $('#btn-parse-email');
  if(btnParseEmail){
    btnParseEmail.addEventListener('click', async ()=>{
      const raw = ($('#mail-raw').value||'').trim();
      const out = $('#mail-result'); out.textContent = '';
      if(!raw){ out.textContent = 'Paste a shipping email first.'; return; }
      try{
        const resp = await fetch('/api/ingest-email', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ raw }) });
        const data = await resp.json().catch(()=> ({}));
        if(resp.ok){
          const sel = data.selected;
          if(sel && sel.tracking){ $('#track-input').value = sel.tracking; currentOrderId = sel.tracking; }
          setStatus(sel.status); setProgress(sel.progress); setRoute(sel.route);
          out.textContent = sel.carrier ? `Detected ${sel.carrier} · ${sel.tracking}` : 'Detected tracking';
          if($('#live-toggle').checked) startLive(currentOrderId); else stopLive();
          recenterMap();
        } else {
          const cands = (data && Array.isArray(data.candidates)) ? data.candidates : [];
          if(cands.length){
            out.innerHTML = 'Candidates: ' + cands.map(c=>{
              const code = c.code || c; return `<a href="#" data-code="${code}">${code}</a>`;
            }).join(' · ');
            out.querySelectorAll('a[data-code]').forEach(a => a.addEventListener('click', async (ev)=>{
              ev.preventDefault(); const code = a.getAttribute('data-code');
              $('#track-input').value = code; await loadOrder(code); if($('#live-toggle').checked) startLive(code); else stopLive(); recenterMap();
            }));
          } else {
            out.textContent = data && data.error ? data.error : 'No tracking found in email.';
          }
        }
      }catch{ out.textContent = 'Email parse failed.' }
    });
  }

  // Gmail scan (optional)
  const btnScanGmail = $('#btn-scan-gmail');
  if(btnScanGmail){
    btnScanGmail.addEventListener('click', async ()=>{
      const out = $('#mail-result'); out.textContent = 'Scanning…';
      try{
        const r = await fetchJSON('/api/gmail/scan');
        const sel = r.selected;
        if(sel && sel.tracking){ $('#track-input').value = sel.tracking; currentOrderId = sel.tracking; }
        setStatus(sel.status); setProgress(sel.progress); setRoute(sel.route);
        out.textContent = sel.carrier ? `Detected ${sel.carrier} · ${sel.tracking}` : 'Detected tracking from Gmail';
        if($('#live-toggle').checked) startLive(currentOrderId); else stopLive();
        recenterMap();
      }catch(err){ out.textContent = 'Gmail scan unavailable or no recent shipping emails.'; }
    });
  }
}

init();

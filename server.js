// Simple Express server to serve the Order Tracker and a demo tracking API
// Replace the demo /api/track handler with your real data source.

const path = require('path');
const fs = require('fs');
const express = require('express');
const https = require('https');
const cors = require('cors');
const querystring = require('querystring');
const nodemailer = require('nodemailer');

// Load environment variables from .env located in this folder, regardless of cwd
let dotenvLoaded = false;
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '.env') });
  dotenvLoaded = true;
} catch(_) {
  // Fallback: minimal .env parser if dotenv package isn't installed
  try{
    const envPath = path.join(__dirname, '.env');
    if(fs.existsSync(envPath)){
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for(const line of lines){
        const trimmed = line.trim();
        if(!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if(eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq+1).trim();
        if(key && !(key in process.env)) process.env[key] = val;
      }
    }
  }catch(e){ /* ignore */ }
}
const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Email transporter setup (nodemailer)
let emailTransporter = null;
const setupEmailTransporter = () => {
  try {
    const emailConfig = {};
    if (process.env.EMAIL_SERVICE) {
      // Using a service like 'gmail'
      emailConfig.service = process.env.EMAIL_SERVICE;
      emailConfig.auth = {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      };
    } else if (process.env.EMAIL_HOST) {
      // Using SMTP directly
      emailConfig.host = process.env.EMAIL_HOST;
      emailConfig.port = Number(process.env.EMAIL_PORT) || 587;
      emailConfig.secure = false; // true for 465, false for other ports
      emailConfig.auth = {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      };
    }
    
    if (emailConfig.auth && emailConfig.auth.user && emailConfig.auth.pass) {
      emailTransporter = nodemailer.createTransport(emailConfig);
      console.log('[Email] Transporter configured with user:', emailConfig.auth.user);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[Email] Failed to setup transporter:', err.message);
    return false;
  }
};

const sendEmailNotification = async (to, subject, html) => {
  if (!emailTransporter) {
    console.log('[Email] Transporter not configured, skipping email to:', to);
    return { success: false, reason: 'Email not configured' };
  }
  
  try {
    const mailOptions = {
      from: `"Order Tracker" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    };
    
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Email timeout after 10s')), 10000)
    );
    
    const info = await Promise.race([
      emailTransporter.sendMail(mailOptions),
      timeoutPromise
    ]);
    
    console.log('[Email] Sent to', to, 'MessageId:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[Email] Failed to send to', to, ':', err.message);
    return { success: false, reason: err.message };
  }
};

// Initialize email on startup
const emailEnabled = setupEmailTransporter();

// CORS for front-end dev servers and new UI origin
// Configure allowed origin via CORS_ORIGIN (default: '*')
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  credentials: false,
}));

app.use(express.json());

// Static/UI: allow serving a different UI build via FRONTEND_DIR
// FRONTEND_DIR can be an absolute or relative path (relative to this folder)
const resolvedFrontendDir = (() => {
  const dir = process.env.FRONTEND_DIR;
  if (!dir) return __dirname;
  const p = path.isAbsolute(dir) ? dir : path.join(__dirname, dir);
  try { return fs.statSync(p).isDirectory() ? p : __dirname; } catch { return __dirname; }
})();
const publicDir = resolvedFrontendDir;
app.use(express.static(publicDir));

// Backward-compat: if HTML references 'Pic.jpg' (uppercase P), serve the actual 'pic.jpg'
app.get('/Pic.jpg', (_req, res) => {
  res.sendFile(path.join(publicDir, 'pic.jpg'));
});

// Knowledge about the app so AI can answer questions about the webpage itself
const APP_KNOWLEDGE = [
  'This is an E‑Commerce Order Tracker single-page app.',
  'UI features:',
  '- Order input with status badge, progress bar, and a truck icon moving along the bar.',
  '- Live map (Leaflet + OpenStreetMap by default) showing a route and a truck marker. A Recenter button focuses on user or route.',
  '- Optional Google Maps mode via URL ?map=google if window.GMAPS_API_KEY is set.',
  '- Email import: paste your shipping email to auto-extract tracking numbers.',
  '- Optional Gmail scan if GOOGLE_CLIENT_ID/SECRET and GOOGLE_REFRESH_TOKEN are set.',
  '- Floating chat widget for questions and tracking help.',
  'Tracking sources:',
  '- Backend demo endpoint GET /api/track?orderId=ID (demo orders 1001–1004, O_ID_3000034).',
  '- Optional carrier proxy GET /api/track-carrier?carrier=slug&tracking=number (requires AFTERSHIP_API_KEY).',
  'Chat endpoints:',
  '- POST /api/chat (now AI-first when OPENAI_API_KEY is set) returns { reply, data? } where data mirrors tracking schema.',
  '- POST /api/chat-ai (direct AI Q&A).',
  'Usage tips:',
  '- To track a known order, type: track 1002. For carrier: ekart:TRACK_ID.',
  '- Recenter button recenters the map to user or route.',
  '- Google Maps can be enabled with ?map=google if an API key is available.',
].join('\n');

// Status mapping to progress
const statusMeta = {
  Processing: 25,
  Packed: 35,
  Shipped: 50,
  'In Transit': 70,
  'Out for Delivery': 85,
  Delivered: 100,
  Canceled: 0,
  Returned: 0,
};

// Demo data for a few orders — replace with DB or external API lookups
const demoOrders = {
  '1001': { status: 'Processing', origin: [28.6139, 77.209], dest: [19.076, 72.8777], originName: 'Delhi', destName: 'Mumbai' },
  '1002': { status: 'Shipped', origin: [12.9716, 77.5946], dest: [13.0827, 80.2707], originName: 'Bengaluru', destName: 'Chennai' },
  '1003': { status: 'Out for Delivery', origin: [22.5726, 88.3639], dest: [22.5726, 88.3639], originName: 'Kolkata', destName: 'Kolkata' },
  '1004': { status: 'Delivered', origin: [17.385, 78.4867], dest: [17.385, 78.4867], originName: 'Hyderabad', destName: 'Hyderabad' },
  'O_ID_3000034': { status: 'Shipped', origin: [28.6139, 77.209], dest: [26.9124, 75.7873], originName: 'Delhi', destName: 'Jaipur' },
};

// Demo customers mapping to orders for history
const demoCustomers = {
  'alice@example.com': ['1002', '1004'],
  'bob@example.com': ['1001'],
  'cara@example.com': ['1003', 'O_ID_3000034'],
};

// Helper to build a coarse polyline between origin and dest
function buildPolyline(origin, dest) {
  if (!Array.isArray(origin) || !Array.isArray(dest)) return null;
  const [olat, olng] = origin;
  const [dlat, dlng] = dest;
  // 3-point poly with a midpoint bowed slightly
  const mid = [(olat + dlat) / 2 + 0.5, (olng + dlng) / 2];
  return [origin, mid, dest];
}

// API: GET /api/track?orderId=...
// Response schema:
// { status: string, progress: number (0-100), origin?: [lat,lng], dest?: [lat,lng], polyline?: Array<[lat,lng]> }
// Normalized helpers
function normalizeOrderId(input){
  if (!input) return '';
  return String(input).trim();
}

function buildUnifiedResponse(rec){
  if(!rec) return null;
  const progress = statusMeta[rec.status] ?? 40;
  const polyline = buildPolyline(rec.origin, rec.dest);
  // Synthetic current position along the route based on progress
  let current = undefined;
  try{
    if(Array.isArray(rec.origin) && Array.isArray(rec.dest)){
      const [olat, olng] = rec.origin; const [dlat, dlng] = rec.dest;
      const r = Math.max(0, Math.min(1, (progress||0)/100));
      current = { lat: olat + (dlat-olat)*r, lng: olng + (dlng-olng)*r };
    }
  }catch{}
  return {
    // Back-compat fields
    status: rec.status,
    progress,
    origin: rec.origin,
    dest: rec.dest,
    polyline,
    // New grouped route payload for the redesigned UI
    route: {
      origin: rec.origin ? { lat: rec.origin[0], lng: rec.origin[1] } : undefined,
      dest: rec.dest ? { lat: rec.dest[0], lng: rec.dest[1] } : undefined,
      polyline: polyline || undefined,
      current,
      originName: rec.originName,
      destName: rec.destName,
    }
  };
}

// API: GET /api/track?orderId=... (also supports id, order_id)
app.get('/api/track', (req, res) => {
  const orderId = normalizeOrderId(req.query.orderId || req.query.id || req.query.order_id);
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  // Replace this lookup with your real source
  const rec = demoOrders[orderId];
  if (!rec) return res.status(404).json({ error: 'Order not found' });

  res.json(buildUnifiedResponse(rec));
});

// API: GET /api/track/:orderId (RESTful style)
app.get('/api/track/:orderId', (req, res) => {
  const orderId = normalizeOrderId(req.params.orderId);
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const rec = demoOrders[orderId];
  if (!rec) return res.status(404).json({ error: 'Order not found' });
  res.json(buildUnifiedResponse(rec));
});

// API: POST /api/track { orderId }
// Also accepts { id }, { order_id }, or { query: "track 1002" }
app.post('/api/track', (req, res) => {
  const body = req.body || {};
  let orderId = normalizeOrderId(body.orderId || body.id || body.order_id);
  if(!orderId && typeof body.query === 'string'){
    const token = body.query.match(/[A-Za-z]*\d[A-Za-z0-9_\-]*/);
    if(token) orderId = token[0];
  }
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const rec = demoOrders[orderId];
  if (!rec) return res.status(404).json({ error: 'Order not found' });
  res.json(buildUnifiedResponse(rec));
});

// Map AfterShip tags to a friendly status and progress
function mapAfterShipTag(tag){
  const t = (tag || '').toString().toLowerCase();
  if(['pending','info_received'].includes(t)) return { status: 'Processing', progress: 15 };
  if(['intransit','in_transit'].includes(t)) return { status: 'In Transit', progress: 70 };
  if(['outfordelivery','out_for_delivery'].includes(t)) return { status: 'Out for Delivery', progress: 85 };
  if(['delivered'].includes(t)) return { status: 'Delivered', progress: 100 };
  if(['exception','failed_attempt'].includes(t)) return { status: 'Exception', progress: 50 };
  if(['expired','canceled'].includes(t)) return { status: 'Canceled', progress: 0 };
  return { status: 'Shipped', progress: 50 };
}

// --- Geocoding helper (Nominatim) with simple file cache ---
const geocodeCacheFile = path.join(__dirname, 'geocode-cache.json');
function loadGeoCache(){ try{ return JSON.parse(fs.readFileSync(geocodeCacheFile,'utf8')); }catch{ return {}; } }
function saveGeoCache(c){ try{ fs.writeFileSync(geocodeCacheFile, JSON.stringify(c, null, 2)); }catch{} }
async function geocodePlace(query){
  if(!query) return null;
  const key = String(query).trim().toLowerCase();
  const cache = loadGeoCache();
  if(cache[key]) return cache[key];
  return await new Promise((resolve) => {
    const url = `/search?${querystring.stringify({ q: query, format: 'json', limit: 1 })}`;
    const opt = { hostname: 'nominatim.openstreetmap.org', path: url, method: 'GET', headers: { 'User-Agent': 'order-tracker-demo/1.0' } };
    const reqH = https.request(opt, (resp) => {
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => {
        try{
          const arr = JSON.parse(data);
          const hit = Array.isArray(arr) && arr[0] ? { lat: Number(arr[0].lat), lng: Number(arr[0].lon) } : null;
          cache[key] = hit; saveGeoCache(cache); resolve(hit);
        }catch{ resolve(null); }
      });
    });
    reqH.on('error', () => resolve(null));
    reqH.end();
  });
}

// GET /api/track-carrier?carrier=slug&tracking=number
// Uses AfterShip API if AFTERSHIP_API_KEY is set. Returns 501 if not configured.
app.get('/api/track-carrier', (req, res) => {
  const { carrier, tracking } = req.query;
  if(!carrier || !tracking){
    return res.status(400).json({ error: 'carrier and tracking are required' });
  }
  const apiKey = process.env.AFTERSHIP_API_KEY;
  if(!apiKey){
    return res.status(501).json({ error: 'Tracking provider not configured on server (set AFTERSHIP_API_KEY)' });
  }

  const options = {
    hostname: 'api.aftership.com',
    path: `/v4/trackings/${encodeURIComponent(carrier)}/${encodeURIComponent(tracking)}`,
    method: 'GET',
    headers: {
      'aftership-api-key': apiKey,
      'accept': 'application/json'
    }
  };

  const reqHttps = https.request(options, (resp) => {
    let data = '';
    resp.on('data', chunk => data += chunk);
    resp.on('end', () => {
      try{
        const json = JSON.parse(data);
        if(json.meta && json.meta.code && json.meta.code !== 200){
          return res.status(400).json({ error: json.meta.message || 'Tracking error' });
        }
        const tr = json.data && json.data.tracking ? json.data.tracking : null;
        if(!tr){ return res.status(404).json({ error: 'Tracking not found' }); }
        const tag = tr.tag || tr.subtag;
        const mapped = mapAfterShipTag(tag);
        // Build a lightweight response compatible with frontend
        const result = {
          status: mapped.status,
          progress: mapped.progress,
        };
        // AfterShip usually lacks coordinates; if checkpoints have lat/lng, include a polyline
        const cps = Array.isArray(tr.checkpoints) ? tr.checkpoints : [];
        const pts = cps
          .map(c => (c.latitude!=null && c.longitude!=null) ? [Number(c.latitude), Number(c.longitude)] : null)
          .filter(Boolean);
        if(pts.length >= 2){ result.polyline = pts; }
        return res.json(result);
      }catch(err){
        return res.status(500).json({ error: 'Failed to parse provider response' });
      }
    });
  });
  reqHttps.on('error', () => res.status(502).json({ error: 'Tracking provider request failed' }));
  reqHttps.end();
});

// Helper: build demo tracking response for an orderId
function getDemoTracking(orderId){
  const rec = demoOrders[orderId];
  if(!rec) return null;
  const progress = statusMeta[rec.status] ?? 40;
  const polyline = buildPolyline(rec.origin, rec.dest);
  return {
    status: rec.status,
    progress,
    origin: rec.origin,
    dest: rec.dest,
    polyline,
  };
}

// Helper: query AfterShip directly and map to our schema
function fetchAfterShipTracking(carrier, tracking, apiKey){
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.aftership.com',
      path: `/v4/trackings/${encodeURIComponent(carrier)}/${encodeURIComponent(tracking)}`,
      method: 'GET',
      headers: { 'aftership-api-key': apiKey, 'accept': 'application/json' }
    };
    const reqHttps = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try{
          const json = JSON.parse(data);
          if(json.meta && json.meta.code && json.meta.code !== 200){
            return reject(new Error(json.meta.message || 'Tracking error'));
          }
          const tr = json.data && json.data.tracking ? json.data.tracking : null;
          if(!tr) return reject(new Error('Tracking not found'));
          const tag = tr.tag || tr.subtag;
          const mapped = mapAfterShipTag(tag);
          const result = { status: mapped.status, progress: mapped.progress };
          const cps = Array.isArray(tr.checkpoints) ? tr.checkpoints : [];
          // Prefer explicit lat/lng from checkpoints
          let pts = cps
            .map(c => (c.latitude!=null && c.longitude!=null) ? [Number(c.latitude), Number(c.longitude)] : null)
            .filter(Boolean);
          // If none, try geocoding first/last locations
          (async () => {
            try{
              if(pts.length < 2 && cps.length){
                const first = cps[0];
                const last = cps[cps.length-1];
                const mkQuery = (c) => (c.location || [c.city, c.state, c.country_iso3 || c.country_iso2].filter(Boolean).join(', ')).trim();
                const q1 = mkQuery(first);
                const q2 = mkQuery(last);
                const g1 = await geocodePlace(q1);
                const g2 = await geocodePlace(q2);
                if(g1 && g2){ pts = [[g1.lat,g1.lng],[g2.lat,g2.lng]]; }
                else if(g2){ pts = [[g2.lat,g2.lng]]; }
              }
            }catch{}
            if(pts && pts.length){ result.polyline = pts; }
            resolve(result);
          })();
        }catch(err){ reject(new Error('Failed to parse provider response')); }
      });
    });
    reqHttps.on('error', () => reject(new Error('Tracking provider request failed')));
    reqHttps.end();
  });
}

// Detect carriers for a tracking number using AfterShip
function afterShipDetectCarriers(trackingNumber, apiKey){
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ tracking: { tracking_number: String(trackingNumber) } });
    const options = {
      hostname: 'api.aftership.com',
      path: '/v4/couriers/detect',
      method: 'POST',
      headers: {
        'aftership-api-key': apiKey,
        'accept': 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    };
    const reqHttps = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try{
          const json = JSON.parse(data);
          if(json.meta && json.meta.code && json.meta.code !== 200){
            return reject(new Error(json.meta.message || 'Detect carriers failed'));
          }
          const list = json.data && Array.isArray(json.data.couriers) ? json.data.couriers : [];
          resolve(list.map(c => c.slug).filter(Boolean));
        }catch(err){ reject(new Error('Failed to parse detect response')); }
      });
    });
    reqHttps.on('error', () => reject(new Error('Detect carriers request failed')));
    reqHttps.write(payload);
    reqHttps.end();
  });
}

// Helper: unify an AfterShip tracking response to our unified shape
function unifyCarrierResult(carrierSlug, trackingNumber, data){
  const status = data.status || 'In Transit';
  const progress = typeof data.progress === 'number' ? data.progress : (statusMeta[status] ?? 50);
  const pts = Array.isArray(data.polyline) ? data.polyline : [];
  const origin = pts.length ? pts[0] : undefined;
  const dest = pts.length ? pts[pts.length-1] : undefined;
  const current = pts.length ? { lat: pts[pts.length-1][0], lng: pts[pts.length-1][1] } : undefined;
  return {
    status, progress,
    origin, dest, polyline: pts,
    route: {
      origin: origin ? { lat: origin[0], lng: origin[1] } : undefined,
      dest: dest ? { lat: dest[0], lng: dest[1] } : undefined,
      polyline: pts.length ? pts : undefined,
      current,
      carrier: carrierSlug,
      tracking: trackingNumber,
    }
  };
}

// POST /api/track-any { query }
// Accepts: demo order IDs, "carrier:tracking" format, or raw tracking numbers (auto-detects carriers)
app.post('/api/track-any', async (req, res) => {
  try{
    const raw = String((req.body && (req.body.query||req.body.q)) || '').trim();
    if(!raw) return res.status(400).json({ error: 'query required' });

    // 1) Demo order
    if(demoOrders[raw]){
      return res.json(buildUnifiedResponse(demoOrders[raw]));
    }

    const apiKey = process.env.AFTERSHIP_API_KEY;
    // Free-mode fallback: if no API key, provide official tracking links for common carriers
    if(!apiKey){
      const links = buildCarrierLinks(raw);
      if(links.length){
        return res.json({
          status: 'Open in carrier site',
          progress: 0,
          route: undefined,
          links,
          note: 'Provider API not configured; use an official tracking link below.'
        });
      }
      return res.status(404).json({ error: 'No provider configured and no known link format for this code' });
    }

    // 2) carrier:tracking pattern
    const colon = raw.indexOf(':');
    if(colon > 0){
      const carrier = raw.slice(0, colon).trim().toLowerCase();
      const tracking = raw.slice(colon+1).trim();
      if(!carrier || !tracking) return res.status(400).json({ error: 'Invalid carrier:tracking format' });
      try{
        const data = await fetchAfterShipTracking(carrier, tracking, apiKey);
        return res.json(unifyCarrierResult(carrier, tracking, data));
      }catch(err){ return res.status(404).json({ error: err.message || 'Carrier tracking failed' }); }
    }

    // 3) Try auto-detect carriers for this tracking number
    try{
      const slugs = await afterShipDetectCarriers(raw, apiKey);
      for(const slug of slugs){
        try{
          const data = await fetchAfterShipTracking(slug, raw, apiKey);
          return res.json(unifyCarrierResult(slug, raw, data));
        }catch{ /* try next */ }
      }
      return res.status(404).json({ error: 'No matching carrier found for this tracking number' });
    }catch(err){
      return res.status(400).json({ error: err.message || 'Carrier detect failed' });
    }
  }catch(err){
    return res.status(500).json({ error: 'track-any failed' });
  }
});

// Build a list of official tracking links for a code (best-effort, no API key needed)
function buildCarrierLinks(code){
  const c = String(code||'').trim();
  const links = [];
  const push = (carrier, url) => links.push({ carrier, url });
  // Amazon Logistics (TBA...)
  if(/^TBA[0-9A-Z]+$/i.test(c)){
    push('Amazon Logistics', `https://track.amazon.in/?trackingId=${encodeURIComponent(c)}`);
  }
  // UPS (1Z...)
  if(/^1Z[0-9A-Z]{16,18}$/i.test(c)){
    push('UPS', `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(c)}`);
  }
  // USPS (common ranges 20-22 digits)
  if(/^\d{20,22}$/.test(c)){
    push('USPS', `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(c)}`);
  }
  // FedEx (common 12/14/15/20/22 digits – heuristic)
  if(/^(\d{12}|\d{14}|\d{15}|\d{20}|\d{22})$/.test(c)){
    push('FedEx', `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(c)}`);
  }
  // DHL
  if(/^[0-9A-Z]{10,22}$/.test(c)){
    push('DHL', `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${encodeURIComponent(c)}`);
  }
  // India carriers (best-effort)
  push('Delhivery', `https://www.delhivery.com/track/package/${encodeURIComponent(c)}/`);
  push('Blue Dart', `https://www.bluedart.com/trackdartresult?trackFor=0&trackInput=${encodeURIComponent(c)}`);
  push('XpressBees', `https://www.xpressbees.com/track?awb=${encodeURIComponent(c)}`);
  push('DTDC', `https://www.dtdc.com/track/shipment-tracking.asp?cnNo=${encodeURIComponent(c)}`);
  push('Ecom Express', `https://ecomexpress.in/tracking/?awb_field=${encodeURIComponent(c)}`);
  // Ekart (Flipkart) – public page often requires form; provide homepage for manual entry
  push('Ekart (Flipkart)', `https://www.ekartlogistics.com/`);
  return links;
}

// Helper: call OpenAI Chat Completions API
function callOpenAIChat(messages, { model = process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature = 0.3 } = {}){
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if(!apiKey){ return reject(new Error('OPENAI_API_KEY not set')); }
    const payload = JSON.stringify({ model, temperature, messages });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: (() => {
        const h = {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        };
        if(process.env.OPENAI_ORG){ h['OpenAI-Organization'] = process.env.OPENAI_ORG; }
        if(process.env.OPENAI_ORGANIZATION){ h['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION; }
        if(process.env.OPENAI_PROJECT){ h['OpenAI-Project'] = process.env.OPENAI_PROJECT; }
        return h;
      })()
    };
    const reqHttps = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try{
          const json = JSON.parse(data);
          if(resp.statusCode < 200 || resp.statusCode >= 300){
            const msg = json?.error?.message || json?.message || `OpenAI error ${resp.statusCode}`;
            return reject(new Error(msg));
          }
          const text = json.choices?.[0]?.message?.content?.trim() || '';
          resolve(text);
        }catch(err){ reject(new Error('Failed to parse OpenAI response')); }
      });
    });
    reqHttps.on('error', (e) => reject(new Error('OpenAI request failed')));
    reqHttps.write(payload);
    reqHttps.end();
  });
}

// Health endpoint to verify AI connectivity and configuration
app.get('/api/ai-health', async (_req, res) => {
  try{
    if(!process.env.OPENAI_API_KEY){
      return res.status(200).json({ ok: false, reason: 'OPENAI_API_KEY not set' });
    }
    const reply = await callOpenAIChat([
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: 'Reply with just: ok' }
    ], { temperature: 0.0 });
    const ok = /^ok\b/i.test(reply || '');
    return res.json({ ok, reply, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });
  }catch(err){
    return res.status(200).json({ ok: false, error: err.message });
  }
});

// POST /api/chat-ai { message: string }
// General AI Q&A using OpenAI (set OPENAI_API_KEY and optionally OPENAI_MODEL)
app.post('/api/chat-ai', async (req, res) => {
  try{
    const msg = (req.body && req.body.message ? String(req.body.message) : '').trim();
    if(!msg){ return res.status(400).json({ error: 'message is required' }); }
    if(process.env.OPENAI_API_KEY){
      try{
        let data = null;
        const ctx = [];
        // Try carrier:tracking
        const colonIdx0 = msg.indexOf(':');
        if(colonIdx0 > 0){
          const carrier0 = msg.slice(0, colonIdx0).trim().toLowerCase();
          const tracking0 = msg.slice(colonIdx0+1).trim();
          if(carrier0 && tracking0 && process.env.AFTERSHIP_API_KEY){
            try{
              const tdata = await fetchAfterShipTracking(carrier0, tracking0, process.env.AFTERSHIP_API_KEY);
              data = tdata;
              ctx.push(`Carrier ${carrier0} ${tracking0}: ${tdata.status}${typeof tdata.progress==='number'?` (${tdata.progress}%)`:''}`);
            }catch(e){ ctx.push(`Carrier lookup failed: ${e.message}`); }
          }
        }
        // Try order id from demo
        const tokenAI = msg.match(/[A-Za-z]*\d[A-Za-z0-9_\-]*/g) || [];
        const orderIdAI = tokenAI[0];
        if(orderIdAI && demoOrders[orderIdAI]){
          const d = getDemoTracking(orderIdAI);
          data = d;
          ctx.push(`Order ${orderIdAI}: ${d.status}${typeof d.progress==='number'?` (${d.progress}%)`:''}`);
        }
        const system = [
          'You are a concise, helpful assistant for an e-commerce order tracking site.',
          'Always answer directly and helpfully. Use provided context when available.',
          'If the user reports an issue, provide 1-2 concrete next steps (returns/replacements/cancellation policy).',
          '',
          'About this webpage (for answering questions about the page itself):',
          APP_KNOWLEDGE
        ].join('\n');
        const user = `User: ${msg}` + (ctx.length ? `\nContext:\n- ${ctx.join('\n- ')}` : '');
        const reply = await callOpenAIChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]);
        console.log('[chat] route=ai-first');
        return res.json({ reply: reply || 'Okay.', data: data || undefined, meta: { route: 'ai-first' } });
      }catch(e){
        console.warn('[chat] ai-first failed, falling back to rule-based:', e.message);
        // Provide failure meta to help debug on the client
        return res.json({ reply: 'I had trouble contacting AI. You can still track orders by ID (e.g., 1002).', meta: { route: 'ai-first-failed', error: e.message } });
      }
    }

    // If the question references a known order id, include a brief context
    const digitTokens = msg.match(/[A-Za-z]*\d[A-Za-z0-9_\-]*/g) || [];
    const orderId = digitTokens[0];
    let orderContext = '';
    if(orderId && demoOrders[orderId]){
      const rec = demoOrders[orderId];
      orderContext = `\nKnown order in demo data: ${orderId} -> status: ${rec.status}.`;
    }

  const system = `You are a concise, helpful assistant for an e-commerce order tracking app.\n`
           + `Use short, clear answers. If asked about an order, use provided context first.\n`
           + `If unsure, say so and suggest how the user can proceed.\n\n`
           + `About this webpage (for answering questions about the page itself):\n${APP_KNOWLEDGE}`;
    const user = `User question: ${msg}${orderContext}`;

    const reply = await callOpenAIChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    return res.json({ reply });
  }catch(err){
    return res.status(500).json({ error: err.message || 'AI processing failed' });
  }
});

// POST /api/chat { message: string }
// Very simple rule-based assistant that can:
// - Answer help/FAQ
// - Extract order IDs or carrier:tracking and call tracking endpoints
app.post('/api/chat', async (req, res) => {
  try{
    const msg = (req.body && req.body.message ? String(req.body.message) : '').trim();
    if(!msg){ return res.status(400).json({ error: 'message is required' }); }

    const lower = msg.toLowerCase();
    console.log(`[chat] msg="${msg}"`);

    // AI-first: If AI is configured, answer every message via AI, enriched with tracking context
    if(process.env.OPENAI_API_KEY){
      try{
        let data = null; // structured tracking to update UI
        const ctx = [];
        // Try carrier:tracking
        const colonIdx0 = msg.indexOf(':');
        if(colonIdx0 > 0){
          const carrier0 = msg.slice(0, colonIdx0).trim().toLowerCase();
          const tracking0 = msg.slice(colonIdx0+1).trim();
          if(carrier0 && tracking0 && process.env.AFTERSHIP_API_KEY){
            try{
              const tdata = await fetchAfterShipTracking(carrier0, tracking0, process.env.AFTERSHIP_API_KEY);
              data = tdata;
              ctx.push(`Carrier ${carrier0} ${tracking0}: ${tdata.status}${typeof tdata.progress==='number'?` (${tdata.progress}%)`:''}`);
            }catch(e){ ctx.push(`Carrier lookup failed: ${e.message}`); }
          }
        }
        // Try order id from demo
        const tokenAI = msg.match(/[A-Za-z]*\d[A-Za-z0-9_\-]*/g) || [];
        const orderIdAI = tokenAI[0];
        if(orderIdAI && demoOrders[orderIdAI]){
          const d = getDemoTracking(orderIdAI);
          data = d;
          ctx.push(`Order ${orderIdAI}: ${d.status}${typeof d.progress==='number'?` (${d.progress}%)`:''}`);
        }
        const system = [
          'You are a concise, helpful assistant for an e-commerce order tracking site.',
          'Always answer directly and helpfully. Use provided context when available.',
          'If the user reports an issue, provide 1-2 concrete next steps (returns/replacements/cancellation policy).',
          '',
          'About this webpage (for answering questions about the page itself):',
          APP_KNOWLEDGE
        ].join('\n');
        const user = `User: ${msg}` + (ctx.length ? `\nContext:\n- ${ctx.join('\n- ')}` : '');
        const reply = await callOpenAIChat([
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]);
        console.log('[chat] route=ai-first');
        return res.json({ reply: reply || 'Okay.', data: data || undefined, meta: { route: 'ai-first' } });
      }catch(e){
        console.warn('[chat] ai-first failed, falling back to rule-based:', e.message);
        // continue to rule-based below
      }
    }
  // Basic support/issue intents (prioritize over generic help)
  const issueIntent = /(issue|problem|support|help|complain|complaint|damag|damage|broken|defect|faulty|wrong|missing|lost|late|delay|refund|return|replace|exchange|cancel|not\s*work|doesn['’]?t\s*work|cannot|can['’]?t|error|failed|fail|stuck)/i.test(lower);
    if(issueIntent){
      // Try to pull an order id and include status if known
      const digitTokens = msg.match(/[A-Za-z]*\d[A-Za-z0-9_\-]*/g) || [];
      const orderId = digitTokens[0];
      if(orderId && demoOrders[orderId]){
        const data = getDemoTracking(orderId);
        const status = data.status || 'In Transit';
        const reply = `I can help with your order ${orderId}. Current status: ${status}.\n`+
                      `- To refresh status, reply: track ${orderId}.\n`+
                      `- For returns/replacements, share what went wrong (e.g., 'return ${orderId} damaged item').\n`+
                      `- For cancellations, note shipping may limit this.`;
        console.log(`[chat] route=issue orderId=${orderId} status=${status}`);
        return res.json({ reply, data, meta: { route: 'issue', orderId } });
      }
      const reply = `I can help. Please share your Order ID (e.g., 1002).\n`+
                    `- To track, send: track <orderId>\n`+
                    `- For returns/replacements, describe the issue with the order ID.\n`+
                    `- For cancellations, note it may not be possible after shipping.`;
      console.log(`[chat] route=issue-noid`);
      return res.json({ reply, meta: { route: 'issue-noid' } });
    }

    // FAQs / common intents
    const faqs = [
      { pat: /(hello|hi|hey|namaste|good\s*(morning|afternoon|evening))/i, reply: 'Hi! I can track orders (e.g., 1002), help with returns, and answer basic questions. What can I do for you?' },
      { pat: /(thanks|thank\s*you|tysm|thx)/i, reply: "You're welcome. Happy to help!" },
      { pat: /(return|refund|replace|exchange).*policy|policy.*(return|refund|replace|exchange)|return\s*policy|refund\s*policy/i, reply: 'Returns/Refunds: Request within 7 days of delivery. Items must be unused with original packaging. Refunds issued after inspection. Some categories may be non-returnable.' },
      { pat: /(how\s*do\s*i|can\s*i).*cancel|cancel(lation)?\s*(policy|order)?/i, reply: 'Cancellation: Possible before shipping. If already shipped, wait for delivery or refuse at the door; otherwise request a return from Orders.' },
      { pat: /(when|how\s*long).*(deliver|arrival|arrive|shipping)|delivery\s*time|shipping\s*time|eta/i, reply: 'Delivery times: Standard 3–5 business days (metros) and 5–7 days (other regions). Check live status via your Order ID for a precise ETA.' },
      { pat: /(contact|reach|email|call).*support|customer\s*support/i, reply: 'Support: You can chat here. For escalations email support@example.com with your Order ID and issue summary.' },
      { pat: /(payment|cod|cash\s*on\s*delivery|upi|card)/i, reply: 'Payments: We accept UPI, cards, and Cash on Delivery in eligible areas. COD fees may apply.' },
    ];
  for(const f of faqs){ if(f.pat.test(lower)) { console.log('[chat] route=faq'); return res.json({ reply: f.reply, meta: { route: 'faq' } }); } }

    // Generic help (narrowed) after other intents
    const help = /^(help|what can you do\??|how (do|can) i\b|features\b)/i.test(lower);
    if(help){
      console.log('[chat] route=help');
      return res.json({
        reply: 'I can track orders by ID (e.g., 1002) or by carrier code like ekart:TRACK_ID. Try: "track 1002" or "ekart:FMPC123456".',
        meta: { route: 'help' }
      });
    }

    // Extract carrier:tracking
    const colonIdx = msg.indexOf(':');
    if(colonIdx > 0){
      const carrier = msg.slice(0, colonIdx).trim().toLowerCase();
      const tracking = msg.slice(colonIdx+1).trim();
      if(carrier && tracking){
        const apiKey = process.env.AFTERSHIP_API_KEY;
        if(!apiKey){
          console.log('[chat] route=carrier-unconfigured');
          return res.json({ reply: 'Carrier tracking is not configured on the server yet. Please track by Order ID (e.g., 1002), or ask your admin to set AFTERSHIP_API_KEY.', meta: { route: 'carrier-unconfigured' } });
        }
        try{
          const data = await fetchAfterShipTracking(carrier, tracking, apiKey);
          const status = data.status || 'In Transit';
          console.log(`[chat] route=carrier status=${status}`);
          return res.json({ reply: `Status: ${status}${typeof data.progress==='number'?` (${data.progress}%)`:''}.`, data, meta: { route: 'carrier' } });
        }catch(err){
          console.log('[chat] route=carrier-error', err.message);
          return res.json({ reply: err.message || 'Carrier tracking failed.', meta: { route: 'carrier-error' } });
        }
      }
    }

    // Extract a likely order id: prefer tokens containing digits (e.g., 1002 or O_ID_3000034)
    const stop = new Set(['track','tracking','order','status','where','is','for','my','please','the','and']);
    const digitTokens2 = msg.match(/[A-Za-z]*\d[A-Za-z0-9_\-]*/g) || [];
    const candidates = digitTokens2.filter(t => !stop.has(t.toLowerCase()));
    const orderId = candidates.length ? candidates[0] : null;
    if(orderId){
      const data = getDemoTracking(orderId);
      if(!data){
        console.log(`[chat] route=order-not-found orderId=${orderId}`);
        return res.json({ reply: `I couldn't find order ${orderId} in the demo data. Try one like 1002 or O_ID_3000034.`, meta: { route: 'order-not-found', orderId } });
      }
      const status = data.status || 'In Transit';
      // If the user message also contains complaint/support keywords, provide a contextual support reply
      const complaint = /(issue|problem|support|complain|complaint|damag|damage|broken|defect|faulty|wrong|missing|lost|late|delay|refund|return|replace|exchange|cancel|not\s*work|doesn['’]?t\s*work|cannot|can['’]?t|error|failed|fail|stuck)/i.test(lower);
      if(complaint){
        const reply = `I can help with your order ${orderId}. Current status: ${status}.\n`+
                      `- To refresh status, reply: track ${orderId}.\n`+
                      `- For returns/replacements, share what went wrong (e.g., 'return ${orderId} damaged item').\n`+
                      `- For cancellations, note shipping may limit this.`;
        console.log(`[chat] route=order-issue orderId=${orderId} status=${status}`);
        return res.json({ reply, data, meta: { route: 'order-issue', orderId } });
      }
      // Otherwise, send a concise status update
      console.log(`[chat] route=order-status orderId=${orderId} status=${status}`);
      return res.json({ reply: `Order ${orderId}: ${status}${typeof data.progress==='number'?` (${data.progress}%)`:''}.`, data, meta: { route: 'order-status', orderId } });
    }

    // No tracking intent matched. If AI is configured, answer generally.
  if(process.env.OPENAI_API_KEY){
      try{
        const system = [
          'You are a concise, helpful assistant for an e-commerce tracking site. Keep answers short.',
          '',
          'About this webpage (for answering questions about the page itself):',
          APP_KNOWLEDGE
        ].join('\n');
        const reply = await callOpenAIChat([
          { role: 'system', content: system },
          { role: 'user', content: msg }
        ]);
    console.log('[chat] route=ai');
    return res.json({ reply, meta: { route: 'ai' } });
      }catch(err){ /* fall through to default */ }
    }

  console.log('[chat] route=default');
  return res.json({ reply: "I'm here to help track orders. Send an Order ID like 1002, or a carrier code like ekart:TRACK_ID.", meta: { route: 'default' } });
  }catch(err){
  console.error('[chat] error', err);
  return res.status(500).json({ error: 'Chat processing failed' });
  }
});

// --- Email ingestion: extract tracking numbers from raw email text ---
function extractCandidatesFromText(text){
  if(!text) return [];
  const tokens = new Set();
  // Generic alphanumeric codes length 8-30
  const alnum = text.match(/[A-Z0-9][A-Z0-9\-]{7,29}/gi) || [];
  for(const t of alnum){ tokens.add(t.replace(/\s+/g,'').trim()); }
  // Long digit-only sequences (8-20)
  const digits = text.match(/\b\d{8,20}\b/g) || [];
  for(const t of digits){ tokens.add(t.trim()); }
  return Array.from(tokens).slice(0, 20);
}

app.post('/api/ingest-email', async (req, res) => {
  const raw = String((req.body && (req.body.raw || req.body.text || req.body.html)) || '').trim();
  if(!raw) return res.status(400).json({ error: 'raw email text required' });
  const apiKey = process.env.AFTERSHIP_API_KEY;
  const candidates = extractCandidatesFromText(raw);
  const results = [];
  for(const code of candidates){
    if(!apiKey) { results.push({ code, carriers: [], ok:false }); continue; }
    try{
      const slugs = await afterShipDetectCarriers(code, apiKey);
      results.push({ code, carriers: slugs, ok: slugs.length>0 });
      for(const slug of slugs){
        try{
          const data = await fetchAfterShipTracking(slug, code, apiKey);
          const unified = unifyCarrierResult(slug, code, data);
          return res.json({ candidates: results, selected: { ...unified, tracking: code, carrier: slug } });
        }catch{ /* try next slug */ }
      }
    }catch{ results.push({ code, error: 'detect failed' }); }
  }
  return res.status(404).json({ error: 'no tracking found in email', candidates: results });
});

// --- Gmail scan (optional) ---
async function getGoogleAccessToken(){
  const cid = process.env.GOOGLE_CLIENT_ID;
  const sec = process.env.GOOGLE_CLIENT_SECRET;
  const rt = process.env.GOOGLE_REFRESH_TOKEN;
  if(!cid || !sec || !rt) throw new Error('Gmail not configured');
  const postData = querystring.stringify({ client_id: cid, client_secret: sec, refresh_token: rt, grant_type: 'refresh_token' });
  return await new Promise((resolve, reject) => {
    const opt = { hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } };
    const reqH = https.request(opt, (resp) => { let data=''; resp.on('data', d=> data+=d); resp.on('end', ()=>{ try{ const j = JSON.parse(data); if(j.access_token) resolve(j.access_token); else reject(new Error('no access_token')); }catch(e){ reject(e); } }); });
    reqH.on('error', reject); reqH.write(postData); reqH.end();
  });
}

async function gmailListRecentIds(token){
  return await new Promise((resolve, reject) => {
    const q = encodeURIComponent('subject:(shipped OR shipping OR dispatched OR delivery) newer_than:14d');
    const opt = { hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages?q=${q}&maxResults=10`, method: 'GET', headers: { Authorization: `Bearer ${token}` } };
    const reqH = https.request(opt, (resp) => { let data=''; resp.on('data', d=> data+=d); resp.on('end', ()=>{ try{ const j = JSON.parse(data); resolve((j.messages||[]).map(m=>m.id)); }catch(e){ reject(e); } }); });
    reqH.on('error', reject); reqH.end();
  });
}

async function gmailGetMessageText(token, id){
  return await new Promise((resolve, reject) => {
    const opt = { hostname: 'gmail.googleapis.com', path: `/gmail/v1/users/me/messages/${id}?format=full`, method: 'GET', headers: { Authorization: `Bearer ${token}` } };
    const reqH = https.request(opt, (resp) => { let data=''; resp.on('data', d=> data+=d); resp.on('end', ()=>{ try{ const j = JSON.parse(data); const parts = j.payload && j.payload.parts ? j.payload.parts : [j.payload]; const decode = (b64)=> Buffer.from((b64||'').replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); let text=''; for(const p of parts||[]){ if(p.mimeType==='text/plain' && p.body && p.body.data){ text += decode(p.body.data)+'\n'; } if(p.mimeType==='text/html' && p.body && p.body.data){ text += decode(p.body.data).replace(/<[^>]+>/g,' ')+'\n'; } } resolve(text); }catch(e){ reject(e); } }); });
    reqH.on('error', reject); reqH.end();
  });
}

app.get('/api/gmail/scan', async (_req, res) => {
  try{
    const token = await getGoogleAccessToken();
    const ids = await gmailListRecentIds(token);
    const apiKey = process.env.AFTERSHIP_API_KEY;
    for(const id of ids){
      try{
        const text = await gmailGetMessageText(token, id);
        const cands = extractCandidatesFromText(text);
        for(const code of cands){
          const slugs = apiKey ? await afterShipDetectCarriers(code, apiKey) : [];
          for(const slug of slugs){
            try{
              const data = await fetchAfterShipTracking(slug, code, apiKey);
              const unified = unifyCarrierResult(slug, code, data);
              return res.json({ id, selected: { ...unified, tracking: code, carrier: slug }, candidates: cands });
            }catch{ /* try next */ }
          }
        }
      }catch{ /* next message */ }
    }
    return res.status(404).json({ error: 'No tracking found in recent emails' });
  }catch(err){
    return res.status(501).json({ error: err.message || 'Gmail not configured' });
  }
});

// Lightweight server config for the frontend to bootstrap capabilities
app.get('/api/config', (_req, res) => {
  const hasAI = !!process.env.OPENAI_API_KEY;
  const hasAfterShip = !!process.env.AFTERSHIP_API_KEY;
  const hasGmail = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
  res.json({
    ai: { enabled: hasAI, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' },
    carrier: { enabled: hasAfterShip },
    map: { mode: 'leaflet', googleMapsSupported: !!process.env.GMAPS_API_KEY },
    email: { pasteImport: true, gmailScan: hasGmail },
    features: {
      orders: true,
      eta: true,
      returns: true,
      subscribe: true,
      analytics: true,
      search: true,
      sse: true,
    },
    version: 'v2'
  });
});

// Orders history: GET /api/orders?email=alice@example.com
app.get('/api/orders', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if(!email) return res.status(400).json({ error: 'email required' });
  
  // Check subscriptions.json for user's subscribed orders
  let subscribedIds = [];
  try {
    const file = path.join(__dirname, 'subscriptions.json');
    const subs = JSON.parse(fs.readFileSync(file, 'utf-8'));
    subscribedIds = subs
      .filter(s => s.email.toLowerCase() === email)
      .map(s => s.orderId);
  } catch {}
  
  // Combine with demo customers if exists
  const demoIds = demoCustomers[email] || [];
  const allIds = [...new Set([...subscribedIds, ...demoIds])]; // unique order IDs
  
  const list = allIds.map(id => ({ id, ...(getDemoTracking(id) || { status: 'Unknown', progress: 0 }) }));
  res.json({ email, orders: list });
});

// Order details: GET /api/orders/:orderId
app.get('/api/orders/:orderId', (req, res) => {
  const id = String(req.params.orderId || '').trim();
  const rec = demoOrders[id];
  if(!rec) return res.status(404).json({ error: 'Order not found' });
  const unified = buildUnifiedResponse(rec);
  // Simple synthetic timeline
  const tl = [
    { label: 'Order Placed', ts: daysAgo(4) },
    { label: 'Packed', ts: daysAgo(3) },
    { label: 'Shipped', ts: daysAgo(2) },
    { label: unified.status, ts: daysAgo( unified.status==='Delivered' ? 0 : 1 ) },
  ];
  res.json({ id, ...unified, timeline: tl });
});

// ETA: GET /api/eta/:orderId
app.get('/api/eta/:orderId', (req, res) => {
  const id = String(req.params.orderId || '').trim();
  const rec = demoOrders[id];
  if(!rec) return res.status(404).json({ error: 'Order not found' });
  const eta = estimateETA(rec.status);
  res.json({ id, status: rec.status, etaISO: eta.toISOString(), etaDays: daysUntil(eta), note: etaNote(rec.status) });
});

// Returns: POST /api/returns { orderId, reason, type }
// type: 'return' | 'replace'
app.post('/api/returns', (req, res) => {
  const { orderId, reason, type } = req.body || {};
  const id = normalizeOrderId(orderId);
  if(!id) return res.status(400).json({ error: 'orderId required' });
  if(!demoOrders[id]) return res.status(404).json({ error: 'Order not found' });
  const t = (type||'return').toString().toLowerCase();
  if(!['return','replace'].includes(t)) return res.status(400).json({ error: 'type must be return or replace' });
  const rma = `RMA-${Date.now().toString(36).toUpperCase()}`;
  const policy = 'Items must be unused with original packaging within 7 days of delivery.';
  res.json({ rma, status: 'initiated', type: t, orderId: id, policy, reason: reason || '' });
});

// Subscribe for email notifications (demo): POST /api/subscribe { orderId, email }
app.post('/api/subscribe', async (req, res) => {
  console.log('[Subscribe] Received request:', req.body);
  try{
    const { orderId, email } = req.body || {};
    const id = normalizeOrderId(orderId);
    const em = String(email||'').trim().toLowerCase();
    console.log('[Subscribe] Normalized:', { id, em });
    if(!id || !em) return res.status(400).json({ error: 'orderId and email required' });
    if(!demoOrders[id]) return res.status(404).json({ error: 'Order not found' });
    
    // Save subscription
    const file = path.join(__dirname, 'subscriptions.json');
    let arr = [];
    try{ if(fs.existsSync(file)) arr = JSON.parse(fs.readFileSync(file, 'utf8')||'[]'); }catch{ arr = []; }
    arr.push({ orderId: id, email: em, ts: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    
    // Send confirmation email
    const order = demoOrders[id];
    const emailSubject = `Order ${id} - Subscription Confirmed`;
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
          .container { background: white; border-radius: 10px; padding: 30px; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #d4af37, #7c3aed); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
          .content { padding: 20px; }
          .status-badge { display: inline-block; padding: 8px 16px; border-radius: 20px; background: #7c3aed; color: white; font-weight: bold; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin:0;">🚚 Order Tracker</h1>
          </div>
          <div class="content">
            <h2>Subscription Confirmed!</h2>
            <p>Hi there,</p>
            <p>You've successfully subscribed to updates for order <strong>${id}</strong>.</p>
            <p>Current Status: <span class="status-badge">${order.status}</span></p>
            <p><strong>Route:</strong> ${order.originName || 'Origin'} → ${order.destName || 'Destination'}</p>
            <p>We'll send you an email whenever this order's status changes.</p>
            <p>You can track your order anytime at: <a href="http://localhost:${PORT}">Order Tracker</a></p>
          </div>
          <div class="footer">
            <p>This is an automated message from Order Tracker. Please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    const emailResult = await sendEmailNotification(em, emailSubject, emailHtml);
    console.log('[Subscribe] Email result:', emailResult);
    
    const response = { 
      ok: true, 
      emailSent: emailResult.success,
      message: emailResult.success ? 'Subscription confirmed! Check your email.' : 'Subscription saved but email could not be sent (email not configured).'
    };
    console.log('[Subscribe] Sending response:', response);
    res.json(response);
  }catch(err){ 
    console.error('[Subscribe] Error:', err);
    res.status(500).json({ error: 'Failed to save subscription' }); 
  }
});

// Analytics: GET /api/analytics
app.get('/api/analytics', (_req, res) => {
  const counts = Object.values(demoOrders).reduce((acc, o) => { acc[o.status] = (acc[o.status]||0)+1; return acc; }, {});
  const total = Object.keys(demoOrders).length;
  res.json({ total, byStatus: counts });
});

// Search: GET /api/search?status=Shipped&q=100
app.get('/api/search', (req, res) => {
  const statusQ = String(req.query.status||'').trim().toLowerCase();
  const q = String(req.query.q||'').trim().toLowerCase();
  const items = Object.entries(demoOrders).filter(([id, o]) => {
    const st = (o.status||'').toLowerCase();
    const matchStatus = statusQ ? st.includes(statusQ) : true;
    const matchQ = q ? id.toLowerCase().includes(q) : true;
    return matchStatus && matchQ;
  }).map(([id, _o]) => ({ id, ...(getDemoTracking(id)||{}) }));
  res.json({ results: items });
});

// Live updates via Server-Sent Events (SSE): GET /api/stream/:orderId
app.get('/api/stream/:orderId', (req, res) => {
  const id = String(req.params.orderId||'').trim();
  if(!id || !demoOrders[id]) return res.status(404).json({ error: 'Order not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = () => {
    const unified = buildUnifiedResponse(demoOrders[id]);
    res.write(`data: ${JSON.stringify({ id, ...unified })}\n\n`);
  };
  send();
  const timer = setInterval(() => send(), 10000);
  req.on('close', () => clearInterval(timer));
});

// Helper to notify subscribers when order status changes
const notifySubscribers = async (orderId, oldStatus, newStatus) => {
  try {
    const file = path.join(__dirname, 'subscriptions.json');
    if (!fs.existsSync(file)) return;
    
    const subscriptions = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    const orderSubs = subscriptions.filter(sub => sub.orderId === orderId);
    
    if (orderSubs.length === 0) return;
    
    const order = demoOrders[orderId];
    if (!order) return;
    
    console.log(`[Notify] Sending ${orderSubs.length} email(s) for order ${orderId} status change: ${oldStatus} → ${newStatus}`);
    
    for (const sub of orderSubs) {
      const emailSubject = `Order ${orderId} Update - ${newStatus}`;
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
            .container { background: white; border-radius: 10px; padding: 30px; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #d4af37, #7c3aed); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
            .content { padding: 20px; }
            .status-badge { display: inline-block; padding: 8px 16px; border-radius: 20px; background: #7c3aed; color: white; font-weight: bold; margin: 10px 0; }
            .status-old { background: #94a3b8; }
            .arrow { font-size: 20px; margin: 0 10px; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin:0;">🚚 Order Tracker</h1>
            </div>
            <div class="content">
              <h2>Order Status Updated!</h2>
              <p>Hi there,</p>
              <p>Great news! Your order <strong>${orderId}</strong> has been updated.</p>
              <div style="text-align: center; margin: 20px 0;">
                <span class="status-badge status-old">${oldStatus}</span>
                <span class="arrow">→</span>
                <span class="status-badge">${newStatus}</span>
              </div>
              <p><strong>Route:</strong> ${order.originName || 'Origin'} → ${order.destName || 'Destination'}</p>
              ${newStatus === 'Delivered' ? '<p style="color: #16a34a; font-weight: bold;">✓ Your order has been delivered!</p>' : ''}
              ${newStatus === 'Out for Delivery' ? '<p style="color: #f59e0b; font-weight: bold;">Your order is out for delivery today!</p>' : ''}
              <p>Track your order in real-time: <a href="http://localhost:${PORT}" style="color: #7c3aed; text-decoration: none; font-weight: bold;">Open Order Tracker</a></p>
            </div>
            <div class="footer">
              <p>This is an automated update from Order Tracker.</p>
              <p>You're receiving this because you subscribed to updates for order ${orderId}.</p>
            </div>
          </div>
        </body>
        </html>
      `;
      
      await sendEmailNotification(sub.email, emailSubject, emailHtml);
    }
  } catch (err) {
    console.error('[Notify] Error sending notifications:', err.message);
  }
};

// Dev helper: POST /api/admin/advance/:orderId to advance status (demo only)
app.post('/api/admin/advance/:orderId', async (req, res) => {
  const id = String(req.params.orderId||'').trim();
  const rec = demoOrders[id];
  if(!rec) return res.status(404).json({ error: 'Order not found' });
  
  const oldStatus = rec.status;
  const flow = ['Processing','Packed','Shipped','In Transit','Out for Delivery','Delivered'];
  const idx = Math.max(0, flow.indexOf(rec.status));
  if(idx < flow.length - 1){ 
    rec.status = flow[idx+1]; 
    
    // Notify subscribers about the status change
    await notifySubscribers(id, oldStatus, rec.status);
  }
  
  res.json({ id, ...getDemoTracking(id) });
});

// Helpers for ETA and timeline
function daysAgo(n){ const d = new Date(); d.setDate(d.getDate()-Number(n||0)); return d.toISOString(); }
function daysUntil(date){ const now = new Date(); const ms = new Date(date) - now; return Math.ceil(ms / 86400000); }
function estimateETA(status){
  const now = new Date();
  const add = (days) => { const d = new Date(now); d.setDate(d.getDate()+days); return d; };
  switch(status){
    case 'Processing': return add(5);
    case 'Packed': return add(4);
    case 'Shipped': return add(3);
    case 'In Transit': return add(2);
    case 'Out for Delivery': return add(0);
    case 'Delivered': return now;
    default: return add(3);
  }
}
function etaNote(status){
  switch(status){
    case 'Out for Delivery': return 'Arriving today';
    case 'In Transit': return 'On the way';
    case 'Shipped': return 'Left origin facility';
    case 'Packed': return 'Preparing for shipment';
    case 'Processing': return 'Order confirmed';
    case 'Delivered': return 'Delivered';
    default: return 'Tracking in progress';
  }
}


// Default route: serve sample.html
app.get('/', (_req, res) => {
  const idx = path.join(publicDir, 'index.html');
  const fallback = path.join(publicDir, 'sample.html');
  try{
    if(fs.existsSync(idx)) return res.sendFile(idx);
  }catch{}
  return res.sendFile(fallback);
});

// SPA fallback: if FRONTEND_DIR/index.html exists and SPA_FALLBACK is enabled
if (process.env.SPA_FALLBACK === '1'){
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)){
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(indexPath);
    });
  }
}

app.listen(PORT, '0.0.0.0', () => {
  const hasAI = !!process.env.OPENAI_API_KEY;
  const hasAfterShip = !!process.env.AFTERSHIP_API_KEY;
  console.log(`Order Tracker server running at http://0.0.0.0:${PORT}`);
  console.log(`[env] AI=${hasAI ? 'on' : 'off'} AfterShip=${hasAfterShip ? 'on' : 'off'} (.env: ${path.join(__dirname, '.env')})`);
});

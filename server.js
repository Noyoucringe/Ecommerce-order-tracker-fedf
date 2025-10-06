// Simple Express server to serve the Order Tracker and a demo tracking API
// Replace the demo /api/track handler with your real data source.

const path = require('path');
const fs = require('fs');
const express = require('express');
const https = require('https');
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
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files from this folder
const publicDir = __dirname;
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
  '1001': { status: 'Processing', origin: [28.6139, 77.209], dest: [19.076, 72.8777] }, // Delhi -> Mumbai
  '1002': { status: 'Shipped', origin: [12.9716, 77.5946], dest: [13.0827, 80.2707] }, // Bengaluru -> Chennai
  '1003': { status: 'Out for Delivery', origin: [22.5726, 88.3639], dest: [22.5726, 88.3639] }, // Kolkata city delivery
  '1004': { status: 'Delivered', origin: [17.385, 78.4867], dest: [17.385, 78.4867] }, // Hyderabad delivered
  'O_ID_3000034': { status: 'Shipped', origin: [28.6139, 77.209], dest: [26.9124, 75.7873] }, // Delhi -> Jaipur
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
app.get('/api/track', (req, res) => {
  const orderId = (req.query.orderId || '').toString();
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  // Replace this lookup with your real source
  const rec = demoOrders[orderId];
  if (!rec) return res.status(404).json({ error: 'Order not found' });

  const progress = statusMeta[rec.status] ?? 40;
  const polyline = buildPolyline(rec.origin, rec.dest);
  res.json({
    status: rec.status,
    progress,
    origin: rec.origin,
    dest: rec.dest,
    polyline,
  });
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
          const pts = cps
            .map(c => (c.latitude!=null && c.longitude!=null) ? [Number(c.latitude), Number(c.longitude)] : null)
            .filter(Boolean);
          if(pts.length >= 2){ result.polyline = pts; }
          resolve(result);
        }catch(err){ reject(new Error('Failed to parse provider response')); }
      });
    });
    reqHttps.on('error', () => reject(new Error('Tracking provider request failed')));
    reqHttps.end();
  });
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


// Default route: serve sample.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'sample.html'));
});

app.listen(PORT, () => {
  const hasAI = !!process.env.OPENAI_API_KEY;
  const hasAfterShip = !!process.env.AFTERSHIP_API_KEY;
  console.log(`Order Tracker server running at http://localhost:${PORT}`);
  console.log(`[env] AI=${hasAI ? 'on' : 'off'} AfterShip=${hasAfterShip ? 'on' : 'off'} (.env: ${path.join(__dirname, '.env')})`);
});

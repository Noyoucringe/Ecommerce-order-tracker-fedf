# Order Tracker (PBL)

Simple Express server that serves an order tracking demo page and APIs. Configure via `.env`.

## Quick start (Windows PowerShell)

1. Duplicate `.env.example` as `.env` and set:
    - OPENAI_API_KEY=sk-...
    - Optionally AFTERSHIP_API_KEY for live carrier tracking
    - Optionally set PORT (defaults to 3000; example uses 3001)
2. Install deps (once):
    - npm install
3. Start the server (from this folder):
    - node server.js
4. Open http://localhost:3001 and hard refresh (Ctrl+F5).
5. Open DevTools Console. When you chat, look for `meta.route`:
    - ai-first: replies are from AI
    - order-status / carrier: structured status

Tips:
- Try: `track 1002`, `ekart:FMPC123456`, `my order is damaged 1002`, or ask about the page: `what does the recenter button do?`.
- If replies feel generic, ensure OPENAI_API_KEY is set and the server was restarted.

## New features for richer UIs

- CORS enabled (configurable): set `CORS_ORIGIN` to your dev origin (default `*`).
- Flexible Tracking APIs (backward compatible):
   - `GET /api/track?orderId=ID` (also supports `id`, `order_id`)
   - `GET /api/track/:orderId`
   - `POST /api/track` with `{ orderId }` body
   - Response includes legacy fields plus `route: { origin, dest, polyline }` for map UIs.
- Config endpoint: `GET /api/config` describing server capabilities and flags.
- Orders history:
   - `GET /api/orders?email=<email>` returns demo orders for that email.
   - `GET /api/orders/:orderId` returns details with a simple timeline.
- ETA:
   - `GET /api/eta/:orderId` returns estimated delivery date and a note.
- Returns:
   - `POST /api/returns` with `{ orderId, reason, type: 'return'|'replace' }` returns an RMA id.
- Subscribe:
   - `POST /api/subscribe` with `{ orderId, email }` stores in `subscriptions.json` (demo).
- Analytics & Search:
   - `GET /api/analytics` returns counts by status.
   - `GET /api/search?status=...&q=...` filters demo orders.
- Live Updates (SSE):
   - `GET /api/stream/:orderId` emits periodic tracking snapshots.
   - Dev helper: `POST /api/admin/advance/:orderId` advances demo status.

## Serving a new frontend

- Set `FRONTEND_DIR` to a UI build folder to serve it statically.
- Set `SPA_FALLBACK=1` to route non-API requests to `index.html` (client-side routing).

## Env vars

See `.env.example` and copy to `.env`.

```env
# OpenAI for AI-first chatbot replies
OPENAI_API_KEY=...
# Optional: override model (defaults to gpt-4o-mini)
# OPENAI_MODEL=gpt-4o-mini

# AfterShip for live carrier tracking (ekart, bluedart, etc.)
AFTERSHIP_API_KEY=...

# Port (defaults to 3000; this project often uses 3001)
PORT=3001

# CORS origin for dev UI
# CORS_ORIGIN=http://localhost:5173

# Serve a different UI folder
# FRONTEND_DIR=dist
# SPA_FALLBACK=1
```

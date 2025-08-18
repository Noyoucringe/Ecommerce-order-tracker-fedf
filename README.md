# Order Tracker (Demo)

Quick start on Windows (PowerShell):

1. Duplicate `.env.example` as `.env` and set:
   - OPENAI_API_KEY=sk-...
   - Optionally AFTERSHIP_API_KEY for live carrier tracking
2. Start the server (from this folder):
   - node server.js
3. Open http://localhost:3000 and hard refresh (Ctrl+F5).
4. Open DevTools Console. When you chat, look for `meta.route`:
   - ai-first: replies are from AI
   - order-status / carrier: structured status

Tips:
- Try: `track 1002`, `ekart:FMPC123456`, `my order is damaged 1002`, or ask about the page: `what does the recenter button do?`.
- If replies feel generic, ensure OPENAI_API_KEY is set and the server was restarted.

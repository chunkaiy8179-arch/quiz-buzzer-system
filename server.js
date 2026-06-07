const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  phase: 'locked',          // 'locked' | 'open' | 'reviewing'
  buzzOrder: [],             // [{ team, ts, verified, result }]
  currentFocus: null,        // team string currently under review
};

function currentFocusTeam() {
  return state.buzzOrder.find(b => !b.verified) ?? null;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function broadcastState() {
  const focus = currentFocusTeam();
  broadcast({
    type: 'state',
    phase: state.phase,
    buzzOrder: state.buzzOrder,
    currentFocus: focus ? focus.team : null,
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Send current state to new connection
  const focus = currentFocusTeam();
  ws.send(JSON.stringify({
    type: 'state',
    phase: state.phase,
    buzzOrder: state.buzzOrder,
    currentFocus: focus ? focus.team : null,
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'host_open': {
        if (state.phase !== 'locked') return;
        state.phase = 'open';
        state.buzzOrder = [];
        state.currentFocus = null;
        broadcastState();
        break;
      }

      case 'host_reset': {
        state.phase = 'locked';
        state.buzzOrder = [];
        state.currentFocus = null;
        broadcastState();
        break;
      }

      case 'buzz': {
        if (state.phase !== 'open') return;
        const { team, ts } = msg;
        if (!team) return;
        // Ignore duplicate buzz from same team
        if (state.buzzOrder.find(b => b.team === team)) return;

        const isFirst = state.buzzOrder.length === 0;
        state.buzzOrder.push({ team, ts: ts || Date.now(), verified: false, result: null });
        // Keep sorted by timestamp
        state.buzzOrder.sort((a, b) => a.ts - b.ts);
        const rank = state.buzzOrder.findIndex(b => b.team === team) + 1;

        if (isFirst) {
          broadcast({ type: 'first_buzz', team, rank: 1 });
        } else {
          broadcast({ type: 'buzz_registered', team, rank });
        }
        broadcastState();
        break;
      }

      case 'host_verify': {
        const { team, result } = msg;
        if (!team || !result) return;
        const entry = state.buzzOrder.find(b => b.team === team);
        if (!entry) return;

        entry.verified = true;
        entry.result = result;
        state.phase = result === 'correct' ? 'locked' : 'reviewing';

        const next = currentFocusTeam();
        broadcast({
          type: 'verify_result',
          team,
          result,
          nextFocus: next ? next.team : null,
        });
        broadcastState();
        break;
      }
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quiz Buzzer System running at http://localhost:${PORT}`);
  console.log(`  學員端: http://localhost:${PORT}/client.html`);
  console.log(`  主持端: http://localhost:${PORT}/console.html`);
  console.log(`  投影端: http://localhost:${PORT}/display.html`);
});

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Security headers ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/client.html'));

// ── Host PIN ───────────────────────────────────────────────────────────────
const HOST_PIN = process.env.HOST_PIN || Math.random().toString(36).slice(2, 6).toUpperCase();

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  phase: 'locked',
  buzzOrder: [],
  currentFocus: null,
};

// 已加入的學員端：ws → 組別名稱（投影端/主持端不會 join，故不計入）
const sockets = new Map();

function joinedTeams() {
  const seen = new Set();
  const out = [];
  for (const name of sockets.values()) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

function currentFocusTeam() {
  return state.buzzOrder.find(b => !b.verified) ?? null;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function stateMsg() {
  const focus = currentFocusTeam();
  return {
    type: 'state',
    phase: state.phase,
    buzzOrder: state.buzzOrder,
    currentFocus: focus ? focus.team : null,
    joinedTeams: joinedTeams(),
  };
}

function broadcastState() {
  broadcast(stateMsg());
}

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(stateMsg()));

  ws.on('close', () => {
    if (sockets.has(ws)) {
      sockets.delete(ws);
      broadcastState();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const checkPin = () => {
      if (msg.pin !== HOST_PIN) {
        ws.send(JSON.stringify({ type: 'auth_error' }));
        return false;
      }
      return true;
    };

    switch (msg.type) {

      case 'join': {
        const { team } = msg;
        if (!team || typeof team !== 'string') return;
        const trimmed = team.trim();
        if (trimmed.length === 0 || trimmed.length > 30) return;
        sockets.set(ws, trimmed);
        broadcastState();
        break;
      }

      case 'host_open': {
        if (!checkPin()) return;
        if (state.phase !== 'locked') return;
        state.phase = 'open';
        state.buzzOrder = [];
        state.currentFocus = null;
        broadcastState();
        break;
      }

      case 'host_reset': {
        if (!checkPin()) return;
        state.phase = 'locked';
        state.buzzOrder = [];
        state.currentFocus = null;
        broadcastState();
        break;
      }

      case 'buzz': {
        if (state.phase !== 'open') return;
        const { team } = msg;
        if (!team || typeof team !== 'string') return;
        const trimmed = team.trim();
        if (trimmed.length === 0 || trimmed.length > 30) return;
        if (state.buzzOrder.find(b => b.team === trimmed)) return;

        const isFirst = state.buzzOrder.length === 0;
        // Always use server timestamp — client ts is ignored to prevent rank manipulation
        state.buzzOrder.push({ team: trimmed, ts: Date.now(), verified: false, result: null });
        state.buzzOrder.sort((a, b) => a.ts - b.ts);
        const rank = state.buzzOrder.findIndex(b => b.team === trimmed) + 1;

        if (isFirst) {
          broadcast({ type: 'first_buzz', team: trimmed, rank: 1 });
        } else {
          broadcast({ type: 'buzz_registered', team: trimmed, rank });
        }
        broadcastState();
        break;
      }

      case 'host_verify': {
        if (!checkPin()) return;
        const { team, result } = msg;
        if (!team || !['correct', 'wrong'].includes(result)) return;
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
  console.log(`  主持端 PIN: ${HOST_PIN}`);
});

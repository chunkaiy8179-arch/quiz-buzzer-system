const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

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
const COUNT_FROM = Number(process.env.COUNT_FROM) || 30; // 搶答視窗秒數（伺服器權威，倒數歸零即關閉搶答）
let state = {
  phase: 'locked',
  buzzOrder: [],
  currentFocus: null,
  deadline: null, // open 期間的關閉時間戳（epoch ms）
  closed: false,  // 倒數歸零 → 搶答視窗關閉（仍可顯示順位與判定）
};

let countdownTimer = null;
function clearCountdown() {
  if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
  state.deadline = null;
}

// 已加入的學員端：ws → 組別名稱（投影端/主持端不會 join，故不計入）
const sockets = new Map();

// 重連權杖：組別名稱 → token。F5/重連時 client 帶 token 回來，
// 伺服器認得同一人就「接管」該名稱（踢掉殘留的舊連線），不必等舊連線被代理清掉。
// Render 等反向代理偵測斷線常延遲約 10 秒，遠超過 client 重試預算，故需此機制。
const teamTokens = new Map();
function makeToken() { return crypto.randomUUID(); }

function joinedTeams() {
  const seen = new Set();
  const out = [];
  for (const name of sockets.values()) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

// 清理組別名稱（防 injection；渲染端另有 HTML 跳脫做第二層防護）：
// 移除控制字元與角括號，trim，並以「字元數」(非 UTF-16 單位) 限制 10 字內，支援中英文。
// 回傳 null 代表不合法。
const MAX_TEAM_LEN = 10;
function cleanTeam(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[\x00-\x1f\x7f<>]/g, '').trim();
  const chars = [...stripped];
  if (chars.length === 0 || chars.length > MAX_TEAM_LEN) return null;
  return chars.join('');
}

function nameInUse(name, exceptWs) {
  for (const [s, n] of sockets) { if (s !== exceptWs && n === name) return true; }
  return false;
}

function currentFocusTeam() {
  // 回合已結束（答對 → locked）時沒有待判 focus，避免剩餘組仍可被誤判而重開回合
  if (state.phase === 'locked') return null;
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
    closed: state.closed,
    // 以剩餘毫秒下發，避免投影端與伺服器時鐘差造成倒數不準
    remainingMs: (state.phase === 'open' && state.deadline)
      ? Math.max(0, state.deadline - Date.now()) : null,
    countFrom: COUNT_FROM,
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
        const name = cleanTeam(msg.team);
        if (!name) { ws.send(JSON.stringify({ type: 'join_error', reason: 'invalid' })); return; }
        const token = typeof msg.token === 'string' ? msg.token : null;
        const sameOwner = token && teamTokens.get(name) === token; // 帶對 token = 同一人重連

        if (nameInUse(name, ws)) {
          if (sameOwner) {
            // 同一人 F5/重連：踢掉仍占用此名稱的舊連線，由新連線接管
            for (const [s, n] of sockets) {
              if (s !== ws && n === name) {
                sockets.delete(s);
                try { s.send(JSON.stringify({ type: 'force_reselect' })); } catch {}
                try { s.close(); } catch {}
              }
            }
          } else {
            // 不同裝置撞同名 → 維持原本保護，拒絕
            ws.send(JSON.stringify({ type: 'join_error', reason: 'duplicate' }));
            return;
          }
        }

        // 接管沿用原 token；全新加入則發新 token
        const outToken = sameOwner ? token : makeToken();
        sockets.set(ws, name);
        teamTokens.set(name, outToken);
        ws.send(JSON.stringify({ type: 'join_ok', team: name, token: outToken }));
        broadcastState();
        break;
      }

      // 學員自行「換城鎮」：離開目前名稱但保持連線（主動離開 → 連 token 一併作廢）
      case 'leave': {
        if (sockets.has(ws)) {
          const name = sockets.get(ws);
          sockets.delete(ws);
          if (!nameInUse(name, ws)) teamTokens.delete(name);
          broadcastState();
        }
        break;
      }

      // 主持「清空所有連線」：清掉所有進場名單與回合，要求全部學員重新選城鎮
      case 'host_clear': {
        if (!checkPin()) return;
        clearCountdown();
        sockets.clear();
        teamTokens.clear();
        state.phase = 'locked';
        state.buzzOrder = [];
        state.currentFocus = null;
        state.closed = false;
        broadcast({ type: 'force_reselect' });
        broadcastState();
        break;
      }

      case 'host_open': {
        if (!checkPin()) return;
        if (state.phase !== 'locked') return;
        state.phase = 'open';
        state.buzzOrder = [];
        state.currentFocus = null;
        state.closed = false;
        // 伺服器權威倒數：到時即關閉搶答視窗（buzzOrder/順位仍保留供判定）
        clearCountdown();
        state.deadline = Date.now() + COUNT_FROM * 1000;
        countdownTimer = setTimeout(() => {
          countdownTimer = null;
          state.deadline = null;
          if (state.phase === 'open' && !state.closed) {
            state.closed = true;
            broadcast({ type: 'time_up' });
            broadcastState();
          }
        }, COUNT_FROM * 1000);
        broadcastState();
        break;
      }

      case 'host_reset': {
        if (!checkPin()) return;
        clearCountdown();
        state.phase = 'locked';
        state.buzzOrder = [];
        state.currentFocus = null;
        state.closed = false;
        broadcastState();
        break;
      }

      case 'buzz': {
        // 僅在 open 且未到時才接受；倒數歸零（closed）後拒絕，達成「歸零後不能拍燈」
        if (state.phase !== 'open' || state.closed) return;
        const team = cleanTeam(msg.team);
        if (!team) return;
        if (state.buzzOrder.find(b => b.team === team)) return;

        const isFirst = state.buzzOrder.length === 0;
        // Always use server timestamp — client ts is ignored to prevent rank manipulation
        state.buzzOrder.push({ team, ts: Date.now(), verified: false, result: null });
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
        if (!checkPin()) return;
        const { team, result } = msg;
        if (!team || !['correct', 'wrong'].includes(result)) return;
        const entry = state.buzzOrder.find(b => b.team === team);
        if (!entry) return;

        entry.verified = true;
        entry.result = result;
        state.phase = result === 'correct' ? 'locked' : 'reviewing';
        // 已進入判定階段，搶答視窗結束 → 停掉倒數，避免殘餘 timer 後續覆蓋狀態
        clearCountdown();
        state.closed = false;

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

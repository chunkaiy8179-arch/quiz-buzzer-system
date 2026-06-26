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
const COUNT_FROM = Number(process.env.COUNT_FROM) || 60; // 搶答視窗秒數（伺服器權威，倒數歸零即關閉搶答）
let state = {
  phase: 'locked',
  buzzOrder: [],
  currentFocus: null,
  deadline: null, // open 期間的關閉時間戳（epoch ms）
  closed: false,  // 倒數歸零 → 搶答視窗關閉（仍可顯示順位與判定）
  remainingMs: null, // 判錯續跑用：拍燈定格時保存的剩餘毫秒（reviewing 階段下發此定格值）
  eliminated: [],    // 本回合已答錯出局、不可再搶的組別名稱
};

// 分數獨立於 state：整場累計，host_reset 不歸零（僅 host_clear / host_score_reset 清）
let scores = {};
let threshold = Number(process.env.LIGHT_THRESHOLD) || 120; // 希望之燈點燈門檻（總分達標方可點燈）
let lit = false;            // 希望之燈是否已點亮
const SCORE_DELTA = 10;     // 每次答對加分

let countdownTimer = null;
function clearCountdown() {
  if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }
  state.deadline = null;
}

// 從指定剩餘毫秒重啟倒數：集中「設 deadline + 到時 time_up」邏輯，
// 供 host_open 開場與判錯後續跑共用。ms<=0 視同已歸零，直接關閉搶答視窗。
function startCountdownFrom(ms) {
  clearCountdown();
  if (ms <= 0) { state.closed = true; return; }
  state.deadline = Date.now() + ms;
  countdownTimer = setTimeout(() => {
    countdownTimer = null; state.deadline = null;
    if (state.phase === 'open' && !state.closed) {
      state.closed = true;
      broadcast({ type: 'time_up' });
      broadcastState();
    }
  }, ms);
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
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0); // 全場總分
  return {
    type: 'state',
    phase: state.phase,
    buzzOrder: state.buzzOrder,
    currentFocus: focus ? focus.team : null,
    joinedTeams: joinedTeams(),
    closed: state.closed,
    // 以剩餘毫秒下發，避免投影端與伺服器時鐘差造成倒數不準。
    // reviewing 時回傳拍燈當下定格的剩餘值；open 時維持 deadline - now。
    remainingMs: state.phase === 'reviewing'
      ? state.remainingMs
      : ((state.phase === 'open' && state.deadline) ? Math.max(0, state.deadline - Date.now()) : null),
    countFrom: COUNT_FROM,
    scores: scores,                       // 各組累計分數 {組名: 分數}
    eliminated: state.eliminated,         // 本回合出局組別
    threshold: threshold,                 // 點燈門檻
    totalScore: totalScore,               // 全場總分
    canIgnite: totalScore >= threshold,   // 總分是否達標、可點燈
    lit: lit,                             // 希望之燈是否已亮
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
        // 整場重來：分數歸零、熄燈、清出局與定格倒數
        scores = {};
        lit = false;
        state.eliminated = [];
        state.remainingMs = null;
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
        // 新回合：清出局與定格倒數（分數與燈狀態跨回合保留，不動）
        state.eliminated = [];
        state.remainingMs = null;
        // 伺服器權威倒數：到時即關閉搶答視窗（buzzOrder/順位仍保留供判定）
        startCountdownFrom(COUNT_FROM * 1000);
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
        // 結束回合：清出局與定格倒數（分數與燈狀態保留）
        state.eliminated = [];
        state.remainingMs = null;
        broadcastState();
        break;
      }

      case 'buzz': {
        const team = cleanTeam(msg.team);
        if (!team) return; // 名稱不合法，無法定位來源，不回 reject（client 也認不出）
        // 僅在 open 且未到時才接受；倒數歸零（closed）後拒絕，達成「歸零後不能拍燈」。
        // 競態：他人幾乎同時拍燈使 phase 進 reviewing 時，明確回 buzz_rejected，
        // 讓被拒端解除樂觀鎖（buzzed=true），避免續跑後該端孤兒卡死整回合。
        if (state.phase !== 'open' || state.closed) {
          ws.send(JSON.stringify({ type: 'buzz_rejected', team }));
          return;
        }
        // 自己已在 buzzOrder（已搶到）：正常情況，不回 reject（reject 會誤解鎖樂觀鎖）
        if (state.buzzOrder.find(b => b.team === team)) return;
        // 本回合已答錯出局者不可再搶：回 reject 讓 client 解鎖，後續靠 state.eliminated 正確顯示出局
        if (state.eliminated.includes(team)) {
          ws.send(JSON.stringify({ type: 'buzz_rejected', team }));
          return;
        }

        const isFirst = state.buzzOrder.length === 0;
        // Always use server timestamp — client ts is ignored to prevent rank manipulation
        state.buzzOrder.push({ team, ts: Date.now(), verified: false, result: null });
        state.buzzOrder.sort((a, b) => a.ts - b.ts);
        const rank = state.buzzOrder.findIndex(b => b.team === team) + 1;

        // 拍燈即定格：保存剩餘倒數、停表並進入判定，避免主持判定期間倒數繼續跑
        state.remainingMs = state.deadline ? Math.max(0, state.deadline - Date.now()) : 0;
        clearCountdown();
        state.phase = 'reviewing';

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
        if (!entry || entry.verified) return; // 防重複判定（達標廣播只計一次）

        entry.verified = true;
        entry.result = result;

        if (result === 'correct') {
          // 答對：加分、回合結束鎖定，清出局與定格倒數
          scores[team] = (scores[team] || 0) + SCORE_DELTA;
          state.phase = 'locked';
          state.eliminated = [];
          state.remainingMs = null;
          clearCountdown();
          state.closed = false;
        } else {
          // 答錯：該組本回合出局，從拍燈定格的剩餘倒數續跑，讓其他組搶答
          state.eliminated.push(team);
          const ms = state.remainingMs ?? 0;
          state.remainingMs = null;
          state.phase = 'open';
          state.closed = false;
          startCountdownFrom(ms); // ms<=0 時內部會把 closed 設回 true
        }

        const next = currentFocusTeam();
        broadcast({
          type: 'verify_result',
          team,
          result,
          nextFocus: next ? next.team : null,
          scores: scores,
        });
        broadcastState();
        break;
      }

      // 分數全清零（不影響進場名單與回合）
      case 'host_score_reset': {
        if (!checkPin()) return;
        scores = {};
        broadcastState();
        break;
      }

      // 手動微調某組分數（delta 可正可負，下限 clamp 至 0）
      case 'host_score_adjust': {
        if (!checkPin()) return;
        const team = cleanTeam(msg.team);
        const delta = Number(msg.delta);
        if (!team || !Number.isFinite(delta)) return;
        scores[team] = (scores[team] || 0) + delta;
        if (scores[team] < 0) scores[team] = 0;
        // 0 分不保留在 scores 物件，避免對從未得分的隊扣分後留下 0 分鬼項污染計分板/榜單
        if (scores[team] === 0) delete scores[team];
        broadcastState();
        break;
      }

      // 設定點燈門檻
      case 'host_set_threshold': {
        if (!checkPin()) return;
        const t = Number(msg.threshold);
        if (!Number.isFinite(t) || t < 0) return;
        threshold = Math.round(t);
        broadcastState();
        break;
      }

      // 點亮希望之燈：二次驗達標，防止前端搶跑
      case 'host_ignite': {
        if (!checkPin()) return;
        const total = Object.values(scores).reduce((a, b) => a + b, 0);
        if (total < threshold) return;
        lit = true;
        broadcast({ type: 'ignite' });
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

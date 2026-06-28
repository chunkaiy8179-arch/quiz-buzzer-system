const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

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
// 保活/健康檢查端點：供外部排程 ping（cron-job.org / UptimeRobot）在活動期間避免 Render 免費方案休眠
app.get('/healthz', (req, res) => res.json({ ok: true, up: process.uptime() }));

// ── Host PIN ───────────────────────────────────────────────────────────────
const HOST_PIN = process.env.HOST_PIN || Math.random().toString(36).slice(2, 6).toUpperCase();

// ── State ──────────────────────────────────────────────────────────────────
const COUNT_FROM = Number(process.env.COUNT_FROM) || 60; // 搶答視窗秒數（伺服器權威，倒數歸零即關閉搶答）
let state = {
  phase: 'locked',
  firstBuzzer: null, // 只追蹤「第一位」拍燈者：{team,ts,verified,result,points} | null
  currentFocus: null,
  deadline: null, // open 期間的關閉時間戳（epoch ms）
  closed: false,  // 倒數歸零 → 搶答視窗關閉（仍可顯示順位與判定）
  remainingMs: null, // 判錯續跑用：拍燈定格時保存的剩餘毫秒（reviewing 階段下發此定格值）
  eliminated: [],    // 本回合已答錯出局、不可再搶的組別名稱
  lastVerify: null,  // 最後一筆判定的快照，供 host_unverify 撤銷（開新回合即清）
};

// 分數獨立於 state：整場累計，host_reset 不歸零（僅 host_clear / host_score_reset 清）
let scores = {};
// 各組「達到當前分數」的時間戳（組名 → epoch ms），供投影端平手排序：
// 0 分組記加入時間、有分組記最後一次加分到該分的時間（撤銷視為當下變動）。
let scoreSince = {};
let threshold = Number(process.env.LIGHT_THRESHOLD) || 120; // 希望之燈點燈門檻（總分達標方可點燈）
let lit = false;            // 希望之燈是否已點亮
// 答錯鎖定模式：true=答錯出局不可再搶（現狀預設）；false=答錯不鎖、該組可再搶
let lockOnWrong = (process.env.LOCK_ON_WRONG ?? 'true') !== 'false';
const SCORE_DELTA = 10;     // 每次答對加分

// ── 狀態持久化（次要保險：救本機/同進程崩潰重啟；Render 免費方案休眠會清磁碟，主防線是外部保活 ping）──
const STATE_FILE = path.join(__dirname, 'state.json');
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && typeof saved === 'object') {
      if (saved.scores && typeof saved.scores === 'object') scores = saved.scores;
      if (saved.scoreSince && typeof saved.scoreSince === 'object') scoreSince = saved.scoreSince;
      if (Number.isFinite(saved.threshold)) threshold = saved.threshold;
      if (typeof saved.lit === 'boolean') lit = saved.lit;
      console.log('[load] restored persisted state from', STATE_FILE);
    }
  }
} catch (e) { console.log('[load] no valid persisted state:', e.message); }

let persistTimer = null;
function persist() {
  if (persistTimer) return; // 500ms 內合併多次寫入
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ scores, scoreSince, threshold, lit })); }
    catch (e) { /* 寫檔失敗不影響運行（如 Render 免費磁碟 ephemeral） */ }
  }, 500);
}

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
  return (state.firstBuzzer && !state.firstBuzzer.verified) ? state.firstBuzzer : null;
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
    buzzOrder: state.firstBuzzer ? [state.firstBuzzer] : [], // 對外維持 ≤1 筆陣列，前端不改存取方式
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
    scoreSince: scoreSince,               // 各組達到當前分數的時間戳 {組名: epoch ms}，投影端平手排序用
    eliminated: state.eliminated,         // 本回合出局組別
    threshold: threshold,                 // 點燈門檻
    totalScore: totalScore,               // 全場總分
    canIgnite: totalScore >= threshold,   // 總分是否達標、可點燈
    lit: lit,                             // 希望之燈是否已亮
    canUndo: !!state.lastVerify,          // 是否有可撤銷的最後一筆判定（無則主持端不顯示撤銷鈕）
    lockOnWrong: lockOnWrong,             // 答錯鎖定模式：true=出局不可再搶；false=不鎖可再搶
  };
}

function broadcastState() {
  broadcast(stateMsg());
  persist(); // 任何狀態廣播後持久化（debounce 500ms，頻繁呼叫無妨）
}

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(stateMsg()));

  ws.on('close', () => {
    const wasStudent = sockets.has(ws);
    if (wasStudent) {
      sockets.delete(ws);
      broadcastState();
    }
    console.log('[ws] close', wasStudent ? '(student)' : '(viewer/host)');
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

      // 主持/投影端進場握手：console 輸入 PIN 後先驗一次，驗過才放行進介面。
      // 此為第一道防線；後續所有 host_* 操作仍各自 checkPin 作第二道防線。
      case 'host_auth': {
        if (msg.pin !== HOST_PIN) { ws.send(JSON.stringify({ type: 'auth_error' })); return; }
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        break;
      }

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
        // 全新加入才記加入時間（0 分組以此作平手排序基準）；重連接管沿用舊值不重設
        if (scoreSince[name] === undefined) scoreSince[name] = Date.now();
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
        console.log('[clear] all connections + scores wiped by host');
        clearCountdown();
        sockets.clear();
        teamTokens.clear();
        state.phase = 'locked';
        state.firstBuzzer = null;
        state.currentFocus = null;
        state.closed = false;
        // 整場重來：分數歸零、熄燈、清出局與定格倒數
        scores = {};
        scoreSince = {}; // 整場重來：清掉所有達分時間戳
        lit = false;
        state.eliminated = [];
        state.remainingMs = null;
        state.lastVerify = null; // 開新局：上一回合的判定不可再撤
        broadcast({ type: 'force_reselect' });
        broadcastState();
        break;
      }

      case 'host_open': {
        if (!checkPin()) return;
        if (state.phase !== 'locked') return;
        state.phase = 'open';
        state.firstBuzzer = null;
        state.currentFocus = null;
        state.closed = false;
        // 新回合：清出局與定格倒數（分數與燈狀態跨回合保留，不動）
        state.eliminated = [];
        state.remainingMs = null;
        state.lastVerify = null; // 開新回合：上一回合的判定不可再撤
        // 伺服器權威倒數：到時即關閉搶答視窗（buzzOrder/順位仍保留供判定）
        startCountdownFrom(COUNT_FROM * 1000);
        broadcastState();
        break;
      }

      case 'host_reset': {
        if (!checkPin()) return;
        clearCountdown();
        state.phase = 'locked';
        state.firstBuzzer = null;
        state.currentFocus = null;
        state.closed = false;
        // 結束回合：清出局與定格倒數（分數與燈狀態保留）
        state.eliminated = [];
        state.remainingMs = null;
        state.lastVerify = null; // 結束回合：判定不可再撤
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
        // 同一人重複拍（已是當前待判的第一位）：正常情況，不回 reject（reject 會誤解鎖樂觀鎖）
        if (state.firstBuzzer && state.firstBuzzer.team === team && !state.firstBuzzer.verified) return;
        // 已有他人持有答題權（理論上 phase 已轉 reviewing 會先被上面擋掉；此為同 tick 競態保險）
        if (state.firstBuzzer && !state.firstBuzzer.verified) {
          ws.send(JSON.stringify({ type: 'buzz_rejected', team }));
          return;
        }
        // 本回合已答錯出局者不可再搶：回 reject 讓 client 解鎖，後續靠 state.eliminated 正確顯示出局
        if (state.eliminated.includes(team)) {
          ws.send(JSON.stringify({ type: 'buzz_rejected', team }));
          return;
        }

        // 只記錄「第一位」拍燈者（用伺服器時戳，client ts 一律忽略以防作弊）
        state.firstBuzzer = { team, ts: Date.now(), verified: false, result: null };

        // 拍燈即定格：保存剩餘倒數、停表並進入判定，避免主持判定期間倒數繼續跑
        state.remainingMs = state.deadline ? Math.max(0, state.deadline - Date.now()) : 0;
        clearCountdown();
        state.phase = 'reviewing';
        state.lastVerify = null; // 新搶答者出現，前一筆判定不可再撤

        broadcast({ type: 'first_buzz', team, rank: 1 });
        broadcastState();
        break;
      }

      case 'host_verify': {
        if (!checkPin()) return;
        const { team, result } = msg;
        if (!team || !['correct', 'wrong'].includes(result)) return;
        const entry = state.firstBuzzer;
        if (!entry || entry.team !== team || entry.verified) return; // 防重複判定（達標廣播只計一次）

        // 每題可設加分值：correct 用傳入 points（clamp 1~200），預設 SCORE_DELTA；wrong 不加分
        const pts = Number.isFinite(Number(msg.points))
          ? Math.min(200, Math.max(1, Math.round(Number(msg.points))))
          : SCORE_DELTA;

        // 撤銷快照：在改 state 之前存「判定前」的定格狀態，供 host_unverify 一鍵還原。
        // prevRemainingMs = 拍燈當下定格的剩餘毫秒；prevEliminated = 判定前出局名單快照。
        // prevBuzzOrder = 判定前完整順位深拷貝，供撤銷時統一還原（涵蓋非鎖模式被移除的 entry）。
        // lockOnWrong = 記錄此筆判定當下的模式，撤銷時據此正確還原。
        state.lastVerify = {
          team,
          result,
          points: result === 'correct' ? pts : 0,
          prevRemainingMs: state.remainingMs,
          prevEliminated: [...state.eliminated],
          prevFirstBuzzer: state.firstBuzzer ? { ...state.firstBuzzer } : null,
          lockOnWrong,
        };

        if (result === 'correct') {
          // 答對：加分（用本題分值）、回合結束鎖定，清出局與定格倒數
          entry.verified = true;
          entry.result = result;
          entry.points = pts; // 記錄本題分值，供撤銷與顯示用
          scores[team] = (scores[team] || 0) + pts;
          scoreSince[team] = Date.now(); // 達到新分數的時間戳，供平手排序
          state.phase = 'locked';
          state.eliminated = [];
          state.remainingMs = null;
          clearCountdown();
          state.closed = false;
        } else {
          // 答錯：鎖定模式下該組本回合出局、不可再搶；兩模式都清掉 firstBuzzer 讓下一位可成為新的答題者
          if (lockOnWrong) state.eliminated.push(team);
          state.firstBuzzer = null;
          // 從拍燈定格的剩餘倒數續跑，讓其他組（不鎖時含本組）繼續搶
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

      // 撤銷最後一筆判定：主持人判錯/判對後反悔，一鍵還原回「該組剛拍燈、定格待判」狀態。
      // 僅允許撤銷最後一筆（lastVerify），撤完即清快照，不可連撤。
      case 'host_unverify': {
        if (!checkPin()) return;
        const lv = state.lastVerify;
        if (!lv) return;

        // 還原分數：correct 才扣回本題分值；扣到 0 以下移除鬼項
        if (lv.result === 'correct') {
          scores[lv.team] = (scores[lv.team] || 0) - lv.points;
          if (scores[lv.team] <= 0) { delete scores[lv.team]; delete scoreSince[lv.team]; }
        }
        // 撤銷視為當下一次分數變動（近似，不存歷史）：仍在 scores 內才更新時間戳
        if (scores[lv.team] !== undefined) scoreSince[lv.team] = Date.now();

        // 還原判定前的第一位搶答者快照（correct / wrong 皆回到「該組剛拍燈、定格待判」）
        state.firstBuzzer = lv.prevFirstBuzzer ? { ...lv.prevFirstBuzzer } : null;

        // 還原狀態回 reviewing 定格：用快照覆蓋出局名單，
        // 回填拍燈當下的剩餘毫秒，reviewing 不跑倒數＝定格。
        state.eliminated = lv.prevEliminated;
        state.phase = 'reviewing';
        state.remainingMs = lv.prevRemainingMs;
        state.closed = false;
        clearCountdown();

        state.lastVerify = null; // 撤完清掉，不可連撤
        broadcast({ type: 'verify_undone', team: lv.team, scores });
        broadcastState();
        break;
      }

      // 分數全清零（不影響進場名單與回合）
      case 'host_score_reset': {
        if (!checkPin()) return;
        scores = {};
        scoreSince = {}; // 分數全清 → 達分時間戳一併清
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
        if (scores[team] === 0) { delete scores[team]; delete scoreSince[team]; }
        else scoreSince[team] = Date.now(); // 調分視為一次分數變動，更新達分時間戳
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

      // 切換答錯鎖定模式：true=出局不可再搶；false=不鎖可再搶
      case 'host_set_lock_mode': {
        if (!checkPin()) return;
        if (typeof msg.lock !== 'boolean') return;
        lockOnWrong = msg.lock;
        if (!lockOnWrong) {
          state.eliminated = []; // 切到可再搶 → 全部解放（使用者指定）
          // 跨模式切換視為新決策點，舊判定快照已失真，禁止用它撤銷（避免還原出非法中間態）。
          state.lastVerify = null;
        }
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

// 收到終止訊號（Render 休眠/部署、Ctrl-C）時做最後一次持久化 flush，補 debounce 來不及落地的最後一筆
function flushAndExit() { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ scores, scoreSince, threshold, lit })); } catch {} process.exit(0); }
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

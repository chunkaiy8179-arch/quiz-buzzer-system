// @ts-check
// 新行為測試：搶答定格、計分、出局、希望之燈（scoring-and-hope-lamp 分支）
// 使用 PORT=3200、HOST_PIN=SCORE1234、短倒數 COUNT_FROM=5（時序案例）
// 與 buzzer.spec.js(3000)、load/timeup(3100) 互不干擾
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

let serverProc;
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const PIN = 'SCORE1234';
const COUNT_FROM = 5; // 倒數秒數：夠短讓定格/續跑測試不用等太久
const WS_TIMEOUT = 5000;

test.beforeAll(async () => {
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: String(COUNT_FROM) },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProc.stdout.on('data', d => {
      if (d.toString().includes('running at')) { clearTimeout(t); resolve(); }
    });
    serverProc.on('error', reject);
  });
});

test.afterAll(() => { if (serverProc) serverProc.kill(); });

// ── helpers ──────────────────────────────────────────────────────────────────
// 回合進行中重設會彈自製 confirmDialog（#confirm-overlay），需點「確定」(#cd-ok)；locked 不彈框。
async function clickReset(page) {
  await page.click('#btn-reset');
  const ok = page.locator('#confirm-overlay:not(.hidden) #cd-ok');
  if (await ok.count()) await ok.click();
}
// 判「正確」也會彈 confirmDialog（+N 分結束回合需確認），點確定後才送出 host_verify correct。
async function verifyCorrect(page) {
  await page.locator('.v-btn[data-result="correct"]').first().click();
  const ok = page.locator('#confirm-overlay:not(.hidden) #cd-ok');
  await expect(ok).toBeVisible({ timeout: WS_TIMEOUT });
  await ok.click();
}

async function freshHost(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/console.html`);
  await p.fill('#pin-input', PIN);
  await p.click('#pin-btn');
  await expect(p.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS_TIMEOUT });
  await clickReset(p);
  await expect(p.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });
  return p;
}

async function joinClient(ctx, town) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/client.html`);
  await p.click(`.town-btn[data-town="${town}"]`);
  await p.click('#join-btn');
  await expect(p.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  return p;
}

// 原生 WebSocket 直連（不經瀏覽器）
function rawConn() {
  const sock = new WebSocket(`ws://localhost:${PORT}`);
  const inbox = [];
  sock.on('message', d => { try { inbox.push(JSON.parse(d)); } catch (e) {} });
  const ready = new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
  return { sock, inbox, ready };
}

function waitMsg(inbox, type, timeout = 4000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = inbox.find(x => x.type === type);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`timeout waiting ${type}`)); }
    }, 25);
  });
}

// 等待包含特定條件的 state 訊息
function waitState(inbox, predicate, timeout = 4000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = inbox.filter(x => x.type === 'state').find(predicate);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout waiting state condition')); }
    }, 25);
  });
}

// ── 測試案例 B1：搶錯出局+續跑 ────────────────────────────────────────────
test('B1 搶錯出局+續跑：c1 拍→判錯→c1 不可再搶、c2 可搶→判對→locked', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const c1 = await joinClient(ctx, '城鎮一');
  const c2 = await joinClient(ctx, '城鎮二');

  await host.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // c1 拍燈 → phase=reviewing
  await c1.click('#buzz-btn');
  await expect(host.locator('#buzz-list li')).toHaveCount(1, { timeout: WS_TIMEOUT });
  await expect(c2.locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });

  // 判 c1 錯 → c1 出局（eliminated），phase=open，c2 解鎖
  const wrongBtn = host.locator('.v-btn[data-result="wrong"]').first();
  await expect(wrongBtn).toBeVisible({ timeout: WS_TIMEOUT });
  await wrongBtn.click();

  // c1 應無法再搶（出局後按鈕應是 disabled）
  await expect(c1.locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });
  // c2 解鎖可搶
  await expect(c2.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // c2 搶→判對→locked
  await c2.click('#buzz-btn');
  await expect(host.locator('#buzz-list li')).toHaveCount(2, { timeout: WS_TIMEOUT });
  await verifyCorrect(host);
  await expect(host.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });

  await clickReset(host);
  await ctx.close();
});

// ── 測試案例 B2：定格倒數 ──────────────────────────────────────────────────
test('B2 定格倒數：拍燈後剩餘秒定格；判錯後繼續下降', async () => {
  // 用 rawConn 取 state.remainingMs，避免 UI 渲染延遲
  const host = rawConn(); await host.ready;
  // 先 reset
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 加入兩組
  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: '定格A' }));
  await waitMsg(c1.inbox, 'join_ok');

  const c2 = rawConn(); await c2.ready;
  c2.sock.send(JSON.stringify({ type: 'join', team: '定格B' }));
  await waitMsg(c2.inbox, 'join_ok');

  // 清掉舊 state 訊息，重新開搶
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  const openState = await waitState(host.inbox, s => s.phase === 'open');
  expect(openState.remainingMs).toBeGreaterThan(0);

  // 等 1.5 秒再讓 c1 拍，確保倒數有在跑
  await new Promise(r => setTimeout(r, 1500));

  // c1 拍燈
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: '定格A' }));
  const afterBuzzState = await waitState(host.inbox, s => s.phase === 'reviewing');
  const frozenMs = afterBuzzState.remainingMs;
  expect(frozenMs).toBeGreaterThan(0);
  expect(frozenMs).toBeLessThan(COUNT_FROM * 1000); // 應比初始少（已跑過時間）

  // 等再過 1.5 秒，remainingMs 應不變（定格）
  await new Promise(r => setTimeout(r, 1500));
  host.inbox.length = 0;
  // 送 ping 觸發 server 下發新 state（等待任意 state 訊息）
  // 直接讀 remainingMs —— reviewing 時 server 每次都回相同 remainingMs
  const stateAfterWait = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no state after wait')), 3000);
    const iv = setInterval(() => {
      // 重連一個新 ws 取最新 state（on connection server 立刻 push stateMsg）
    }, 9999);
    clearInterval(iv);
    clearTimeout(t);
    // 改用新連線取即時 state
    const peek = rawConn();
    peek.ready.then(() => {
      return waitMsg(peek.inbox, 'state', 3000);
    }).then(s => {
      peek.sock.close();
      clearTimeout(t);
      res(s);
    }).catch(e => { clearTimeout(t); rej(e); });
  });

  // reviewing 下 remainingMs 應等於定格值（不隨時間減少）
  expect(stateAfterWait.phase).toBe('reviewing');
  expect(stateAfterWait.remainingMs).toBe(frozenMs);

  // 判 c1 錯 → 續跑，remainingMs 應在一段時間後減少
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '定格A', result: 'wrong' }));
  const afterWrongState = await waitState(host.inbox, s => s.phase === 'open');
  const runningMs = afterWrongState.remainingMs;
  // 等 500ms 再取一次 state，應比 runningMs 小（倒數繼續跑）
  await new Promise(r => setTimeout(r, 600));
  const peekRunning = rawConn();
  await peekRunning.ready;
  const laterState = await waitMsg(peekRunning.inbox, 'state', 3000);
  peekRunning.sock.close();
  expect(laterState.phase).toBe('open');
  expect(laterState.remainingMs).toBeLessThan(runningMs);

  host.sock.close(); c1.sock.close(); c2.sock.close();
  // reset 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── 測試案例 B3：計分累計 ──────────────────────────────────────────────────
test('B3 計分累計：兩回合各判對一次 → 該組 20；host_reset 後分數仍在', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const c1 = await joinClient(ctx, '城鎮一');

  // 回合一：c1 拍→判對 → 城鎮一 +10
  await host.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await c1.click('#buzz-btn');
  await expect(host.locator('.v-btn[data-result="correct"]')).toBeVisible({ timeout: WS_TIMEOUT });
  await verifyCorrect(host);
  await expect(host.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });

  // host_reset → 回到 locked，但分數應保留
  await clickReset(host);
  await expect(host.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });

  // 回合二：c1 拍→判對 → 城鎮一累計 +10 = 20
  await host.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await c1.click('#buzz-btn');
  await expect(host.locator('.v-btn[data-result="correct"]')).toBeVisible({ timeout: WS_TIMEOUT });
  await verifyCorrect(host);
  await expect(host.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });

  // 驗 state scores 城鎮一 = 20（用 raw ws 取最新 state）
  const peek = rawConn(); await peek.ready;
  const stateMsg = await waitMsg(peek.inbox, 'state', 3000);
  peek.sock.close();
  expect(stateMsg.scores['城鎮一']).toBe(20);

  await clickReset(host);
  // host_reset 後分數仍在（不歸零）
  const peek2 = rawConn(); await peek2.ready;
  const stateMsg2 = await waitMsg(peek2.inbox, 'state', 3000);
  peek2.sock.close();
  expect(stateMsg2.scores['城鎮一']).toBe(20);

  await ctx.close();
});

// ── 測試案例 B4：分數歸零 ──────────────────────────────────────────────────
test('B4 分數歸零：累積後 host_score_reset → 全部 0', async () => {
  // 先用 raw ws 累積分數再清零
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: '歸零甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  // 開搶 → 拍 → 判對（+10）
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: '歸零甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '歸零甲', result: 'correct' }));
  const afterCorrect = await waitState(host.inbox, s => s.phase === 'locked');
  expect(afterCorrect.scores['歸零甲']).toBe(10);

  // host_score_reset → 分數全清
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  const afterReset = await waitState(host.inbox, s => true); // 任一 state
  expect(afterReset.scores['歸零甲'] ?? 0).toBe(0);
  expect(afterReset.totalScore).toBe(0);

  host.sock.close(); c1.sock.close();
  // 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── 測試案例 B5：手動±分 ───────────────────────────────────────────────────
test('B5 手動±分：+10 兩次 -10 一次 → +10；連續負至 0 不變負（clamp）', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 先 score_reset 確保乾淨
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  await waitState(host.inbox, s => true);

  // +10 兩次
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_adjust', pin: PIN, team: '手動隊', delta: 10 }));
  await waitState(host.inbox, s => (s.scores['手動隊'] ?? 0) === 10);
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_adjust', pin: PIN, team: '手動隊', delta: 10 }));
  await waitState(host.inbox, s => (s.scores['手動隊'] ?? 0) === 20);

  // -10 一次 → 應剩 10
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_adjust', pin: PIN, team: '手動隊', delta: -10 }));
  const s1 = await waitState(host.inbox, s => true);
  expect(s1.scores['手動隊']).toBe(10);

  // 連續 -20（超過現有 10）→ clamp 0，不應變負；clamp 到 0 後該 key 從 scores 移除（避免 0 分鬼項污染榜單），
  // 故以 ?? 0 取值，有效分數仍為 0 且不為負。
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_adjust', pin: PIN, team: '手動隊', delta: -20 }));
  const s2 = await waitState(host.inbox, s => true);
  expect(s2.scores['手動隊'] ?? 0).toBe(0);
  expect(s2.scores['手動隊'] ?? 0).not.toBeLessThan(0);
  expect('手動隊' in s2.scores).toBe(false); // 0 分鬼項已被刪除，不留在計分板來源

  host.sock.close();
  // 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── 測試案例 B6：first_buzz 立即鎖他人 ────────────────────────────────────
test('B6 first_buzz 立即鎖他人：c1 拍後 c2 的 #buzz-btn 立即 disabled', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const c1 = await joinClient(ctx, '城鎮一');
  const c2 = await joinClient(ctx, '城鎮二');

  await host.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await expect(c2.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // c1 拍燈 → c2 應立即被鎖（不等額外操作）
  await c1.click('#buzz-btn');
  await expect(c2.locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });
  // c1 本身也轉為 state-buzzed + disabled
  await expect(c1.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });

  await host.click('#btn-reset');
  await ctx.close();
});

// ── 測試案例 B7：出局組不可再搶（raw ws 直連）────────────────────────────
test('B7 出局組不可再搶：A 出局後再送 buzz → buzzOrder 不增第二筆 A', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  const a = rawConn(); await a.ready;
  a.sock.send(JSON.stringify({ type: 'join', team: '出局甲' }));
  await waitMsg(a.inbox, 'join_ok');

  const b = rawConn(); await b.ready;
  b.sock.send(JSON.stringify({ type: 'join', team: '出局乙' }));
  await waitMsg(b.inbox, 'join_ok');

  // 開搶
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  // A 拍燈 → reviewing
  host.inbox.length = 0;
  a.sock.send(JSON.stringify({ type: 'buzz', team: '出局甲' }));
  const r1 = await waitState(host.inbox, s => s.phase === 'reviewing');
  expect(r1.buzzOrder.length).toBe(1);
  expect(r1.buzzOrder[0].team).toBe('出局甲');

  // 判 A 錯 → A 出局，phase=open
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '出局甲', result: 'wrong' }));
  await waitState(host.inbox, s => s.phase === 'open');

  // A 再送 buzz（被 eliminated 拒絕）
  host.inbox.length = 0;
  a.sock.send(JSON.stringify({ type: 'buzz', team: '出局甲' }));
  // 等短暫後取最新 state，buzzOrder 不應再增加 A
  await new Promise(r => setTimeout(r, 300));
  const peek = rawConn(); await peek.ready;
  const latestState = await waitMsg(peek.inbox, 'state', 3000);
  peek.sock.close();
  // buzzOrder 中 '出局甲' 只應有一筆
  const aEntries = latestState.buzzOrder.filter(x => x.team === '出局甲');
  expect(aEntries.length).toBe(1);

  host.sock.close(); a.sock.close(); b.sock.close();
  // 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── 測試案例 B8：門檻達標解鎖 canIgnite ──────────────────────────────────
test('B8 門檻達標解鎖：設低門檻、加分達標 → state.canIgnite=true', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');
  // 先清分
  host.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));

  // 設低門檻 = 10
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_threshold', pin: PIN, threshold: 10 }));
  const afterThreshold = await waitState(host.inbox, s => s.threshold === 10);
  expect(afterThreshold.canIgnite).toBe(false); // 分數尚未達標

  // 手動加分 +10 → 達標
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_adjust', pin: PIN, team: '達標隊', delta: 10 }));
  const afterScore = await waitState(host.inbox, s => (s.scores['達標隊'] ?? 0) >= 10);
  expect(afterScore.canIgnite).toBe(true);
  expect(afterScore.totalScore).toBeGreaterThanOrEqual(10);

  host.sock.close();
  // 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cleanup.sock.send(JSON.stringify({ type: 'host_set_threshold', pin: PIN, threshold: 120 }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── 測試案例 B9：host_ignite ──────────────────────────────────────────────
test('B9 host_ignite：未達標時送不 broadcast ignite；達標後送 → 收到 ignite 且 lit=true', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');
  // 清分、設門檻 50
  host.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_threshold', pin: PIN, threshold: 50 }));
  await waitState(host.inbox, s => s.threshold === 50);

  // 旁觀者監聽 ignite
  const observer = rawConn(); await observer.ready;
  await waitMsg(observer.inbox, 'state', 3000); // 接收初始 state

  // 未達標（0分）→ 送 host_ignite 應無效（不 broadcast ignite）
  host.inbox.length = 0;
  observer.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_ignite', pin: PIN }));
  await new Promise(r => setTimeout(r, 400));
  const igniteBeforeScore = observer.inbox.find(x => x.type === 'ignite');
  expect(igniteBeforeScore).toBeUndefined();

  // 加分達標（+50）→ 再送 host_ignite → 應 broadcast ignite，lit=true
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_score_adjust', pin: PIN, team: '燈隊', delta: 50 }));
  await waitState(host.inbox, s => s.canIgnite === true);

  observer.inbox.length = 0;
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_ignite', pin: PIN }));
  const igniteMsg = await waitMsg(observer.inbox, 'ignite', 3000);
  expect(igniteMsg.type).toBe('ignite');

  // 後續 state 應有 lit=true
  const litState = await waitState(host.inbox, s => s.lit === true);
  expect(litState.lit).toBe(true);

  host.sock.close(); observer.sock.close();
  // 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cleanup.sock.send(JSON.stringify({ type: 'host_set_threshold', pin: PIN, threshold: 120 }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── 測試案例 B10：同時拍燈競態（raw ws 回歸）────────────────────────────────
// 重現 reviewer 阻斷 #1：A、B 幾乎同時拍燈，B 命中 phase!=='open' 守衛。
// 修法後 B 必須收到 buzz_rejected（解除 client 樂觀鎖）；判 A 錯續跑後 B 仍能成功進 buzzOrder（沒被卡死）。
test('B10 同時拍燈競態：B 被拒收到 buzz_rejected；判 A 錯續跑後 B 可成功搶到', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  const a = rawConn(); await a.ready;
  a.sock.send(JSON.stringify({ type: 'join', team: '競態甲' }));
  await waitMsg(a.inbox, 'join_ok');

  const b = rawConn(); await b.ready;
  b.sock.send(JSON.stringify({ type: 'join', team: '競態乙' }));
  await waitMsg(b.inbox, 'join_ok');

  // 開搶
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  // A 先送 buzz、B 緊接著送 buzz（同一 tick，B 會命中 phase 已 reviewing 守衛）
  host.inbox.length = 0;
  b.inbox.length = 0;
  a.sock.send(JSON.stringify({ type: 'buzz', team: '競態甲' }));
  b.sock.send(JSON.stringify({ type: 'buzz', team: '競態乙' }));

  // A 進 buzzOrder、phase=reviewing
  const r1 = await waitState(host.inbox, s => s.phase === 'reviewing');
  expect(r1.buzzOrder.length).toBe(1);
  expect(r1.buzzOrder[0].team).toBe('競態甲');

  // B 必須收到 buzz_rejected（針對自己 team）→ 解除 client 樂觀鎖
  const rej = await waitMsg(b.inbox, 'buzz_rejected', 3000);
  expect(rej.team).toBe('競態乙');

  // 判 A 錯 → A 出局、phase=open 續跑
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '競態甲', result: 'wrong' }));
  await waitState(host.inbox, s => s.phase === 'open');

  // 續跑後 B 再送 buzz → 應成功進 buzzOrder（沒被卡死）
  host.inbox.length = 0;
  b.sock.send(JSON.stringify({ type: 'buzz', team: '競態乙' }));
  const r2 = await waitState(host.inbox, s => s.phase === 'reviewing' && s.buzzOrder.some(x => x.team === '競態乙'));
  const bEntry = r2.buzzOrder.find(x => x.team === '競態乙');
  expect(bEntry).toBeTruthy();
  expect(bEntry.verified).toBe(false);

  host.sock.close(); a.sock.close(); b.sock.close();
  // 清場
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 本輪新協定測試：可變加分(points)、撤銷判定(host_unverify)、verify_undone 廣播
// ═══════════════════════════════════════════════════════════════════════════════

// ── helper：開場並加入一組，直到 c1 拍燈 phase=reviewing ───────────────────────
async function openRoundWith(hostSock, hostInbox, teamName) {
  hostSock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(hostInbox, s => s.phase === 'locked');
  hostInbox.length = 0;
  // 清分確保測試起始乾淨
  hostSock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  await waitState(hostInbox, () => true);

  const c = rawConn(); await c.ready;
  c.sock.send(JSON.stringify({ type: 'join', team: teamName }));
  await waitMsg(c.inbox, 'join_ok');

  hostInbox.length = 0;
  hostSock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(hostInbox, s => s.phase === 'open');

  hostInbox.length = 0;
  c.sock.send(JSON.stringify({ type: 'buzz', team: teamName }));
  await waitState(hostInbox, s => s.phase === 'reviewing');

  return c;
}

// ── C1 可變加分：帶 points:20 → +20 ─────────────────────────────────────────
test('C1 可變加分：host_verify 帶 points:20 → 該組 +20', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '加分甲');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '加分甲', result: 'correct', points: 20 }));
  const s = await waitState(host.inbox, st => st.phase === 'locked');
  expect(s.scores['加分甲']).toBe(20);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C2 可變加分：帶 points:5 → +5 ───────────────────────────────────────────
test('C2 可變加分：host_verify 帶 points:5 → 該組 +5', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '加分乙');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '加分乙', result: 'correct', points: 5 }));
  const s = await waitState(host.inbox, st => st.phase === 'locked');
  expect(s.scores['加分乙']).toBe(5);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C3 可變加分：不帶 points → 預設 +10 ────────────────────────────────────
test('C3 可變加分：不帶 points → 預設 +10（向後相容）', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '加分丙');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '加分丙', result: 'correct' }));
  const s = await waitState(host.inbox, st => st.phase === 'locked');
  expect(s.scores['加分丙']).toBe(10);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C4 可變加分：points 超界(999) → clamp 到 200 ────────────────────────────
test('C4 可變加分：points:999 超界 → clamp 到 200', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '加分丁');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '加分丁', result: 'correct', points: 999 }));
  const s = await waitState(host.inbox, st => st.phase === 'locked');
  expect(s.scores['加分丁']).toBe(200);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C5 可變加分：points:0 → clamp 到下限 1（最小 1 分） ─────────────────────
test('C5 可變加分：points:0 → clamp 下限，至少 +1', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '加分戊');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '加分戊', result: 'correct', points: 0 }));
  const s = await waitState(host.inbox, st => st.phase === 'locked');
  // points:0 應被 clamp 到 1（Math.max(1, ...)），不應為 0 或預設 10
  expect(s.scores['加分戊']).toBe(1);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C6 可變加分：points:-5（負數）→ clamp 下限 1 ────────────────────────────
test('C6 可變加分：points:-5 負數 → clamp 下限，至少 +1', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '加分己');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '加分己', result: 'correct', points: -5 }));
  const s = await waitState(host.inbox, st => st.phase === 'locked');
  expect(s.scores['加分己']).toBe(1);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C7 撤銷 correct：判對後 host_unverify → 分扣回、phase=reviewing、entry 重置 ─
test('C7 撤銷 correct：判對(+10) → host_unverify → 分扣回、phase=reviewing、entry 可再判', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '撤銷正');

  // 判 correct
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '撤銷正', result: 'correct' }));
  const afterCorrect = await waitState(host.inbox, s => s.phase === 'locked');
  expect(afterCorrect.scores['撤銷正']).toBe(10);

  // host_unverify
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  const afterUndo = await waitState(host.inbox, s => s.phase === 'reviewing');

  // 驗分數扣回（0 分被刪除鬼項）
  expect(afterUndo.scores['撤銷正'] ?? 0).toBe(0);
  // phase 回 reviewing
  expect(afterUndo.phase).toBe('reviewing');
  // entry.verified 應回 false（currentFocus 應是該組）
  const entry = afterUndo.buzzOrder.find(b => b.team === '撤銷正');
  expect(entry).toBeTruthy();
  expect(entry.verified).toBe(false);
  // currentFocus 應重新指向該組
  expect(afterUndo.currentFocus).toBe('撤銷正');

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C8 撤銷 wrong：判錯 → host_unverify → 移出 eliminated、phase=reviewing ────
test('C8 撤銷 wrong：判錯(出局) → host_unverify → 移出 eliminated、phase=reviewing', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '撤銷錯');

  // 判 wrong → 出局，phase=open
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '撤銷錯', result: 'wrong' }));
  const afterWrong = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong.eliminated).toContain('撤銷錯');

  // host_unverify
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  const afterUndo = await waitState(host.inbox, s => s.phase === 'reviewing');

  // 移出 eliminated
  expect(afterUndo.eliminated).not.toContain('撤銷錯');
  // phase 回 reviewing
  expect(afterUndo.phase).toBe('reviewing');
  // entry 重置為 unverified
  const entry = afterUndo.buzzOrder.find(b => b.team === '撤銷錯');
  expect(entry).toBeTruthy();
  expect(entry.verified).toBe(false);
  expect(entry.result).toBeNull();
  // 分數不受影響（wrong 不加分）
  expect(afterUndo.scores['撤銷錯'] ?? 0).toBe(0);

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C9 撤銷限制：連續兩次 host_unverify → 第二次應無效 ───────────────────────
test('C9 撤銷限制：連續兩次 host_unverify → 第二次無效（lastVerify 已清）', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '連撤隊');

  // 判 correct
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '連撤隊', result: 'correct' }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 第一次撤銷 → 成功，phase 回 reviewing
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  const undone1 = await waitMsg(host.inbox, 'verify_undone', 4000);
  expect(undone1.team).toBe('連撤隊');
  await waitState(host.inbox, s => s.phase === 'reviewing');

  // 第二次撤銷 → 無效（lastVerify 已清，server 靜默忽略）
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  await new Promise(r => setTimeout(r, 400));
  // 不應再有新的 verify_undone
  const undone2 = host.inbox.find(x => x.type === 'verify_undone');
  expect(undone2).toBeUndefined();
  // phase 仍應維持 reviewing
  const latestState = [...host.inbox].reverse().find(x => x.type === 'state');
  if (latestState) {
    expect(latestState.phase).toBe('reviewing');
  }

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C10 撤銷限制：host_reset 後 host_unverify 無效 ───────────────────────────
test('C10 撤銷限制：host_reset 後 host_unverify 無效（lastVerify 已清）', async () => {
  const host = rawConn(); await host.ready;
  const c = await openRoundWith(host.sock, host.inbox, '重設後撤');

  // 判 correct
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '重設後撤', result: 'correct' }));
  const afterCorrect = await waitState(host.inbox, s => s.phase === 'locked');
  expect(afterCorrect.scores['重設後撤']).toBe(10);

  // host_reset → lastVerify 清除
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // host_unverify → 應無效（靜默忽略，分數維持不變）
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  await new Promise(r => setTimeout(r, 400));

  // 取最新 state，分數應維持（reset 後 lastVerify 已清，無法撤銷）
  const peek = rawConn(); await peek.ready;
  const latestState = await waitMsg(peek.inbox, 'state', 3000);
  peek.sock.close();
  // 分數應仍為 10（host_unverify 無效）
  expect(latestState.scores['重設後撤']).toBe(10);
  expect(latestState.phase).toBe('locked');
  // 不應收到 verify_undone
  const undone = host.inbox.find(x => x.type === 'verify_undone');
  expect(undone).toBeUndefined();

  host.sock.close(); c.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C11 verify_undone 廣播：host_unverify 後 observer 收到帶最新 scores ───────
test('C11 verify_undone 廣播：host_unverify 後 observer 收到 verify_undone 帶最新 scores', async () => {
  const host = rawConn(); await host.ready;
  const observer = rawConn(); await observer.ready;
  await waitMsg(observer.inbox, 'state', 3000); // 接收初始 state

  const c = await openRoundWith(host.sock, host.inbox, '廣播隊');

  // 判 correct(+10)
  host.inbox.length = 0;
  observer.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: '廣播隊', result: 'correct', points: 10 }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // host_unverify → 應廣播 verify_undone
  observer.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));

  // observer 應收到 verify_undone
  const undoneMsg = await waitMsg(observer.inbox, 'verify_undone', 4000);
  expect(undoneMsg.type).toBe('verify_undone');
  expect(undoneMsg.team).toBe('廣播隊');
  // scores 應反映扣回後狀態（0 分不留鬼項）
  expect(undoneMsg.scores['廣播隊'] ?? 0).toBe(0);

  host.sock.close(); c.sock.close(); observer.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ── C12（H-1 回歸）：判錯續跑期間別組拍燈後，撤銷必須失效，不得還原出非法中間態 ──
// 重現 reviewer 阻斷 H-1：A 拍→判 A 錯(eliminated=[A]、續跑、lastVerify 指 A)→ 續跑期間 B 拍燈
// (phase=reviewing)。此時若仍能 host_unverify，會用 A 的舊快照還原：buzzOrder 出現兩個未判定組、
// currentFocus 跳回 A、remainingMs 被 A 舊定格值覆蓋。修法是在 buzz 進 reviewing 時清 lastVerify，
// 使撤銷只在「判錯後、還沒有人接著拍燈」的窗口內有效。
test('C12 H-1 回歸：判錯續跑後別組拍燈，host_unverify 失效（環境已變不可還原）', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');
  host.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));

  const a = rawConn(); await a.ready;
  a.sock.send(JSON.stringify({ type: 'join', team: 'H1甲' }));
  await waitMsg(a.inbox, 'join_ok');
  const b = rawConn(); await b.ready;
  b.sock.send(JSON.stringify({ type: 'join', team: 'H1乙' }));
  await waitMsg(b.inbox, 'join_ok');

  // 開搶 → A 拍 → reviewing
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');
  host.inbox.length = 0;
  a.sock.send(JSON.stringify({ type: 'buzz', team: 'H1甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  // 判 A 錯 → A 出局、phase=open 續跑（此刻 lastVerify 指向 A，撤銷尚有效）
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'H1甲', result: 'wrong' }));
  await waitState(host.inbox, s => s.phase === 'open' && s.eliminated.includes('H1甲'));

  // 續跑期間 B 拍燈 → phase=reviewing（環境已變，server 應在此清掉 lastVerify）
  host.inbox.length = 0;
  b.sock.send(JSON.stringify({ type: 'buzz', team: 'H1乙' }));
  const afterBBuzz = await waitState(host.inbox, s => s.phase === 'reviewing' && s.buzzOrder.some(x => x.team === 'H1乙'));
  // 健全性：此刻只有 B 一個未判定組，currentFocus 指 B
  expect(afterBBuzz.currentFocus).toBe('H1乙');
  const frozenForB = afterBBuzz.remainingMs;

  // 嘗試 host_unverify → 必須無效（lastVerify 已被 B 的 buzz 清空），不得還原出非法中間態
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  await new Promise(r => setTimeout(r, 400));
  // 不應收到 verify_undone
  const undone = host.inbox.find(x => x.type === 'verify_undone');
  expect(undone).toBeUndefined();

  // 取最新 state 驗證狀態未被破壞
  const peek = rawConn(); await peek.ready;
  const latest = await waitMsg(peek.inbox, 'state', 3000);
  peek.sock.close();
  expect(latest.phase).toBe('reviewing');
  // A 仍出局、未被舊快照復活
  expect(latest.eliminated).toContain('H1甲');
  // buzzOrder 不應出現兩個未判定組（A 已 verified=wrong、B 未判定）
  const unverified = latest.buzzOrder.filter(x => !x.verified);
  expect(unverified.length).toBe(1);
  expect(unverified[0].team).toBe('H1乙');
  // currentFocus 仍指 B，未被還原跳回 A
  expect(latest.currentFocus).toBe('H1乙');
  // remainingMs 未被 A 的舊定格值覆蓋（仍是 B 拍燈的定格值）
  expect(latest.remainingMs).toBe(frozenForB);

  host.sock.close(); a.sock.close(); b.sock.close();
  const cl = rawConn(); await cl.ready;
  cl.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));
  cl.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cl.sock.close();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 本輪新協定測試：lockOnWrong 可變、host_set_lock_mode、非鎖模式撤銷
// PORT=3200, PIN=SCORE1234, COUNT_FROM=5
// ═══════════════════════════════════════════════════════════════════════════════

// ── D1 預設鎖模式答錯（迴歸）：c1 拍→判 wrong→進 eliminated、再 buzz 被拒 ──
test('D1 預設鎖模式答錯：c1 進 eliminated、再 buzz 被拒、其他組可搶', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 確保鎖定模式 = true（預設）
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  await waitState(host.inbox, s => s.lockOnWrong === true);

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: 'D1甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  const c2 = rawConn(); await c2.ready;
  c2.sock.send(JSON.stringify({ type: 'join', team: 'D1乙' }));
  await waitMsg(c2.inbox, 'join_ok');

  // 開搶
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  // c1 拍燈 → reviewing
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D1甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  // 判 c1 wrong → 鎖模式 → c1 進 eliminated、phase=open
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D1甲', result: 'wrong' }));
  const afterWrong = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong.eliminated).toContain('D1甲');
  expect(afterWrong.lockOnWrong).toBe(true);

  // c1 再送 buzz → 應收到 buzz_rejected（出局不可再搶）
  c1.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D1甲' }));
  const rej = await waitMsg(c1.inbox, 'buzz_rejected', 3000);
  expect(rej.team).toBe('D1甲');

  // 等 300ms 確認 buzzOrder 中 D1甲 未再增加
  await new Promise(r => setTimeout(r, 300));
  const peek = rawConn(); await peek.ready;
  const latest = await waitMsg(peek.inbox, 'state', 3000);
  peek.sock.close();
  const d1Entries = latest.buzzOrder.filter(x => x.team === 'D1甲');
  expect(d1Entries.length).toBe(1); // 只有第一筆（verified=true）

  // c2 此時應可搶（未出局）
  host.inbox.length = 0;
  c2.sock.send(JSON.stringify({ type: 'buzz', team: 'D1乙' }));
  const r2 = await waitState(host.inbox, s => s.phase === 'reviewing' && s.buzzOrder.some(x => x.team === 'D1乙'));
  expect(r2.buzzOrder.find(x => x.team === 'D1乙')).toBeTruthy();

  host.sock.close(); c1.sock.close(); c2.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── D2 非鎖模式答錯可再搶：lock:false→c1 拍→判 wrong→不在 eliminated、可再 buzz ──
test('D2 非鎖模式答錯可再搶：lock:false→c1拍→判wrong→不在eliminated、c1再buzz成功', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 切到非鎖模式
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: false }));
  await waitState(host.inbox, s => s.lockOnWrong === false);

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: 'D2甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  // 開搶
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  // c1 第一次拍燈 → reviewing
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D2甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  // 判 c1 wrong → 非鎖模式：entry 被移除，不進 eliminated，phase=open
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D2甲', result: 'wrong' }));
  const afterWrong = await waitState(host.inbox, s => s.phase === 'open');
  // 非鎖模式：不在 eliminated
  expect(afterWrong.eliminated).not.toContain('D2甲');
  // entry 被移除（buzzOrder 不含 D2甲）
  expect(afterWrong.buzzOrder.find(x => x.team === 'D2甲')).toBeUndefined();

  // c1 再次 buzz → 應成功進 buzzOrder（非鎖、未在 eliminated）
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D2甲' }));
  const r2 = await waitState(host.inbox, s => s.phase === 'reviewing' && s.buzzOrder.some(x => x.team === 'D2甲'));
  const entry = r2.buzzOrder.find(x => x.team === 'D2甲');
  expect(entry).toBeTruthy();
  expect(entry.verified).toBe(false);

  host.sock.close(); c1.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  // 恢復預設鎖模式
  cleanup.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── D3 切非鎖全部解放：先鎖模式讓 c1 出局→切 lock:false→eliminated 清空、c1 可再搶 ──
test('D3 切非鎖全部解放：c1出局後切lock:false→eliminated清空、c1可再搶', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 確保鎖定模式 = true
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  await waitState(host.inbox, s => s.lockOnWrong === true);

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: 'D3甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  const c2 = rawConn(); await c2.ready;
  c2.sock.send(JSON.stringify({ type: 'join', team: 'D3乙' }));
  await waitMsg(c2.inbox, 'join_ok');

  // 開搶，c1 拍→判 wrong（鎖模式）→ c1 進 eliminated
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D3甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D3甲', result: 'wrong' }));
  const afterWrong = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong.eliminated).toContain('D3甲'); // c1 在 eliminated

  // 切 lock:false → 應清空 eliminated
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: false }));
  const afterUnlock = await waitState(host.inbox, s => s.lockOnWrong === false);
  expect(afterUnlock.eliminated).toHaveLength(0); // eliminated 已清空
  expect(afterUnlock.lockOnWrong).toBe(false);

  // c1 應可再搶（不再被 eliminated 擋）
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D3甲' }));
  const r2 = await waitState(host.inbox, s => s.phase === 'reviewing' && s.buzzOrder.some(x => x.team === 'D3甲'));
  expect(r2.buzzOrder.find(x => x.team === 'D3甲')).toBeTruthy();

  host.sock.close(); c1.sock.close(); c2.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── D4 非鎖模式判錯後撤銷：lock:false→c1拍→判wrong(entry移除)→host_unverify→c1回 buzzOrder ──
test('D4 非鎖模式判錯後撤銷：lock:false→拍→判wrong→host_unverify→c1回buzzOrder可重判', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');
  host.sock.send(JSON.stringify({ type: 'host_score_reset', pin: PIN }));

  // 切非鎖模式
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: false }));
  await waitState(host.inbox, s => s.lockOnWrong === false);

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: 'D4甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  // 開搶，c1 拍
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D4甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  // 判 wrong（非鎖）：entry 被移除，不進 eliminated，phase=open
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D4甲', result: 'wrong' }));
  const afterWrong = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong.eliminated).not.toContain('D4甲');
  expect(afterWrong.buzzOrder.find(x => x.team === 'D4甲')).toBeUndefined();

  // host_unverify → 應還原 c1 回 buzzOrder（prevBuzzOrder 快照）、phase=reviewing
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  const afterUndo = await waitState(host.inbox, s => s.phase === 'reviewing');

  // c1 應回到 buzzOrder，verified=false，可重判
  const entry = afterUndo.buzzOrder.find(b => b.team === 'D4甲');
  expect(entry).toBeTruthy();
  expect(entry.verified).toBe(false);
  expect(entry.result).toBeNull();
  // eliminated 仍為空（非鎖模式）
  expect(afterUndo.eliminated).not.toContain('D4甲');
  // currentFocus 指向 D4甲
  expect(afterUndo.currentFocus).toBe('D4甲');
  // phase = reviewing
  expect(afterUndo.phase).toBe('reviewing');

  host.sock.close(); c1.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── D5 鎖模式判錯後撤銷（迴歸）：lock:true→c1拍→判wrong→host_unverify→c1移出eliminated ──
test('D5 鎖模式判錯後撤銷：lock:true→c1拍→判wrong→host_unverify→c1移出eliminated回reviewing', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 確保鎖定模式 = true
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  await waitState(host.inbox, s => s.lockOnWrong === true);

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: 'D5甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  // 開搶，c1 拍
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'open');

  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D5甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  // 判 wrong（鎖模式）→ c1 進 eliminated，phase=open
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D5甲', result: 'wrong' }));
  const afterWrong = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong.eliminated).toContain('D5甲');
  // entry 仍在 buzzOrder，verified=true，result=wrong
  const wrongEntry = afterWrong.buzzOrder.find(x => x.team === 'D5甲');
  expect(wrongEntry).toBeTruthy();
  expect(wrongEntry.verified).toBe(true);
  expect(wrongEntry.result).toBe('wrong');

  // host_unverify → c1 移出 eliminated，回 reviewing，entry 重置
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_unverify', pin: PIN }));
  const afterUndo = await waitState(host.inbox, s => s.phase === 'reviewing');

  // c1 移出 eliminated
  expect(afterUndo.eliminated).not.toContain('D5甲');
  // phase 回 reviewing
  expect(afterUndo.phase).toBe('reviewing');
  // entry 重置：verified=false、result=null
  const restoredEntry = afterUndo.buzzOrder.find(b => b.team === 'D5甲');
  expect(restoredEntry).toBeTruthy();
  expect(restoredEntry.verified).toBe(false);
  expect(restoredEntry.result).toBeNull();
  // currentFocus 指向 D5甲
  expect(afterUndo.currentFocus).toBe('D5甲');

  host.sock.close(); c1.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── D6 host_set_lock_mode 下發：切換後 observer 收到 state.lockOnWrong 對應值 ──
test('D6 host_set_lock_mode 下發：切換後 observer 收到 state.lockOnWrong 正確值', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  const observer = rawConn(); await observer.ready;
  await waitMsg(observer.inbox, 'state', 3000); // 接收初始 state

  // 先確認初始值（預設 true）
  observer.inbox.length = 0;
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  const s1 = await waitState(observer.inbox, s => true);
  expect(s1.lockOnWrong).toBe(true);

  // 切到 false，observer 應收到 lockOnWrong=false
  observer.inbox.length = 0;
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: false }));
  const s2 = await waitState(observer.inbox, s => s.lockOnWrong === false);
  expect(s2.lockOnWrong).toBe(false);

  // 切回 true，observer 再收到 lockOnWrong=true
  observer.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  const s3 = await waitState(observer.inbox, s => s.lockOnWrong === true);
  expect(s3.lockOnWrong).toBe(true);

  host.sock.close(); observer.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

// ── D7 非鎖模式同組連搶錯：c1拍→判wrong→c1再拍→判wrong→倒數歸零closed=true不卡死 ──
// COUNT_FROM=5（短倒數），讓時間到時歸零 closed=true，驗不卡死（phase 最終 closed 或 locked）。
test('D7 非鎖模式同組連搶錯：連錯後倒數歸零 closed=true 不卡死', async () => {
  const host = rawConn(); await host.ready;
  host.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await waitState(host.inbox, s => s.phase === 'locked');

  // 切非鎖模式
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: false }));
  await waitState(host.inbox, s => s.lockOnWrong === false);

  const c1 = rawConn(); await c1.ready;
  c1.sock.send(JSON.stringify({ type: 'join', team: 'D7甲' }));
  await waitMsg(c1.inbox, 'join_ok');

  // 開搶（COUNT_FROM=5）
  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_open', pin: PIN }));
  const openState = await waitState(host.inbox, s => s.phase === 'open');
  expect(openState.remainingMs).toBeGreaterThan(0);

  // c1 第一次拍→判 wrong（非鎖：entry 移除、可再搶）
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D7甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D7甲', result: 'wrong' }));
  const afterWrong1 = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong1.eliminated).not.toContain('D7甲'); // 非鎖，不出局

  // c1 第二次拍→判 wrong
  host.inbox.length = 0;
  c1.sock.send(JSON.stringify({ type: 'buzz', team: 'D7甲' }));
  await waitState(host.inbox, s => s.phase === 'reviewing');

  host.inbox.length = 0;
  host.sock.send(JSON.stringify({ type: 'host_verify', pin: PIN, team: 'D7甲', result: 'wrong' }));
  const afterWrong2 = await waitState(host.inbox, s => s.phase === 'open');
  expect(afterWrong2.eliminated).not.toContain('D7甲'); // 仍不出局

  // 等待倒數歸零（COUNT_FROM=5，最多等 8 秒）
  // 每次判 wrong 後從 remainingMs 續跑，兩次判 wrong 後 remainingMs 應所剩無幾
  // 等待 closed=true 或 time_up
  const peek = rawConn(); await peek.ready;
  const closedState = await waitState(peek.inbox, s => s.closed === true || s.phase === 'locked', 9000);
  peek.sock.close();
  // 確認不卡死：closed=true（open 已歸零）或 locked（已結束）
  expect(closedState.closed === true || closedState.phase === 'locked').toBe(true);
  // c1 不在 eliminated（非鎖模式始終如此）
  expect(closedState.eliminated).not.toContain('D7甲');

  host.sock.close(); c1.sock.close();
  const cleanup = rawConn(); await cleanup.ready;
  cleanup.sock.send(JSON.stringify({ type: 'host_set_lock_mode', pin: PIN, lock: true }));
  cleanup.sock.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
  await new Promise(r => setTimeout(r, 200));
  cleanup.sock.close();
});

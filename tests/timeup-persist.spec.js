// @ts-check
// 新行為驗證：伺服器權威倒數（時間到關閉搶答、第一搶後倒數續跑）、
// 換城鎮限制（開賽後不可換）、F5 記憶城鎮（重整自動回原隊伍）。
// 自起一台短倒數（COUNT_FROM=3）的 server，與主測試（3000/30s）互不干擾。
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

let serverProc;
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const PIN = 'TEST1234';
const COUNT_FROM = 3;
const WS = 5000;

test.beforeAll(async () => {
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: String(COUNT_FROM) },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProc.stdout.on('data', d => { if (d.toString().includes('running at')) { clearTimeout(t); resolve(); } });
    serverProc.on('error', reject);
  });
});

test.afterAll(() => { if (serverProc) serverProc.kill(); });

// 回合進行中重設會彈自製 confirmDialog（#confirm-overlay），需點「確定」(#cd-ok)；locked 不彈框。
async function clickReset(page) {
  await page.click('#btn-reset');
  const ok = page.locator('#confirm-overlay:not(.hidden) #cd-ok');
  if (await ok.count()) await ok.click();
}
// 判「正確」也會彈 confirmDialog（+N 分結束回合需確認），點確定後才送出。
async function verifyCorrect(page) {
  await page.locator('.v-btn[data-result="correct"]').first().click();
  const ok = page.locator('#confirm-overlay:not(.hidden) #cd-ok');
  await expect(ok).toBeVisible({ timeout: WS });
  await ok.click();
}

async function freshHost(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/console.html`);
  await p.fill('#pin-input', PIN);
  await p.click('#pin-btn');
  await expect(p.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS });
  await clickReset(p);
  await expect(p.locator('#btn-open')).toBeEnabled({ timeout: WS });
  return p;
}
async function joinClient(ctx, town) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/client.html`);
  await p.click(`.town-btn[data-town="${town}"]`);
  await p.click('#join-btn');
  await expect(p.locator('#game-screen')).toBeVisible({ timeout: WS });
  return p;
}

// 原生 WebSocket 連線（直接測伺服器 join/接管邏輯，不經瀏覽器儲存）
function rawConn() {
  const sock = new WebSocket(`ws://localhost:${PORT}`);
  const inbox = [];
  sock.on('message', d => { try { inbox.push(JSON.parse(d)); } catch (e) {} });
  const ready = new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
  return { sock, inbox, ready };
}
function waitMsg(inbox, type, timeout = 3000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = inbox.find(x => x.type === type);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('timeout waiting ' + type)); }
    }, 25);
  });
}

test('倒數歸零後關閉搶答：學員顯示「時間到」、再拍燈不計入', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const client = await joinClient(ctx, '城鎮一');

  await host.click('#btn-open');
  await expect(client.locator('#buzz-btn')).toBeEnabled({ timeout: WS });

  // 不拍燈，等倒數歸零 → 視窗關閉
  await expect(client.locator('#buzz-btn')).toHaveText('時間到', { timeout: COUNT_FROM * 1000 + 3000 });
  await expect(client.locator('#buzz-btn')).toBeDisabled();

  // 此時拍燈不應計入
  await client.click('#buzz-btn', { force: true }).catch(() => {});
  await expect(host.locator('#buzz-list li')).toHaveCount(0);

  await clickReset(host);
  await ctx.close();
});

test('第一個拍燈後定格：c2 立即被鎖；判 c1 錯後 c2 才可搶、倒數續跑', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const c1 = await joinClient(ctx, '城鎮一');
  const c2 = await joinClient(ctx, '城鎮二');

  await host.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS });

  // c1 拍燈 → phase=reviewing、c2 應立即被鎖（定格期間不可搶）
  await c1.click('#buzz-btn');
  await expect(host.locator('#buzz-list li')).toHaveCount(1, { timeout: WS });
  await expect(c2.locator('#buzz-btn')).toBeDisabled({ timeout: WS });

  // 判 c1 錯 → phase=open（從剩餘秒續跑）、c1 出局、c2 解鎖可搶
  const wrongBtn = host.locator('.v-btn[data-result="wrong"]').first();
  await expect(wrongBtn).toBeVisible({ timeout: WS });
  await wrongBtn.click();

  // c2 解鎖並可搶答
  await expect(c2.locator('#buzz-btn')).toBeEnabled({ timeout: WS });
  await c2.click('#buzz-btn');
  await expect(host.locator('#buzz-list li')).toHaveCount(2, { timeout: WS });

  // 判 c2 對 → 回合結束 LOCKED
  await verifyCorrect(host);
  await expect(host.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS });

  await clickReset(host);
  await ctx.close();
});

test('換城鎮按鈕：開賽後隱藏、回 locked 後再現', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const client = await joinClient(ctx, '城鎮一');

  await expect(client.locator('#change-town')).toBeVisible();
  await host.click('#btn-open');
  await expect(client.locator('#change-town')).toBeHidden({ timeout: WS });
  await clickReset(host);
  await expect(client.locator('#change-town')).toBeVisible({ timeout: WS });

  await ctx.close();
});

test('F5 記憶：重整後自動回到原本城鎮，不需重選', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const client = await joinClient(ctx, '城鎮三');
  await expect(client.locator('#team-badge')).toHaveText('城鎮三');

  await client.reload();
  // 不再停在選城鎮畫面，而是自動回搶答畫面、隊名維持
  await expect(client.locator('#game-screen')).toBeVisible({ timeout: WS });
  await expect(client.locator('#team-badge')).toHaveText('城鎮三');
  await expect(host.locator('#joined-count')).toHaveText('1', { timeout: WS });

  await clickReset(host);
  await ctx.close();
});

test('Token 接管：帶對 token 的新連線踢掉殘留舊連線、接管原城鎮（模擬 Render F5）', async () => {
  const a = rawConn(); await a.ready;
  a.sock.send(JSON.stringify({ type: 'join', team: '城鎮七' }));
  const okA = await waitMsg(a.inbox, 'join_ok');
  expect(okA.team).toBe('城鎮七');
  expect(typeof okA.token).toBe('string');

  // 舊連線 a 不關閉（模擬 Render 上舊 ws 殘留）；新連線 b 帶同一 token 重連
  const b = rawConn(); await b.ready;
  b.sock.send(JSON.stringify({ type: 'join', team: '城鎮七', token: okA.token }));
  const okB = await waitMsg(b.inbox, 'join_ok');
  expect(okB.team).toBe('城鎮七');
  // 舊連線被踢、收到 force_reselect
  const kicked = await waitMsg(a.inbox, 'force_reselect');
  expect(kicked.type).toBe('force_reselect');

  a.sock.close(); b.sock.close();
});

test('撞同名仍被拒：無 token 的新連線不能搶走使用中的城鎮', async () => {
  const a = rawConn(); await a.ready;
  a.sock.send(JSON.stringify({ type: 'join', team: '城鎮八' }));
  await waitMsg(a.inbox, 'join_ok');

  // 不同裝置（無 token）撞同名 → 應被拒
  const b = rawConn(); await b.ready;
  b.sock.send(JSON.stringify({ type: 'join', team: '城鎮八' }));
  const errB = await waitMsg(b.inbox, 'join_error');
  expect(errB.reason).toBe('duplicate');

  a.sock.close(); b.sock.close();
});

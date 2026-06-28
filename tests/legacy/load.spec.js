// @ts-check
// 壓力測試：多城鎮同時連線與同時搶答的正確性與順暢度（UI 端，8 城鎮）
// 註：10+ 組的極限併發另由 tests/stress-concurrency.js（WebSocket 直連）涵蓋
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

let serverProc;
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const WS_TIMEOUT = 8000;
const TEST_PIN = 'LOAD1234';
const NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const N = 10; // 同時連線城鎮數（對應 client.html 預設 10 城鎮）

test.beforeAll(async () => {
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: { ...process.env, PORT: String(PORT), HOST_PIN: TEST_PIN },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProc.stdout.on('data', data => {
      if (data.toString().includes('running at')) { clearTimeout(timeout); resolve(); }
    });
    serverProc.on('error', reject);
  });
});

test.afterAll(() => { if (serverProc) serverProc.kill(); });

test(`${N} 城鎮同時連線、進場顯示正確；搶答定格：第一人搶到後其他人被鎖`, async ({ browser }) => {
  test.setTimeout(60000);
  const ctx = await browser.newContext();

  const hostPage = await ctx.newPage();
  const displayPage = await ctx.newPage();
  await hostPage.goto(`${BASE}/console.html`);
  await hostPage.fill('#pin-input', TEST_PIN);
  await hostPage.click('#pin-btn');
  await expect(hostPage.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS_TIMEOUT });
  await displayPage.goto(`${BASE}/display.html`);

  // N 個城鎮同時加入（點選城鎮）
  const teamNames = Array.from({ length: N }, (_, i) => `城鎮${NUMS[i]}`);
  const clients = await Promise.all(teamNames.map(() => ctx.newPage()));
  await Promise.all(clients.map(async (page, i) => {
    await page.goto(`${BASE}/client.html`);
    await page.click(`.town-btn[data-town="${teamNames[i]}"]`);
    await page.click('#join-btn');
    await expect(page.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  }));

  // 進場名單應顯示全部 N 城（主持端 + 投影端）
  await expect(hostPage.locator('#joined-count')).toHaveText(String(N), { timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#idle-count')).toHaveText(String(N), { timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#idle-chips .chip')).toHaveCount(N, { timeout: WS_TIMEOUT });

  // 開搶；所有學員按鈕啟用
  const t0 = Date.now();
  await hostPage.click('#btn-open');
  await Promise.all(clients.map(page =>
    expect(page.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT })
  ));
  await expect(displayPage.locator('#open-screen')).toBeVisible();
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(5000);

  // 新搶答機制：第一個城鎮搶答 → phase=reviewing → 其他城鎮被鎖
  // 只讓城鎮一搶（第一人），其餘不搶，驗證第一人 rank=1、其他人被鎖
  await clients[0].click('#buzz-btn');

  // 主持端應只有 1 筆（第一人）
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(1, { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#buzz-list li').first()).toContainText(teamNames[0], { timeout: WS_TIMEOUT });

  // 第一人按鈕應顯示 state-buzzed 且 rank=1
  await expect(clients[0].locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });
  await expect(clients[0].locator('#buzz-btn')).toContainText('第 1 名', { timeout: WS_TIMEOUT });

  // 其他城鎮應立即被鎖（phase=reviewing，非第一人搶到後其他人無法搶）
  for (let i = 1; i < N; i++) {
    await expect(clients[i].locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });
  }

  await ctx.close();
});

test('城鎮斷線後進場名單即時減少', async ({ browser }) => {
  test.setTimeout(30000);
  const ctx = await browser.newContext();
  const hostPage = await ctx.newPage();
  await hostPage.goto(`${BASE}/console.html`);
  await hostPage.fill('#pin-input', TEST_PIN);
  await hostPage.click('#pin-btn');
  await expect(hostPage.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS_TIMEOUT });

  const c1 = await ctx.newPage();
  const c2 = await ctx.newPage();
  for (const [page, name] of [[c1, '城鎮一'], [c2, '城鎮二']]) {
    await page.goto(`${BASE}/client.html`);
    await page.click(`.town-btn[data-town="${name}"]`);
    await page.click('#join-btn');
    await expect(page.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  }
  await expect(hostPage.locator('#joined-count')).toHaveText('2', { timeout: WS_TIMEOUT });

  await c2.close();
  await expect(hostPage.locator('#joined-count')).toHaveText('1', { timeout: WS_TIMEOUT });

  await ctx.close();
});

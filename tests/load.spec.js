// @ts-check
// 壓力測試：8–10 人同時連線與同時搶答的正確性與順暢度
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

let serverProc;
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const WS_TIMEOUT = 8000;
const TEST_PIN = 'LOAD1234';
const N = 10; // 同時連線人數

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

test(`${N} 人同時連線、進場顯示、同時搶答的順序正確且順暢`, async ({ browser }) => {
  test.setTimeout(60000);
  const ctx = await browser.newContext();

  // 主持端 + 投影端
  const hostPage = await ctx.newPage();
  const displayPage = await ctx.newPage();
  await hostPage.goto(`${BASE}/console.html`);
  await hostPage.fill('#pin-input', TEST_PIN);
  await hostPage.click('#pin-btn');
  await expect(hostPage.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS_TIMEOUT });
  await displayPage.goto(`${BASE}/display.html`);

  // N 位學員同時加入
  const teamNames = Array.from({ length: N }, (_, i) => `第${i + 1}組`);
  const clients = await Promise.all(teamNames.map(() => ctx.newPage()));
  await Promise.all(clients.map(async (page, i) => {
    await page.goto(`${BASE}/client.html`);
    await page.fill('#team-input', teamNames[i]);
    await page.click('#join-btn');
    await expect(page.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  }));

  // 需求1：進場名單應顯示全部 N 組（主持端 + 投影端）
  await expect(hostPage.locator('#joined-count')).toHaveText(String(N), { timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#idle-count')).toHaveText(String(N), { timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#idle-chips .chip')).toHaveCount(N, { timeout: WS_TIMEOUT });

  // 主持人開搶；所有學員按鈕應啟用
  await hostPage.click('#btn-open');
  await Promise.all(clients.map(page =>
    expect(page.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT })
  ));
  await expect(displayPage.locator('#open-screen')).toBeVisible();

  // N 人「同時」搶答
  const t0 = Date.now();
  await Promise.all(clients.map(page => page.click('#buzz-btn')));

  // 主持端應收到全部 N 筆，且排名 1..N 不重複
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(N, { timeout: WS_TIMEOUT });
  const elapsed = Date.now() - t0;

  // 投影端即時順位也應有 N 筆
  await expect(displayPage.locator('#open-rank-list li')).toHaveCount(N, { timeout: WS_TIMEOUT });

  // 每位學員都顯示為已搶答（鎖定）
  await Promise.all(clients.map(page =>
    expect(page.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT })
  ));

  // 排名標記應為 1..N 連續且唯一
  const rankNums = await hostPage.locator('#buzz-list .rank-num').allInnerTexts();
  const parsed = rankNums.map(s => parseInt(s.trim(), 10)).sort((a, b) => a - b);
  expect(parsed).toEqual(Array.from({ length: N }, (_, i) => i + 1));

  // 順暢度：N 人同時搶答後全部登記完成應在合理時間內（< 5s）
  expect(elapsed).toBeLessThan(5000);

  await ctx.close();
});

test('學員斷線後進場名單即時減少', async ({ browser }) => {
  test.setTimeout(30000);
  const ctx = await browser.newContext();
  const hostPage = await ctx.newPage();
  await hostPage.goto(`${BASE}/console.html`);
  await hostPage.fill('#pin-input', TEST_PIN);
  await hostPage.click('#pin-btn');
  await expect(hostPage.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS_TIMEOUT });

  const c1 = await ctx.newPage();
  const c2 = await ctx.newPage();
  for (const [page, name] of [[c1, '甲組'], [c2, '乙組']]) {
    await page.goto(`${BASE}/client.html`);
    await page.fill('#team-input', name);
    await page.click('#join-btn');
    await expect(page.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  }
  await expect(hostPage.locator('#joined-count')).toHaveText('2', { timeout: WS_TIMEOUT });

  // 關閉一位學員 → 應減為 1
  await c2.close();
  await expect(hostPage.locator('#joined-count')).toHaveText('1', { timeout: WS_TIMEOUT });

  await ctx.close();
});

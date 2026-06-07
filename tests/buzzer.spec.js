// @ts-check
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

let serverProc;
const BASE = 'http://localhost:3000';
const WS_TIMEOUT = 5000;

test.beforeAll(async () => {
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: { ...process.env, PORT: '3000' },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProc.stdout.on('data', data => {
      if (data.toString().includes('running at')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProc.on('error', reject);
  });
});

test.afterAll(() => {
  if (serverProc) serverProc.kill();
});

async function joinClient(page, teamName) {
  await page.goto(`${BASE}/client.html`);
  await page.fill('#team-input', teamName);
  await page.click('#join-btn');
  await expect(page.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
}

test('學員端未開搶時按鈕應為 disabled', async ({ page }) => {
  await joinClient(page, '第1組');
  await expect(page.locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });
  await expect(page.locator('#buzz-btn')).toHaveClass(/state-locked/);
});

test('完整搶答流程：開搶→搶答→遞補驗證', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, displayPage, client1, client2] = await Promise.all([
    ctx.newPage(), ctx.newPage(), ctx.newPage(), ctx.newPage(),
  ]);

  await Promise.all([
    hostPage.goto(`${BASE}/console.html`),
    displayPage.goto(`${BASE}/display.html`),
  ]);
  await joinClient(client1, '第1組');
  await joinClient(client2, '第2組');

  // 確認開搶前鎖定
  await expect(client1.locator('#buzz-btn')).toBeDisabled();
  await expect(client2.locator('#buzz-btn')).toBeDisabled();
  await expect(hostPage.locator('#btn-open')).toBeEnabled();

  // 主持人開搶
  await hostPage.click('#btn-open');

  // 等待 WebSocket 廣播到達學員端
  await expect(client1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await expect(client2.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // 投影端應切換到開放畫面
  await expect(displayPage.locator('#open-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  // 第1組先搶，第2組後搶
  await client1.click('#buzz-btn');
  await client2.click('#buzz-btn');

  // 第1組按鈕應顯示排名
  await expect(client1.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });
  await expect(client1.locator('#buzz-btn')).toContainText('第 1 名');

  // 主持端列表應顯示第1組排第一
  await expect(hostPage.locator('#buzz-list li').first()).toContainText('第1組', { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('第2組', { timeout: WS_TIMEOUT });

  // 投影端排名畫面
  await expect(displayPage.locator('#rank-list li').first()).toContainText('第1組', { timeout: WS_TIMEOUT });

  // 主持人判第1組錯誤
  const wrongBtn = hostPage.locator('.v-btn[data-result="wrong"]').first();
  await expect(wrongBtn).toBeVisible({ timeout: WS_TIMEOUT });
  await wrongBtn.click();

  // 第2組應成為 focus（review 狀態）
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('待驗證', { timeout: WS_TIMEOUT });

  // 主持人判第2組正確
  const correctBtn = hostPage.locator('.v-btn[data-result="correct"]').first();
  await expect(correctBtn).toBeVisible({ timeout: WS_TIMEOUT });
  await correctBtn.click();

  // 回到 locked：開搶按鈕重新啟用
  await expect(hostPage.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });

  await ctx.close();
});

test('重設後回到 locked 狀態，學員按鈕文字清除', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, client] = await Promise.all([ctx.newPage(), ctx.newPage()]);

  await hostPage.goto(`${BASE}/console.html`);
  await joinClient(client, '測試組');

  await hostPage.click('#btn-open');
  await expect(client.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // 搶答
  await client.click('#buzz-btn');
  await expect(client.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });

  // 重設
  await hostPage.click('#btn-reset');

  // 按鈕應回到 BUZZ 且 disabled
  await expect(client.locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });
  await expect(client.locator('#buzz-btn')).toHaveText('BUZZ', { timeout: WS_TIMEOUT });
  await expect(client.locator('#buzz-btn')).toHaveClass(/state-locked/);

  await ctx.close();
});

test('投影端在各 phase 顯示正確畫面', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, displayPage, client] = await Promise.all([
    ctx.newPage(), ctx.newPage(), ctx.newPage(),
  ]);

  await hostPage.goto(`${BASE}/console.html`);
  await displayPage.goto(`${BASE}/display.html`);
  await joinClient(client, '展示組');

  // 初始：idle 畫面
  await expect(displayPage.locator('#idle-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  // 開搶 → open 畫面
  await hostPage.click('#btn-open');
  await expect(displayPage.locator('#open-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  // 搶答 → rank 畫面
  await client.click('#buzz-btn');
  await expect(displayPage.locator('#rank-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#rank-list li').first()).toContainText('展示組');

  // 重設 → idle 畫面
  await hostPage.click('#btn-reset');
  await expect(displayPage.locator('#idle-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  await ctx.close();
});

// @ts-check
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

let serverProc;
const BASE = 'http://localhost:3000';
const WS_TIMEOUT = 5000;
const TEST_PIN = 'TEST1234';

test.beforeAll(async () => {
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: { ...process.env, PORT: '3000', HOST_PIN: TEST_PIN },
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

async function joinHost(page) {
  await page.goto(`${BASE}/console.html`);
  await page.fill('#pin-input', TEST_PIN);
  await page.click('#pin-btn');
  await expect(page.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS_TIMEOUT });
}

// 新版以「點選城鎮」加入（teamName 必須是 client.html TOWNS 之一，如 城鎮一）
async function joinClient(page, teamName) {
  await page.goto(`${BASE}/client.html`);
  await page.click(`.town-btn[data-town="${teamName}"]`);
  await expect(page.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });
}

test('學員端未開搶時按鈕應為 disabled', async ({ page }) => {
  await joinClient(page, '城鎮一');
  await expect(page.locator('#buzz-btn')).toBeDisabled({ timeout: WS_TIMEOUT });
  await expect(page.locator('#buzz-btn')).toHaveClass(/state-locked/);
});

test('完整搶答流程：開搶→搶答→遞補驗證', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, displayPage, client1, client2] = await Promise.all([
    ctx.newPage(), ctx.newPage(), ctx.newPage(), ctx.newPage(),
  ]);

  await joinHost(hostPage);
  await displayPage.goto(`${BASE}/display.html`);
  await joinClient(client1, '城鎮一');
  await joinClient(client2, '城鎮二');

  await expect(client1.locator('#buzz-btn')).toBeDisabled();
  await expect(client2.locator('#buzz-btn')).toBeDisabled();
  await expect(hostPage.locator('#btn-open')).toBeEnabled();

  await hostPage.click('#btn-open');

  await expect(client1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await expect(client2.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#open-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  // 城鎮一先搶，城鎮二後搶
  await client1.click('#buzz-btn');
  await client2.click('#buzz-btn');

  await expect(client1.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });
  await expect(client1.locator('#buzz-btn')).toContainText('第 1 名');

  await expect(hostPage.locator('#buzz-list li').first()).toContainText('城鎮一', { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('城鎮二', { timeout: WS_TIMEOUT });

  // 投影端開放畫面中即時順位列表（搶答時仍在 open phase，倒數移到角落）
  await expect(displayPage.locator('#open-screen')).toBeVisible();
  await expect(displayPage.locator('#open-rank-list li').first()).toContainText('城鎮一', { timeout: WS_TIMEOUT });

  // 判城鎮一錯誤 → 城鎮二遞補
  const wrongBtn = hostPage.locator('.v-btn[data-result="wrong"]').first();
  await expect(wrongBtn).toBeVisible({ timeout: WS_TIMEOUT });
  await wrongBtn.click();
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('待驗證', { timeout: WS_TIMEOUT });

  // 判城鎮二正確 → 回到 locked
  const correctBtn = hostPage.locator('.v-btn[data-result="correct"]').first();
  await expect(correctBtn).toBeVisible({ timeout: WS_TIMEOUT });
  await correctBtn.click();

  await expect(hostPage.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });

  await ctx.close();
});

test('答對使回合結束後，剩餘未判定組不應再有判定鈕（bug 修正）', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, c1, c2, c3] = await Promise.all([
    ctx.newPage(), ctx.newPage(), ctx.newPage(), ctx.newPage(),
  ]);

  await joinHost(hostPage);
  await joinClient(c1, '城鎮一');
  await joinClient(c2, '城鎮二');
  await joinClient(c3, '城鎮三');

  await hostPage.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // 三組都搶（城鎮一、二、三）
  await c1.click('#buzz-btn');
  await c2.click('#buzz-btn');
  await c3.click('#buzz-btn');
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(3, { timeout: WS_TIMEOUT });

  // 城鎮一錯 → 城鎮二對（回合結束，城鎮三從未被判）
  await hostPage.locator('.v-btn[data-result="wrong"]').first().click();
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('待驗證', { timeout: WS_TIMEOUT });
  await hostPage.locator('.v-btn[data-result="correct"]').first().click();

  // 回合結束（LOCKED）：不應再有任何判定鈕，城鎮三不應顯示「待驗證」
  await expect(hostPage.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('.v-btn')).toHaveCount(0, { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#buzz-list')).not.toContainText('待驗證');

  await ctx.close();
});

test('重設後回到 locked 狀態，學員按鈕文字清除', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, client] = await Promise.all([ctx.newPage(), ctx.newPage()]);

  await joinHost(hostPage);
  await joinClient(client, '城鎮三');

  await hostPage.click('#btn-open');
  await expect(client.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  await client.click('#buzz-btn');
  await expect(client.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });

  await hostPage.click('#btn-reset');

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

  await joinHost(hostPage);
  await displayPage.goto(`${BASE}/display.html`);
  await joinClient(client, '城鎮四');

  await expect(displayPage.locator('#idle-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  await hostPage.click('#btn-open');
  await expect(displayPage.locator('#open-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  await client.click('#buzz-btn');
  await expect(displayPage.locator('#open-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#open-rank-list li').first()).toContainText('城鎮四');

  await hostPage.click('#btn-reset');
  await expect(displayPage.locator('#idle-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  await ctx.close();
});

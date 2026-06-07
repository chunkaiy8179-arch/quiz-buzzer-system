// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

let serverProc;
const BASE = 'http://localhost:3000';

test.beforeAll(async () => {
  serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: { ...process.env, PORT: '3000' },
  });
  // Wait for server to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 8000);
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

test('學員端未開搶時按鈕應為 disabled', async ({ page }) => {
  await page.goto(`${BASE}/client.html`);
  // Join first
  await page.fill('#team-input', '第1組');
  await page.click('#join-btn');
  // Buzz button should be disabled (locked state)
  const btn = page.locator('#buzz-btn');
  await expect(btn).toBeDisabled({ timeout: 3000 });
});

test('完整搶答流程：開搶→搶答→遞補驗證', async ({ browser }) => {
  const ctx = await browser.newContext();
  const [hostPage, displayPage, client1, client2] = await Promise.all([
    ctx.newPage(), ctx.newPage(), ctx.newPage(), ctx.newPage(),
  ]);

  // Open all pages
  await Promise.all([
    hostPage.goto(`${BASE}/console.html`),
    displayPage.goto(`${BASE}/display.html`),
    client1.goto(`${BASE}/client.html`),
    client2.goto(`${BASE}/client.html`),
  ]);

  // Join clients
  await client1.fill('#team-input', '第1組');
  await client1.click('#join-btn');
  await client2.fill('#team-input', '第2組');
  await client2.click('#join-btn');

  // Wait for game screen to appear
  await expect(client1.locator('#game-screen')).toBeVisible({ timeout: 3000 });
  await expect(client2.locator('#game-screen')).toBeVisible({ timeout: 3000 });

  // Buzz buttons should be disabled before open
  await expect(client1.locator('#buzz-btn')).toBeDisabled();
  await expect(client2.locator('#buzz-btn')).toBeDisabled();

  // Host opens buzzing
  await hostPage.click('#btn-open');

  // Buzz buttons should become enabled
  await expect(client1.locator('#buzz-btn')).toBeEnabled({ timeout: 3000 });
  await expect(client2.locator('#buzz-btn')).toBeEnabled({ timeout: 3000 });

  // Client 1 buzzes first
  await client1.click('#buzz-btn');
  // Client 2 buzzes second
  await client2.click('#buzz-btn');

  // Host console should show 第1組 at rank 1
  await expect(hostPage.locator('#buzz-list li').first()).toContainText('第1組', { timeout: 3000 });

  // Display should show rank screen with 第1組
  await expect(displayPage.locator('#rank-list li').first()).toContainText('第1組', { timeout: 4000 });

  // Host marks 第1組 as WRONG
  const wrongBtn = hostPage.locator('.v-btn[data-result="wrong"]').first();
  await wrongBtn.click();

  // Host console should now show 第2組 as current focus (border-yellow)
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('第2組', { timeout: 3000 });

  // Host marks 第2組 as CORRECT
  const correctBtn = hostPage.locator('.v-btn[data-result="correct"]').first();
  await correctBtn.click();

  // Phase should return to locked (open button re-enables)
  await expect(hostPage.locator('#btn-open')).toBeEnabled({ timeout: 3000 });

  await ctx.close();
});

test('重設後回到 locked 狀態', async ({ page: hostPage, browser }) => {
  const ctx = await browser.newContext();
  const client = await ctx.newPage();
  await hostPage.goto(`${BASE}/console.html`);
  await client.goto(`${BASE}/client.html`);
  await client.fill('#team-input', '測試組');
  await client.click('#join-btn');
  await expect(client.locator('#game-screen')).toBeVisible({ timeout: 3000 });

  await hostPage.click('#btn-open');
  await expect(client.locator('#buzz-btn')).toBeEnabled({ timeout: 3000 });

  await hostPage.click('#btn-reset');
  await expect(client.locator('#buzz-btn')).toBeDisabled({ timeout: 3000 });

  await ctx.close();
});

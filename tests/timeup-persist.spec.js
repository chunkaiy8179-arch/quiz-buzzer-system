// @ts-check
// 新行為驗證：伺服器權威倒數（時間到關閉搶答、第一搶後倒數續跑）、
// 換城鎮限制（開賽後不可換）、F5 記憶城鎮（重整自動回原隊伍）。
// 自起一台短倒數（COUNT_FROM=3）的 server，與主測試（3000/30s）互不干擾。
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

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

async function freshHost(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/console.html`);
  await p.fill('#pin-input', PIN);
  await p.click('#pin-btn');
  await expect(p.locator('#pin-screen')).toHaveClass(/hidden/, { timeout: WS });
  await p.click('#btn-reset');
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

  await host.click('#btn-reset');
  await ctx.close();
});

test('第一個拍燈後倒數續跑：視窗仍開放，後續城鎮可繼續拍燈', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const c1 = await joinClient(ctx, '城鎮一');
  const c2 = await joinClient(ctx, '城鎮二');

  await host.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS });

  await c1.click('#buzz-btn');
  await expect(host.locator('#buzz-list li')).toHaveCount(1, { timeout: WS });
  // 第一搶後視窗未關（倒數續跑）→ 城鎮二仍可拍燈
  await expect(c2.locator('#buzz-btn')).toBeEnabled();
  await c2.click('#buzz-btn');
  await expect(host.locator('#buzz-list li')).toHaveCount(2, { timeout: WS });

  await host.click('#btn-reset');
  await ctx.close();
});

test('換城鎮按鈕：開賽後隱藏、回 locked 後再現', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await freshHost(ctx);
  const client = await joinClient(ctx, '城鎮一');

  await expect(client.locator('#change-town')).toBeVisible();
  await host.click('#btn-open');
  await expect(client.locator('#change-town')).toBeHidden({ timeout: WS });
  await host.click('#btn-reset');
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

  await host.click('#btn-reset');
  await ctx.close();
});

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

// 加入流程：城鎮按鈕會填入名稱輸入框，再按「加入」。
// teamName 為預設城鎮（如 城鎮一）時點按鈕；否則視為自訂名稱直接輸入。
async function joinClient(page, teamName) {
  await page.goto(`${BASE}/client.html`);
  const chip = page.locator(`.town-btn[data-town="${teamName}"]`);
  if (await chip.count()) await chip.click();
  else await page.fill('#name-input', teamName);
  await page.click('#join-btn');
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

// 每個案例開頭先 reset 確保乾淨狀態（伺服器狀態跨測試共用）
async function freshHost(ctx) {
  const hostPage = await ctx.newPage();
  await joinHost(hostPage);
  await hostPage.click('#btn-reset');
  await expect(hostPage.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });
  return hostPage;
}

test('開搶後 0 城搶答：投影維持開放等待、主持端列表空', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const displayPage = await ctx.newPage();
  await displayPage.goto(`${BASE}/display.html`);
  const client = await ctx.newPage();
  await joinClient(client, '城鎮一');

  await hostPage.click('#btn-open');
  await expect(displayPage.locator('#open-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  // 沒有人搶 → 等待畫面顯示、即時順位隱藏、主持端列表空
  await expect(displayPage.locator('#open-waiting')).toBeVisible();
  await expect(displayPage.locator('#open-rank-list')).toBeHidden();
  await expect(hostPage.locator('#empty-msg')).toBeVisible();
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(0);

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('部分城鎮搶答：未搶城鎮按鈕仍可搶', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const [c1, c2, c3] = await Promise.all([ctx.newPage(), ctx.newPage(), ctx.newPage()]);
  await joinClient(c1, '城鎮一');
  await joinClient(c2, '城鎮二');
  await joinClient(c3, '城鎮三');

  await hostPage.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });

  // 只有城鎮一、城鎮二搶
  await c1.click('#buzz-btn');
  await c2.click('#buzz-btn');
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(2, { timeout: WS_TIMEOUT });
  // 城鎮三未搶 → 按鈕仍可按
  await expect(c3.locator('#buzz-btn')).toBeEnabled();
  await expect(c3.locator('#buzz-btn')).toHaveClass(/state-open/);

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('連續答錯遞補：錯→錯→對，focus 依序遞補', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const [c1, c2, c3] = await Promise.all([ctx.newPage(), ctx.newPage(), ctx.newPage()]);
  await joinClient(c1, '城鎮一');
  await joinClient(c2, '城鎮二');
  await joinClient(c3, '城鎮三');

  await hostPage.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await c1.click('#buzz-btn');
  await c2.click('#buzz-btn');
  await c3.click('#buzz-btn');
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(3, { timeout: WS_TIMEOUT });

  // 第1名錯 → 第2名 focus
  await hostPage.locator('.v-btn[data-result="wrong"]').first().click();
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('待驗證', { timeout: WS_TIMEOUT });
  // 第2名錯 → 第3名 focus
  await hostPage.locator('.v-btn[data-result="wrong"]').first().click();
  await expect(hostPage.locator('#buzz-list li').nth(2)).toContainText('待驗證', { timeout: WS_TIMEOUT });
  // 第3名對 → 回合結束
  await hostPage.locator('.v-btn[data-result="correct"]').first().click();
  await expect(hostPage.locator('#phase-badge')).toContainText('LOCKED', { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('.v-btn')).toHaveCount(0);

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('全部答錯：無 focus、無判定鈕，可重設續行', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const [c1, c2] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await joinClient(c1, '城鎮一');
  await joinClient(c2, '城鎮二');

  await hostPage.click('#btn-open');
  await expect(c1.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await c1.click('#buzz-btn');
  await c2.click('#buzz-btn');
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(2, { timeout: WS_TIMEOUT });

  // 兩組都判錯
  await hostPage.locator('.v-btn[data-result="wrong"]').first().click();
  await expect(hostPage.locator('#buzz-list li').nth(1)).toContainText('待驗證', { timeout: WS_TIMEOUT });
  await hostPage.locator('.v-btn[data-result="wrong"]').first().click();

  // 全錯後：兩列皆「錯誤」、無待驗證、無判定鈕
  await expect(hostPage.locator('#buzz-list')).toContainText('錯誤', { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#buzz-list')).not.toContainText('待驗證');
  await expect(hostPage.locator('.v-btn')).toHaveCount(0);

  // 重設可續行 → 回到可開搶
  await hostPage.click('#btn-reset');
  await expect(hostPage.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });
  await ctx.close();
});

test('開搶中不可再開搶（btn-open 鎖定）', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const client = await ctx.newPage();
  await joinClient(client, '城鎮一');

  await expect(hostPage.locator('#btn-open')).toBeEnabled();
  await hostPage.click('#btn-open');
  await expect(hostPage.locator('#btn-open')).toBeDisabled({ timeout: WS_TIMEOUT });
  // 搶答後仍 open → 仍不可再開搶
  await client.click('#buzz-btn');
  await expect(hostPage.locator('#btn-open')).toBeDisabled();

  await hostPage.click('#btn-reset');
  await expect(hostPage.locator('#btn-open')).toBeEnabled({ timeout: WS_TIMEOUT });
  await ctx.close();
});

test('學員拍燈後鎖定，再點無效', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const client = await ctx.newPage();
  await joinClient(client, '城鎮一');

  await hostPage.click('#btn-open');
  await expect(client.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await client.click('#buzz-btn');
  await expect(client.locator('#buzz-btn')).toHaveClass(/state-buzzed/, { timeout: WS_TIMEOUT });
  await expect(client.locator('#buzz-btn')).toBeDisabled();
  // 再點不會新增第二筆
  await client.click('#buzz-btn', { force: true }).catch(() => {});
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(1);

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('城鎮選擇衝突：已被選的城鎮在其他人端顯示「已加入」', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);

  const a = await ctx.newPage();
  await joinClient(a, '城鎮一'); // A 選了城鎮一

  // B 進到選城鎮畫面（不選），城鎮一應標記 taken
  const b = await ctx.newPage();
  await b.goto(`${BASE}/client.html`);
  await expect(b.locator('.town-btn[data-town="城鎮一"]')).toHaveClass(/taken/, { timeout: WS_TIMEOUT });
  // 其他城鎮不受影響
  await expect(b.locator('.town-btn[data-town="城鎮二"]')).not.toHaveClass(/taken/);

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('重設：投影回 idle、主持端清空、學員按鈕復位', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const displayPage = await ctx.newPage();
  await displayPage.goto(`${BASE}/display.html`);
  const client = await ctx.newPage();
  await joinClient(client, '城鎮一');

  await hostPage.click('#btn-open');
  await expect(client.locator('#buzz-btn')).toBeEnabled({ timeout: WS_TIMEOUT });
  await client.click('#buzz-btn');
  await expect(hostPage.locator('#buzz-list li')).toHaveCount(1, { timeout: WS_TIMEOUT });

  await hostPage.click('#btn-reset');
  await expect(displayPage.locator('#idle-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#empty-msg')).toBeVisible();
  await expect(client.locator('#buzz-btn')).toHaveClass(/state-locked/);
  await expect(client.locator('#buzz-btn')).toBeDisabled();

  await ctx.close();
});

test('自訂隊名：可輸入名稱，三端顯示自訂名', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const displayPage = await ctx.newPage();
  await displayPage.goto(`${BASE}/display.html`);
  const client = await ctx.newPage();
  await client.goto(`${BASE}/client.html`);
  await client.fill('#name-input', '烈焰隊');
  await client.click('#join-btn');
  await expect(client.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  await expect(client.locator('#team-badge')).toHaveText('烈焰隊');
  await expect(displayPage.locator('#idle-chips')).toContainText('烈焰隊', { timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#joined-names')).toContainText('烈焰隊', { timeout: WS_TIMEOUT });

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('重複名稱：第二個同名加入被拒絕', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const a = await ctx.newPage();
  await joinClient(a, '城鎮一');

  const b = await ctx.newPage();
  await b.goto(`${BASE}/client.html`);
  await b.click('.town-btn[data-town="城鎮一"]');
  await b.click('#join-btn');
  // B 應停在選擇畫面並看到錯誤
  await expect(b.locator('#join-error')).toContainText('已被使用', { timeout: WS_TIMEOUT });
  await expect(b.locator('#game-screen')).toBeHidden();
  await expect(hostPage.locator('#joined-count')).toHaveText('1');

  await hostPage.click('#btn-reset');
  await ctx.close();
});

test('換城鎮：學員可自行回到選擇畫面，名單即時更新', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const client = await ctx.newPage();
  await joinClient(client, '城鎮一');
  await expect(hostPage.locator('#joined-count')).toHaveText('1', { timeout: WS_TIMEOUT });

  await client.click('#change-town');
  await expect(client.locator('#login-screen')).toBeVisible();
  await expect(hostPage.locator('#joined-count')).toHaveText('0', { timeout: WS_TIMEOUT });

  await ctx.close();
});

test('主持端「清空連線」：全部學員退回選擇畫面', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  hostPage.on('dialog', d => d.accept()); // 接受確認對話框
  const [c1, c2] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await joinClient(c1, '城鎮一');
  await joinClient(c2, '城鎮二');
  await expect(hostPage.locator('#joined-count')).toHaveText('2', { timeout: WS_TIMEOUT });

  await hostPage.click('#btn-clear');
  // 兩個學員都被退回選擇畫面、名單歸零
  await expect(c1.locator('#login-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  await expect(c2.locator('#login-screen')).toBeVisible({ timeout: WS_TIMEOUT });
  await expect(hostPage.locator('#joined-count')).toHaveText('0', { timeout: WS_TIMEOUT });

  await ctx.close();
});

test('injection 安全：名稱中的角括號被移除、不會注入元素', async ({ browser }) => {
  const ctx = await browser.newContext();
  const hostPage = await freshHost(ctx);
  const displayPage = await ctx.newPage();
  await displayPage.goto(`${BASE}/display.html`);
  const client = await ctx.newPage();
  await client.goto(`${BASE}/client.html`);
  await client.fill('#name-input', '<b>x');
  await client.click('#join-btn');
  await expect(client.locator('#game-screen')).toBeVisible({ timeout: WS_TIMEOUT });

  // 角括號被移除 → 名稱變 "bx"，且投影端不存在被注入的 <b> 元素
  await expect(client.locator('#team-badge')).toHaveText('bx');
  await expect(displayPage.locator('#idle-chips')).toContainText('bx', { timeout: WS_TIMEOUT });
  await expect(displayPage.locator('#idle-chips b')).toHaveCount(0);

  await hostPage.click('#btn-reset');
  await ctx.close();
});

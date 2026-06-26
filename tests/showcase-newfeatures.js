// showcase-newfeatures.js
// 新功能展示：計分系統 + 聖火進度條 + 希望之燈點燈動畫
// 執行：node tests/showcase-newfeatures.js
// 輸出：.screenshots/showcase/*.png

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const PORT = 3000;
const PIN = 'DEMO1234';
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, '..', '.screenshots', 'showcase');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function snap(page, filename) {
  const fullPath = path.join(OUT, filename);
  await page.screenshot({ path: fullPath, fullPage: false });
  console.log(`  截圖 → ${fullPath}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 啟動 server
  console.log('啟動 server...');
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe',
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST_PIN: PIN,
      LIGHT_THRESHOLD: '30',
      COUNT_FROM: '60',
    },
  });

  // 等 server 就緒
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout')), 12000);
    server.stdout.on('data', d => {
      const txt = d.toString();
      process.stdout.write(txt);
      if (txt.includes('running at')) { clearTimeout(t); res(); }
    });
    server.stderr.on('data', d => process.stderr.write(d.toString()));
    server.on('error', rej);
  });

  console.log('Server 就緒，啟動 browser...');
  const browser = await chromium.launch({ headless: true });

  // 投影端：1920x1080 大螢幕
  const bigCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // 主持端：桌面
  const conCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // 學員端：手機尺寸
  const mobCtx = await browser.newContext({ viewport: { width: 414, height: 896 } });

  // 開啟各端
  const display = await bigCtx.newPage();
  await display.goto(`${BASE}/display.html`);
  // 隱藏音效解鎖按鈕，避免擋住畫面
  await display.evaluate(() => {
    const btn = document.getElementById('audio-unlock');
    if (btn) btn.classList.add('hidden');
  });

  const con = await conCtx.newPage();
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN);
  await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state: 'hidden', timeout: 8000 });

  // 4 個學員加入
  const towns = ['城鎮一', '城鎮二', '城鎮三', '城鎮四'];
  const clients = [];
  for (const t of towns) {
    const p = await mobCtx.newPage();
    await p.goto(`${BASE}/client.html`);
    await p.click(`.town-btn[data-town="${t}"]`);
    await p.click('#join-btn');
    await p.waitForSelector('#game-screen', { state: 'visible', timeout: 8000 });
    clients.push(p);
  }
  await delay(800);

  // ── Step 1：idle 進場名單 ──
  console.log('\n[1] idle 進場名單...');
  await snap(display, '01-idle-進場名單.png');

  // ── Step 2：開搶，截倒數開始 ──
  console.log('\n[2] 開搶...');
  await con.click('#btn-open');
  // 等 display 切換到 open-screen
  await display.waitForSelector('#open-screen.active', { timeout: 8000 });
  await delay(600);
  await snap(display, '02-open-倒數開始.png');

  // ── Step 3：城鎮一拍燈，display 定格，其他人鎖定 ──
  console.log('\n[3] 城鎮一拍燈...');
  await clients[0].click('#buzz-btn');
  // 等 display open-screen 顯示順位（城鎮一出現在列表）
  await display.waitForFunction(
    () => {
      const list = document.getElementById('open-rank-list');
      return list && list.querySelectorAll('li').length > 0;
    },
    { timeout: 8000 }
  );
  await delay(500);
  await snap(display, '03-定格倒數-display.png');
  // 城鎮二 client（clients[1]）：按鈕應被 disable（驗證中狀態）
  await delay(300);
  await snap(clients[1], '04-其他人被鎖-client.png');

  // ── Step 4：判城鎮一答對 ──
  console.log('\n[4] 判城鎮一答對...');
  // 等判定按鈕出現
  await con.waitForSelector('.v-btn[data-result="correct"]', { timeout: 8000 });
  // 找到城鎮一對應的答對鈕（第一個）
  await con.locator('.v-btn[data-result="correct"]').first().click();
  await delay(1200); // 等加分動畫
  await snap(display, '05-答對加分-display.png');

  // ── Step 5：重複兩輪，讓總分達到 30 ──
  // 輪 2：城鎮二答對（+10，總分 20）
  console.log('\n[5] 第二輪：城鎮二答對...');
  await con.click('#btn-reset');
  await delay(400);
  await con.click('#btn-open');
  await display.waitForSelector('#open-screen.active', { timeout: 8000 });
  await delay(500);
  await clients[1].click('#buzz-btn');
  await con.waitForSelector('.v-btn[data-result="correct"]', { timeout: 8000 });
  await con.locator('.v-btn[data-result="correct"]').first().click();
  await delay(800);

  // 輪 3：城鎮三答對（+10，總分 30，達標）
  console.log('\n[5] 第三輪：城鎮三答對（達標）...');
  await con.click('#btn-reset');
  await delay(400);
  await con.click('#btn-open');
  await display.waitForSelector('#open-screen.active', { timeout: 8000 });
  await delay(500);
  await clients[2].click('#buzz-btn');
  await con.waitForSelector('.v-btn[data-result="correct"]', { timeout: 8000 });
  await con.locator('.v-btn[data-result="correct"]').first().click();
  await delay(1500); // 等進度條滿動畫

  // 截達標畫面（先重設回 locked，讓 display 顯示 idle 大排行榜或 rank 畫面）
  // 但先截 open/rank 畫面的進度條
  await snap(display, '06-門檻達標-display.png');

  // ── Step 6：截 console 點燈鈕 ──
  console.log('\n[6] 截 console 點燈鈕解鎖...');
  await snap(con, '07-點燃鈕解鎖-console.png');

  // ── Step 7：點燈！等高潮畫面 ──
  console.log('\n[7] 點燃希望之燈...');
  // 先重設到 locked（讓 display 到 idle 或 rank），確保點燈時 display 在可見狀態
  await con.click('#btn-reset');
  await delay(500);

  // 點燈
  const igniteBtn = con.locator('#btn-ignite');
  // 確認按鈕未 disabled
  const isDisabled = await igniteBtn.getAttribute('disabled');
  console.log(`  點燈按鈕 disabled 狀態: ${isDisabled}`);
  await igniteBtn.click();
  // 等動畫高潮：ig-titles 出現約在 3.2 秒後
  await delay(3800);
  await snap(display, '08-點燈動畫高潮-display.png');

  // 等動畫結束後額外等待
  await delay(2000);

  // ── Step 8：重設回 idle，截大型排行榜 ──
  console.log('\n[8] 重設回 idle，截大型排行榜...');
  await con.click('#btn-reset');
  await display.waitForSelector('#idle-screen.active', { timeout: 8000 });
  await delay(1000);
  await snap(display, '09-idle大型排行榜-display.png');

  console.log('\n所有截圖完成！');

  await browser.close();
  server.kill();
  process.exit(0);
}

main().catch(e => {
  console.error('錯誤:', e);
  process.exit(1);
});

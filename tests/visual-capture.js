// 功能性 + 介面顯示驗證：實際驅動完整流程，逐一截圖各關鍵畫面。
//   node tests/visual-capture.js
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('@playwright/test');

const PORT = 3300, PIN = 'VISUAL';
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.screenshots');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN },
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server timeout')), 10000);
    server.stdout.on('data', d => { if (d.toString().includes('running at')) { clearTimeout(t); res(); } });
    server.on('error', rej);
  });

  const browser = await chromium.launch();
  const big = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const mob = await browser.newContext({ viewport: { width: 390, height: 780 } });

  const display = await big.newPage();
  const con = await big.newPage();
  await display.goto(`${BASE}/display.html`);

  // 學員登入畫面（先截一張未加入的）
  const loginPeek = await mob.newPage();
  await loginPeek.goto(`${BASE}/client.html`);
  await delay(400);
  await loginPeek.screenshot({ path: path.join(SHOTS, 'vfx-00-client-login.png') });
  await loginPeek.close();

  // 主持端 PIN 登入
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN);
  await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state: 'hidden' });

  // 三個城鎮加入（點選城鎮）
  const teams = ['城鎮一', '城鎮二', '城鎮三'];
  const clients = [];
  for (const t of teams) {
    const p = await mob.newPage();
    await p.goto(`${BASE}/client.html`);
    await p.click(`.town-btn[data-town="${t}"]`);
    await p.waitForSelector('#game-screen', { state: 'visible' });
    clients.push(p);
  }
  await delay(600);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-01-display-idle-joined.png') });
  await con.screenshot({ path: path.join(SHOTS, 'vfx-02-console-locked.png') });
  await clients[0].screenshot({ path: path.join(SHOTS, 'vfx-03-client-locked.png') });

  // 開搶
  await con.click('#btn-open');
  await delay(700);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-04-display-open-waiting.png') });
  await clients[0].screenshot({ path: path.join(SHOTS, 'vfx-05-client-open.png') });

  // 搶答：藍 → 綠 → 紅
  await clients[1].click('#buzz-btn'); await delay(300);
  await clients[2].click('#buzz-btn'); await delay(300);
  await clients[0].click('#buzz-btn'); await delay(600);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-06-display-open-liveorder.png') });
  await con.screenshot({ path: path.join(SHOTS, 'vfx-07-console-buzzlist.png') });
  await clients[1].screenshot({ path: path.join(SHOTS, 'vfx-08-client-buzzed.png') });

  // 判第 1 名「答錯」→ 捕捉大 X
  await con.locator('.v-btn[data-result="wrong"]').first().click();
  await delay(350);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-09-display-wrong-X.png') });
  await delay(1700);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-10-display-reviewing-focus.png') });
  await con.screenshot({ path: path.join(SHOTS, 'vfx-11-console-after-wrong.png') });

  // 判遞補者「答對」→ 捕捉彩帶 + 排名回顧
  await con.locator('.v-btn[data-result="correct"]').first().click();
  await delay(450);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-12-display-correct-confetti.png') });
  await delay(1400);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-13-display-rank-recap.png') });
  await con.screenshot({ path: path.join(SHOTS, 'vfx-14-console-results.png') });

  // 重設 → 回 idle
  await con.click('#btn-reset');
  await delay(600);
  await display.screenshot({ path: path.join(SHOTS, 'vfx-15-display-idle-reset.png') });

  console.log('✅ 視覺驗證截圖完成，共 16 張，存於 .screenshots/');
  await browser.close();
  server.kill();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

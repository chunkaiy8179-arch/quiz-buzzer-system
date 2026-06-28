// 快速擷取 client 搶答鈕三狀態（可搶 / 已搶到 / 鎖定）截圖，肉眼確認石板獎章視覺
//   node tests/client-capture.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const PORT = 3413, PIN = 'CLI8';
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.screenshots', 'refactor');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: '90' },
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server timeout')), 10000);
    server.stdout.on('data', d => { if (d.toString().includes('running at')) { clearTimeout(t); res(); } });
  });
  const browser = await chromium.launch();
  const mob = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const big = await browser.newContext({ viewport: { width: 1100, height: 720 } });

  const con = await big.newPage();
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN); await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state: 'hidden' });

  const a = await mob.newPage(); await a.goto(`${BASE}/client.html`);
  await a.click('.town-btn[data-town="城鎮一"]'); await a.click('#join-btn');
  await a.waitForSelector('#game-screen', { state: 'visible' });
  const b = await mob.newPage(); await b.goto(`${BASE}/client.html`);
  await b.click('.town-btn[data-town="城鎮二"]'); await b.click('#join-btn');
  await b.waitForSelector('#game-screen', { state: 'visible' });

  await delay(400);
  await a.screenshot({ path: path.join(SHOTS, 'client-1-待命locked.png') });

  await con.click('#btn-open'); await delay(500);
  await a.screenshot({ path: path.join(SHOTS, 'client-2-可搶open.png') });

  await a.click('#buzz-btn', { force: true }); await delay(500);
  await a.screenshot({ path: path.join(SHOTS, 'client-3-已搶到buzzed.png') });
  await b.screenshot({ path: path.join(SHOTS, 'client-4-他人驗證中review.png') });

  // 判 a 答錯 → a 出局（破損石板）
  await con.click('.v-btn[data-result="wrong"]'); await delay(500);
  await a.screenshot({ path: path.join(SHOTS, 'client-5-出局out.png') });

  console.log('✅ client 截圖完成 →', SHOTS);
  await browser.close(); server.kill(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(2); });

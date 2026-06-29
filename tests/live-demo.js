// 實際走一輪完整流程並逐步截圖（投影端為主 + 學員端 + 主控端）
//   node tests/live-demo.js   → 截圖存 .screenshots/refactor/demo/
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const PORT = 3414, PIN = 'DEMO8';
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.screenshots', 'refactor', 'demo');
const delay = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
const shot = async (page, name) => { n++; try { await page.bringToFront(); } catch {} await delay(250); await page.screenshot({ path: path.join(SHOTS, `${String(n).padStart(2,'0')}-${name}.png`) }); };

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const sf = path.join(__dirname, '..', 'state.json'); if (fs.existsSync(sf)) try { fs.unlinkSync(sf); } catch {}
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: '90', LIGHT_THRESHOLD: '20' },
  });
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 10000); server.stdout.on('data', d => { if (d.toString().includes('running at')) { clearTimeout(t); res(); } }); });

  // headed：視窗真的彈出在螢幕上；slowMo 放慢每個動作方便肉眼看
  const browser = await chromium.launch({ headless: false, slowMo: 350 });
  const big = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const conCtx = await browser.newContext({ viewport: { width: 900, height: 760 } });
  const mob = await browser.newContext({ viewport: { width: 390, height: 780 } });

  const display = await big.newPage();
  await display.goto(`${BASE}/display.html`);
  await display.evaluate(() => document.getElementById('audio-unlock')?.classList.add('hidden'));
  const con = await conCtx.newPage();
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN); await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state: 'hidden' });

  async function dismiss() { if (await con.evaluate(() => { const o = document.getElementById('confirm-overlay'); return o && !o.classList.contains('hidden'); })) await con.click('#cd-ok'); }
  async function resetRound() { await con.click('#btn-reset'); await delay(150); await dismiss(); await delay(200); }
  async function setPoints(p) { await con.click(`.points-chip[data-points="${p}"]`); }
  async function correct() { await con.click('.v-btn[data-result="correct"]'); await delay(120); await dismiss(); }

  // 8 城鎮加入
  const TOWNS = ['城鎮一','城鎮二','城鎮三','城鎮四','城鎮五','城鎮六','城鎮七','城鎮八'];
  const clients = [];
  for (const t of TOWNS) {
    const p = await mob.newPage(); await p.goto(`${BASE}/client.html`);
    await p.click(`.town-btn[data-town="${t}"]`); await p.click('#join-btn');
    await p.waitForSelector('#game-screen', { state: 'visible' }); clients.push(p);
  }
  const byTown = t => clients[TOWNS.indexOf(t)];
  await delay(600);
  await shot(display, 'idle-進場8城鎮');
  await shot(clients[0], 'client-待命');

  // 一回合：開搶 → 城鎮五搶 → 答錯續搶 → 城鎮三搶 → 答對
  await con.click('#btn-open'); await delay(700);
  await shot(display, 'open-五段三欄倒數中');
  await shot(clients[0], 'client-可搶搶答');

  await byTown('城鎮五').click('#buzz-btn', { force: true }); await delay(600);
  await shot(display, 'reviewing-城鎮五獲得答題權');
  await shot(byTown('城鎮五'), 'client-您搶到啦');
  await shot(byTown('城鎮一'), 'client-他人驗證中');

  await con.click('.v-btn[data-result="wrong"]'); await delay(700); // 城鎮五答錯→出局、續搶
  await shot(display, '答錯X-城鎮五出局續搶');
  await shot(byTown('城鎮五'), 'client-答錯出局');

  await byTown('城鎮三').click('#buzz-btn', { force: true }); await delay(500);
  await setPoints(10); await correct(); await delay(900);
  await shot(display, '答對-城鎮三撒花加分');
  await delay(1200);
  await shot(display, '答對-本題結果回顧');
  await resetRound();

  // 再兩回合做出分差，讓英雄榜有排序（城鎮二 +20、城鎮一 +30）
  await con.click('#btn-open'); await delay(400);
  await byTown('城鎮二').click('#buzz-btn', { force: true }); await delay(400);
  await setPoints(20); await correct(); await delay(700); await resetRound();

  await con.click('#btn-open'); await delay(400);
  await byTown('城鎮一').click('#buzz-btn', { force: true }); await delay(400);
  await setPoints(30); await correct(); await delay(700); await resetRound();

  // 再開一回合：右側英雄榜現在有 3 隊（城鎮一30 > 城鎮二20 > 城鎮三10）
  await con.click('#btn-open'); await delay(800);
  await shot(display, 'open-右欄英雄榜排序');
  await shot(con, 'console-主控台計分點燈');
  await resetRound();

  // 點燈高潮（總分 60 ≥ 門檻 20）
  await delay(300);
  await con.click('#btn-ignite'); await delay(120); await dismiss();
  await delay(1500); await shot(display, 'ignite-聖杯點燃');
  await delay(2200); await shot(display, 'ignite-希望之燈獨佔');

  console.log('✅ 實際走一輪完成，共', n, '張 →', SHOTS);
  console.log('（視窗會停留 9 秒讓你看最後的點燈，然後自動關閉；想提前關按 Ctrl+C）');
  await delay(9000);
  await browser.close(); server.kill(); process.exit(0);
}
main().catch(e => { console.error('demo 錯誤：', e); process.exit(2); });

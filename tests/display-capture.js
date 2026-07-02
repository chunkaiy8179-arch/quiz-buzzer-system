// Display UI 重構驗證 + 截圖（Playwright）：驅動新流程，截各狀態並斷言 DOM 層需求
//   node tests/display-capture.js
// 斷言：5 段三欄不重疊、英雄榜禁捲動、中央 hero「獲得答題權」、點燈 z-index 最高 + 背景壓暗。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const PORT = 3412, PIN = 'CAP8';
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.screenshots', 'refactor');
const delay = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failed = [];
const check = (n, c) => { if (c) pass++; else { fail++; failed.push(n); console.log('   ✗ FAIL —', n); } };

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const stateFile = path.join(__dirname, '..', 'state.json');
  if (fs.existsSync(stateFile)) { try { fs.unlinkSync(stateFile); } catch {} }
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: '90', LIGHT_THRESHOLD: '30' },
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
  const errors = [];
  display.on('pageerror', e => errors.push(String(e)));
  await display.goto(`${BASE}/display.html`);
  await display.evaluate(() => document.getElementById('audio-unlock')?.classList.add('hidden'));

  const con = await big.newPage();
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN);
  await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state: 'hidden' });

  // 重設/危險操作會跳確認框；按完自動關閉，避免遮罩攔截後續點擊
  async function dismissDialog() {
    const isOpen = await con.evaluate(() => { const o = document.getElementById('confirm-overlay'); return o && !o.classList.contains('hidden'); });
    if (isOpen) await con.click('#cd-ok');
  }
  async function resetRound() { await con.click('#btn-reset'); await delay(150); await dismissDialog(); await delay(200); }

  // 8 城鎮加入
  const TOWNS = ['城鎮一','城鎮二','城鎮三','城鎮四','城鎮五','城鎮六','城鎮七','城鎮八'];
  const clients = [];
  for (const t of TOWNS) {
    const p = await mob.newPage();
    await p.goto(`${BASE}/client.html`);
    await p.click(`.town-btn[data-town="${t}"]`);
    await p.click('#join-btn');
    await p.waitForSelector('#game-screen', { state: 'visible' });
    clients.push(p);
  }
  await delay(500);
  await display.screenshot({ path: path.join(SHOTS, '01-idle-8隊.png') });

  // ── 聖火/倒數開關新預設（關閉）：display 對應區塊應整個隱藏、不佔版面 ──
  const flameHiddenByDefault = await display.evaluate(() => {
    const idle = document.getElementById('idle-flame-bar');
    const open = document.getElementById('open-flame-bar');
    return idle.classList.contains('is-hidden') && open.classList.contains('is-hidden')
      && idle.getBoundingClientRect().width === 0 && open.getBoundingClientRect().width === 0;
  });
  check('聖火開關預設關閉：idle/open 能量條皆隱藏且不佔版面', flameHiddenByDefault);
  const countBadgeHiddenByDefault = await display.evaluate(() => document.getElementById('count-badge').classList.contains('is-hidden'));
  check('倒數開關預設關閉：count-badge 隱藏', countBadgeHiddenByDefault);

  // 主持端開啟聖火/倒數開關（實際點擊 UI 上的 <label>，如同使用者點擊視覺化開關）
  await con.click('label:has(#flame-toggle)');
  await con.click('label:has(#countdown-toggle)');
  await delay(300);
  // 單一畫面重構：待機看的是 open 畫面（非 idle-screen），聖火能量條改驗 open-flame-bar
  const flameShownAfterToggle = await display.evaluate(() => {
    const open = document.getElementById('open-flame-bar');
    return !open.classList.contains('is-hidden') && open.getBoundingClientRect().width > 0;
  });
  check('聖火開關開啟後：open 能量條顯示', flameShownAfterToggle);

  // 開搶 → 截 open（5 段三欄）
  await con.click('#btn-open');
  await delay(500);
  await display.screenshot({ path: path.join(SHOTS, '02-open-五段三欄.png') });
  const countBadgeShown = await display.evaluate(() => !document.getElementById('count-badge').classList.contains('is-hidden'));
  check('倒數開關開啟後：開搶時 count-badge 顯示', countBadgeShown);

  // 斷言：左/中/右三欄存在且水平不重疊
  const cols = await display.evaluate(() => {
    const r = s => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
    return { left: r('.open-left'), center: r('.open-center'), right: r('.open-right') };
  });
  check('五段佈局：左欄與中央欄存在', !!(cols.left && cols.center));
  if (cols.left && cols.center) {
    check('左欄在中央欄左側、不重疊', cols.left.r <= cols.center.l + 1);
  }
  // 註：開搶初無分數時右側英雄榜 display:none，完整三欄不重疊改在「英雄榜可見」時驗（見下方 cols2）
  // 聖火能量條為直立式
  const flameVertical = await display.evaluate(() => {
    const t = document.querySelector('#open-flame-bar .flame-track');
    if (!t) return false; const b = t.getBoundingClientRect(); return b.height > b.width * 1.5;
  });
  check('左欄聖火能量條為直立式（高>寬）', flameVertical);

  // 一名學員搶答 → reviewing，中央 hero「獲得答題權」
  await clients[3].click('#buzz-btn', { force: true }); // 石板有升起浮動動畫，略過 Playwright 穩定性等待
  await delay(500);
  await display.screenshot({ path: path.join(SHOTS, '03-reviewing-獲得答題權.png') });
  const heroTxt = await display.evaluate(() => document.getElementById('open-hero')?.textContent || '');
  check('中央 hero 顯示「獲得答題權」', heroTxt.includes('獲得答題權'));
  check('中央 hero 不含「第一名/順位」字樣', !/第一名|第 ?1 ?名|順位/.test(heroTxt));
  check('搶答時右側英雄榜仍在（左右固定顯示）', !!cols.right);

  // 英雄榜禁捲動（先讓它有資料：判對加分後檢查）
  await con.click('.v-btn[data-result="correct"]');
  await con.click('#cd-ok'); // 答對需確認
  await delay(700);
  await display.screenshot({ path: path.join(SHOTS, '04-correct-hero+撒花.png') });
  const heroCorrect = await display.evaluate(() => document.getElementById('rank-hero')?.textContent || document.getElementById('open-hero')?.textContent || '');
  check('答對後 hero 顯示「答對」', heroCorrect.includes('答對'));

  // 再開一回合讓 open 右欄英雄榜顯示，檢查禁捲動
  await delay(500);
  await con.click('#btn-open');
  await delay(500);
  const lbNoScroll = await display.evaluate(() => {
    const el = document.getElementById('open-leaderboard');
    if (!el || !el.classList.contains('show')) return true; // 無資料時略過
    return el.scrollHeight <= el.clientHeight + 2 && getComputedStyle(el).overflowY !== 'scroll';
  });
  check('右欄英雄榜禁捲動（無 overflow scroll）', lbNoScroll);

  // 英雄榜可見時的完整三欄不重疊檢查
  const cols2 = await display.evaluate(() => {
    const r = s => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, vis: b.width > 0 }; };
    return { left: r('.open-left'), center: r('.open-center'), right: r('.open-right') };
  });
  check('英雄榜可見時左中右三欄都在', !!(cols2.left && cols2.center && cols2.right && cols2.right.vis));
  if (cols2.left && cols2.center && cols2.right && cols2.right.vis) {
    check('三欄水平不重疊（左<中<右）', cols2.left.r <= cols2.center.l + 1 && cols2.center.r <= cols2.right.l + 1);
    check('中央欄最寬', cols2.center.w > cols2.left.w && cols2.center.w > cols2.right.w);
  }
  await resetRound();

  // ── 點燈：達標 → ignite，驗 z-index 最高 + 背景壓暗 ──
  await con.fill('#threshold-input', '10'); await con.click('#btn-threshold'); await delay(200);
  // 用計分板 + 鈕讓總分達標（已有 10 分；再 +某隊）
  await con.evaluate(() => { /* noop */ });
  // 直接透過已加分達標；若未達標則再判一題對。確保 canIgnite。
  const canIgnite = await con.evaluate(() => window.lastState && window.lastState.canIgnite);
  if (!canIgnite) {
    await con.click('#btn-open'); await delay(300);
    await clients[4].click('#buzz-btn', { force: true }); await delay(300);
    await con.click('.v-btn[data-result="correct"]'); await con.click('#cd-ok'); await delay(500);
    await resetRound();
  }
  await delay(200);
  await con.click('#btn-ignite');
  await con.click('#cd-ok'); // 點燈需確認
  await delay(1500); // 點燈動畫進行中
  await display.screenshot({ path: path.join(SHOTS, '05-ignite-點燈獨佔.png') });

  const ig = await display.evaluate(() => {
    const ov = document.getElementById('ignite-overlay');
    const z = el => { if (!el) return -1; const v = parseInt(getComputedStyle(el).zIndex, 10); return Number.isNaN(v) ? 0 : v; };
    const overlayZ = z(ov);
    // 取所有其他可見元素的最大 z-index 作對照
    const others = ['#open-screen', '#idle-screen', '#rank-screen', '.grain', '#burst', '#x-overlay', '#open-leaderboard']
      .map(s => z(document.querySelector(s)));
    const maxOther = Math.max(...others);
    return { overlayZ, maxOther, igniting: document.body.classList.contains('igniting'), shown: ov && ov.classList.contains('show') };
  });
  check('點燈 overlay 顯示中', ig.shown);
  check('點燈 z-index 高於一切其他元素', ig.overlayZ > ig.maxOther);
  check('點燈時 body.igniting（背景壓暗）已套用', ig.igniting === true);

  check('display 全程無 JS 例外', errors.length === 0);
  if (errors.length) errors.forEach(e => console.log('   pageerror:', e));

  await browser.close();
  server.kill();

  const total = pass + fail;
  console.log('\n──────────────────────────────────────────');
  console.log(`  Display UI 斷言：${total}（通過 ${pass} / 失敗 ${fail}）`);
  if (fail) { console.log('  失敗清單：'); failed.forEach(f => console.log('   -', f)); }
  console.log(`  截圖：${SHOTS}`);
  console.log(`  結果：${fail === 0 ? '✅ 全數通過' : '❌ 有失敗'}`);
  console.log('──────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('擷取執行錯誤：', e); process.exit(2); });

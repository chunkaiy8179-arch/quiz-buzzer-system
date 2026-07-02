// 本批四項改動的功能驗證（Playwright headless）：
//   node tests/toggle-features-check.js
// 1) 倒數計時開關（預設關）  2) 聖火能量顯示開關（預設關）
// 3) 記分板編輯鎖（預設鎖）  4) client 搶答鈕回大理石材（無獎章圖引用）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const PORT = 3419, PIN = 'TGCK';
const BASE = `http://localhost:${PORT}`;
const delay = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failed = [];
const check = (n, c) => { if (c) pass++; else { fail++; failed.push(n); console.log('   ✗ FAIL —', n); } };

async function main() {
  const stateFile = path.join(__dirname, '..', 'state.json');
  if (fs.existsSync(stateFile)) { try { fs.unlinkSync(stateFile); } catch {} }
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: '3', LIGHT_THRESHOLD: '30' },
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
  const pageErrors = [];
  display.on('pageerror', e => pageErrors.push(String(e)));
  await display.goto(`${BASE}/display.html`);
  await display.evaluate(() => document.getElementById('audio-unlock')?.classList.add('hidden'));

  const con = await big.newPage();
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN);
  await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state: 'hidden' });

  async function dismissDialog() {
    const isOpen = await con.evaluate(() => { const o = document.getElementById('confirm-overlay'); return o && !o.classList.contains('hidden'); });
    if (isOpen) await con.click('#cd-ok');
  }
  async function resetRound() { await con.click('#btn-reset'); await delay(150); await dismissDialog(); await delay(150); }

  // 一名學員加入，供搶答/記分測試用
  async function join(t) {
    const p = await mob.newPage();
    await p.goto(`${BASE}/client.html`);
    await p.click(`.town-btn[data-town="${t}"]`);
    await p.click('#join-btn');
    await p.waitForSelector('#game-screen', { state: 'visible' });
    return p;
  }
  const c1 = await join('城鎮一');
  const c2 = await join('城鎮二');
  await delay(300);

  console.log('\n=== 1) 倒數計時開關（預設關）===');
  // 主持端載入時 checkbox 應未勾選（預設關）
  const countdownCheckedInitial = await con.evaluate(() => document.getElementById('countdown-toggle').checked);
  check('主持端倒數開關預設未勾選', countdownCheckedInitial === false);

  await con.click('#btn-open');
  await delay(300);
  const countBadgeHidden1 = await display.evaluate(() => document.getElementById('count-badge').classList.contains('is-hidden'));
  check('倒數關閉：開放搶答後 #count-badge 帶 is-hidden（不顯示）', countBadgeHidden1);
  const remainingMsNull1 = await con.evaluate(() => lastState && lastState.remainingMs === null);
  check('倒數關閉：state.remainingMs 為 null', remainingMsNull1);
  // 靜候超過 COUNT_FROM 秒，確認不會自動 time_up（closed 仍為 false、phase 仍 open）
  await delay(4000);
  const stillOpenAfterWait = await con.evaluate(() => lastState && lastState.phase === 'open' && lastState.closed === false);
  check('倒數關閉：久候不會自動 time_up（phase 仍 open、closed=false）', stillOpenAfterWait);
  await resetRound();

  // 開啟倒數開關 → count-badge 應顯示、正常倒數
  await con.click('label:has(#countdown-toggle)');
  await delay(200);
  const countdownCheckedAfter = await con.evaluate(() => document.getElementById('countdown-toggle').checked);
  check('切換後主持端倒數開關已勾選', countdownCheckedAfter === true);

  await con.click('#btn-open');
  await delay(300);
  const countBadgeShown = await display.evaluate(() => !document.getElementById('count-badge').classList.contains('is-hidden'));
  check('倒數開啟：開放搶答後 #count-badge 顯示（無 is-hidden）', countBadgeShown);
  const remainingMsSet = await con.evaluate(() => lastState && typeof lastState.remainingMs === 'number' && lastState.remainingMs > 0);
  check('倒數開啟：state.remainingMs 為正數', remainingMsSet);
  // 靜候超過 COUNT_FROM 秒，確認會自動 time_up + closed
  await delay(4000);
  const timedOut = await con.evaluate(() => lastState && lastState.closed === true);
  check('倒數開啟：久候後自動逾時 closed=true', timedOut);
  await resetRound();

  console.log('\n=== 2) 聖火能量顯示開關（預設關）===');
  const flameCheckedInitial = await con.evaluate(() => document.getElementById('flame-toggle').checked);
  check('主持端聖火開關預設未勾選', flameCheckedInitial === false);

  const idleFlameHidden1 = await display.evaluate(() => document.getElementById('idle-flame-bar').classList.contains('is-hidden'));
  check('聖火關閉：idle 畫面 #idle-flame-bar 帶 is-hidden', idleFlameHidden1);
  await con.click('#btn-open');
  await delay(300);
  const openFlameHidden1 = await display.evaluate(() => document.getElementById('open-flame-bar').classList.contains('is-hidden'));
  check('聖火關閉：open 畫面 #open-flame-bar 帶 is-hidden', openFlameHidden1);
  await resetRound();

  // 開啟聖火開關 → 兩條都應移除 is-hidden 顯示
  await con.click('label:has(#flame-toggle)');
  await delay(200);
  const flameCheckedAfter = await con.evaluate(() => document.getElementById('flame-toggle').checked);
  check('切換後主持端聖火開關已勾選', flameCheckedAfter === true);

  const idleFlameShown = await display.evaluate(() => {
    const el = document.getElementById('idle-flame-bar');
    return !el.classList.contains('is-hidden') && el.getBoundingClientRect().width > 0;
  });
  check('聖火開啟：idle 畫面 #idle-flame-bar 顯示（無 is-hidden 且有寬度）', idleFlameShown);
  await con.click('#btn-open');
  await delay(300);
  const openFlameShown = await display.evaluate(() => {
    const el = document.getElementById('open-flame-bar');
    return !el.classList.contains('is-hidden') && el.getBoundingClientRect().width > 0;
  });
  check('聖火開啟：open 畫面 #open-flame-bar 顯示（無 is-hidden 且有寬度）', openFlameShown);
  await resetRound();

  console.log('\n=== 3) 記分板編輯鎖（預設鎖）===');
  // 先讓城鎮一有分數，確保記分板有渲染內容
  await con.click('#btn-open');
  await delay(200);
  await c1.click('#buzz-btn', { force: true });
  await delay(300);
  await con.click('.v-btn[data-result="correct"]');
  await con.click('#cd-ok');
  await delay(400);
  await resetRound();

  const scoreEditCheckedInitial = await con.evaluate(() => document.getElementById('score-edit-toggle')?.checked);
  check('記分板編輯鎖預設未勾選（鎖定中）', scoreEditCheckedInitial === false);
  const adjDisabledLocked = await con.evaluate(() => {
    const btns = [...document.querySelectorAll('.score-adj button')];
    return btns.length > 0 && btns.every(b => b.disabled);
  });
  check('鎖定時：所有 .score-adj button 皆 disabled', adjDisabledLocked);
  const resetDisabledLocked = await con.evaluate(() => document.querySelector('.btn-score-reset')?.disabled === true);
  check('鎖定時：「分數歸零」按鈕 disabled', resetDisabledLocked);

  // 鎖定時點擊加分鈕應無效（不送出 host_score_adjust）
  const scoreBeforeLockedClick = await con.evaluate(() => lastState.scores['城鎮一'] || 0);
  await con.click('.s-plus', { force: true });
  await delay(200);
  const scoreAfterLockedClick = await con.evaluate(() => lastState.scores['城鎮一'] || 0);
  check('鎖定時點擊加分鈕無效（分數不變）', scoreAfterLockedClick === scoreBeforeLockedClick);

  // 解鎖
  await con.click('label:has(#score-edit-toggle)');
  await delay(200);
  const scoreEditCheckedAfter = await con.evaluate(() => document.getElementById('score-edit-toggle')?.checked);
  check('解鎖後 checkbox 已勾選', scoreEditCheckedAfter === true);
  const adjEnabledUnlocked = await con.evaluate(() => {
    const btns = [...document.querySelectorAll('.score-adj button')];
    return btns.length > 0 && btns.every(b => !b.disabled);
  });
  check('解鎖後：所有 .score-adj button 皆非 disabled', adjEnabledUnlocked);
  const resetEnabledUnlocked = await con.evaluate(() => document.querySelector('.btn-score-reset')?.disabled === false);
  check('解鎖後：「分數歸零」按鈕非 disabled', resetEnabledUnlocked);

  // 解鎖後點擊加分鈕應生效
  const scoreBeforeUnlockedClick = await con.evaluate(() => lastState.scores['城鎮一'] || 0);
  await con.click('.s-plus');
  await delay(250);
  const scoreAfterUnlockedClick = await con.evaluate(() => lastState.scores['城鎮一'] || 0);
  check('解鎖後點擊加分鈕生效（分數增加）', scoreAfterUnlockedClick > scoreBeforeUnlockedClick);

  // 再鎖回去
  await con.click('label:has(#score-edit-toggle)');
  await delay(200);
  const relockedDisabled = await con.evaluate(() => {
    const btns = [...document.querySelectorAll('.score-adj button')];
    return btns.length > 0 && btns.every(b => b.disabled) && document.querySelector('.btn-score-reset')?.disabled === true;
  });
  check('再鎖定後：加減分鈕與歸零鈕又變回 disabled', relockedDisabled);

  console.log('\n=== 4) client 搶答鈕回大理石材（無獎章圖引用）===');
  // 原始碼層級：全域無 buzz.png / buzz-broken.png 引用
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.html'), 'utf8');
  const swSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  check('client.html 原始碼無 buzz.png 引用', !/buzz\.png/.test(clientSrc));
  check('client.html 原始碼無 buzz-broken.png 引用', !/buzz-broken\.png/.test(clientSrc));
  check('sw.js 原始碼無 buzz.png 引用', !/buzz\.png/.test(swSrc));
  check('sw.js 原始碼無 buzz-broken\\.png 引用', !/buzz-broken\.png/.test(swSrc));
  check('sw.js CACHE 版本已推進為 v37 或以上', /buzzer-v3[7-9]|buzzer-v[4-9]\d/.test(swSrc));

  // DOM/computed style 層級：c2（城鎮二）走過 locked → open → buzzed 三態，逐一驗證無 background-image url()
  const bgOf = async page => page.evaluate(() => {
    const btn = document.getElementById('buzz-btn');
    return getComputedStyle(btn).backgroundImage;
  });
  const bgLocked = await bgOf(c2);
  check('state-locked：computed background-image 無 buzz png url', !/buzz(-broken)?\.png/.test(bgLocked));

  await con.click('#btn-open');
  await delay(300);
  const stateOpen = await c2.evaluate(() => document.getElementById('buzz-btn').classList.contains('state-open'));
  check('城鎮二按鈕已進入 state-open', stateOpen);
  const bgOpen = await bgOf(c2);
  check('state-open：computed background-image 無 buzz png url', !/buzz(-broken)?\.png/.test(bgOpen));

  await c2.click('#buzz-btn', { force: true });
  await delay(300);
  const stateBuzzed = await c2.evaluate(() => document.getElementById('buzz-btn').classList.contains('state-buzzed'));
  check('城鎮二按鈕已進入 state-buzzed', stateBuzzed);
  const bgBuzzed = await bgOf(c2);
  check('state-buzzed：computed background-image 無 buzz png url', !/buzz(-broken)?\.png/.test(bgBuzzed));

  // 判錯 → state-out
  await con.click('.v-btn[data-result="wrong"]');
  await delay(300);
  const stateOut = await c2.evaluate(() => document.getElementById('buzz-btn').classList.contains('state-out'));
  check('城鎮二按鈕已進入 state-out（答錯出局）', stateOut);
  const bgOut = await bgOf(c2);
  check('state-out：computed background-image 無 buzz png url', !/buzz(-broken)?\.png/.test(bgOut));
  await resetRound();

  check('display 全程無 JS 例外', pageErrors.length === 0);
  if (pageErrors.length) pageErrors.forEach(e => console.log('   pageerror:', e));

  await browser.close();
  server.kill();

  const total = pass + fail;
  console.log('\n──────────────────────────────────────────');
  console.log(`  四項功能驗證：${total}（通過 ${pass} / 失敗 ${fail}）`);
  if (fail) { console.log('  失敗清單：'); failed.forEach(f => console.log('   -', f)); }
  console.log(`  結果：${fail === 0 ? '✅ 全數通過' : '❌ 有失敗'}`);
  console.log('──────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('驗證執行錯誤：', e); process.exit(2); });

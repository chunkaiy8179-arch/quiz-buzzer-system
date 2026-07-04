// 回歸測試：display.html 三處改動的行為驗證（不動產品程式碼，只驗證）
//   node tests/regression-lb-wrong-flip.js
// 對應改動：
//   1) applyState locked 分支：wrongOverlayUntil 保留窗內不清 x-overlay（答錯大叉叉能撐住 ~1800ms，不被緊跟的 state 秒清）
//   2) flipCapture：移除 prefers-reduced-motion 閘門（reduced-motion 環境下 FLIP 換位滑動仍套用 transform）
//   3) renderOpenLeaderboard：複用既有 DOM 節點重排順序，而非整批 remove+重建
//      → 同一隊伍換名次後 data-lb-team 對應的 DOM node 應維持同一參考（reference equality）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const PORT = 3421, PIN = 'RGWF';
const BASE = `http://localhost:${PORT}`;
const delay = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const failed = [];
const check = (n, c) => { if (c) pass++; else { fail++; failed.push(n); console.log('   ✗ FAIL —', n); } };

async function main() {
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
  // reduced-motion 環境：驗證改動 2（flipCapture 不受此閘門影響）
  const big = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
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
  async function resetRound() { await con.click('#btn-reset'); await delay(150); await dismissDialog(); await delay(200); }

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
  const c3 = await join('城鎮三');
  await delay(300);

  console.log('\n=== 1) 答錯大叉叉存活 wrongOverlayUntil 保留窗（不被緊跟的 state(locked) 秒清）===');
  await con.click('#btn-open');
  await delay(250);
  await c1.click('#buzz-btn', { force: true });
  await delay(250);
  await con.click('.v-btn[data-result="wrong"]');
  // 答錯不需確認框（host_verify 直接送出），緊接著 server 會廣播 verify_result(wrong) + state(open，續搶)
  await delay(150); // 給時間讓 verify_result 與緊跟的 state 都已抵達（<<1800ms 保留窗）
  const overlayShownSoonAfter = await display.evaluate(() => document.getElementById('x-overlay').classList.contains('show'));
  check('答錯後 150ms：x-overlay 仍顯示（未被緊跟的 state 秒清）', overlayShownSoonAfter);

  await delay(900); // 累計 ~1050ms，仍在 1800ms 保留窗內
  const overlayShownMidWindow = await display.evaluate(() => document.getElementById('x-overlay').classList.contains('show'));
  check('答錯後 ~1050ms（仍在 1800ms 保留窗內）：x-overlay 仍顯示', overlayShownMidWindow);

  await delay(900); // 累計 ~1950ms，超過 1800ms 保留窗，應已被 setTimeout 清除
  const overlayGoneAfterWindow = await display.evaluate(() => document.getElementById('x-overlay').classList.contains('show'));
  check('答錯後 ~1950ms（超過 1800ms 保留窗）：x-overlay 已消失', !overlayGoneAfterWindow);
  await resetRound();

  console.log('\n=== 2) flipCapture 不受 prefers-reduced-motion 閘門影響（reduced-motion 環境下仍記錄/套用 FLIP）===');
  const prefersReduced = await display.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  check('測試環境確實已模擬 prefers-reduced-motion: reduce', prefersReduced === true);

  // 讓城鎮一、二、三都有分數，且順位會因為後續加分而變動，觸發 FLIP 換位
  await con.click('#btn-open'); await delay(200);
  await c1.click('#buzz-btn', { force: true }); await delay(200);
  await con.click('.points-chip[data-points="10"]');
  await con.click('.v-btn[data-result="correct"]'); await delay(120); await dismissDialog(); await delay(300);
  await resetRound();

  await con.click('#btn-open'); await delay(200);
  await c2.click('#buzz-btn', { force: true }); await delay(200);
  await con.click('.points-chip[data-points="10"]');
  await con.click('.v-btn[data-result="correct"]'); await delay(120); await dismissDialog(); await delay(300);
  await resetRound();

  // 記錄城鎮三（目前 0 分、排最後）此刻的 row 節點與畫面位置，再讓它反超到第一名，驗證 FLIP transform 有被套用
  const rowTopBefore = await display.evaluate(() => {
    const row = document.querySelector('#open-leaderboard .lb-row[data-lb-team="城鎮三"]');
    return row ? row.getBoundingClientRect().top : null;
  });
  check('城鎮三加分前 lb-row 節點存在於榜單', rowTopBefore !== null);

  // 在觸發加分「之前」先安裝 hook：用 MutationObserver 監看城鎮三 row 的 style attribute 變化，
  // 不管 flipPlay 的 transform 賦值發生在哪個 rAF tick 都能可靠捕捉到（避免 polling 錯過瞬間的 race）。
  await display.evaluate(() => {
    const row = document.querySelector('#open-leaderboard .lb-row[data-lb-team="城鎮三"]');
    if (!row) return;
    window.__flipSawTransform = false;
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.attributeName === 'style' && row.style.transform && row.style.transform !== '') window.__flipSawTransform = true;
      }
    });
    mo.observe(row, { attributes: true, attributeFilter: ['style'] });
    window.__flipObserver = mo;
  });

  await con.click('#btn-open'); await delay(200);
  await c3.click('#buzz-btn', { force: true }); await delay(200);
  await con.click('.points-chip[data-points="30"]'); // 30 分反超到第一名，觸發大幅換位
  await con.click('.v-btn[data-result="correct"]'); await delay(120); await dismissDialog(); await delay(400);

  const flipApplied = await display.evaluate(() => window.__flipSawTransform === true);
  await delay(700); // 讓 FLIP transition 跑完
  const rowTopAfter = await display.evaluate(() => {
    const row = document.querySelector('#open-leaderboard .lb-row[data-lb-team="城鎮三"]');
    return row ? row.getBoundingClientRect().top : null;
  });
  check('城鎮三反超第一名後 lb-row 節點仍存在（未被摧毀重建成不同節點也能定位）', rowTopAfter !== null);
  check('城鎮三名次變動觸發了 FLIP transform（reduced-motion 環境下仍套用，未被閘門擋掉）', flipApplied === true);
  if (rowTopBefore !== null && rowTopAfter !== null) {
    check('城鎮三最終位置確實從原位置移動（反超到第一名，非停留原地）', Math.abs(rowTopAfter - rowTopBefore) > 5);
  }
  await resetRound();

  console.log('\n=== 3) renderOpenLeaderboard 節點複用：同隊伍 DOM node 參考在重排/雙重渲染後應保持一致 ===');
  // 取得目前城鎮一的 row 節點參考（透過幫節點打標記，reference equality 驗證用）
  await display.evaluate(() => {
    const row = document.querySelector('#open-leaderboard .lb-row[data-lb-team="城鎮一"]');
    if (row) row.dataset.testMarker = 'original-node-' + Date.now();
  });
  const markerBefore = await display.evaluate(() => document.querySelector('#open-leaderboard .lb-row[data-lb-team="城鎮一"]')?.dataset.testMarker);
  check('城鎮一 row 節點已標記（測試前置條件成立）', !!markerBefore);

  // 觸發一次會造成排序重排的加分（答對雙重渲染：verify_result 與緊跟的 state 都會呼叫 renderOpenLeaderboard）
  await con.click('#btn-open'); await delay(200);
  await c2.click('#buzz-btn', { force: true }); await delay(200);
  await con.click('.points-chip[data-points="10"]');
  await con.click('.v-btn[data-result="correct"]'); await delay(120); await dismissDialog(); await delay(400);

  const markerAfter = await display.evaluate(() => document.querySelector('#open-leaderboard .lb-row[data-lb-team="城鎮一"]')?.dataset.testMarker);
  check('答對雙重渲染（verify_result + 緊跟 state）後，城鎮一 row 節點仍是同一個 DOM 節點（自訂標記未消失，證明是複用而非重建）', markerAfter === markerBefore);

  // 同時驗證 data-lb-team 屬性本身在重排後仍正確對應（不會因複用節點而錯位）
  const teamAttrCorrect = await display.evaluate(() => {
    const rows = [...document.querySelectorAll('#open-leaderboard .lb-row')];
    return rows.every(r => {
      const teamTextEl = r.querySelector('.lb-team');
      return teamTextEl && teamTextEl.textContent === r.dataset.lbTeam;
    });
  });
  check('重排後每一列 data-lb-team 屬性與顯示的隊名文字仍一致（無錯位）', teamAttrCorrect);
  await resetRound();

  check('display 全程無 JS 例外', pageErrors.length === 0);
  if (pageErrors.length) pageErrors.forEach(e => console.log('   pageerror:', e));

  await browser.close();
  server.kill();

  const total = pass + fail;
  console.log('\n──────────────────────────────────────────');
  console.log(`  回歸驗證（答錯保留窗 / FLIP 動態 / 榜單節點複用）：${total}（通過 ${pass} / 失敗 ${fail}）`);
  if (fail) { console.log('  失敗清單：'); failed.forEach(f => console.log('   -', f)); }
  console.log(`  結果：${fail === 0 ? '✅ 全數通過' : '❌ 有失敗'}`);
  console.log('──────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('驗證執行錯誤：', e); process.exit(2); });

// 極限併發測試：在同一 event-loop tick 內把 N 組的搶答全部射出，
// 驗證伺服器在「時間差極小」下的排序正確性。
//
//   本地（自起 server）： node tests/stress-concurrency.js
//   打線上 Render：       TEST_WS=wss://<host> HOST_PIN=<pin> node tests/stress-concurrency.js
//
// 設定 TEST_WS 時連遠端、不自起 server；PIN 一律從 HOST_PIN 環境變數讀（不寫死在檔案）。
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const TARGET = process.env.TEST_WS || null;
const PORT = 3211;
const PIN = process.env.HOST_PIN || 'STRESS';
const BASE = TARGET || `ws://localhost:${PORT}`;
const N = 10;
const ROUNDS = 5;
const delay = ms => new Promise(r => setTimeout(r, ms));

function openSock() {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(BASE);
    const t = setTimeout(() => { s.terminate(); reject(new Error('ws connect timeout')); }, 60000);
    s.once('open', () => { clearTimeout(t); resolve(s); });
    s.once('error', err => { clearTimeout(t); reject(err); });
  });
}

async function main() {
  let server = null;
  if (!TARGET) {
    server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN },
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server start timeout')), 10000);
      server.stdout.on('data', d => { if (d.toString().includes('running at')) { clearTimeout(t); resolve(); } });
      server.on('error', reject);
    });
  }
  console.log(`目標：${BASE}\n`);

  // 觀察者（投影端視角）追蹤最新 state
  const obs = await openSock();
  let lastState = null;
  obs.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') lastState = m; });

  const host = await openSock();
  let allPass = true;

  for (let round = 1; round <= ROUNDS; round++) {
    host.send(JSON.stringify({ type: 'host_reset', pin: PIN }));
    await delay(250);

    // N 組加入
    const clients = [];
    for (let i = 0; i < N; i++) {
      const c = await openSock();
      clients.push(c);
      c.send(JSON.stringify({ type: 'join', team: `第${i + 1}組` }));
    }
    await delay(300);

    host.send(JSON.stringify({ type: 'host_open', pin: PIN }));
    await delay(300);

    // ★ 關鍵：同一 tick 內同步射出全部搶答（無 await 間隔，比真人快）
    clients.forEach((c, i) => c.send(JSON.stringify({ type: 'buzz', team: `第${i + 1}組`, ts: Date.now() })));
    await delay(700);

    // 驗證
    const order = (lastState?.buzzOrder || []);
    const teams = order.map(e => e.team);
    const uniqueTeams = new Set(teams);
    const tsList = order.map(e => e.ts);
    const tsSpread = tsList.length ? Math.max(...tsList) - Math.min(...tsList) : 0;

    const okCount = order.length === N;
    const okUnique = uniqueTeams.size === N;
    const expected = Array.from({ length: N }, (_, i) => `第${i + 1}組`);
    const okAllPresent = expected.every(t => uniqueTeams.has(t));
    const pass = okCount && okUnique && okAllPresent;
    allPass = allPass && pass;

    console.log(`── Round ${round} ${pass ? '✅ PASS' : '❌ FAIL'} ──`);
    console.log(`  登記筆數：${order.length}/${N}  唯一組別：${uniqueTeams.size}  全員到齊：${okAllPresent}`);
    console.log(`  伺服器時間戳跨度：${tsSpread}ms（越小代表搶答間隔越近）`);
    console.log(`  排序結果：${teams.join(' → ')}`);
    if (!okAllPresent) console.log(`  ⚠️ 遺漏：${expected.filter(t => !uniqueTeams.has(t)).join(', ')}`);
    console.log('');

    clients.forEach(c => c.close());
    await delay(200);
  }

  // 額外：同名重複搶答應被去重
  host.send(JSON.stringify({ type: 'host_reset', pin: PIN })); await delay(200);
  host.send(JSON.stringify({ type: 'host_open', pin: PIN })); await delay(200);
  const dupA = await openSock(); const dupB = await openSock();
  dupA.send(JSON.stringify({ type: 'join', team: '重複組' }));
  dupB.send(JSON.stringify({ type: 'join', team: '重複組' }));
  await delay(200);
  dupA.send(JSON.stringify({ type: 'buzz', team: '重複組', ts: Date.now() }));
  dupB.send(JSON.stringify({ type: 'buzz', team: '重複組', ts: Date.now() }));
  await delay(500);
  const dupCount = (lastState?.buzzOrder || []).filter(e => e.team === '重複組').length;
  const dupPass = dupCount === 1;
  allPass = allPass && dupPass;
  console.log(`── 同名去重 ${dupPass ? '✅ PASS' : '❌ FAIL'} ── 「重複組」登記 ${dupCount} 次（應為 1）`);
  dupA.close(); dupB.close();

  // 收尾：讓伺服器回到乾淨狀態（locked、清空）
  host.send(JSON.stringify({ type: 'host_reset', pin: PIN })); await delay(200);

  console.log(`\n${'='.repeat(40)}\n總結：${allPass ? '✅ 全部通過' : '❌ 有失敗'}\n${'='.repeat(40)}`);

  obs.close(); host.close();
  if (server) server.kill();
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

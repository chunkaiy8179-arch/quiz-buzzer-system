// 8 人並發搶答模擬 + 完整流程驗證（ws 直連，毫秒級同 tick 搶答）
//   node tests/sim-8users.js   或   npm run sim
// 覆蓋：≥8 人同時搶答只 1 人成功、答錯續搶換新首位、答對加分鎖定、
//       時間到鎖定、出局不可再搶、重連分數同步、調分/歸零、門檻/點燈、撤銷、狀態持久化。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 3411, PIN = 'SIM8', COUNT_FROM = 4;
const URL = `ws://localhost:${PORT}`;
const STATE_FILE = path.join(__dirname, '..', 'state.json');
const delay = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const failed = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; failed.push(name); console.log('   ✗ FAIL —', name); }
}

function open(url) {
  const ws = new WebSocket(url);
  ws._msgs = []; ws._lastState = null; ws._team = null;
  ws.on('message', d => { const m = JSON.parse(d); ws._msgs.push(m); if (m.type === 'state') ws._lastState = m; });
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const has = (ws, type) => ws._msgs.some(m => m.type === type);
const countAcross = (socks, type) => socks.filter(s => has(s, type)).length;
const clear = socks => socks.forEach(s => s._msgs = []);

async function main() {
  // 啟動受測伺服器（短倒數，方便驗時間到）
  if (fs.existsSync(STATE_FILE)) { try { fs.unlinkSync(STATE_FILE); } catch {} } // 乾淨起步
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, COUNT_FROM: String(COUNT_FROM), LIGHT_THRESHOLD: '30' },
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server timeout')), 10000);
    server.stdout.on('data', d => { if (d.toString().includes('running at')) { clearTimeout(t); res(); } });
    server.on('error', rej);
  });

  const host = await open(URL);
  send(host, { type: 'host_auth', pin: PIN });
  await delay(120);
  check('host auth_ok', has(host, 'auth_ok'));

  // 8 城鎮加入
  const TOWNS = ['城鎮一','城鎮二','城鎮三','城鎮四','城鎮五','城鎮六','城鎮七','城鎮八'];
  const clients = [];
  for (const t of TOWNS) {
    const c = await open(URL); c._team = t;
    send(c, { type: 'join', team: t });
    await delay(40);
    clients.push(c);
  }
  await delay(150);
  check('8 城鎮全部加入 join_ok', clients.every(c => has(c, 'join_ok')));
  check('host state 進場名單=8', host._lastState && host._lastState.joinedTeams.length === 8);

  const hpin = o => send(host, { ...o, pin: PIN });

  // ── 核心情境：3 回合「8 人同 tick 搶答 → 1 勝 7 鎖」+ 答錯續搶 + 答對加分 ──
  let cumulativeWins = {};
  for (let round = 1; round <= 3; round++) {
    clear([host, ...clients]);
    hpin({ type: 'host_open' });
    await delay(150);
    check(`R${round} 開搶後 phase=open`, host._lastState.phase === 'open');

    // 8 人毫秒級同 tick 拍燈
    const t0 = Date.now();
    clients.forEach(c => send(c, { type: 'buzz', team: c._team, ts: t0 }));
    await delay(250);

    const rejected = clients.filter(c => has(c, 'buzz_rejected'));
    check(`R${round} 同時搶答恰 7 人被鎖（buzz_rejected）`, rejected.length === 7);
    check(`R${round} phase 進入 reviewing`, host._lastState.phase === 'reviewing');
    check(`R${round} buzzOrder 僅 1 筆（只記第一位）`, host._lastState.buzzOrder.length === 1);
    const winner1 = host._lastState.buzzOrder[0] && host._lastState.buzzOrder[0].team;
    check(`R${round} 勝出者是唯一沒被鎖的人`, winner1 && !rejected.some(c => c._team === winner1));
    check(`R${round} 倒數定格（remainingMs 有值且 >0）`, host._lastState.remainingMs > 0);

    // 主持判第一位「答錯」→ 出局、恢復倒數續搶
    clear([host, ...clients]);
    hpin({ type: 'host_verify', team: winner1, result: 'wrong' });
    await delay(200);
    check(`R${round} 答錯後恢復 phase=open`, host._lastState.phase === 'open');
    check(`R${round} 答錯者進入 eliminated`, host._lastState.eliminated.includes(winner1));
    check(`R${round} 答錯後 buzzOrder 清空`, host._lastState.buzzOrder.length === 0);

    // 出局者再拍應被拒
    clear([host, ...clients]);
    const elimClient = clients.find(c => c._team === winner1);
    send(elimClient, { type: 'buzz', team: winner1, ts: Date.now() });
    await delay(120);
    check(`R${round} 出局者再拍被拒`, has(elimClient, 'buzz_rejected'));

    // 其餘 7 人同 tick 再搶 → 新首位
    clear([host, ...clients]);
    const rest = clients.filter(c => c._team !== winner1);
    const t1 = Date.now();
    rest.forEach(c => send(c, { type: 'buzz', team: c._team, ts: t1 }));
    await delay(250);
    const winner2 = host._lastState.buzzOrder[0] && host._lastState.buzzOrder[0].team;
    check(`R${round} 續搶產生新首位`, !!winner2 && winner2 !== winner1);
    check(`R${round} 續搶恰 6 人被鎖`, rest.filter(c => has(c, 'buzz_rejected')).length === 6);

    // 主持判第二位「答對」→ +10、鎖定
    clear([host, ...clients]);
    const before = (host._lastState.scores[winner2] || 0);
    hpin({ type: 'host_verify', team: winner2, result: 'correct', points: 10 });
    await delay(200);
    check(`R${round} 答對後 phase=locked`, host._lastState.phase === 'locked');
    check(`R${round} 答對者 +10 分`, (host._lastState.scores[winner2] || 0) === before + 10);
    check(`R${round} verify_result 廣播 correct`, has(host, 'verify_result'));
    cumulativeWins[winner2] = (cumulativeWins[winner2] || 0) + 10;

    hpin({ type: 'host_reset' });
    await delay(120);
    check(`R${round} 重設後 phase=locked 且分數保留`, host._lastState.phase === 'locked' && (host._lastState.scores[winner2] || 0) === before + 10);
  }

  // ── 時間到鎖定：開搶後不拍，等倒數歸零 ──
  clear([host, ...clients]);
  hpin({ type: 'host_open' });
  await delay(150);
  check('時間到測試：開搶 phase=open', host._lastState.phase === 'open');
  await delay(COUNT_FROM * 1000 + 600);
  check('倒數歸零廣播 time_up', has(host, 'time_up'));
  check('時間到後 closed=true', host._lastState && host._lastState.closed === true);
  // 時間到後再拍被拒
  clear([host, ...clients]);
  send(clients[0], { type: 'buzz', team: clients[0]._team, ts: Date.now() });
  await delay(150);
  check('時間到後拍燈被拒', has(clients[0], 'buzz_rejected'));
  hpin({ type: 'host_reset' });
  await delay(120);

  // ── 開搶前拍燈被拒 ──
  clear([host, ...clients]);
  send(clients[1], { type: 'buzz', team: clients[1]._team, ts: Date.now() });
  await delay(150);
  check('locked（未開搶）拍燈被拒', has(clients[1], 'buzz_rejected'));

  // ── 重連分數同步：取一個有分數的隊，斷線後帶 token 重連 ──
  const scoredTeam = Object.keys(host._lastState.scores)[0];
  const scoredClient = clients.find(c => c._team === scoredTeam);
  const tokenMsg = scoredClient._msgs.find(m => m.type === 'join_ok');
  const token = tokenMsg && tokenMsg.token;
  const scoreBefore = host._lastState.scores[scoredTeam];
  scoredClient.close();
  await delay(200);
  const re = await open(URL); re._team = scoredTeam;
  send(re, { type: 'join', team: scoredTeam, token });
  await delay(200);
  check('重連 join_ok', has(re, 'join_ok'));
  check('重連後該隊分數維持', re._lastState && (re._lastState.scores[scoredTeam] || 0) === scoreBefore);

  // ── 重名保護：不同連線、無 token、同名 → 拒絕 ──
  const dup = await open(URL);
  send(dup, { type: 'join', team: scoredTeam });
  await delay(150);
  check('重名（無 token）被拒', dup._msgs.some(m => m.type === 'join_error' && m.reason === 'duplicate'));
  dup.close();

  // ── 手動調分 + 下限 clamp 到 0 ──
  clear([host]);
  hpin({ type: 'host_score_adjust', team: scoredTeam, delta: 5 });
  await delay(120);
  check('調分 +5 生效', (host._lastState.scores[scoredTeam] || 0) === scoreBefore + 5);
  hpin({ type: 'host_score_adjust', team: scoredTeam, delta: -9999 });
  await delay(120);
  check('調分下限 clamp 至 0（移除鬼項）', (host._lastState.scores[scoredTeam] || 0) === 0);

  // ── 門檻 / 點燈：設低門檻、加分達標、點燈 ──
  hpin({ type: 'host_set_threshold', threshold: 10 });
  await delay(100);
  check('設定門檻=10', host._lastState.threshold === 10);
  hpin({ type: 'host_score_adjust', team: TOWNS[0], delta: 15 });
  await delay(120);
  check('總分達標 canIgnite=true', host._lastState.canIgnite === true);
  clear([host, ...clients]);
  hpin({ type: 'host_ignite' });
  await delay(150);
  check('點燈廣播 ignite', has(host, 'ignite'));
  check('點燈後 lit=true', host._lastState.lit === true);

  // ── 分數歸零 ──
  hpin({ type: 'host_score_reset' });
  await delay(120);
  check('分數歸零後 totalScore=0', (host._lastState.totalScore || 0) === 0);

  // ── 撤銷判定：開搶→搶→判對→撤銷，分數回退 ──
  clear([host, ...clients]);
  hpin({ type: 'host_open' });
  await delay(150);
  send(clients[2], { type: 'buzz', team: clients[2]._team, ts: Date.now() });
  await delay(150);
  hpin({ type: 'host_verify', team: clients[2]._team, result: 'correct', points: 10 });
  await delay(150);
  const afterCorrect = host._lastState.scores[clients[2]._team] || 0;
  check('撤銷前已加分', afterCorrect === 10);
  hpin({ type: 'host_unverify' });
  await delay(150);
  check('撤銷後分數回退', (host._lastState.scores[clients[2]._team] || 0) === 0);
  check('撤銷後回到 reviewing 定格', host._lastState.phase === 'reviewing');
  hpin({ type: 'host_reset' });
  await delay(120);

  // ── 狀態持久化：加分後 state.json 應落地且含該分數 ──
  hpin({ type: 'host_score_adjust', team: TOWNS[1], delta: 40 });
  await delay(700); // 等 persist debounce
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  check('state.json 已落地', !!persisted);
  check('state.json 含持久化分數', persisted && (persisted.scores[TOWNS[1]] || 0) === 40);

  // 收尾
  [host, ...clients, re].forEach(s => { try { s.close(); } catch {} });
  server.kill();

  const total = pass + fail;
  console.log('\n──────────────────────────────────────────');
  console.log(`  測試案例總數：${total}（通過 ${pass} / 失敗 ${fail}）`);
  if (fail) { console.log('  失敗清單：'); failed.forEach(f => console.log('   -', f)); }
  console.log(`  結果：${fail === 0 ? '✅ 全數通過' : '❌ 有失敗'}`);
  console.log('──────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('模擬執行錯誤：', e); process.exit(2); });

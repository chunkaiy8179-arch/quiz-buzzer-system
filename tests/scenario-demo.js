// 情境預覽：依真實活動流程模擬 10 城鎮搶答，逐情境截三端畫面，
// 並產生一頁 HTML 總覽（每情境：說明 + 學員/主持/投影 並排）。
//   node tests/scenario-demo.js  →  .screenshots/scenarios/index.html
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const PORT = 3302, PIN = 'DEMO';
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, '..', '.screenshots', 'scenarios');
const NUMS = ['一','二','三','四','五','六','七','八','九','十'];
const TOWNS = NUMS.map(n => `城鎮${n}`);
const delay = ms => new Promise(r => setTimeout(r, ms));

const scenarios = []; // { id, title, action, shots:[{label,file}] }
function scene(id, title, action){ const s={id,title,action,shots:[]}; scenarios.push(s); return s; }
async function snap(s, page, label, name){
  const file = `${s.id}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  s.shots.push({ label, file });
}

async function main(){
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: 'pipe', env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN },
  });
  await new Promise((res, rej)=>{ const t=setTimeout(()=>rej(new Error('server timeout')),10000);
    server.stdout.on('data',d=>{ if(d.toString().includes('running at')){clearTimeout(t);res();} }); server.on('error',rej); });

  const browser = await chromium.launch();
  const big = await browser.newContext({ viewport:{width:1280,height:720} });
  const mob = await browser.newContext({ viewport:{width:390,height:844} });

  const display = await big.newPage(); await display.goto(`${BASE}/display.html`);
  await display.evaluate(()=>document.getElementById('audio-unlock')?.classList.add('hidden'));
  const con = await big.newPage();
  await con.goto(`${BASE}/console.html`);
  await con.fill('#pin-input', PIN); await con.click('#pin-btn');
  await con.waitForSelector('#pin-screen', { state:'hidden' });

  // 10 城加入
  const clients = [];
  for(const t of TOWNS){ const p=await mob.newPage(); await p.goto(`${BASE}/client.html`);
    await p.click(`.town-btn[data-town="${t}"]`); await p.click('#join-btn');
    await p.waitForSelector('#game-screen',{state:'visible'}); clients.push(p); }
  await delay(600);

  const reset = async ()=>{ await con.click('#btn-reset'); await delay(300); };
  const open  = async ()=>{ await con.click('#btn-open'); await delay(500); };
  const buzz  = async idxs=>{ for(const i of idxs){ await clients[i].click('#buzz-btn'); await delay(180);} await delay(400); };
  const wrong = async ()=>{ await con.locator('.v-btn[data-result="wrong"]').first().click(); await delay(400); };
  const correct = async ()=>{ await con.locator('.v-btn[data-result="correct"]').first().click(); await delay(450); };

  // ── S1 進場 ──
  let s = scene('s1','進場 · 10 城選好城鎮','各組手機開學員端、點選自己的城鎮。投影與主持端即時顯示「已點亮 N 城」。');
  await snap(s, clients[0], '學員端（已選城鎮·鎖定）', 'client');
  await snap(s, con, '主持端（10 城名單）', 'console');
  await snap(s, display, '投影端（已點亮 10 城）', 'display');

  // ── S2 開搶·等待 ──
  s = scene('s2','開搶 · 等待搶答（倒數中）','播前奏後，主持端點「點燃聖火」開放搶答。投影倒數移到右上角，中央等待第一個拍燈。');
  await open();
  await snap(s, display, '投影端（開放·倒數中）', 'display');
  await snap(s, con, '主持端（OPEN·列表空）', 'console');

  // ── S3 10 城同搶 ──
  s = scene('s3','10 城同時搶答 · 滿載即時順位','各組衝五步拍燈。投影中央即時顯示 1～10 名順位（第一名金焰），主持端同步排出順位。');
  await buzz([...Array(10).keys()]);
  await snap(s, display, '投影端（10 名即時順位）', 'display');
  await snap(s, con, '主持端（搶答列表+判定鈕）', 'console');
  await snap(s, clients[0], '學員端（顯示第 N 名）', 'client');
  await reset();

  // ── S4 部分搶 ──
  s = scene('s4','部分城鎮搶答','不是每組都搶得到。只有部分城鎮拍燈時，順位只列出有搶的組，其餘城鎮仍可繼續搶。');
  await open(); await buzz([2,5,7]);
  await snap(s, display, '投影端（僅 3 城順位）', 'display');
  await snap(s, con, '主持端（3 筆）', 'console');
  await reset();

  // ── S5 答對歌名 ──
  s = scene('s5','答對歌名 · 火光彩帶','第一名答對歌名 → 主持點「O 正確」。投影放火光彩帶並進入排名回顧；回合結束（剩餘組不再有判定鈕）。');
  await open(); await buzz([0,1,2]); await correct();
  await snap(s, display, '投影端（火光彩帶+回顧）', 'display');
  await snap(s, con, '主持端（LOCKED·無多餘判定鈕）', 'console');
  await reset();

  // ── S6 答錯換次快 ──
  s = scene('s6','答錯 · 自動換次快的組','第一名答錯 → 主持點「X 錯誤」。投影放大 X，focus 自動跳到第二名，由次快的組接答。');
  await open(); await buzz([0,1,2]);
  await con.locator('.v-btn[data-result="wrong"]').first().click(); await delay(350);
  await snap(s, display, '投影端（答錯大 X）', 'displayX');
  await delay(1700);
  await snap(s, display, '投影端（第二名遞補待驗證）', 'display');
  await snap(s, con, '主持端（第一名錯·第二名 focus）', 'console');

  // ── S7 連續答錯 ──
  s = scene('s7','連續答錯 · 逐一遞補','若連續答錯，focus 會一路往下遞補，直到有人答對或全部答錯。');
  await wrong(); // 第二名也錯 → 第三名 focus
  await snap(s, display, '投影端（兩組劃掉·第三名待驗證）', 'display');
  await snap(s, con, '主持端（兩組錯·第三名 focus）', 'console');
  await reset();

  // ── S8 全部答錯 ──
  s = scene('s8','全部答錯','所有搶到的組都答錯時，沒有可判定的組；主持人重設後即可進下一題或開放補搶。');
  await open(); await buzz([0,1]); await wrong(); await wrong();
  await snap(s, display, '投影端（全部劃掉）', 'display');
  await snap(s, con, '主持端（全錯·無判定鈕）', 'console');
  await reset();

  // ── S9 開放別組搶填 ──
  s = scene('s9','開放別組搶填（重開）','填詞失敗時，主持點「重設」再「點燃聖火」，開放其他城鎮重新搶答。');
  await open();
  await snap(s, display, '投影端（再次開放）', 'display');
  await snap(s, con, '主持端（重新 OPEN）', 'console');
  await reset();

  // ── S10 城鎮選擇衝突 ──
  s = scene('s10','城鎮已被選 · 防止重複','某城鎮已被一支手機選走後，其他手機的選單會把該城鎮標記「已加入」，避免兩支手機選同一城鎮。');
  const peek = await mob.newPage(); await peek.goto(`${BASE}/client.html`); await delay(500);
  await snap(s, peek, '學員端選單（已選城鎮標記已加入）', 'client');
  await peek.close();

  // ── S11 斷線 ──
  s = scene('s11','城鎮斷線 · 名單即時更新','某組手機斷線（關頁/沒網路）時，進場名單會即時減少。');
  await clients[9].close(); await delay(500); // 城鎮十 離線
  await snap(s, display, '投影端（已點亮 9 城）', 'display');
  await snap(s, con, '主持端（9 城）', 'console');

  // ── S12 PIN 錯誤 ──
  s = scene('s12','主持端 PIN 錯誤','主持端輸入錯誤 PIN 嘗試操作時，會被擋下並提示重新輸入。');
  const badCon = await big.newPage(); await badCon.goto(`${BASE}/console.html`);
  await badCon.fill('#pin-input', '0000'); await badCon.click('#pin-btn');
  await badCon.waitForSelector('#pin-screen', { state:'hidden' });
  await badCon.click('#btn-open'); await delay(500); // 觸發 auth_error
  await snap(s, badCon, '主持端（PIN 錯誤提示）', 'console');
  await badCon.close();

  // ── S13 選城鎮 → 自訂隊名 ──
  s = scene('s13','選城鎮 → 可自訂隊名','點城鎮會把名稱填入下方欄位，可直接用或改成自己的隊名（10 字內，中英文皆可，已做防注入處理）。進場後隨時可按「換城鎮」重選；主持端的「清空連線」可一鍵讓全場退回重選（示範完正式開始很好用）。');
  const pick = await mob.newPage(); await pick.goto(`${BASE}/client.html`);
  await pick.click('.town-btn[data-town="城鎮三"]');
  await pick.fill('#name-input', '烈焰戰隊'); await delay(300);
  await snap(s, pick, '學員端（選城鎮＋自訂隊名）', 'client');
  await pick.close();

  // ── 產生 HTML 總覽 ──
  writeIndex();

  console.log(`✅ 情境預覽完成，共 ${scenarios.length} 情境，開啟：`);
  console.log(`   ${path.join(OUT, 'index.html')}`);
  await browser.close();
  server.kill();
  process.exit(0);
}

function writeIndex(){
  const blocks = scenarios.map(s=>{
    const shots = s.shots.map(sh=>`
      <figure><img src="${sh.file}" alt="${sh.label}"><figcaption>${sh.label}</figcaption></figure>`).join('');
    return `
    <section>
      <h2><span class="sid">${s.id.toUpperCase()}</span> ${s.title}</h2>
      <p class="action">▶ ${s.action}</p>
      <div class="shots">${shots}</div>
    </section>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>聖火之夜 · 情境預覽</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@700;900&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root{ --gold:#d4af37; --gold-bright:#f5d77a; --ink:#f3ecd9; --muted:#a99a76; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Noto Sans TC',sans-serif;color:var(--ink);
    background:radial-gradient(ellipse 80% 40% at 50% 0%,#1f2a55 0%,transparent 60%),linear-gradient(165deg,#0a1430,#20102b);
    padding:40px 24px 80px;-webkit-font-smoothing:antialiased}
  header{text-align:center;margin-bottom:40px}
  h1{font-family:'Noto Serif TC',serif;font-size:42px;font-weight:900;letter-spacing:10px;color:var(--gold-bright);text-shadow:0 0 30px rgba(245,166,35,.3)}
  .sub{color:var(--muted);letter-spacing:6px;margin-top:8px}
  section{max-width:1200px;margin:0 auto 36px;border:2px solid var(--gold);border-radius:14px;padding:24px 28px;background:rgba(8,10,26,.5)}
  h2{font-family:'Noto Serif TC',serif;font-size:26px;font-weight:700;color:var(--gold-bright);letter-spacing:2px;margin-bottom:8px}
  .sid{display:inline-block;background:var(--gold);color:#2a1c00;font-family:'Noto Sans TC';font-size:14px;font-weight:700;padding:2px 10px;border-radius:6px;margin-right:8px;letter-spacing:1px;vertical-align:middle}
  .action{color:var(--ink);opacity:.9;margin-bottom:18px;font-size:15px;line-height:1.6}
  .shots{display:flex;flex-wrap:wrap;gap:16px}
  figure{flex:1;min-width:280px;border:1px solid rgba(212,175,55,.4);border-radius:10px;overflow:hidden;background:#000}
  img{width:100%;display:block}
  figcaption{padding:8px 12px;font-size:13px;color:var(--muted);letter-spacing:1px;border-top:1px solid rgba(212,175,55,.2)}
</style></head><body>
<header><h1>聖火之夜</h1><div class="sub">搶答系統 · 情境預覽（10 城鎮）</div></header>
${blocks}
</body></html>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
}

main().catch(e=>{ console.error(e); process.exit(1); });

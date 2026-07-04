// 英雄榜在「少城鎮(3)」與「滿城鎮(10)」下的緊湊度/不捲動驗證 + 截圖
//   node tests/lb-check.js  → .screenshots/refactor/lb/
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs');
const { chromium } = require('@playwright/test');
const PORT = 3416, PIN = 'LBCK';
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.screenshots', 'refactor', 'lb');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SCROLL_PROBE = `() => {
  const out = [];
  for (const id of ['idle-leaderboard','open-leaderboard']) {
    const e = document.getElementById(id);
    if (e && e.offsetParent !== null && e.scrollHeight > e.clientHeight + 2) out.push('⚠️ '+id+' 仍可捲動 scrollH='+e.scrollHeight+' > clientH='+e.clientHeight);
  }
  return out;
}`;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const sf = path.join(__dirname,'..','state.json'); if (fs.existsSync(sf)) try{fs.unlinkSync(sf)}catch{}
  const server = spawn('node',[path.join(__dirname,'..','server.js')],{stdio:'pipe',env:{...process.env,PORT:String(PORT),HOST_PIN:PIN,COUNT_FROM:'90',LIGHT_THRESHOLD:'120'}});
  await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),10000);server.stdout.on('data',d=>{if(d.toString().includes('running at')){clearTimeout(t);res();}});});

  const browser = await chromium.launch();
  const dispCtx = await browser.newContext(); const display = await dispCtx.newPage();
  await display.goto(`${BASE}/display.html`);
  const mob = await browser.newContext({viewport:{width:390,height:780}});
  const con = await (await browser.newContext({viewport:{width:900,height:760}})).newPage();
  await con.goto(`${BASE}/console.html`); await con.fill('#pin-input',PIN); await con.click('#pin-btn'); await con.waitForSelector('#pin-screen',{state:'hidden'});
  const TOWNS=['城鎮一','城鎮二','城鎮三','城鎮四','城鎮五','城鎮六','城鎮七','城鎮八','城鎮九','城鎮十','城鎮十一'];
  const clients=[];
  const dismiss=async()=>{if(await con.evaluate(()=>{const o=document.getElementById('confirm-overlay');return o&&!o.classList.contains('hidden')}))await con.click('#cd-ok');};
  async function score(town,pts){await con.click('#btn-open');await delay(200);await clients[TOWNS.indexOf(town)].click('#buzz-btn',{force:true});await delay(200);await con.click(`.points-chip[data-points="${pts}"]`);await con.click('.v-btn[data-result="correct"]');await delay(120);await dismiss();await delay(200);await con.click('#btn-reset');await delay(120);await dismiss();await delay(150);}
  async function join(t){const p=await mob.newPage();await p.goto(`${BASE}/client.html`);await p.click(`.town-btn[data-town="${t}"]`);await p.click('#join-btn');await p.waitForSelector('#game-screen',{state:'visible'});clients.push(p);}

  const report = {};
  async function snap(tag){
    for (const [w,h] of [[1920,1080],[1366,768]]) {
      await display.setViewportSize({width:w,height:h}); await delay(450);
      await display.screenshot({path:path.join(SHOTS,`${tag}-${w}x${h}.png`)});
      const s = await display.evaluate(eval('('+SCROLL_PROBE+')')); if (s.length) report[`${tag}-${w}x${h}`]=s;
    }
  }

  // 少城鎮：3 城、2 隊有分 → idle 大榜 + open 右欄
  for (const t of TOWNS.slice(0,3)) await join(t);
  await score('城鎮一',30); await score('城鎮二',10);
  await snap('idle-3城');
  await con.click('#btn-open'); await delay(500); await snap('open-3城'); await con.click('#btn-reset'); await delay(150); await dismiss();

  // 滿城鎮：再加 8 = 11 城、給更多分差
  for (const t of TOWNS.slice(3)) await join(t);
  await score('城鎮三',30); await score('城鎮五',20); await score('城鎮七',10);
  await snap('idle-11城');
  await con.click('#btn-open'); await delay(500); await snap('open-11城');

  console.log('=== 卷軸檢查（應全無）===');
  const keys = Object.keys(report);
  if (!keys.length) console.log('✅ idle/open 榜單 × 3城/11城 × 兩解析度：完全無卷軸');
  else keys.forEach(k=>console.log(k+':\n   '+report[k].join('\n   ')));
  console.log('截圖 →', SHOTS);
  await browser.close(); server.kill(); process.exit(keys.length?1:0);
}
main().catch(e=>{console.error(e);process.exit(2)});

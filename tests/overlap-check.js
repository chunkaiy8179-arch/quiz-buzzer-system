// 多解析度重現 display（idle空榜/idle有榜/open），找出 100% 顯示時的切邊與重疊
//   node tests/overlap-check.js  → 截圖存 .screenshots/refactor/overlap/
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const PORT = 3415, PIN = 'OVL8';
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', '.screenshots', 'refactor', 'overlap');
const delay = ms => new Promise(r => setTimeout(r, ms));

// 含使用者回報的「寬而矮」情境
const SIZES = [[1920,800],[1600,720],[1366,768],[1280,720],[1920,1080]];

// 偵測「應獨立區塊」是否互相重疊，並偵測是否有元素被視窗上下切掉
const PROBE = `() => {
  const sel = ['.open-top','.open-left','.open-center','.open-right','#count-badge','#open-leaderboard','#audio-unlock','#idle-flame-bar','#idle-leaderboard','.joined-panel','.idle-standby','.emblem-wrap','.idle-headings'];
  const els = sel.map(s => ({s, el: document.querySelector(s)})).filter(x => x.el && x.el.offsetParent !== null);
  const r = e => e.getBoundingClientRect();
  const ov = (a,b) => !(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);
  const out = [];
  for (let i=0;i<els.length;i++) for (let j=i+1;j<els.length;j++) {
    if (els[i].el.contains(els[j].el) || els[j].el.contains(els[i].el)) continue;
    const A=r(els[i].el), B=r(els[j].el);
    if (ov(A,B)) { const ix={l:Math.max(A.left,B.left),t:Math.max(A.top,B.top),rr:Math.min(A.right,B.right),bb:Math.min(A.bottom,B.bottom)};
      out.push('重疊 '+els[i].s+' ✕ '+els[j].s+' (~'+Math.round(Math.max(0,ix.rr-ix.l)*Math.max(0,ix.bb-ix.t))+'px²)'); }
  }
  // 被視窗切邊（top<0 或 bottom>視窗高）
  const H = window.innerHeight;
  for (const {s,el} of els) { const b=r(el); if (b.top < -1) out.push('切到上緣 '+s+' (top='+Math.round(b.top)+')'); if (b.bottom > H+1) out.push('切到下緣 '+s+' (bottom='+Math.round(b.bottom)+'/'+H+')'); }
  return out;
}`;

async function probe(page, name, report) { report[name] = await page.evaluate(eval('('+PROBE+')')); await page.screenshot({ path: path.join(SHOTS, name+'.png') }); }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const sf = path.join(__dirname,'..','state.json'); if (fs.existsSync(sf)) try{fs.unlinkSync(sf)}catch{}
  const server = spawn('node',[path.join(__dirname,'..','server.js')],{stdio:'pipe',env:{...process.env,PORT:String(PORT),HOST_PIN:PIN,COUNT_FROM:'90',LIGHT_THRESHOLD:'20'}});
  await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),10000);server.stdout.on('data',d=>{if(d.toString().includes('running at')){clearTimeout(t);res();}});});

  const browser = await chromium.launch();
  const dispCtx = await browser.newContext();
  const display = await dispCtx.newPage();
  await display.goto(`${BASE}/display.html`);
  const report = {};

  // 1) idle 空榜（0 城，等待加入）
  for (const [w,h] of SIZES) { await display.setViewportSize({width:w,height:h}); await delay(400); await probe(display, `idleEmpty-${w}x${h}`, report); }

  // 加入 8 城鎮、給 3 隊分數
  const mob = await browser.newContext({viewport:{width:390,height:780}});
  const con = await (await browser.newContext({viewport:{width:900,height:760}})).newPage();
  await con.goto(`${BASE}/console.html`); await con.fill('#pin-input',PIN); await con.click('#pin-btn'); await con.waitForSelector('#pin-screen',{state:'hidden'});
  const TOWNS=['城鎮一','城鎮二','城鎮三','城鎮四','城鎮五','城鎮六','城鎮七','城鎮八'];
  const clients=[];
  for(const t of TOWNS){const p=await mob.newPage();await p.goto(`${BASE}/client.html`);await p.click(`.town-btn[data-town="${t}"]`);await p.click('#join-btn');await p.waitForSelector('#game-screen',{state:'visible'});clients.push(p);}
  const dismiss=async()=>{if(await con.evaluate(()=>{const o=document.getElementById('confirm-overlay');return o&&!o.classList.contains('hidden')}))await con.click('#cd-ok');};
  async function score(town,pts){await con.click('#btn-open');await delay(250);await clients[TOWNS.indexOf(town)].click('#buzz-btn',{force:true});await delay(250);await con.click(`.points-chip[data-points="${pts}"]`);await con.click('.v-btn[data-result="correct"]');await delay(120);await dismiss();await delay(250);await con.click('#btn-reset');await delay(120);await dismiss();await delay(200);}
  await score('城鎮一',30); await score('城鎮三',20); await score('城鎮二',10);

  // 2) idle 有榜（8 城、3 隊有分）
  for (const [w,h] of SIZES) { await display.setViewportSize({width:w,height:h}); await delay(400); await probe(display, `idleBoard-${w}x${h}`, report); }

  // 3) open（搶答中，右欄英雄榜含全部 8 城）
  await con.click('#btn-open'); await delay(500);
  for (const [w,h] of SIZES) { await display.setViewportSize({width:w,height:h}); await delay(400); await probe(display, `open-${w}x${h}`, report); }

  console.log('=== 切邊/重疊偵測（應全為「無」）===');
  let problems=0;
  for (const k of Object.keys(report)) { if(report[k].length){ problems++; console.log('⚠️ '+k+':\n   - '+report[k].join('\n   - ')); } }
  if(!problems) console.log('✅ 所有畫面 × 所有解析度：無切邊、無重疊');
  console.log('截圖 →', SHOTS);
  await browser.close(); server.kill(); process.exit(problems?1:0);
}
main().catch(e=>{console.error(e);process.exit(2)});

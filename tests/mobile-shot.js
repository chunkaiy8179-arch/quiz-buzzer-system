// 手機 viewport 主持端截圖（暫用，截完即可刪）
const { chromium } = require('@playwright/test');

const BASE = 'http://localhost:3000';
const PIN = 'DEMO1234';
const OUT = process.argv[2] || '.screenshots/console-mobile';
const TAG = process.argv[3] || 'before';

// iPhone 14/15 邏輯解析度
const VP = { width: 393, height: 852 };

function wsClientScript(name){
  return `(${(n)=>{
    return new Promise(res=>{
      const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);
      window.__ws = ws;
      ws.addEventListener('open', ()=> ws.send(JSON.stringify({ type:'join', team:n })));
      ws.addEventListener('message', e=>{
        const m = JSON.parse(e.data);
        if(m.type==='join_ok'){ window.__team = m.team; res(true); }
      });
      setTimeout(()=>res(false), 3000);
    });
  }})(${JSON.stringify(name)})`;
}

(async () => {
  const browser = await chromium.launch();

  // 先把 server 狀態重設回 locked，讓腳本可重複執行
  {
    const resetCtx = await browser.newContext();
    const rp = await resetCtx.newPage();
    await rp.goto(BASE + '/console.html');
    await rp.evaluate((pin)=> new Promise(res=>{
      const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);
      ws.addEventListener('open', ()=>{ ws.send(JSON.stringify({ type:'host_clear', pin })); ws.send(JSON.stringify({ type:'host_reset', pin })); });
      ws.addEventListener('message', e=>{ const m=JSON.parse(e.data); if(m.type==='state' && m.phase==='locked'){ ws.close(); res(true); } });
      setTimeout(()=>res(false), 2000);
    }), PIN);
    await resetCtx.close();
  }

  // 兩個學員：開 client 頁拿真實 ws 連線
  const cliCtx = await browser.newContext();
  const teams = ['雅典', '斯巴達'];
  const cliPages = [];
  for(const t of teams){
    const p = await cliCtx.newPage();
    await p.goto(BASE + '/client.html');
    await p.evaluate(wsClientScript(t));
    cliPages.push(p);
  }

  // 主持端（手機 viewport）
  const hostCtx = await browser.newContext({ viewport: VP, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const host = await hostCtx.newPage();
  await host.goto(BASE + '/console.html');
  await host.fill('#pin-input', PIN);
  await host.click('#pin-btn');
  await host.waitForTimeout(500);

  // 設門檻
  await host.fill('#threshold-input', '30');
  await host.click('#btn-threshold');
  await host.waitForTimeout(200);

  // 畫面1：locked（剛進入，含控制鈕/門檻/計分板雛形）
  await host.screenshot({ path: `${OUT}/${TAG}-1-locked.png`, fullPage: true });

  // 開搶
  await host.click('#btn-open');
  await host.waitForTimeout(300);

  // 兩學員拍燈 → 進 reviewing，有兩筆搶答待判
  for(const p of cliPages){
    await p.evaluate(()=>{ if(window.__ws) window.__ws.send(JSON.stringify({ type:'buzz', team: window.__team })); });
    await host.waitForTimeout(250);
  }
  await host.waitForTimeout(400);

  // 畫面2：reviewing（判定 O/X 鈕、分值器、焦點列、計分板 ± 鈕全在）
  await host.screenshot({ path: `${OUT}/${TAG}-2-reviewing.png`, fullPage: true });

  // 畫面2b：reviewing 視口內（非 fullPage，看拇指可及的真實首屏）
  await host.screenshot({ path: `${OUT}/${TAG}-2b-reviewing-viewport.png` });

  // 判第一筆對 → 製造已判定列（撤銷鈕）+ 計分板有分
  await host.click('.v-btn.v-correct');
  await host.waitForTimeout(200);
  // confirm 對話框
  await host.screenshot({ path: `${OUT}/${TAG}-3-confirm-correct.png` });
  await host.click('#cd-ok');
  await host.waitForTimeout(400);

  // 重新開一回合讓計分板與已判定狀態並存可見
  await host.screenshot({ path: `${OUT}/${TAG}-4-after-verify.png`, fullPage: true });

  // 危險 confirm（清空連線）
  await host.click('#btn-clear');
  await host.waitForTimeout(200);
  await host.screenshot({ path: `${OUT}/${TAG}-5-confirm-danger.png` });
  await host.click('#cd-cancel');

  await browser.close();
  console.log('shots done:', TAG);
})().catch(e=>{ console.error(e); process.exit(1); });

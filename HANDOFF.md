# 對話交接筆記
> 產生時間：2026-07-03 ｜ 工作目錄：C:\ClaudeCodeDev\quiz-buzzer-system

## 背景與目標
持續迭代「聖火之夜」搶答系統（quiz-buzzer-system，三端 WebSocket：client 玩家 / console 主持 / display 投影，希臘金箔暗夜風，主持端主要用手機）。這個 session 做了一連串 UI/功能微調 + 最後一次 display 大重構，每項都 commit → 背景 push master → Render 自動部署上線。線上永遠是 master 最新。

## 已完成 / 當前狀態
本地在 **master** 分支，工作區乾淨。所有改動已 commit + push + **部署上線 Render**。這個 session 的 commit（新→舊）：
- **47dd553（最新，大改）display 單一畫面重構**：不再 idle/open/rank 三畫面切換，全程用 open-screen。待機＝中央聖火之夜聖杯+標題（新增 `#open-standby`）＋右側常駐英雄榜（取代原城鎮名牌）；搶答/答對＝中央大字卡 ＋ 狀態列旁一行提示文字（`#open-tip`）並存；答對後 7 秒自動回待機。已 playwright 驗證待機+答對態、npm test 全綠、已上線。
- **04a9846** 答對後留搶答畫面（不跳 rank）＋ 移除「衝五步」（副標→「拍燈搶答」）。
- **a66cc68** 英雄榜第一名移除聖火火把圖示（lb-crown 設 ''）。
- **be5095a** 新增「答錯後續搶」開關（主持端，預設繼續開放；server `reopenOnWrong`＋`host_set_reopen`；關掉＝答錯即回 locked 結束本題不加分）。
- **b9d2f6c** 英雄榜第一名字級偏小 + 皇冠黑點修正。
- **29d4083** merge ship→master 部署（四項開關+紅按鈕+英雄榜切字等一次合併上 master）。
- **7258041** 英雄榜兩欄不切字 + 記分板歸零反灰 + client 搶答鈕改紅色立體按鈕。
- **c10e4f3** 四項：倒數計時開關 / 聖火能量顯示開關（主持端，預設關）/ 記分板編輯鎖（預設鎖）/ client 石材鈕。
- **cbdbfcd/85a937f** 答對驗證音效換 goodresult。

## 待辦 / 下一步
- [ ] **使用者實機驗收單一畫面**：跑一輪 待機→開放搶答→有人搶到→判答對→回待機，確認流程/排版。
- [ ] **單一畫面排版微調（等使用者反饋）**：可能要調——`#open-tip` 提示文字位置/大小；聖杯+標題在有右側榜時是否偏心（要不要縮小/左移對齊）；答錯提示是否要自動消失。
- [ ] **答錯提示保留窗（設計取捨，待定）**：目前 `#open-tip` 答錯「XXX 答錯」由下一個 state 接管清除（`wrongTipUntil`=1800ms 守護，無獨立清除 timer）。若使用者要「固定 N 秒必消」，需在 `setOpenTip` wrong 分支加 setTimeout 主動清。
- [ ] （可留意，非急）rank-screen / idle-screen 的 HTML 仍在但不再被 showScreen 切換（棄用未刪，無害）；`renderLeaderboard` 舊呼叫也還在（無害）。

## 關鍵決策與踩過的雷
- **決策 client 搶答鈕**：最終＝一般紅色立體按鈕（凸起厚底座／按下整顆下沉）＋**統一紅色系**（可搶鮮紅可按；待命/搶到/驗證中/出局一律「紅色反灰」不可點）＋搶到加金框金光暈。使用者**明確否決過**：綠色（搶到）、橘色（驗證中）、獎章圖片(buzz.png)、淺色大理石、深色石板——別再往這些方向做。
- **決策 display 單一畫面**：用 open-screen 當唯一畫面（本來就有右側英雄榜+中央大字 renderHero），把 idle 的聖杯+標題複製進 open-center 做 `#open-standby`。使用者要保留「聖火之夜」氛圍 ＋ 英雄榜右側直向 ＋ 中央大字 ＋ 提示文字並存。
- **決策 分支/部署**：master 是部署主線；ship/display-refactor 是舊功能分支（已 merge 進 master，29d4083）。idle「城鎮名牌」(8faee57) 與 open「英雄榜」原以為方向衝突，實為**不同畫面可共存**（單一畫面重構後 idle 畫面整個棄用）。
- **決策 答對流程**：答對後**不跳 rank 結果畫面**，留搶答畫面顯示答對者，7 秒回待機。
- **雷 push 會 timeout**：前景 `git push` 常卡 2 分鐘超時。一律**背景** `GIT_TERMINAL_PROMPT=0 git push origin master`（run_in_background）。認證用本機快取憑證（git 的，跟 gh CLI 無關）。**不需要 device flow**（舊 HANDOFF 的 device flow 已過時，這 session 直接背景 push 都成功）。
- **雷 部署驗證**：Render 免費 build 幾分鐘 + 首訪冷啟動 30-60s。驗證用背景 poll loop：`curl -s .../display.html | grep -qF "<新版標記>"` ＋ `curl .../healthz`（up 秒數低＝剛部署重啟）。SW 是 network-first，玩家自動抓新版不用清快取。
- **雷 SVG gradient id 撞名**：複製 idle 聖杯 SVG 到 open-center 時，gradient id（lg/gl_d/cg_d/ff_d/fi_d）會與 idle 撞名 → 複製的全加 `_s` 後綴。同類雷：英雄榜第一名皇冠 `fill=url(#ff_d)` 在 open 畫面失效變黑點（ff_d 在隱藏的 idle SVG）——後來整個火把已移除。
- **雷 測試斷言隨架構失效**：單一畫面後 idle 畫面棄用，測 `idle-flame-bar` 顯示/寬度的斷言必失敗（在隱藏畫面量到 0）。已把 display-capture.js + toggle-features-check.js 兩條改/移除，改驗 `open-flame-bar`。
- **雷 主持端 PIN**：線上 console PIN 是 **Render 後台環境變數 HOST_PIN**（固定，以後台為準），不是本地 `node server.js` 每次隨機生成那組。
- **雷 gh CLI 沒登入**：會跳「GitHub CLI authentication expired」提示，但**不影響 git push/部署**。要消提示才 `gh auth login`。
- **雷 Bash 複合含 rm 被權限擋**：單獨 rm 可過，複合（含 rm -f）會擋。清檔用單獨指令或 git rm。測試截圖產物已被 .gitignore（`*.png`、`.playwright-mcp/`）排除，不會混進 commit。
- **雷 SendUserFile 工具中途變不可用**：改用 playwright 截圖 + Read 自己看，再文字描述給使用者。

## 相關檔案 / 指令 / 連結
- 專案根：`C:\ClaudeCodeDev\quiz-buzzer-system`（GitHub: chunkaiy8179-arch/quiz-buzzer-system，分支 master）
- `public/display.html` — 投影端。單一畫面：`showScreen`(行 834，全 'open')、`applyState`(行 1039 依 phase 分支)、`#open-standby` 待機聖火之夜、`#open-tip` 提示、`renderHero`(908 中央大字)、`renderOpenLeaderboard`(935 右側榜)、helper `setOpenStatus`/`setOpenTip`/`showOpenStandby`。
- `public/console.html` — 主持端。開關（複用 `.lock-switch`）：lock-toggle 答錯處置、countdown-toggle 倒數、flame-toggle 聖火、reopen-toggle 答錯後續搶、score-edit-toggle 記分板鎖。
- `public/client.html` — 玩家端。`#buzz-btn` 紅色立體按鈕（state-open 鮮紅可搶／其餘紅反灰；state-buzzed 金框）。
- `server.js` — WS 狀態機。旗標：enableCountdown/showFlame（預設 false）、reopenOnWrong（預設 true）、lockOnWrong（預設 true）、scoreEditMode（純前端）。`host_verify`(357) 答對/答錯分支、`host_set_*` 訊息。
- 指令：`npm test`（sim-8users/display-capture/overlap-check/lb-check/toggle-features-check，全綠；playwright 自起 server）；`npm start`（起 server，localhost:3000，PIN 隨機印在 log）。
- 部署：改 master → `git add <檔>` → commit → **背景** `GIT_TERMINAL_PROMPT=0 git push origin master` → 背景 poll loop 等 Render build。
- 線上：https://quiz-buzzer-system.onrender.com/{display,console,client}.html ；PIN＝Render 後台 HOST_PIN。
- Render dashboard：https://dashboard.render.com/web/srv-d8imk9jtqb8s73bba7j0
- 環境變數：COUNT_FROM(60)、LIGHT_THRESHOLD(120)、LOCK_ON_WRONG(true)、HOST_PIN。
- `CHANGELOG.md` — 專案完整迭代史（已入版控）。
- 記憶：`C:\Users\yoga9\.claude\projects\C--ClaudeCodeDev-quiz-buzzer-system\memory\`（MEMORY.md 索引 + display-branch-divergence.md 分岔已解決）。

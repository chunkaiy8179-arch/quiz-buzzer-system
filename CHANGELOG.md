# CHANGELOG — 搶答燈系統

> 完整迭代史。本檔由原本累積在 Claude 長期記憶（memory）中的開發紀錄整理而來，
> 移到專案內保存，避免每次對話都載入而稀釋焦點。最新在上。

## 2026-06-28 — idle 響應式修正 + 英雄榜列全部城鎮（`50f05ce`，已部署）
- 使用者實機回報 display 100% 顯示「各種重疊」。根因＝Phase B 的 `#open-screen{display:grid}`（id 選擇器）蓋過 `.screen{display:none}`，使 open 畫面在 idle 時也持續算版面、疊在下方令整頁兩倍高 → 改 `#open-screen.active`。
- idle 尺寸只綁 vw 沒綁高度，視窗一矮就溢出切聖杯 → emblem/title 改 `min(vw,vh)`、padding/gap 改 vh、英雄榜/進場面板 `flex` 收縮 + `max-height(vh)` + 內捲。`#audio-unlock` 從正中下移右下角。
- open 右欄英雄榜改「一開始就列全部已加入城鎮（含 0 分），依分數重排」（移除 `score>0` 過濾）。清死碼 `renderOrderList`。
- 新增 `tests/overlap-check.js`（idle空/榜/open × 5 解析度含 1920x800 寬矮，偵測切邊+重疊）納入 `npm test`。
- 認證踩雷：`gh auth login --with-token` 需 token 含 `read:org` scope，但 device code 只要了 `repo` → gh 存失敗。改用「權杖直接放 push URL（`https://x-access-token:TOKEN@...`）+ `git credential approve` 餵進 GCM」，之後 `git push` 免再授權。

## 2026-06-27 — 大級別重構：搶答只記第一位 + display 5 段式 + 石板獎章鈕 + 持久化（`bc251f6`，sw v36，已部署）
- 此 session 環境禁子 agent 編輯（子 agent Edit 被拒），全部主 session 親手改；reviewer agent 唯讀把關。
- **搶答機制簡化**：移除完整順位陣列，server 改單一 `state.firstBuzzer`；對外 `stateMsg().buzzOrder` 仍送 ≤1 筆陣列讓三端不必大改。答錯→出局+剩餘秒續搶+下一位成新首位；移除 `buzz_registered`/後續 ding/名次徽章。
- **display 5 段式 Grid**：上 1/5 標題+倒數、下 4/5 左（直立聖火能量條 `.flame-vertical`）中（hero 大字卡「{城鎮}，獲得答題權！」）右（英雄榜）。
- **點燈圖層修復**：`#ignite-overlay` z-index 80→10000 + `body.igniting` 壓暗三 screen，聖杯+標題獨佔。
- **英雄榜**：禁捲動 + 各列 flex 等分；換位用 FLIP（flipCapture/flipPlay）滑動。
- **音效**：答錯音重疊修復（答錯→續搶時等 `wrong.mp3` `ended` 才放 openBeep）；換音效檔（`音效庫\victory|lose` 覆蓋 `correct/wrong.mp3`）。sw v35→v36。
- **client 石板獎章鈕**：改用 `public/img/buzz.png`（完整=可搶/搶到）/`buzz-broken.png`（破損=鎖定/出局）背景圖（約 2.8MB/張未壓縮，之後可轉 webp）。
- **聖火能量歸零 bug 根因＝Render 免費方案閒置休眠、記憶體清空**（非程式錯）。修：scores/scoreSince/threshold/lit 持久化 `state.json`（broadcastState debounce 寫 + 開機載入 + SIGTERM/SIGINT flush）+ `/healthz`。但 Render 免費磁碟 ephemeral，持久化救不了跨休眠 → 主防線是活動期間外部排程 ping `/healthz`（cron-job.org/UptimeRobot 每~10min）保活。
- **測試**：`sim-8users`（ws 直連 71 案）+ `display-capture`（Playwright 15 斷言）+ `client-capture`（按鈕三態截圖）。舊行為測試歸檔 `tests/legacy/`、`testIgnore` 排除。截圖 `.screenshots/refactor/`。

## 2026-06-26 第五批 — 3 bug + 城鎮看板 + 石板按鈕（`2d1361b`，sw v35）
- 主持實戰回報，planner→coder×4→reviewer→tester→approver，59 passed。
- **Bug1（安全）**：主持端輸錯 PIN 也能進（console 輸入就直接進、不驗）→ server 加 `host_auth` 握手，驗對才進（保留 checkPin 雙防線）。
- **Bug2**：答錯重開按鈕卡「第一名」、要等別人按才更新 → 加 `verify_result` handler 清鎖 + open 分支「buzzed 與 server 不符就解鎖」防線。
- **Bug3**：時間到未強制覆蓋 → `time_up`→`forceTimeUp` 一律切「時間到」。
- **Feature4**：display rank 回顧畫面出水平捲軸（`.rank-row.correct` scale 溢出）+ 停太久 → overflow-x:hidden + 改 box-shadow + 7 秒自動切回 idle。
- **Feature5**：城鎮即時看板——idle 一開始完整列出所有城鎮（含 0 分）；排序分數降序、平手用 `scoreSince`（0分=加入時間、有分=達分時間）。
- **石板按鈕**：搶答鈕改「希臘白大理石+金箔刻字」neumorphism（浮起/按壓下凹/裂石出局）。

## 2026-06-26 第三、四批 — 手機優化 + 答錯鎖定開關 + 投影完整榜 + 出局餘燼（`29c544a`，sw v34）
- **主持端手機優化**（`889b3ca`）：主持主要用手機。reviewing 時收起點燈/計分面板，O/X 判定鈕上移首屏拇指區；觸控目標放大（O/X 54px、計分±46px）。
- **(A)** 投影端搶答中常駐完整各組分數榜（open 雙欄，取代角落 top5）。
- **(B)** 「答錯是否鎖定」開關：server `lockOnWrong`（預設 true=出局），主持可切「不鎖、可再搶」；切非鎖「全部解放」（清 eliminated/殘留 wrong/lastVerify）。協定加 `host_set_lock_mode`。
- **(C)** 學員端出局按鈕改「餘燼冷卻」（炭灰+橘紅餘燼微光，取代紅✕斜槓）。
- 澄清：使用者反映「加分只能固定 10 分」其實是沒看到 v33 已做的分值選擇器（手機快取/舊版），非功能缺。

## 2026-06-26 — 重大升級：計分 + 合作點燈「希望之燈」+ 搶答機制反轉（`83eea8a`，已部署）
- 用 agent 隊伍（planner→coder→reviewer→debugger→tester→approver）完成。
- **搶答機制反轉**：第一人拍燈即鎖他人 + 倒數定格 → 主持判定 → 答對結束回合、答錯該組出局並從剩餘秒續跑換其他組。反轉了 PR#9「拍燈後倒數續跑到 0」的舊設計。
- **內建計分**（推翻原「計分不做」）：答對 +10、答錯不扣、跨回合累計；主持端手動 ±分/歸零；host_clear 連分數歸零。
- **合作敘事**：把「各組競爭」改成「八城鎮合作」——全體總分達門檻（env `LIGHT_THRESHOLD` 預設 120）解鎖「希望之燈」，主持結語手動點燃 → 投影全螢幕點燈動畫；投影同時有聖火進度條 + 個人排行榜。競爭性改用「沒點燃明天早起半小時」+ 第一名零食話術。倒數 30→60s。
- 故事：赫拉降長夜 → 通過音樂與智慧試煉重燃聖杯之火、點亮希望之燈。修正同時拍燈競態。sw v31→v32，36 passed。

### 同日二次完善 — 24 項打磨（`21ec8ce`，sw v33）
- **點燈高潮**：希望之燈點燃專屬音效（聖殿鐘+金色琶音，原本竟是靜音）、達標提示音+爆閃、進度條漸強。
- **計分彈性**：每題可設加分值（`host_verify` 帶 `points`，10/20/30，clamp 1-200）；撤銷誤判 `host_unverify`+`lastVerify` 快照一鍵還原（`canUndo` 控撤銷鈕）。
- **主持操作**：點燈二次確認、快捷鍵（空白開搶/O·X判定/R重設）、流程引導 hint-note、金箔風 confirmDialog。
- reviewer 抓到並修：H-1 撤銷競態（判錯續跑期間別組拍燈後撤銷會錯亂→buzz 時清 lastVerify）、M-1 reviewing 期間重複震動。測試 48 passed。
- 部署認證踩雷：B 電腦 Remote Control 連回，push 需認證但 A 電腦彈窗 B 看不到 → 改用 device flow（curl client_id + /login/device 輸碼授權）。

## 2026-06-21 — Render 線上實測 + F5 修復（PR #10，已部署）
- 線上實測 PR#9（Playwright 三端）：倒數續跑✅、歸零鎖✅、開賽鎖換城鎮✅、四種音效✅。
- **抓到 F5 bug**：原 `localStorage('sf_team')`+3×700ms 重試在 Render 上穩定失敗。實測 Render 斷線後約 10.2s 才釋放名稱（無心跳、只靠 ws close + 代理延遲）≫ 2.1s 重試 → 撞重名放棄。
- **修法（Token 接管）**：server 發 `teamTokens`（name→token，crypto.randomUUID）；`join` 帶對 token = 同人重連→踢掉殘留舊連線接管。
- **client 改 sessionStorage**（取代 localStorage）：記憶綁分頁非瀏覽器——F5 同分頁保留、同瀏覽器另開分頁不互相覆蓋。踩雷：原用 localStorage 時多分頁共用記憶→第二分頁載入即以第一分頁 token 自動接管→多學員測試全掛。
- sw v9。測試 26 案全綠。踩雷：load.spec 與 timeup-persist 都用 port 3100，並行會撞 port → `--workers=1` 序列化。

## 2026-06-21 — 回報修正（PR #9，已合併）
- **倒數改伺服器權威**：`COUNT_FROM`（env，預設30）。`host_open` 起算 `deadline`，到時 broadcast `time_up`。第一個拍燈不再停倒數，續跑至 0，歸零才不能拍。投影端倒數改吃 server `remainingMs`。
- **換城鎮限制 + F5 記憶**：「換城鎮」鈕只在 locked 顯示；`localStorage('sf_team')` 記隊伍，F5 自動重連（重名時最多重試3次×700ms）。
- **音效改真實音檔**：first-buzz.mp3（CC BY-NC）、correct/wrong.mp3（Mixkit 免費商用）。倒數 tick 依剩餘秒數變頻。sw v8。
- 新增 `timeup-persist.spec.js`（4案），總計 24 案全綠。

## 2026-06-21 — 客製化為活動「聖火之夜」（已上線）
- 活動：希臘神話主題闖關、約 100 人、10 城鎮、國高中生。搶答用於第一關（音樂猜歌填詞）與第二關（看圖猜成語）。
- **主題重設計**：希臘金箔暗夜風（比照實體卡牌）——深藍紫漸層 + 金 `#d4af37`/`#f5d77a` + 聖杯火焰 + 金箔回紋 + Noto Serif TC。取代原 Binance 風。
- **bug 修正**：答對使回合結束後 `currentFocusTeam` 回 null，主持端不再對剩餘組顯示判定鈕。
- **10 城鎮 + 自訂隊名**：`client.html` 的 `TOWNS` 陣列；選城鎮後可改自訂名（≤10 字）。server `cleanTeam()` 移除控制字元/角括號 + 渲染端跳脫 = 防 injection；重複名稱拒絕。
- **重置機制**：學員端「換城鎮」（server `leave`）；主持端「清空連線」（server `host_clear`）。
- 計分當時不做（純搶答，分數另用試算表/PPT）。HOST_PIN 設於 Render 後台。

## 2026-06-20 — 四項改進（測試通過）
1. **進場名單**：server 新增 `join` 訊息處理 + 連線綁定 team，斷線自動移除；state 廣播 `joinedTeams`。
2. **open 畫面重做**：倒數移到右上角 badge，中央改即時更新的搶答順位列表。
3. **UI 重新設計**：採 Binance 設計語言（黃 `#fcd535` × 近黑 `#0b0e11`），移除互相打架的 radial gradient 光暈。字體 Inter。
4. **壓測**：`tests/load.spec.js` 驗證 10 人同時連線+搶答。

## 設計參考來源
`awesome-design-md` repo（github.com/VoltAgent/awesome-design-md）。原版用 Binance，聖火之夜版以卡牌為主視覺、借 Bugatti 執行紀律。

# 聖火之夜搶答燈系統（Quiz Buzzer System）

跨裝置、網頁版的即時電子搶答燈系統，專為現場活動（晚會、闖關、團康搶答）設計。三端透過 WebSocket 即時同步，學員用手機當搶答鈕、主持端控場與判定、投影端在大螢幕顯示倒數與排名。

> **線上版**：<https://quiz-buzzer-system.onrender.com>（學員端首頁）
> 純 Vanilla JS + Express + ws，**無建置步驟**；部署於 Render free tier。

---

## 三端介紹

| 端 | 路徑 | 用途 |
|---|---|---|
| 學員端 | `/client.html` | 手機全螢幕搶答鈕（PWA，可加到主畫面）；選城鎮／自訂隊名後加入 |
| 主持端 | `/console.html` | 輸入 PIN 進入；點燃聖火（開搶）、重設、清空連線、O／X 判定、計分加減／歸零、調整點燈門檻、點燃希望之燈 |
| 投影端 | `/display.html` | 投影在牆上：倒數、即時搶答順位、音效、答對彩帶／答錯 X、聖火進度條（合作）、個人排行榜、希望之燈動畫 |

## 主要功能

- **10 城鎮 + 自訂隊名**：城鎮清單在 `client.html` 的 `TOWNS` 陣列可增減；選完可改自訂名（≤10 字，中英文）。後端 `cleanTeam()` 過濾控制字元／角括號、前端渲染跳脫，雙層防 injection。
- **伺服器權威倒數**：開搶起算 `deadline`，由伺服器在歸零時廣播 `time_up`，**歸零後伺服器拒絕一切搶答**（真正鎖死）。秒數由環境變數 `COUNT_FROM` 設定（預設 60）。
- **搶答機制（拍燈定格）**：**第一個拍燈立刻鎖定其他人並讓投影倒數定格**，交由主持端驗證。答對 → 回合結束；答錯 → 該組**出局**、倒數**從剩餘秒數續跑**讓其他組接著搶（出局組無法再拍）。
- **主持判定**：O（正確）結束回合並計分；X（錯誤）將該組標記出局、焦點遞補到下一位搶答者。
- **計分系統**：答對 +10、答錯不加不扣、**跨回合累計**。主持端可**手動每組加減分**、**分數歸零**；「清空連線」會連同分數一起歸零。投影端顯示個人排行榜。
- **合作點燈「希望之燈」**：全體累計總分達**門檻**（主持端可即時調整）即解鎖「點燃希望之燈」按鈕，由主持人**手動**點燃，投影播放全螢幕點燈動畫。投影同時顯示「聖火進度條（合作）」呈現距離門檻的進度。門檻由環境變數 `LIGHT_THRESHOLD` 設定（預設 120）。
- **換城鎮限制**：「換城鎮」只在未開賽（locked）時可用，開賽後隱藏。
- **F5 回原城鎮（token 重連）**：學員重整／斷線重連時，靠重連權杖（token）讓伺服器辨識同一人並「接管」原城鎮，不受反向代理延遲清除舊連線影響；不同裝置撞同名仍會被拒。記憶綁「分頁」（`sessionStorage`），同瀏覽器多分頁不互相覆蓋。
- **音效**：第一搶 / 答對 / 答錯為真實 mp3 音檔（`public/sounds/`）；後續搶答的「叮」、倒數 tick（依剩餘秒數變頻）、time_up 收尾為 Web Audio 合成。投影端首次需點「🔊 點我啟用音效」解鎖（瀏覽器自動播放限制）。
- **PWA**：manifest + service worker（network-first，離線退回快取）。

## 快速啟動（本機）

需求：Node.js 18+。

```bash
npm install

# 設定主持端 PIN（不設則啟動時隨機產生並印在 log）
# Windows PowerShell：  $env:HOST_PIN="1234"; node server.js
# macOS / Linux：       HOST_PIN=1234 node server.js
node server.js
```

啟動後（預設 <http://localhost:3000>）：

- 學員端：<http://localhost:3000/client.html>
- 主持端：<http://localhost:3000/console.html>（輸入 PIN）
- 投影端：<http://localhost:3000/display.html>

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `3000` | 伺服器埠 |
| `HOST_PIN` | 隨機 4 碼 | 主持端進入 PIN；正式環境請固定設定 |
| `COUNT_FROM` | `60` | 搶答倒數秒數（伺服器權威）。改秒數只需改此變數、重啟服務，不必改碼 |
| `LIGHT_THRESHOLD` | `120` | 希望之燈解鎖門檻（全體累計總分）。主持端亦可即時調整 |

## 部署（Render）

專案內含 [`render.yaml`](render.yaml)：runtime Node、`npm install` 建置、`npm start` 啟動、free plan。

注意事項：
- WebSocket 在 HTTPS 下走 `wss://`（前端已自動依協定切換）。
- free tier 有冷啟動（閒置後首次連線約 30–60 秒喚醒）。
- `HOST_PIN` 在 Render 後台 Environment 設定（`sync: false`，不寫進 git）；要改倒數秒數可另加 `COUNT_FROM`、改點燈門檻可加 `LIGHT_THRESHOLD`。
- 推送到 `master` 後 Render 自動部署；前端有改記得 bump `public/sw.js` 的 `CACHE` 版本避免使用者卡舊版。

## 測試

```bash
# 端對端（Playwright）。load.spec 與 timeup-persist 都用 port 3100，
# 請用 --workers=1 序列化避免並行撞 port。
npx playwright test --workers=1

# WebSocket 直連併發壓測
npm run stress
```

## 技術棧

- 後端：Node.js + Express（靜態檔）+ `ws`（WebSocket 狀態機，伺服器權威倒數、token 重連、防注入）
- 前端：Vanilla JS + CSS，無框架、無建置；PWA（manifest + service worker）
- 音效：真實 mp3 取樣 + Web Audio API 合成
- 部署：Render（`render.yaml`）

## 專案結構

```
server.js              WebSocket 狀態機 + 靜態伺服 + 安全標頭
render.yaml            Render 部署設定
public/
  client.html          學員端（搶答鈕、選城鎮、F5 token 重連）
  console.html         主持端（PIN、開搶/重設/清空、O/X 判定、計分、點燈門檻、點燈）
  display.html         投影端（倒數、順位、音效引擎、聖火進度條、排行榜、點燈動畫）
  sounds/              first-buzz.mp3 / correct.mp3 / wrong.mp3
  sw.js                Service Worker（network-first）
  manifest.json        PWA manifest
tests/                 Playwright 端對端 + 壓測 + 情境截圖
PRODUCT.md             產品規格
```

## 授權與素材

- 程式：ISC。
- 音效：`correct.mp3` / `wrong.mp3` 為 Mixkit（免費、商用免署名）；`first-buzz.mp3` 為 Orange Free Sounds（**CC BY-NC，僅非商業用途**）。如需商業使用請替換第一搶音檔。

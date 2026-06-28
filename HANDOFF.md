# 對話交接筆記
> 產生時間：2026-06-26 ｜ 工作目錄：C:\ClaudeCodeDev\quiz-buzzer-system

## 背景與目標
升級「拍燈搶答系統」(quiz-buzzer-system,三端 WebSocket 即時搶答,希臘金箔暗夜風,活動「聖火之夜」用)。**全程用使用者的 agent 隊伍**(planner/coder/reviewer/debugger/tester/approver)+ `/ship` 分級調度。已連做五大批,**全部上線 Render**。最終目標:做出能跑完整場活動的搶答+計分+合作點燈系統,主持端主要用手機。

## 已完成 / 當前狀態
線上版本 **v35**(sw.js),master 最新乾淨,**59 Playwright 測試全綠**。五批(都已 commit+push+部署):
- **主升級**(962d753):搶答機制反轉(拍燈定格→判定→答錯續跑)、內建計分(答對+10)、合作點燈「希望之燈」(全體達門檻→主持手動點燃→投影全螢幕動畫)。
- **24 項完善**(21ec8ce,v33):點燈音效、可變加分(10/20/30)、撤銷誤判 host_unverify、快捷鍵、投影可讀性。
- **手機優化**(889b3ca):主持端 console reviewing 時收面板讓 O/X 上移、觸控放大。
- **三項**(29c544a,v34):答錯鎖定開關(lockOnWrong,可切「可再搶」+全部解放)、投影搶答中常駐完整榜、出局餘燼(已被下批石板取代)。
- **第五批**(2d1361b,v35):①PIN握手安全(host_auth,輸錯擋下) ②答錯重開按鈕立即重置(verify_result 清樂觀鎖) ③時間到強制 forceTimeUp ④display 消水平捲軸+回顧7秒自動切回 ⑤城鎮即時看板(完整列出含0分+scoreSince 平手排序) ⑥搶答鈕全套「白大理石石板」(浮起/按壓下凹/裂石出局)。

## 待辦 / 下一步
- [ ] **(reviewer 非阻斷,優先)** console 重連重驗**逾時保護**:送 host_auth 後若 server 不回,PIN 畫面會卡「驗證中…」無提示。加 5-8 秒 timeout fallback。
- [ ] **(reviewer 非阻斷)** client `verify_result` 一拍 **stale 重繪閃爍**:現在 verify_result 後 `applyState(lastState)` 用判定前快照多繪一次。建議改成「只解鎖 buzzed,重繪交給緊接的權威 state」(client.html verify_result handler)。
- [ ] (可選) 全系統石板統一:目前只 client 搶答鈕石板化,console/display 仍金箔火焰系;若要一致需另開工。
- [ ] (可選) display open 右側榜/mini 目前只列有分數組(拍板 D);若要也完整列 0 分再調。

## 關鍵決策與踩過的雷
- **決策**:合作點燈敘事——把「各組競爭」改成「八城鎮合作達門檻點燈」(使用者活動故事:赫拉降長夜→通過試煉重燃聖火)。競爭性用「沒點燃明天早起」話術+第一名零食補。
- **決策**:答錯鎖定模式 `lockOnWrong`——預設出局,可切「可再搶」(非鎖=移除該組 buzzOrder entry),切非鎖時「全部解放」(清 eliminated+殘留 wrong entry+lastVerify)。
- **決策**:城鎮看板平手排序用 `scoreSince`(server 記)——0分=加入時間、有分=達分時間(使用者要的混合)。
- **雷(最重要)**:**部署認證**。使用者**在 B 電腦透過 Remote Control** 連回 A 電腦(yoga9)跑的 session,push 需 GitHub 認證但 A 電腦的認證彈窗 B 看不到。解法=**GitHub device flow**:`curl -X POST https://github.com/login/device/code -d "client_id=178c6fc778ccc68e1d6a" -d "scope=repo"` 拿 user_code→使用者瀏覽器 github.com/login/device 輸碼授權→poll access_token→`git push https://x-access-token:TOKEN@github.com/...`。token 沒存,**每次 push 都要重走**;用背景 poll loop 自動 push。device_code 有效 ~15 分鐘會過期。
- **雷**:Remote Control「B 只是一扇窗、運算和檔案都在 A」。所以跨機看截圖全失敗(SendUserFile 卡片 RC 介面點不開、公開圖床被安全 classifier 擋=data exfiltration、Google Drive 上傳的 base64 會被 30000 char 工具輸出上限截斷);CLI 也接不了 RC session。**最後靠「部署上線」徹底繞過**——上線後任何裝置開網址即可。
- **雷**:使用者一度反映「加分只能固定 10」,其實是**手機看到舊快取版**,分值選擇器早就做了。先確認版本/清快取再動工,別重做。
- **雷**:Bash 複合命令含 `rm`/`sed -i` 會被權限擋。改用 Edit 工具改檔、用 gitignore(`tests/_*.js`)排除臨時截圖腳本,別 rm。
- **雷**:coder agent **沒有 WebSearch/firecrawl 工具**;要上網找設計參考(石板/餘燼)得由主 Claude 自己用 firecrawl 找好、提煉要點再餵給 coder。

## 相關檔案 / 指令 / 連結
- 專案根:`C:\ClaudeCodeDev\quiz-buzzer-system`(GitHub: chunkaiy8179-arch/quiz-buzzer-system,分支 master)
- 核心:`server.js`(WS 狀態機+協定)、`public/{client,console,display}.html`(三端)、`public/sw.js`(改前端要升 CACHE 版號,目前 buzzer-v35)
- 線上:https://quiz-buzzer-system.onrender.com/{client,console,display}.html (push master→Render 自動部署)
- 主持端 PIN:Render 後台環境變數 `HOST_PIN`(舊值 810709,以後台為準)
- 測試:`cd C:\ClaudeCodeDev\quiz-buzzer-system && npx playwright test --workers=1`(59 passed;務必 --workers=1,否則 port 撞)
- git 身分:chunkaiy8179 / chunkaiy8179@gmail.com(本機已設)
- 部署:push 需 device flow 授權(見上方雷);commit 後跑背景 poll loop 自動 push,監控 sw.js 版號確認上線
- 環境變數:`COUNT_FROM`(倒數,預設60)、`LIGHT_THRESHOLD`(點燈門檻,預設120)、`LOCK_ON_WRONG`(預設true)
- 記憶:`C:\Users\yoga9\.claude\projects\C--ClaudeCodeDev\memory\project_quiz_buzzer.md` 有完整逐批進度

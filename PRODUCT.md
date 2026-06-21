# Quiz Buzzer System — PRODUCT.md

register: product

## Product

Web-based quiz buzzer system for live quiz events. Three synchronized panels over WebSocket:
- **Student client** (`/client.html`): mobile buzzer button, fullscreen, PWA
- **Host console** (`/console.html`): control panel to open/reset rounds, verify answers
- **Display screen** (`/display.html`): projection screen with countdown, rankings, sound effects

## Users

- **Host**: runs the session from a tablet/laptop; needs clear control flow and immediate feedback
- **Students**: tap buzzer on phones; button state must be instantly obvious at arm's length
- **Audience**: views display screen projected on a wall; text must be readable from 5–10m

## Brand & Aesthetic

Greek gold-foil night theme ("聖火之夜" / Night of the Sacred Flame). Customized for a
Greek-mythology-themed event; replaces the earlier red game-show look.

Gold: `#d4af37` / `#f5d77a` — titles, 1st place, focus, primary actions (on dark text)
Flame: `#e8431f` (red) / `#f5a623` (amber) — BUZZ button, sacred-flame motif
Surface: deep blue-purple night gradient (`#0a1430` → `#160e2c` → `#261031`)
Text: `#f3ecd9` — primary, `#a99a76` — secondary
Type: Noto Serif TC (gold titles) + Noto Sans TC (body)

## Key Flows

1. Students pick a town (1 of 10) or type a custom team name, then join.
2. Host enters PIN, taps "點燃聖火" → WebSocket broadcasts phase=open and the server starts an
   authoritative countdown (`COUNT_FROM`, default 30s).
3. Students tap BUZZ → ranked by **server** timestamp. 1st buzz plays the buzzer mp3 + flash on
   display but **does NOT stop the countdown** (it keeps running). Later buzzers play a "ding".
4. Countdown hits zero → server broadcasts `time_up`, marks the round `closed`, and **rejects all
   further buzzes** (true lockout).
5. Host taps O/X to verify → correct (mp3 + confetti) returns to locked; wrong (mp3 + X) moves focus
   to the next buzzer.
6. Host taps "重設" (reset) → clears the round; "清空連線" (clear) → forces everyone back to town select.

## Reconnect & Identity

- Each student device gets a reconnect **token** on join (server: `teamTokens`).
- On F5/refresh the client re-sends `{team, token}`; the server recognizes the same person and
  **takes over** the town, evicting the stale old socket — necessary because reverse proxies (Render)
  can take ~10s to detect a closed socket, far longer than the client's retry budget.
- A different device with no/wrong token is still rejected (duplicate name protection).
- Identity is stored in `sessionStorage` (per-tab): F5 in the same tab restores the town; a second
  tab in the same browser does not clobber the first. Closing the tab and reopening requires re-select.

## Technical Constraints

- Vanilla JS + CSS only (no framework, no build step)
- Deployed on Render free tier: cold starts ~30–60s, WebSocket needs `wss://` over HTTPS
- Server is authoritative for countdown and buzz ordering (clients cannot manipulate rank)
- Audio: real mp3 samples (first-buzz / correct / wrong in `public/sounds/`) + Web Audio API
  synthesis (ding, frequency-stepped countdown ticks, time-up). Display needs one user gesture to
  unlock audio (autoplay policy).
- PWA: manifest + service worker (network-first) for "Add to Home Screen"; bump `sw.js` CACHE on
  frontend changes.

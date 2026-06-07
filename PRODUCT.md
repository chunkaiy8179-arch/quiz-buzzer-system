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

Dark game-show aesthetic. High contrast, high energy for presentation/meeting room context.

Primary: `#e11d48` (red) — danger/attention, used for BUZZ button, logo
Accent: `#f59e0b` / `#fde047` (amber/gold) — 1st place, focus state
Surface: `#0a0a0a` — near-black background
Text: `#e5e5e5` — primary, `#999` — secondary

No gradients, no glassmorphism, no cream/beige.

## Key Flows

1. Host taps "開啟搶答" → WebSocket broadcasts phase=open
2. Students tap BUZZ → ranked by timestamp; 1st buzz triggers boom sound + flash on display
3. Host taps O/X to verify → correct returns to locked; wrong moves focus to next buzzer
4. Host taps "重設" → clears all, returns to idle

## Technical Constraints

- Vanilla JS + CSS only (no framework, no build step)
- Deployed on Render free tier: cold starts ~50s, WebSocket needs `wss://` over HTTPS
- Audio via Web Audio API (no external files)
- PWA: manifest + service worker for "Add to Home Screen"

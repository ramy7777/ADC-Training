# ADC Training — 3D Conversational Scenario Prototype

"A Morning at Abu Dhabi Customs" — an internal proof-of-concept for the ADC VR
Training System bid. A walkable 3D customs house (Three.js) where **Saif**, an
AI mentor powered by the **Gemini Live API (native real-time voice)**, leads the
trainee through six themed stations in natural conversation — weaving the
assessment into the scenario and triggering 3D interactions at the right moment
via tool calls. Bilingual (English / Arabic, RTL).

The scoring engine implements the client's spec exactly: 24 assessed moments
per level (6 skills × 4), 5 marks each, pass at 96/120, 5 tries with a
different draw each try, level gating with a logged admin bypass (PIN 2026).

## Run locally

```bash
npm install
GEMINI_API_KEY=<your key> node server.js
# open http://localhost:10000
```

## Deploy (Render)

Web service · build `npm install` · start `node server.js` · env var
`GEMINI_API_KEY`. The key is injected at runtime from the environment — it is
never committed to this repository.

## Notes

- Chrome recommended (mic + WebAudio). Click the canvas to enter mouse-look
  (pointer lock); WASD/arrows to move, Shift to run, Esc to release.
- `?autostart&fast&lang=ar` skips the menu — kiosk/demo mode.
- If the mic or the Live connection is unavailable the app degrades to
  text-to-speech narration with clickable 3D interactions, so a session can
  always be completed.
- Internal evaluation tool. The delivered ADC system will use Azure UAE North
  services per the RFP; the conversation layer here sits behind a seam that
  maps 1:1 to Azure OpenAI + Azure Speech.

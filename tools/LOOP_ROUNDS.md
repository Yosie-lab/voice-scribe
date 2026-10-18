# VoiceScribe loop engineering

Measure → **one lever** → remeasure. Freeze line: 7 mandatory harness skills stay green.

```bash
node tools/loop-engineering.js
node tools/harness-skills/run-standalone.js   # skills only
node tools/ja-live-speech-harness.js          # full client regression
```

## Mandatory 7 skills

| ID | Focus |
| --- | --- |
| 01-idle-no-stt | No live captions before/during idle |
| 02-session-start-order | Mic before STT; iOS gesture kick |
| 03-continuity-live | Do not stop a live desktop ja engine |
| 04-dead-engine-revive | Auto-recover zombies/stalls (stop, not abort) |
| 05-ja-transcript | Dedupe / polish live ja text |
| 06-single-mic | One getUserMedia path (recorder) |
| 07-two-phase-whisper | Web Speech live + Groq Whisper after stop |

### Hillclimb round 1 — v96 snappy revive

- **Fixture:** `node tools/loop-engineering.js`
- **Hypothesis:** Shorter dead-engine revive (1.4s) and faster caption health poll (250ms) recover stalls sooner without touching a live desktop engine (skill 03).
- **Change:** `stallAutoRestartMs` / related revive gaps → 1400; `captionStaleMs` → 2800; `captionHealthPollMs` → 250; build v96.
- **Before → after:** v95 1800ms revive / 3200ms stale / 300ms poll → v96 values above.
- **Verdict:** keep (`node tools/loop-engineering.js` green)

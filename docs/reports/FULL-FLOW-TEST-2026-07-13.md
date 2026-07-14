# VideoForge full-flow test - 2026-07-13

## Sample

- Public Douyin URL: https://www.iesdouyin.com/share/video/7602293533764013363/
- Title: 哪些是AI视频，你能分清吗？ #科普一下 #AI
- Author: 小左万物
- Duration: 63 seconds
- Extraction: TikHub metadata -> local Whisper ASR
- Extracted transcript: 281 Chinese characters
- VideoForge records: extraction `2`, article `117`, job `11`

## Results

| Stage | Result | Evidence |
| --- | --- | --- |
| Douyin resolution | Pass | TikHub resolved the public video and audio source. |
| Speech transcription | Pass | Local ASR returned the spoken transcript instead of the 9-character title. |
| Script and outline | Pass | 563-character script, 3 chapters, 10 steps. |
| Style and avatar layout | Pass | `newsroom`, avatar enabled, right-side 448px lecturer area. |
| Chapter generation | Pass after retry | 3/3 chapters and 10/10 steps generated; TypeScript and production build passed. |
| Chapter review gate | Pass | Overall approval was rejected with HTTP 409 until all three chapters were approved. |
| Scoped dialogue | Pass after retry | `01-hook` check read only that chapter; no files changed; other chapters were untouched. |
| Layout audit | Pass | 3/3 chapters reserve 448px; visual inspection found a further 96px content safety gap. |
| MiniMax TTS | Pass | 10/10 MP3 segments, 354 characters, zero failed requests. |
| Subtitle cues/UI | Pass after retry | 10/10 cue groups; audio mode advanced narration and visible subtitles in the browser. |
| Avatar lip sync | Blocked | Source video exists, but local HeyGem `127.0.0.1:7861` is not running and its configured Python environment no longer exists. |
| Preview | Pass | Vite preview available; no application runtime errors (favicon 404 only). |
| Render guidance | Pass | Render stage returned the complete auto-play recording instructions. |

## Defects found and fixed

1. Windows Node 24 terminated during `fs.cpSync()` without throwing, leaving scaffold stuck forever. Replaced it with an observable recursive file copier.
2. Spawn failures could leave a stage unresolved. Added child-process error handling and a single-settlement guard.
3. A6 returned HTML error pages for HTTP 524. Added readable non-JSON errors, a 180-second timeout, and three-attempt backoff for 5xx responses.
4. Chapter generation initially registered chapters only at the end, so partial preview referenced a deleted example chapter. The generation contract now registers and type-checks each chapter before starting the next.
5. The layout audit recognized `reserved` but not the common CSS class name `reserve`, producing false failures. Both forms are now accepted.
6. ASR connection failures previously displayed a misleading ten-minute timeout. The actual connection error is now preserved.
7. Feedback progress is now recorded as job events and displayed by operation rather than a generic spinner.

## Remaining blocker

HeyGem cannot be started from this machine's documented command because the old interpreter path `F:\qingyuAI\python-modules\hdModule\venv\python.exe` is absent. Install or restore the HeyGem runtime, start port `7861`, and retry job 11 at `avatar_gen`. The pipeline correctly keeps the job failed at that stage rather than marking an avatar-less export as complete.

## Verification commands

- Dashboard production build: passed
- `node --check` for changed server modules: passed
- Generated presentation `npx tsc --noEmit`: passed
- Generated presentation `npm run build`: passed
- Browser snapshot and audio/subtitle interaction: passed


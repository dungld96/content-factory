# M5 paid benchmark (V12) and M4 image benchmark (G2): results

- Date: 2026-11-19. Budget approved: USD 2.00 (key limit USD 5). Spent: **USD 1.03** (ledger).
- Commands: `ACF_PAID_SMOKE=1 pnpm ai:registry smoke-image|smoke-video|smoke-tts …`, each capped.
- Models were imported (disabled, tier `balanced`); **none was enabled or routed** by the benchmark.
- Outputs (not committed): `benchmark/m5/{images,videos,audio}`.

## Images (fixed 9:16 product prompt, 1 image each)

| Model                                       | Size           | Time   | Cost (reported)     | Notes                                                         |
| ------------------------------------------- | -------------- | ------ | ------------------- | ------------------------------------------------------------- |
| `bytedance-seed/seedream-5-0-flash`         | 1152×2048 JPEG | 12.8 s | $0.018 (= estimate) | Cleanest, all props correct, full 9:16 resolution             |
| `black-forest-labs/flux-3-image-klein` (1K) | 768×1360 JPEG  | 5.3 s  | $0.009 (= estimate) | Good, warm look; priced per resolution (needs `--resolution`) |
| `recraft/recraft-v4.1-flash`                | 768×1344 WebP  | 1.7 s  | $0.007 (= estimate) | Atmospheric; product barely visible                           |

## Video (4 s, 720p, no audio requested, first frame = the Seedream image)

| Model                              | Output                       | Time  | Estimate | Reported  | Notes                                                                       |
| ---------------------------------- | ---------------------------- | ----- | -------- | --------- | --------------------------------------------------------------------------- |
| `google/veo-3.1-lite`              | 720×1280 H.264, 4.00 s       | 49 s  | $0.12    | **$0.12** | Most faithful to the keyframe; smooth push-in                               |
| `x-ai/grok-imagine-video-1.5-lite` | 720×1280 H.264, 4.04 s       | 49 s  | $0.13    | **$0.13** | Pans away; adds prompt objects                                              |
| `kwaivgi/kling-v3.0-std`           | 720×1280 H.264, 4.04 s       | 109 s | $0.336   | **$0.42** | Billed 5 s for a 4 s clip (minimum billed duration)                         |
| `alibaba/wan-3.0`                  | 720×1280 H.264 + AAC, 4.04 s | 171 s | $0.40    | **$0.30** | Returned an audio track although none was requested; invents product action |

The smoke prompt mentions a laptop and a coffee cup that are not in the keyframe; models adding
them follow the prompt. Every model accepted the first frame as a data URL (risk R4: confirmed
for these four). No failed or expired jobs occurred, so R3 (billing of failures) is still open.

## Text-to-speech (Vietnamese, 113 characters)

| Model                               | Voice        | Output    | Time  | Cost                | Notes                                                        |
| ----------------------------------- | ------------ | --------- | ----- | ------------------- | ------------------------------------------------------------ |
| `elevenlabs/eleven-multilingual-v2` | sarah        | MP3 8.1 s | 1.0 s | $0.0090 (estimated) |                                                              |
| `elevenlabs/eleven-v3`              | sarah        | MP3 8.4 s | 3.3 s | $0.0090 (estimated) |                                                              |
| `microsoft/mai-voice-2.1`           | vi-VN-Harper | MP3 8.0 s | 1.2 s | $0.0025 (estimated) | Native Vietnamese voice                                      |
| `fish-audio/s2-pro`                 | —            | —         | —     | $0                  | `400 Reference not found`: needs a cloned reference voice id |
| `google/gemini-3.8-flash-tts`       | —            | —         | —     | —                   | Not run: token-priced, cost cannot be capped in advance      |

Quality of the Vietnamese voices needs a human listen.

## Findings to act on

1. **Minimum billed duration (Kling).** _Fixed:_ video constraints carry an operator-set
   `minBilledSeconds` (`pnpm ai:registry model set-min-billed-seconds <modelKey> <s|none>`, kept on
   re-import); estimates, the spend guard and the ledger bill `max(requested, minimum)`, and the
   plan shows `requestedSeconds` and `billedSeconds`. Kling v3.0 Std is recorded at 5 s (still
   disabled).
2. **Unrequested audio (Wan 3.0).** `generate_audio: false` still returned an AAC track. Harmless
   for M6 if the voice-over replaces the clip's audio, but the price variant may differ.
3. **TTS reported cost not retrieved.** All three TTS calls recorded `estimated` cost: the
   `/generation?id=` lookup returned nothing right after the call; minutes later the records held
   exactly the estimated amounts ($0.00904, $0.00904, $0.002486). _Fixed:_ the adapter retries the
   lookup after 0.5 s, 1.5 s and 3 s before falling back to the estimate.
4. **Network in this cloud environment:** Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to use the
   session proxy (environment quirk, not an application change).

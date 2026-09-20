# Lumi layered character, v1

Superseded for the active `lumi2d` presentation by `../lumi-reclining/` after the user's request for a relaxed sofa pose. This directory records the previous standing assets.

This is the 2.5D replacement for the experimental 3D character, using the original Lumi portrait as the face reference. It is selected by the existing `lumi2d` appearance setting.

## Assets and provenance

Generated with the built-in image generation tool on 2026-09-19; no external digital-human API is required at runtime. The original face, blink and matte remain in `../lumi-world/`.

| File | Purpose | Dimensions |
| --- | --- | --- |
| body-sleeves-v1.png | Headless body and two detached sleeve layers | 1254 × 1254 |
| hands-v1.png | Left/right relaxed, open-palm and precision hand poses | 1086 × 1448 |
| speech-open-v1.png | Original portrait with an open speaking mouth; only the mouth region is blended | 1024 × 1536 |

The renderer uses atlas UV regions, independent shoulder and wrist transforms, continuous elbow deformation, and body/coat deformation. Face motion includes blinking, limited gaze, head tilt, nodding and audio-amplitude-driven mouth opening. Hand poses crossfade over short transitions; fingers do not have individual bones. This is a frontal conversation puppet, not a walking or freely rotatable 3D avatar. Mouth motion is not phoneme-level lip synchronization.

Source: `src/components/LumiLayeredCharacter.tsx`, `src/lib/lumiLayeredMotion.ts`. Existing conversation/audio configuration is reused. Close and full-body camera views are available in the stage.

## Generation prompt specifications

These are the generation specifications, not a verbatim transcript of tool calls.

1. **Body and sleeves.** Use the original Lumi otome portrait and its full-body design reference. Produce a transparent production sprite atlas with a complete headless, armless central body from collar to boots and two separate matching sleeves from shoulder to ivory cuff, without hands. Preserve the charcoal/teal coat, gold edging, ivory shirt, waistcoat, belt, turquoise brooch and chains. Complete the garment behind the removed arms. Three separated columns, consistent lighting and scale, no labels or background.
2. **Hands.** Use the original portrait as the skin/style reference. Produce six detached elegant young-adult masculine hands on a transparent atlas: viewer-left/right columns, relaxed/open-palm/loose-precision rows. Wrists face upward, fingers downward, consistent wrist scale and anchors, with a short bare-wrist extension. No sleeves, arms, labels or background.
3. **Speaking mouth.** Precisely edit the original 1024 × 1536 portrait while preserving its composition and appearance. Change only the mouth into a modest speaking “ah”, about 50 pixels wide and 14–18 pixels high near x=515, y=286, with visible mouth interior and teeth. The renderer blends only the mouth region.

Original generation outputs: `C:/Users/Administrator/.codex/generated_images/01a070b2-6aa9-73b0-b801-bb97af129332/`:

- `exec-6fc4a208-e665-475f-91c3-0141b6e4e5b0.png` — body/sleeves
- `exec-b2f9cece-c253-4ce5-b888-d410d92f61a5.png` — hands
- `exec-66178ff5-47a1-48f8-84b6-001f2479057c.png` — speaking mouth

## Validation

Targeted motion, stage and editor tests: 25 passed. Isolated browser verification uses the actual production stage, real local test WAV playback, mounted shader uniforms and screenshots. It covers both arms/hands, speech start/stop, blinking, thinking/listening, full-body framing, narrow framing, reduced motion and remount resource stability.

Review artifacts: `D:/LumiCore-Avatar-Design/lumi-layered-v1/review/`. The preview uses a local Windows test voice, not the user's configured Lumi voice. Native microphone conversation was not tested in this verification.

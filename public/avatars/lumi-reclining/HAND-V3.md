# Seated hand correction — 2026-09-19

Superseded on 2026-09-20 at the user's request: all body/arm/head gestures were removed. The current renderer uses a fixed original seated image with only blinking and audio-driven mouth movement. The v3 arm source and motion textures no longer load or ship. This document records the retired experiment.

The previous animation attached a standing sleeve and a separate hand to the seated character. Their proportions, lighting and wrist directions did not match.

The resting view now preserves the original seated portrait, including its complete sleeve, cuff and hand. During the preset hair gesture, `seated-arm-v3.png` supplies the sleeve and hand from a seated-arm edit; the cuff, wrist and all fingers move together, without a separately rotated hand. The arm returns to the original image at the end. This remains authored 2D animation, not freely generated motion or finger tracking.

The built-in image generation tool produced the cutout. The exact prompt and source path are in `hand-v3-provenance.json`. Code applies texture coordinates, alpha masking and transforms; there was no programmatic raster repainting.

The rejected custom VRM and sample VRM have been removed from the appearance selector and renderer, and the VRM dependency was uninstalled. Legacy `lumivrm` records render as the 2D character; saving the appearance changes the style to `lumi2d`. The two old asset directories are excluded from frontend builds and return 404 in Vite development. Physical deletion was initially blocked, then completed and verified on 2026-09-20 following the user's renewed request.

Validation: 43 targeted tests, TypeScript, ESLint for affected components, desktop frontend build, and actual WebGL playback in isolated Edge. The render acceptance covers the complete arm cycle, original hand at rest, local WAV mouth movement, reduced motion, and stable resource counts after two remounts. It does not claim live microphone/conversation acceptance.

Review artifacts: `D:/LumiCore-Avatar-Design/lumi-hand-v3/review`.

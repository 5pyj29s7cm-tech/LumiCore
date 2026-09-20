# Fixed seated portrait — 2026-09-20

The user rejected the character's unnatural gestures and asked to remove them.

Removed: hair brushing, arm and hand sprites, body/ankle/head deformation, pointer gaze, automatic expression changes, gesture scheduling and portrait camera parallax. The portrait is now one fixed quad using the original seated image. Blinking and audio-amplitude mouth movement remain. The 3D room and its ambient curtain movement remain separate from the character.

Runtime portrait textures: `idle-v1.png`, `blink-v1.png`, `speech-v1.png`.

The old standing sprite directory and retired seated motion textures are excluded from the frontend build. Old VRM directories remain excluded. An initial deletion attempt was rejected by automatic approval policy. After the user's renewed request on 2026-09-20, ordinary `Remove-Item -LiteralPath` successfully deleted both VRM files and their metadata directories; filesystem readback confirmed both directories are absent. No permission modification or alternate deletion mechanism was used.

Verification artifacts: `D:/LumiCore-Avatar-Design/lumi-still-v4`. Renderer acceptance checks that body geometry and transform stay fixed through idle/listening/thinking/speaking, camera no longer follows the pointer, no retired arm textures load, and local WAV playback still opens/closes the mouth. This does not claim native microphone testing.

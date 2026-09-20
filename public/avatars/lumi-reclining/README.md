# Lumi reclining conversation, v1

## Current fixed portrait (2026-09-20)

At the user's request, all body, arm, hand and head movements have been removed. The original seated portrait stays fixed; only blinking and speech-driven mouth movement remain. The current implementation is described in [STILL-V4.md](STILL-V4.md). Previous motion assets are no longer loaded or included in the build.

## Historical animation and night-scene update (2026-09-19)

The active renderer now has an independent upper arm, forearm and hand. A 6.8-second preset raises the resting hand, brushes the hair, and returns it to the armrest. It first becomes eligible after five seconds of quiet time and then uses a long cooldown; it does not start during speaking/thinking. A gesture already in progress finishes smoothly. Reduced-motion preference disables it. This is a planar joint animation, not generated video or human motion capture.

Smiling and thoughtful face frames blend according to idle/listening/thinking/speaking state. They do not infer the semantic emotion of the conversation. Mouth opening remains driven by actual audio amplitude.

The active night scene uses a photographic city matte, a photographic linen floor-lamp cutout, and real 3D room/window/curtain geometry. Ambient and overhead fill have been reduced; the figure has a matching warm/cool night color grade. The city matte and lamp are not fully modeled 3D objects. This replaces the previous toy-like city geometry for this avatar style.

New active generated assets, all created with the built-in image generation tool:

- `clean-plate-v3.png`: arm-free underlay with closed coat shoulder. Only the removed-arm region is sampled; the original face and body remain elsewhere. The original silhouette additionally masks the underlay.
- `smile-v2.png`, `thoughtful-v2.png`: expression frames, sampled only over the face.
- `night-city-v2.png`: distant night city and half-moon texture.
- `reading-lamp-v2.png`: linen reading lamp with warm transmitted light.
- The existing `../lumi-layered/body-sleeves-v1.png` and `hands-v1.png` supply the separated limb textures.

`clean-plate-v2.png` is an intermediate asset with incorrect background alpha; it is not used by the renderer. Its alpha and shoulder-opening defects were fixed in v3 and guarded by the original silhouette mask.

Exact prompts: `animation-v2-prompts.json`. Review and recorded animation: `D:/LumiCore-Avatar-Design/lumi-night-v2/review/`. The acceptance script checks the mounted hand position during lift/contact/return, the stationary sofa, expressions, real-audio mouth, silence, local-only assets, near/full/portrait framing and repeated renderer teardown. 29 targeted tests passed.

Generation source directory remains the one below. New source filenames:

- `exec-4b405b3b-2919-4aff-b7e0-a50b2e474d9b.png` → `clean-plate-v3.png`
- `exec-6f588cc8-060c-40e2-9e5c-f896eb5e6e76.png` → `smile-v2.png`
- `exec-9c5efe5a-0fdc-48d5-a5dd-1cf969bbb44a.png` → `thoughtful-v2.png`
- `exec-2f85c7bc-810f-44a4-91ad-552fe679a284.png` → `night-city-v2.png`
- `exec-ac9716e4-51af-4bf9-a117-77ab416ed19a.png` → `reading-lamp-v2.png`

The sections below record the previous version.

Generated with the built-in image generation tool on 2026-09-19. This replaces the standing `lumi2d` presentation following the user's request for a closer, more natural view and a relaxed reclining sofa pose.

Files: `idle-v1.png`, `blink-v1.png`, `speech-v1.png`, all 1536 × 1024 RGBA. The original alpha is preserved. The definitive identity reference was `../lumi-world/lumi-otome-idle.webp`.

The character and sofa are a 2.5D textured mesh. Local deformations affect the head, breathing chest, forearms, wrists and ankle; the support points and most of the sofa stay fixed. Only the eye and mouth regions blend the animation frames. There are no individual finger bones, free 3D turns or phoneme recognition. The surrounding room, curtain and outdoor city remain 3D. The close camera and background depth of field are rendered at runtime. Existing voice configuration is reused; no digital-human API is required.

## Saved generation outputs

Source directory: `C:/Users/Administrator/.codex/generated_images/01a070b2-6aa9-73b0-b801-bb97af129332/`.

- `exec-09bb636f-b9d0-41e1-b7b8-14dad721f44c.png` → `idle-v1.png`
- `exec-c7dfd8ba-bb29-4084-b2e3-e888abcf4e48.png` → `blink-v1.png`
- `exec-845adeca-86f2-44d3-9fdc-a0e3cd43c194.png` → `speech-v1.png`

## Final prompt set

### Seated identity reference

Use case: identity-preserve. Production reference for an animated 2.5D Lumi companion. Use the supplied image as the definitive identity: keep the exact same recognizable young adult man's face, grey-brown parted hair, grey-green eyes, dark charcoal teal tailored long coat with delicate gold edging, ivory high collar shirt, turquoise brooch. Make him MUCH more natural and realistically lit, fine skin and fabric texture, expensive otome cinematic character rather than plastic cartoon. Show his ENTIRE BODY, head and boots included, comfortably lounging half-seated and slightly reclined in a generous warm taupe contemporary fabric sofa. His back and one shoulder are visibly supported by cushions, torso leaning about 12 degrees toward viewer's left, relaxed weight, pelvis and bent legs naturally supported, ankles loosely crossed forward. He looks directly at the camera with a calm welcoming expression and closed mouth. One forearm lies along the viewer-left sofa armrest with relaxed hand; the other rests loosely on his thigh, so both can later gesture. Sofa is modern, deep-seat, softly rounded, linen weave, no ornate carving. Gentle warm key light from upper-left, soft cool reflected light from right. Camera frontal at seated eye level, mild 50mm perspective, avoid foreshortening. Composition: character centered, full sofa and full character visible, no room/floor behind it. Genuinely TRANSPARENT background, clean alpha edge, no background shadow rectangle, no labels, no grid, no text. Large landscape image, high detail in the face and hands. This is a reference cutout for layer separation; no room environment in this image.

### Blink frame

Use case: precise-object-edit. This is an animation frame of the supplied reclining Lumi on a sofa, transparent PNG. Change ONLY both eyes to a gentle fully closed natural blink, with eyelids in exactly the same eye positions. Keep EVERY other pixel, face identity, eyebrows, mouth, hair, pose, hands, clothing, sofa, lighting, silhouette and TRANSPARENT ALPHA unchanged. Maintain exact 1536x1024 canvas, same scale and alignment. No new expression, no camera change, no relighting, no backdrop. This will be blended only over his eyes on the original frame.

### Speech frame

Use case: precise-object-edit. Exact aligned speaking animation frame of supplied reclining Lumi on sofa. Change ONLY the closed mouth centered at approximately x611,y166 on this 1536x1024 image: open into a natural modest speaking 'ah', about 43px wide and 11px high, with dark mouth interior and a slight upper teeth edge. Keep lips elegant and relaxed, no exaggerated smile. EVERYTHING else exactly unchanged: identity, eyes open, all face geometry, hair, body, hands, clothing, sofa, pose, lighting and original transparent alpha. Same canvas size, alignment and scale. No background, no crop, no relighting. This will be blended over just the mouth region in the original image.

## Checks

27 targeted tests, TypeScript, relevant ESLint and desktop UI build passed. Actual production rendering and local test WAV playback passed: default close framing, corner background, both hands moving with the sofa stationary, mounted mouth shader responding to sound, silence closes mouth, blink, full-body and narrow framing, reduced motion, two remounts without increasing GPU allocations. Review: `D:/LumiCore-Avatar-Design/lumi-reclining-v1/review/`.

The preview uses a local Windows test voice, not the user's configured voice. Native microphone conversation and livestreaming were not tested in this pass.

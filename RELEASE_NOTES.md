# LumiCore Release Notes

## v3.1.0 LumiCore task-loop and product migration

- Renamed the user-facing product, desktop binary, installers, public source repository, and website from LumiOS to LumiCore while preserving the stable application identity and explicit legacy upgrade fallbacks.
- Added lease-protected, integrity-checked in-place migration from the legacy user data root so conversations, settings, voice preferences, and credentials are not copied or discarded during the rename.
- Made chat, task, voice, tool, adapter, and multi-agent terminal outcomes durable before they are presented as complete, with restart-safe checkpoints and receipt-bound arbitration.
- Added scoped model failover, bounded request context, clearer failure state, conversation/task continuity, and removal of the false “no current-turn tool execution” response replacement.
- Replaced the command-center office with a live receipt-driven agent cosmos and added consent-based computer capability discovery with explicit privacy boundaries.

## v3.0.3 stability and release candidate hardening

- Added immutable runtime build metadata shared by source runs, bundled backend health/version APIs, desktop resources, manifests, and installer smoke tests.
- Eliminated racing `AudioContext.close()` failures across calls, voiceprints, wake word, and voice cloning.
- Enforced zero critical/high production dependency findings and documented the remaining MCP/Hono reachability decision.
- Moved 3D, MediaPipe, Picovoice, and terminal code out of the desktop preload chain; initial desktop resources are capped at 750 KiB gzip.
- Added PR/main CI gates, Windows packaged/installer lifecycle smoke tests, 50-run cold-start evidence, and a 24-hour reference-machine soak workflow.
- Internal candidates use the `internal` channel and do not register the public updater. Public candidates require updater signing, Authenticode, HTTPS distribution, current-commit evidence, and explicit commercial-license approval.

The old v3.0.0 manifest and `release-out` bundle are historical only. They must never be copied, renamed, or reused for v3.0.3; regenerate all artifacts from the current commit.

## v3.0.2 display-scaling adaptation

- Added compact and tight desktop layouts for macOS/Windows display scaling.
- Kept app windows clear of the top bar and dock at reduced logical resolutions.
- Made first-run, onboarding, login, and control-center actions scrollable and reachable.
- Added live visual-viewport tracking for scaling and mixed-DPI monitor changes.

## v3.0.1 macOS desktop-control repair

- Preserves the legacy macOS `open` behavior that already launched AutoCAD, while adding installed `.app` discovery, localized aliases, and LaunchServices name lookup.
- Reports native macOS Accessibility and Screen Recording readiness instead of an obsolete external-app switch.
- Adds real macOS screen capture and Retina-aware input coordinate mapping for visible computer control.
- Makes the computer adaptation report evidence-based for apps, MCP connections, knowledge files, permissions, and the bundled Node runtime.
- Replaces the fragile default desktop `npx` Filesystem process with Lumi's built-in file tools and packages the correct macOS Sharp native runtime.
- Adds optional Developer ID signing/notarization to the macOS workflow and verifies architecture, permissions metadata, native resources, and signature state.

## v3.0.0 private-paid (historical)

Release artifacts:

- Bundle directory format: `release-out/lumicore-v3.0.0-<short-commit>`
- Installer: `LumiCore_3.0.0_x64-setup.exe`
- Exact source commit, file size, and SHA-256 are recorded in each generated `release-manifest.json`.

Validated gates:

- `npm run lint`
- `npm run test -- --run`
- `npm run release:verify`
- `npm run tauri:build`
- `npm run smoke:installer:win`
- `npm run release:manifest`
- `npm run release:bundle`

Highlights:

- Packaged desktop resources are verified before release, including bundled backend, Node runtime, `tsx`, MCP SDK, `zod`, and bundled skills.
- Windows installer smoke test covers silent install, first backend start, marketplace loading, bundled skill install, MCP connection, and silent uninstall.
- Lumi action routing handles current release-regression phrases such as opening Skill Center, watchlist assistant mode, checking MCP status, and installing a referenced skill.
- Skill and MCP install resilience now cleans failed npm/GitHub installs and preserves clear setup metadata for API-key-required skills.
- Key-required bundled skills now surface setup notes and remain disabled until the needed key is configured.

Known release blockers before public distribution:

- Tauri updater `pubkey` is still `REPLACE_WITH_YOUR_PUBLIC_KEY`.
- Updater artifact signing private key must be configured for release signing.
- Windows Authenticode signing is not configured.
- Download page content still needs final publication review at `https://lumiai.asia/download`.

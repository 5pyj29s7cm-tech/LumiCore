# LumiCore Commercial Release

This repository contains the public source track for LumiCore 3.x. Source availability and signed binary distribution are separate release decisions.

## Positioning

- The public repository is the canonical source and community collaboration track.
- A commit or pull request is not a signed public installer by itself.
- Official binaries are published only after the platform-specific release gates below pass.

## Current Channel

- App version: `3.1.0`
- Release channel: `internal` until every strict public gate passes
- Official site: `https://lumiai.asia`
- Support contact: `3565286431@qq.com`
- Sales contact: `Cap_William`

These defaults are controlled by:

```env
LUMI_APP_VERSION=3.1.0
LUMI_RELEASE_CHANNEL=internal
LUMI_OFFICIAL_URL=https://lumiai.asia
LUMI_DOWNLOAD_URL=https://lumiai.asia/download
LUMI_SUPPORT_EMAIL=3565286431@qq.com
```

## Provider Access Model

The desktop client currently has no Free / Light / Pro / Org runtime plan gate.

- A configured and reachable provider may be selected and called directly.
- LM Studio and Ollama are local providers and are never rejected by a subscription check.
- Cloud providers depend on the user's own configuration, credentials, endpoint availability, and provider-side limits.
- Token records are local usage telemetry, not a Lumi quota.

Any future billing or managed-service entitlement system must be introduced as a separate, explicit product decision. It must not silently create a default plan or intercept local model execution.

## Public Binary Checklist

Before a build is offered as a public download on the official website:

- Publish a stable download page and update `LUMI_DOWNLOAD_URL`.
- Add release notes for each distributed build.
- Document any future hosted-service costs independently from local provider access.
- Confirm source/license compliance. This repository uses `AGPL-3.0`; closed-source commercial distribution needs a separate licensing agreement.
- Validate updater endpoint and signing keys.
- Run `npm run release:check -- --strict-publish` and resolve every failure.

## First-Run Release Gate

Run this gate before handing a desktop build to testers or users:

1. Start from a clean `main` checkout.
2. Run `npm run release:verify`.
3. Run `npm run tauri:build`.
4. On Windows, run `npm run smoke:installer:win`.
5. Run `npm run release:manifest`.
6. Run `npm run release:bundle`.
7. Run `npm run release:check`.
8. Confirm the installer exists under `src-tauri/target/release/bundle/nsis/`.
9. Confirm `src-tauri/target/release/bundle/release-manifest.json` lists every installer with SHA-256.
10. Hand testers the generated `release-out/` bundle directory, not loose files from multiple folders.

`npm run release:check` validates version sync, manifest freshness, artifact hashes, release bundle contents, release notes, updater endpoint shape, and download URL shape. For a public or paid distribution build, build with `LUMI_RELEASE_CHANNEL=public` and run `npm run release:check -- --strict-publish`. Strict mode blocks placeholder updater keys, missing updater signing or Windows Authenticode configuration, missing current-commit 50-run/24-hour evidence, missing `LUMI_COMMERCIAL_LICENSE_APPROVED=1`, and missing `LUMI_DEPENDENCY_RISK_APPROVED=1` for the signed low/moderate dependency risk register. Only the responsible owners may provide those approvals.

Every 3.1.0 installer, checksum, manifest, and `release-out` directory must be generated from the same commit. Historical manifests are not templates or fallback artifacts.

The automated packaged smoke test must prove:

- The bundled backend starts from `desktop-resources/dist-server`.
- `node.exe`, `entry.cjs`, `server.mjs`, `tsx`, MCP SDK, and `zod` are packaged.
- `server/mcp/config.example.json` is packaged.
- `server/mcp/config.json` is not packaged.
- A temporary new-user profile can open the marketplace.
- A bundled marketplace skill can be installed into `~/lumi_skills`.
- The installed bundled skill connects as an MCP server.

The Windows installer smoke test must prove:

- The NSIS installer can silently install to an isolated temporary directory.
- The installed `lumi-core.exe` starts the bundled backend.
- A temporary new-user profile can install a bundled skill.
- The installed bundled skill connects as an MCP server.
- The silent uninstaller can remove the temporary install.

## LumiCore Rename Upgrade Gate

- Keep the bundle identifier `com.lumiai.os` stable so an upgrade retains the existing WebView profile and macOS privacy grants.
- On Windows, the LumiCore NSIS pre-install hook never executes an uninstall command read from the registry. If a legacy `Lumi OS` registration exists, installation stops and asks the user to uninstall the old application through Windows Settings before retrying.
- User data is never deleted by the installer. The backend moves the legacy `~/LumiOS/` root to `~/LumiCore/` under an exclusive data lease on first start.
- On macOS, launch and verify `LumiCore.app` before manually removing the legacy `Lumi OS.app`; a DMG cannot safely delete another app bundle during drag-install.

Manual clean Windows user gate:

1. If Windows still lists the legacy application, uninstall that application through Windows Settings; user data remains outside the application directory.
2. Install the NSIS setup file.
3. Launch LumiCore from the installed app shortcut.
4. Confirm the main window appears without a console window.
5. Confirm the local backend starts and the UI leaves loading state.
6. Open Skill Center.
7. Confirm official bundled skills are listed.
8. Install Admin Assistant.
9. Confirm the skill appears installed and usable.
10. Open MCP or skills status.
11. Confirm installed bundled skills connect or show clear setup requirements.
12. Try a no-key skill action.
13. Try a key-required skill and confirm the setup message is clear.
14. Quit and relaunch LumiCore.
15. Confirm installed skills and user data persist.

Conversation gate prompts:

- `Open Skill Center`
- `Install Admin Assistant`
- `Check MCP status`
- `Open watchlist assistant mode`
- `What changed after that action?`

Expected behavior:

- Lumi reads client state before client actions.
- Lumi verifies action results instead of assuming success.
- Lumi reports pending or failed actions plainly.
- Lumi does not rely on disconnected MCP tools.

# Lumi OS Commercial Release

This repository is the private release track for Lumi OS 3.x.

## Positioning

- The previous public repository remains the fan preview track.
- `lumi-oeo` is the private development track for newer builds before the official website launch.
- After the official website and distribution flow are ready, selected builds can reopen for free public download.

## Current Channel

- App version: `3.0.0`
- Release channel: `private-paid`
- Official site: `https://lumiai.asia`
- Support contact: `3565286431@qq.com`
- Sales contact: `Cap_William`

These defaults are controlled by:

```env
LUMI_APP_VERSION=3.0.0
LUMI_RELEASE_CHANNEL=private-paid
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

## Reopen Checklist

Before public free downloads reopen on the official website:

- Publish a stable download page and update `LUMI_DOWNLOAD_URL`.
- Add release notes for each distributed build.
- Document any future hosted-service costs independently from local provider access.
- Confirm source/license strategy. The current repository includes `AGPL-3.0`; closed-source commercial distribution needs a separate licensing decision.
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

`npm run release:check` validates version sync, manifest freshness, artifact hashes, release bundle contents, release notes, updater endpoint shape, and download URL shape. For a public or paid distribution build, run `npm run release:check -- --strict-publish`; strict mode also blocks placeholder updater pubkeys, missing updater signing key, and missing Windows code-signing configuration.

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
- The installed `lumi-os.exe` starts the bundled backend.
- A temporary new-user profile can install a bundled skill.
- The installed bundled skill connects as an MCP server.
- The silent uninstaller can remove the temporary install.

Manual clean Windows user gate:

1. Install the NSIS setup file.
2. Launch Lumi OS from the installed app shortcut.
3. Confirm the main window appears without a console window.
4. Confirm the local backend starts and the UI leaves loading state.
5. Open Skill Center.
6. Confirm official bundled skills are listed.
7. Install Admin Assistant.
8. Confirm the skill appears installed and usable.
9. Open MCP or skills status.
10. Confirm installed bundled skills connect or show clear setup requirements.
11. Try a no-key skill action.
12. Try a key-required skill and confirm the setup message is clear.
13. Quit and relaunch Lumi OS.
14. Confirm installed skills and user data persist.

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

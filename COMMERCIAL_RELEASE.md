# Lumi OS Commercial Release

This repository is the private commercial track for Lumi OS 3.x.

## Positioning

- The previous public repository remains the free fan preview track.
- `lumi-oeo` is the private paid development track for newer builds before the official website launch.
- After the official website and distribution flow are ready, selected builds can reopen for free public download.

## Current Channel

- App version: `3.0.0`
- Release channel: `private-paid`
- Billing mode: `manual-activation`
- Official site: `https://lumiai.asia`
- Support contact: `3565286431@qq.com`
- Sales contact: `Cap_William`

These defaults are controlled by:

```env
LUMI_APP_VERSION=3.0.0
LUMI_RELEASE_CHANNEL=private-paid
LUMI_BILLING_MODE=manual-activation
LUMI_OFFICIAL_URL=https://lumiai.asia
LUMI_DOWNLOAD_URL=https://lumiai.asia/download
LUMI_SUPPORT_EMAIL=3565286431@qq.com
LUMI_SALES_CONTACT=Cap_William
LUMI_PUBLIC_DOWNLOAD_PLANNED=1
```

## User Access Model

Installed users must always be able to open Lumi and use the Free tier.

Free tier:

- Core chat and local memory
- Basic voice input/output
- One personal agent
- Community preview features from the public branch

Paid tiers:

- Higher monthly token quota
- Voice cloning and avatar studio priority features
- Advanced model/provider access
- Multiple agents, team workspace, and priority support

## Activation Flow

Before online checkout is ready, paid activation is manual:

1. User installs Lumi and signs in.
2. User opens Subscription & Activation.
3. User submits an activation request with target plan and contact info.
4. Admin reviews requests through the subscription admin endpoint.
5. Admin activates Light, Pro, or Org with `/api/subscription/activate`.

Related endpoints:

- `GET /api/subscription/release-info`
- `GET /api/subscription/status`
- `GET /api/subscription/plans`
- `POST /api/subscription/activation-requests`
- `GET /api/subscription/activation-requests`
- `GET /api/subscription/admin/activation-requests`
- `POST /api/subscription/activate`

## Reopen Checklist

Before public free downloads reopen on the official website:

- Publish a stable download page and update `LUMI_DOWNLOAD_URL`.
- Add online checkout or license-code redemption.
- Add release notes for each paid build.
- Confirm which paid features remain gated in Free.
- Confirm source/license strategy. The current repository includes `AGPL-3.0`; closed-source commercial distribution needs a separate licensing decision.
- Validate updater endpoint and signing keys.

## First-Run Release Gate

Run this gate before handing a desktop build to testers or users:

1. Start from a clean `main` checkout.
2. Run `npm run release:verify`.
3. Run `npm run tauri:build`.
4. Run `npm run release:manifest`.
5. Confirm the installer exists under `src-tauri/target/release/bundle/nsis/`.
6. Confirm `src-tauri/target/release/bundle/release-manifest.json` lists every installer with SHA-256.

The automated packaged smoke test must prove:

- The bundled backend starts from `desktop-resources/dist-server`.
- `node.exe`, `entry.cjs`, `server.mjs`, `tsx`, MCP SDK, and `zod` are packaged.
- `server/mcp/config.example.json` is packaged.
- `server/mcp/config.json` is not packaged.
- A temporary new-user profile can open the marketplace.
- A bundled marketplace skill can be installed into `~/lumi_skills`.
- The installed bundled skill connects as an MCP server.

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

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

# Lumi OS Release Notes

## v3.0.0 private-paid

Release artifacts:

- Bundle directory format: `release-out/lumi-os-v3.0.0-<short-commit>`
- Installer: `Lumi OS_3.0.0_x64-setup.exe`
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

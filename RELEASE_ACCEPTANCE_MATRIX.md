# LumiOS 3.0.3 release acceptance matrix

Record the commit, machine image, operator, start/end time, and evidence path for every run. A row passes only when the observable result and the CapabilityManifest/TaskLedger receipt agree; do not add a second success rule in the test harness.

## Intent routing consistency

Run each intent through chat, voice, and Task Center. The selected capability family, risk/confirmation decision, terminal receipt, and final user-facing status must match.

| Intent | Required route/evidence |
| --- | --- |
| Read and summarize a selected document | Existing document capability; no unrequested write; receipt names the source. |
| Create and revise an office artifact | Existing document tools; artifact path exists and TaskLedger reaches a terminal state. |
| Prepare a CAD renovation workflow | CAD capability; no completion claim without CAD state-diff evidence. |
| Open/control an authorized desktop app | Desktop capability; confirmation policy and visible state evidence agree. |
| Install and call a bundled MCP skill | Marketplace lifecycle, MCP health, and tool receipt agree after restart. |
| Recall and update personal memory | Correct user/domain scope; persistence is visible after restart. |
| Execute an organization task | Correct organization role/domain; personal data does not leak into work scope. |
| Send through a configured message adapter | Existing adapter, recipient/scope confirmation, and delivery receipt agree. |

## Voice stress matrix

For continuous calling, rapid hang-up/reconnect, TTS interruption, voiceprint switching, and device sleep/resume, capture browser console plus backend logs. Acceptance is zero unhandled promises, zero concurrent duplicate `AudioContext` or microphone streams, and zero residual Socket.IO sessions after stop. Run the automated voice regressions before and after the manual device cycle.

## Data and upgrade matrix

Test a copy of the last supported database, abnormal termination during a write, normal restart persistence, and a new clean profile. Run `npm run check:sqlite -- <database>` after every case. `integrity_check` must be `ok`, `foreign_key_check` must be empty, and all user data/log/generated files must remain below the configured `LUMI_DATA_DIR`, never the source or packaged resource directory.

## Windows clean-user matrix

The mandatory workflow is silent isolated install, first launch out of loading state, runtime identity check, 48+ built-in skills, bundled skill install, MCP connection, restart persistence, SQLite checks, silent uninstall, and shortcut/install residue verification. `npm run smoke:installer:win` automates these checks; retain its JSON result and logs.

## Reliability evidence

- RC1: `npm run stress:lifecycle` on the fixed Windows reference image. Evidence must cover at least 50 starts, zero forced/orphan processes, and cold-start P95 no greater than 75% of the recorded baseline.
- Public candidate: run the `Windows 24-hour Reliability` workflow on the labeled reference runner. Evidence must show 24 hours, zero backend restarts, zero MCP consecutive crashes, a clean database, zero unhandled exceptions, and the candidate build ID.
- `npm run release:check -- --strict-publish` consumes both JSON reports and rejects stale-commit evidence.

## Owner-provided public prerequisites

Engineering validates but does not invent the updater private key, updater public key, HTTPS update/download endpoint, Windows Authenticode certificate, or AGPL/closed-commercial distribution decision. Missing prerequisites still allow an `internal` candidate, but block public distribution.

The public Windows workflow requires these GitHub Actions secrets:

- `TAURI_UPDATER_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY` and, when encrypted, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `WINDOWS_CODESIGN_CERTIFICATE_BASE64` and `WINDOWS_CODESIGN_CERTIFICATE_PASSWORD`
- `LUMI_COMMERCIAL_LICENSE_APPROVED=1`
- `LUMI_DEPENDENCY_RISK_APPROVED=1`

The fixed reference runner requires these repository variables:

- `LUMI_COLD_START_BASELINE_MS`
- `LUMI_GPTSOVITS_ROOT`, pointing to a provisioned GPT-SoVITS runtime outside the checkout
- `LUMI_TTS_RELIABILITY_FIXTURE_DIR`, pointing to controlled PCM16 WAV fixtures outside the checkout

Run `Windows 24-hour Reliability` first and retain its run ID. Then dispatch `Build Windows Installer` with `channel=public` and that `soak_run_id`. The workflow creates an untracked Tauri override in the runner temp directory, so signing configuration never dirties or rewrites the committed application config.

# Runtime dependency risk register

The release gate is `npm run security:audit`: production dependencies must have zero critical and zero high severity findings. Lower-severity findings are not silently ignored; each release owner must review this register and the current audit output.

## Current accepted findings

| Dependency | Severity | Reachability and isolation | Required owner action |
| --- | --- | --- | --- |
| `@hono/node-server` through `@modelcontextprotocol/sdk` | Moderate | LumiCore does not call Hono's `serveStatic` adapter; MCP HTTP transports are authenticated and are not used to serve arbitrary local paths. Keep MCP endpoints bound to the configured application listener and do not expose a filesystem root. | Release owner must confirm this remains unreachable, or update MCP SDK/Hono when a compatible fix is available. |
| `@modelcontextprotocol/sdk` (effect of Hono finding) | Moderate | Same transitive reachability as above; MCP lifecycle smoke tests remain mandatory. | Release owner sign-off required for public release. |

Run the audit again immediately before producing a release manifest. Any new low or moderate finding requires a row here with reachability, isolation, and an owner decision.

After the responsible release owner signs the current register, set `LUMI_DEPENDENCY_RISK_APPROVED=1` only for the strict public-release job. The strict gate fails while tracked findings lack that explicit approval.

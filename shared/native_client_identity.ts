/**
 * Process identity claim emitted by the native Tauri shell or the explicitly
 * labelled local acceptance harness.
 *
 * `startedAtUnixMs` deliberately uses an integer epoch value on the wire so
 * Rust, Node and OS probes can compare the same timestamp without locale or
 * timezone ambiguity. The server adds a canonical ISO `startedAt` value when
 * it stores the identity in the device registry.
 */
export interface NativeClientIdentityClaim {
  schemaVersion: 1;
  /** Tauri is the product client; acceptance harnesses must identify themselves separately. */
  clientKind: 'tauri' | 'local_acceptance_harness';
  pid: number;
  startedAtUnixMs: number;
  executablePath: string;
  executableSha256: string | null;
  binaryHashUnavailable: boolean;
  /** Baseline source commit only; never interpreted as an executable identity. */
  buildId: string;
  buildIdSemantics: 'baseline_commit';
  sourceFingerprint: string;
  sourceDirty: boolean;
  appVersion: string;
}

export interface NativeClientIdentity extends NativeClientIdentityClaim {
  startedAt: string;
  /** Bound to the native bootstrap capability, but not independently OS-attested. */
  trustLevel: 'proof_bound_local_claim';
  osAttested: false;
  /** Actual WebView2/WKWebView profile binding still requires an external probe. */
  webviewProfileTrustLevel: 'unbound';
}

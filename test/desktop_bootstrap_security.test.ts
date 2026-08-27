import fs from 'fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDB, writeDB } from '../db_layer';
import { mountAuthRoutes } from '../server/routes/auth';
import {
  getDesktopBootstrapProofPath,
  getDesktopSessionNativeClientIdentity,
  initializeDesktopBootstrapProof,
  issueDesktopSessionProof,
  resetDesktopBootstrapStateForTests,
  resolveDesktopSession,
  verifyDesktopSessionProof,
} from '../server/config/desktop_bootstrap';
import { COOKIE_OPTS, JWT_SECRET, makeApp } from './helpers';
import { bootstrapDesktopTestSession } from '../scripts/lib/desktop-bootstrap.mjs';

describe.sequential('native desktop bootstrap security', () => {
  let url = '';
  let cleanup: (() => void) | undefined;
  let originalAutoLoginPassword: string | undefined;
  const knownPassword = 'existing-admin-password-42';
  const adminUid = 'existing-local-admin';
  const nativeClientIdentity = {
    schemaVersion: 1 as const,
    clientKind: 'tauri' as const,
    pid: process.pid,
    startedAtUnixMs: Math.floor((Date.now() - 10_000) / 1_000) * 1_000,
    executablePath: process.execPath,
    executableSha256: 'd'.repeat(64),
    binaryHashUnavailable: false,
    buildId: 'a'.repeat(40),
    buildIdSemantics: 'baseline_commit' as const,
    sourceFingerprint: 'e'.repeat(64),
    sourceDirty: false,
    appVersion: '3.1.0',
  };

  beforeAll(async () => {
    originalAutoLoginPassword = process.env.AUTO_LOGIN_PASSWORD;
    process.env.AUTO_LOGIN_PASSWORD = 'legacy-fixed-password-must-not-authenticate';
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);

    const db = readDB();
    db.users = db.users.filter((user: any) => user.username !== 'admin');
    db.users.push({
      uid: adminUid,
      username: 'admin',
      password: await bcrypt.hash(knownPassword, 10),
      phone: '+00000000000',
      role: 'admin',
      balance: 999,
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    initializeDesktopBootstrapProof();
  });

  afterAll(() => {
    resetDesktopBootstrapStateForTests({ removeFile: true });
    if (originalAutoLoginPassword === undefined) delete process.env.AUTO_LOGIN_PASSWORD;
    else process.env.AUTO_LOGIN_PASSWORD = originalAutoLoginPassword;
    cleanup?.();
  });

  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(`${url}/api${path}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
    return { status: response.status, body };
  }

  function currentProof(): string {
    return JSON.parse(fs.readFileSync(getDesktopBootstrapProofPath(), 'utf8')).proof;
  }

  it('writes a bounded regular handoff file with owner-only POSIX mode', () => {
    const proofPath = getDesktopBootstrapProofPath();
    const metadata = fs.lstatSync(proofPath);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.size).toBeGreaterThan(32);
    expect(metadata.size).toBeLessThan(4096);
    if (process.platform !== 'win32') {
      expect(metadata.mode & 0o077).toBe(0);
    }
  });

  it('rejects missing and incorrect proofs even when proxy headers claim loopback', async () => {
    const proofBeforeLegacyGet = currentProof();
    const legacyGet = await request('/auth/bootstrap', {
      headers: { 'X-Lumi-Desktop-Bootstrap': proofBeforeLegacyGet },
    });
    expect(legacyGet.status).toBe(404);
    expect(currentProof()).toBe(proofBeforeLegacyGet);

    const missing = await request('/auth/bootstrap', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' },
    });
    expect(missing.status).toBe(403);
    expect(missing.body.token).toBeUndefined();

    const incorrect = await request('/auth/bootstrap', {
      method: 'POST',
      headers: {
        'X-Forwarded-For': '127.0.0.1',
        'X-Lumi-Desktop-Bootstrap': 'x'.repeat(64),
      },
    });
    expect(incorrect.status).toBe(403);
    expect(incorrect.body.token).toBeUndefined();
  });

  it('consumes the one-time bootstrap proof but refuses an invalid native process identity', async () => {
    const proof = currentProof();
    const invalid = await request('/auth/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lumi-Desktop-Bootstrap': proof,
      },
      body: JSON.stringify({
        nativeClientIdentity: {
          ...nativeClientIdentity,
          executablePath: 'relative-client.exe',
        },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('NATIVE_CLIENT_IDENTITY_REQUIRED');
    expect(currentProof()).not.toBe(proof);

    const replay = await request('/auth/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lumi-Desktop-Bootstrap': proof,
      },
      body: JSON.stringify({ nativeClientIdentity }),
    });
    expect(replay.status).toBe(403);
  });

  it('never issues or verifies a trusted-local session without a bound identity', () => {
    expect(() => issueDesktopSessionProof('identity-required', undefined))
      .toThrow(/valid native client identity/i);
    const issued = issueDesktopSessionProof('identity-required', nativeClientIdentity);
    expect(resolveDesktopSession(issued.proof, 'identity-required')).toMatchObject({
      nativeClientIdentity: {
        ...nativeClientIdentity,
        trustLevel: 'proof_bound_local_claim',
        osAttested: false,
        webviewProfileTrustLevel: 'unbound',
      },
    });
    expect(resolveDesktopSession(issued.proof, 'wrong-user')).toBeNull();
  });

  it('keeps the Node acceptance helper compatible without impersonating Tauri', async () => {
    const dataRoot = path.dirname(path.dirname(getDesktopBootstrapProofPath()));
    const session = await bootstrapDesktopTestSession(`${url}/api`, dataRoot, {
      timeoutMs: 5_000,
      sourceRoot: process.cwd(),
    });
    expect(session.nativeClientIdentity).toMatchObject({
      clientKind: 'local_acceptance_harness',
      pid: process.pid,
      buildIdSemantics: 'baseline_commit',
      trustLevel: 'proof_bound_local_claim',
      osAttested: false,
      webviewProfileTrustLevel: 'unbound',
    });
    expect(resolveDesktopSession(session.desktopSessionProof, session.user.uid))
      .toMatchObject({ nativeClientIdentity: session.nativeClientIdentity });
  });

  it('consumes one proof once, rejects replay, and binds a runtime session proof to the user', async () => {
    const passwordBefore = readDB().users.find((user: any) => user.uid === adminUid)?.password;
    const loginBefore = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: knownPassword }),
    });
    expect(loginBefore.status).toBe(200);

    const proof = currentProof();
    const accepted = await request('/auth/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lumi-Desktop-Bootstrap': proof,
        Authorization: `Bearer ${loginBefore.body.token}`,
      },
      body: JSON.stringify({ nativeClientIdentity }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user.uid).toBe(adminUid);
    expect(accepted.body.token).toBeTruthy();
    expect(accepted.body.desktopSessionProof).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(verifyDesktopSessionProof(accepted.body.desktopSessionProof, adminUid)).toBe(true);
    expect(verifyDesktopSessionProof(accepted.body.desktopSessionProof, 'another-user')).toBe(false);
    expect(getDesktopSessionNativeClientIdentity(accepted.body.desktopSessionProof, adminUid))
      .toMatchObject(nativeClientIdentity);
    expect(accepted.body.nativeClientIdentity).toMatchObject(nativeClientIdentity);
    expect(accepted.body.nativeClientIdentity).toMatchObject({
      trustLevel: 'proof_bound_local_claim',
      osAttested: false,
      buildIdSemantics: 'baseline_commit',
      webviewProfileTrustLevel: 'unbound',
    });

    const replay = await request('/auth/bootstrap', {
      method: 'POST',
      headers: { 'X-Lumi-Desktop-Bootstrap': proof },
    });
    expect(replay.status).toBe(403);
    expect(replay.body.token).toBeUndefined();
    expect(currentProof()).not.toBe(proof);

    const adminAfter = readDB().users.find((user: any) => user.uid === adminUid);
    expect(adminAfter?.password).toBe(passwordBefore);
    const oldLoginStillValid = await request('/auth/me', {
      headers: { Authorization: `Bearer ${loginBefore.body.token}` },
    });
    expect(oldLoginStillValid.status).toBe(200);
    const passwordLoginStillValid = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: knownPassword }),
    });
    expect(passwordLoginStillValid.status).toBe(200);
  });

  it('does not use AUTO_LOGIN_PASSWORD as the credential for a first-created admin', async () => {
    const db = readDB();
    db.users = db.users.filter((user: any) => user.username !== 'admin');
    writeDB(db);
    initializeDesktopBootstrapProof();

    const created = await request('/auth/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lumi-Desktop-Bootstrap': currentProof(),
      },
      body: JSON.stringify({ nativeClientIdentity }),
    });
    expect(created.status).toBe(200);
    expect(created.body.user.role).toBe('admin');

    const fixedPasswordLogin = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: process.env.AUTO_LOGIN_PASSWORD,
      }),
    });
    expect(fixedPasswordLogin.status).toBe(401);

    expect(verifyDesktopSessionProof(created.body.desktopSessionProof, created.body.user.uid)).toBe(true);
    initializeDesktopBootstrapProof();
    expect(verifyDesktopSessionProof(created.body.desktopSessionProof, created.body.user.uid)).toBe(false);
  });
});

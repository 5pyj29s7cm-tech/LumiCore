import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';

let cleanup = () => {};
let testUrl = '';
let generatedDir = '';
let dataDir = '';
let artifactPath = '';
let keysPath = '';
let envPath = '';

const userCookie = `token=${jwt.sign({
  uid: 'generated-output-user',
  username: 'generated-output-user',
  role: 'user',
}, JWT_SECRET)}`;

const adminCookie = `token=${jwt.sign({
  uid: 'generated-output-admin',
  username: 'generated-output-admin',
  role: 'admin',
}, JWT_SECRET)}`;

describe('Generated-output route security boundary', () => {
  beforeAll(async () => {
    const appContext = await makeApp();
    const { app, apiRouter } = appContext;
    const { default: fileRoutes } = await import('../routes/files');
    const { getDataPath, getGeneratedOutputDir } = await import('../server/config/data_path');
    const {
      requireAdmin,
      requireAuth,
      requireLocalRequest,
    } = await import('../server/middleware/auth');

    generatedDir = getGeneratedOutputDir();
    dataDir = path.dirname(getDataPath('.route-security-marker'));
    artifactPath = path.join(generatedDir, 'route-security-artifact.txt');
    keysPath = getDataPath('keys.json');
    envPath = path.join(path.dirname(dataDir), '.env');

    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(artifactPath, 'generated-artifact-ok', 'utf8');
    fs.writeFileSync(keysPath, '{"secret":"must-not-leak"}', 'utf8');
    fs.writeFileSync(envPath, 'PRIVATE_TOKEN=must-not-leak', 'utf8');

    // Mount the production static-output middleware chain. The first middleware
    // lets one test emulate a non-loopback peer without trusting proxy headers.
    app.use('/lumi_output', (req, _res, next) => {
      if (req.header('x-test-non-loopback') === '1') {
        Object.defineProperty(req.socket, 'remoteAddress', {
          configurable: true,
          value: '192.0.2.25',
        });
        _res.once('finish', () => {
          delete (req.socket as any).remoteAddress;
        });
      }
      next();
    }, requireAuth, requireAdmin, requireLocalRequest, express.static(generatedDir));
    apiRouter.use('/', fileRoutes);

    testUrl = appContext.url;
    cleanup = appContext.cleanup;
  });

  afterAll(() => {
    cleanup();
  });

  it('rejects anonymous and ordinary users at /lumi_output', async () => {
    const anonymous = await fetch(`${testUrl}/lumi_output/${path.basename(artifactPath)}`);
    expect(anonymous.status).toBe(401);

    const ordinaryUser = await fetch(`${testUrl}/lumi_output/${path.basename(artifactPath)}`, {
      headers: {
        Cookie: userCookie,
        'X-Forwarded-For': '127.0.0.1',
      },
    });
    expect(ordinaryUser.status).toBe(403);
    expect(await ordinaryUser.text()).not.toContain('generated-artifact-ok');
  });

  it('rejects even an administrator when the actual peer is not loopback', async () => {
    const response = await fetch(`${testUrl}/lumi_output/${path.basename(artifactPath)}`, {
      headers: {
        Cookie: adminCookie,
        'X-Forwarded-For': '127.0.0.1',
        'X-Test-Non-Loopback': '1',
        Connection: 'close',
      },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('generated-artifact-ok');
  });

  it('allows the local administrator to read a legitimate generated artifact', async () => {
    const staticResponse = await fetch(`${testUrl}/lumi_output/${path.basename(artifactPath)}`, {
      headers: { Cookie: adminCookie },
    });
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toBe('generated-artifact-ok');

    const generatedResponse = await fetch(
      `${testUrl}/api/files/generated?path=${encodeURIComponent(artifactPath)}&inline=1`,
      { headers: { Cookie: adminCookie } },
    );
    expect(generatedResponse.status).toBe(200);
    expect(await generatedResponse.text()).toBe('generated-artifact-ok');
  });

  it('cannot read data/keys.json through generated or knowledge download paths', async () => {
    const generatedAttempt = await fetch(
      `${testUrl}/api/files/generated?path=${encodeURIComponent(keysPath)}&inline=1`,
      { headers: { Cookie: adminCookie } },
    );
    expect(generatedAttempt.status).toBe(403);
    expect(await generatedAttempt.text()).not.toContain('must-not-leak');

    const generatedAliasAttempt = await fetch(
      `${testUrl}/api/files/generated?path=${encodeURIComponent('/lumi_output/../keys.json')}&inline=1`,
      { headers: { Cookie: adminCookie } },
    );
    expect(generatedAliasAttempt.status).toBe(403);
    expect(await generatedAliasAttempt.text()).not.toContain('must-not-leak');

    const traversalId = encodeURIComponent(keysPath);
    const downloadAttempt = await fetch(
      `${testUrl}/api/files/download/${traversalId}?domain=personal&inline=1`,
      { headers: { Cookie: userCookie } },
    );
    expect(downloadAttempt.status).toBe(404);
    expect(await downloadAttempt.text()).not.toContain('must-not-leak');
  });

  it('rejects arbitrary local secret-file imports from an ordinary local user', async () => {
    const response = await fetch(`${testUrl}/api/files/import-paths?domain=personal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: userCookie,
      },
      body: JSON.stringify({ paths: [keysPath, envPath] }),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('must-not-leak');
  });

  it('rejects a generated-output link whose real target escapes the output root', async () => {
    const outsideDir = path.join(path.dirname(generatedDir), 'generated-route-outside');
    const outsideFile = path.join(outsideDir, 'outside-secret.txt');
    const linkedDir = path.join(generatedDir, 'linked-outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'symlink-secret-must-not-leak', 'utf8');

    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error: any) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error?.code || ''))) return;
      throw error;
    }

    try {
      const response = await fetch(
        `${testUrl}/api/files/generated?path=${encodeURIComponent(path.join(linkedDir, 'outside-secret.txt'))}`,
        { headers: { Cookie: adminCookie } },
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('symlink-secret-must-not-leak');
    } finally {
      fs.rmSync(linkedDir, { force: true });
    }
  });
});

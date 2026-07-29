import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';

let cleanup = () => {};
let testUrl = '';
let fileRoutesModule: typeof import('../routes/files');
const temporaryRoots: string[] = [];

beforeAll(async () => {
  const app = await makeApp();
  fileRoutesModule = await import('../routes/files');
  fileRoutesModule.configureKnowledgeFileRoutes({ llmGetters: {} });
  app.apiRouter.use('/', fileRoutesModule.default);
  testUrl = app.url;
  cleanup = app.cleanup;
});

afterAll(() => {
  cleanup();
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-knowledge-matrix-'));
  temporaryRoots.push(root);
  return root;
}

describe('knowledge source format acceptance matrix', () => {
  it('accepts non-empty text but marks empty text as incomplete', async () => {
    const root = tempRoot();
    const normal = path.join(root, 'normal.txt');
    const empty = path.join(root, 'empty.txt');
    fs.writeFileSync(normal, 'Traceable source content.', 'utf8');
    fs.writeFileSync(empty, '', 'utf8');

    await expect(fileRoutesModule.extractKnowledgeFileContent(normal)).resolves.toMatchObject({
      status: 'indexed',
      method: 'text',
    });
    await expect(fileRoutesModule.extractKnowledgeFileContent(empty)).resolves.toMatchObject({
      status: 'partial',
      method: 'text',
      failureKind: 'empty_extraction',
      content: null,
    });
  });

  it('does not label scanned/image-only PDFs as fully extracted', async () => {
    const root = tempRoot();
    const scanned = path.join(root, 'scanned.pdf');
    const pdf = await PDFDocument.create();
    const page = (pdf as any).addPage([300, 200]);
    page.drawRectangle({ x: 30, y: 30, width: 240, height: 140 });
    fs.writeFileSync(scanned, await pdf.save());

    const extraction = await fileRoutesModule.extractKnowledgeFileContent(scanned);
    expect(extraction).toMatchObject({
      status: 'partial',
      method: 'pdf',
      failureKind: 'empty_extraction',
      content: null,
    });
    expect(extraction.warning).toMatch(/OCR/i);
  });

  it('keeps image metadata partial when no vision provider is connected', async () => {
    const root = tempRoot();
    const imagePath = path.join(root, 'diagram.png');
    await (sharp as any)({
      create: { width: 8, height: 8, channels: 3, background: { r: 250, g: 250, b: 250 } },
    }).png().toFile(imagePath);

    const extraction = await fileRoutesModule.extractKnowledgeFileContent(imagePath, 'matrix-user');
    expect(extraction).toMatchObject({ status: 'partial', method: 'image-metadata' });
    expect(extraction.content).toContain('[Image File]');
  });

  it('marks unavailable audio extraction, corrupt Office files and unsupported formats as non-indexed', async () => {
    const root = tempRoot();
    const office = path.join(root, 'broken.docx');
    const unsupported = path.join(root, 'archive.bin');
    fs.writeFileSync(office, Buffer.from('not-an-office-zip'));
    fs.writeFileSync(unsupported, Buffer.from([1, 2, 3]));

    const [officeResult, unsupportedResult] = await Promise.all([
      fileRoutesModule.extractKnowledgeFileContent(office),
      fileRoutesModule.extractKnowledgeFileContent(unsupported),
    ]);
    expect(fileRoutesModule.classifyKnowledgeExtractionFailure(
      new Error('No audio transcription provider is configured.'),
    )).toMatchObject({ status: 'failed', failureKind: 'provider_unavailable' });
    expect(officeResult).toMatchObject({ status: 'failed', content: null });
    expect(unsupportedResult).toMatchObject({
      status: 'unsupported',
      failureKind: 'unsupported_format',
      content: null,
    });
  });

  it('classifies password/encryption and corrupt-container failures explicitly', () => {
    expect(fileRoutesModule.classifyKnowledgeExtractionFailure(new Error('Password required for encrypted PDF')))
      .toMatchObject({ status: 'failed', failureKind: 'encrypted_or_password_required' });
    expect(fileRoutesModule.classifyKnowledgeExtractionFailure(new Error('Invalid ZIP central directory')))
      .toMatchObject({ status: 'failed', failureKind: 'corrupt_source' });
  });

  it('persists a failed manifest for an unsupported uploaded file', async () => {
    const userId = `knowledge-matrix-${Date.now()}`;
    const cookie = `token=${jwt.sign({ uid: userId, username: userId }, JWT_SECRET)}`;
    const form = new FormData();
    form.append('files', new Blob([Buffer.from([9, 8, 7])]), 'unsupported.bin');

    const response = await fetch(`${testUrl}/api/files/upload?domain=personal`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.files[0]).toMatchObject({
      extractionStatus: 'unsupported',
      extractionFailureKind: 'unsupported_format',
      ingestionStatus: 'unsupported',
    });

    const { readDB } = await import('../db_layer');
    const meta = readDB().knowledgeFiles.find((item: any) => (
      item.userId === userId && item.filename === 'unsupported.bin'
    ));
    expect(meta?.ingestionManifest).toMatchObject({
      status: 'unsupported',
      extraction: { failureKind: 'unsupported_format' },
      chunks: [],
      coverage: { verified: false },
    });
  });

  it('persists real golden QA evidence through the personal knowledge verification API', async () => {
    const userId = `knowledge-golden-${Date.now()}`;
    const filename = 'golden-source.txt';
    const content = 'The verified July release meeting takes place in the north conference room.';
    const directoryId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
    const { getDataPath } = await import('../server/config/data_path');
    const directory = getDataPath(path.join('knowledge', '_users', directoryId));
    const filePath = path.join(directory, filename);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    const { ingestDocument } = await import('../server/agents/rag');
    const result = await ingestDocument(userId, 'lumi', filename, content, {
      filePath,
      domain: 'personal',
      verifyEmbeddings: false,
      verifyRetrieval: false,
      extraction: { status: 'indexed', method: 'text' },
    });
    const { readDB, writeDB } = await import('../db_layer');
    const db = readDB();
    db.knowledgeFiles = (db.knowledgeFiles || []).filter((item: any) => !(
      item.userId === userId && item.filename === filename
    ));
    db.knowledgeFiles.push({
      filename,
      displayName: filename,
      userId,
      domain: 'personal',
      orgId: '',
      status: 'indexed',
      extractionStatus: 'indexed',
      agentIds: ['lumi'],
      ingestionManifest: result.manifest,
      ingestionManifestId: result.manifest.manifestId,
      ingestionStatus: result.manifest.status,
      ingestionCoverage: result.manifest.coverage,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    writeDB(db);

    try {
      const cookie = `token=${jwt.sign({ uid: userId, username: userId }, JWT_SECRET)}`;
      const response = await fetch(`${testUrl}/api/files/ingestion/${filename}/verify?domain=personal`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'lumi',
          cases: [{
            caseId: 'release-meeting-location',
            question: 'Where does the verified July release meeting take place?',
            referenceAnswer: 'The meeting takes place in the north conference room.',
            expectedChunkIndexes: [0],
            expectedCitationChunkIndexes: [0],
          }],
        }),
      });
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body).toMatchObject({
        success: true,
        ingestionStatus: 'indexed_unverified',
        retrieval: {
          method: 'golden_qa_v1',
          recallAtK: 1,
          citationAccuracy: 1,
          passed: true,
        },
        coverage: {
          embeddingCoverage: 0,
          verified: false,
        },
      });
      const stored = readDB().knowledgeFiles.find((item: any) => (
        item.userId === userId && item.filename === filename
      ));
      expect(stored?.ingestionManifest?.retrieval).toMatchObject({ method: 'golden_qa_v1', passed: true });
    } finally {
      const cleanupDb = readDB();
      cleanupDb.knowledgeFiles = (cleanupDb.knowledgeFiles || []).filter((item: any) => !(
        item.userId === userId && item.filename === filename
      ));
      cleanupDb.memories = (cleanupDb.memories || []).filter((item: any) => !result.memoryIds.includes(item.id));
      writeDB(cleanupDb);
      fs.rmSync(filePath, { force: true });
    }
  });

  it('gradually migrates a missing legacy index to an explicit failed manifest without deleting history', async () => {
    const { readDB, writeDB } = await import('../db_layer');
    const db = readDB();
    db.knowledgeFiles = (db.knowledgeFiles || []).filter((item: any) => item.ingestionManifest?.schemaVersion === 1);
    db.knowledgeFiles.push({
      filename: 'missing-legacy-source.txt',
      displayName: 'missing-legacy-source.txt',
      userId: 'legacy-revalidation-user',
      domain: 'personal',
      orgId: '',
      status: 'indexed',
      extractionStatus: 'indexed',
      agentIds: ['lumi'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    writeDB(db);

    await expect(fileRoutesModule.revalidateOneLegacyKnowledgeFile()).resolves.toBe('failed');
    const migrated = readDB().knowledgeFiles.find((item: any) => (
      item.userId === 'legacy-revalidation-user' && item.filename === 'missing-legacy-source.txt'
    ));
    expect(migrated).toMatchObject({
      status: 'failed',
      legacyRevalidationAttempts: 1,
      ingestionManifest: {
        status: 'failed',
        extraction: { status: 'failed' },
        coverage: { verified: false },
      },
    });
  });
});

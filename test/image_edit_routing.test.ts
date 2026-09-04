import './helpers';
import fs from 'fs';
import dns from 'node:dns/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { saveKeys } from '../server/config/keys';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { ToolRegistry } from '../server/tools/registry';

const EDIT_MODEL = 'huawei_maas/qwen-image-edit-2509';
const OFFICIAL_BASE_URL = 'https://official-image-edit.test/v1';
const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const INPUT_BYTES = Buffer.from(VALID_PNG_BASE64, 'base64');
const OUTPUT_BYTES = Buffer.from(VALID_PNG_BASE64, 'base64');
const INVALID_IMAGE_BYTES = Buffer.from('text that is not an image', 'utf8');

function jsonResponse(body: unknown, ok = true, status = 200): any {
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function configureOfficialImageEdit(userId: string): void {
  saveKeys({
    RELAY_API_KEY: 'image-edit-test-key',
    RELAY_BASE_URL: OFFICIAL_BASE_URL,
    RELAY_IMAGE_MODEL: '',
    RELAY_IMAGE_EDIT_MODEL: '',
    RELAY_IMAGE_PATH: '',
    RELAY_IMAGE_EDIT_PATH: '',
  });
  upsertUserPreferredGenerationModels(userId, {
    imageEdit: {
      provider: 'relay',
      model: EDIT_MODEL,
      models: { relay: EDIT_MODEL },
    },
  });
}

function createImageRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerImageTools(registry);
  return registry;
}

describe('Lumi official AI image editing', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    saveKeys({
      RELAY_API_KEY: '',
      RELAY_BASE_URL: '',
      RELAY_IMAGE_MODEL: '',
      RELAY_IMAGE_EDIT_MODEL: '',
      RELAY_IMAGE_PATH: '',
      RELAY_IMAGE_EDIT_PATH: '',
    });
  });

  it('sends local image bytes as a data URL to qwen-image-edit-2509 and persists the b64 result', async () => {
    const userId = 'official-image-edit-success-user';
    configureOfficialImageEdit(userId);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-image-edit-'));
    const inputPath = path.join(tempDir, 'source.png');
    fs.writeFileSync(inputPath, INPUT_BYTES);

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OFFICIAL_BASE_URL}/models`) {
        return jsonResponse({
          object: 'list',
          data: [{
            id: EDIT_MODEL,
            capability: 'image_edit',
            endpoint: '/v1/images/generations',
          }],
        });
      }
      if (url === `${OFFICIAL_BASE_URL}/images/generations`) {
        return jsonResponse({
          model: EDIT_MODEL,
          data: [{
            url: null,
            b64_json: `data:image/png;base64,${OUTPUT_BYTES.toString('base64')}`,
          }],
        });
      }
      throw new Error(`Unexpected official API request: ${url} ${init?.method || 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    let outputPath = '';
    const progress: string[] = [];
    try {
      const result = JSON.parse(await createImageRegistry().execute(
        'ai_edit_image',
        { filePath: inputPath, prompt: 'Replace the background with a quiet blue studio', seed: 44 },
        { userId, onProgress: step => progress.push(step) },
      ));
      outputPath = result.outputPath;

      expect(result).toMatchObject({
        ok: true,
        status: 'edited',
        verified: true,
        verificationStatus: 'verified',
        provider: 'relay',
        model: EDIT_MODEL,
        inputPaths: [inputPath],
        verification: 'live_provider_result_saved_locally',
      });
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.readFileSync(outputPath)).toEqual(OUTPUT_BYTES);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const generationCall = fetchMock.mock.calls[1];
      expect(String(generationCall[0])).toBe(`${OFFICIAL_BASE_URL}/images/generations`);
      expect(generationCall[1]?.method).toBe('POST');
      expect((generationCall[1]?.headers as Record<string, string>).Authorization).toBe('Bearer image-edit-test-key');
      const requestBody = JSON.parse(String(generationCall[1]?.body));
      expect(requestBody).toMatchObject({
        model: EDIT_MODEL,
        prompt: 'Replace the background with a quiet blue studio',
        seed: 44,
      });
      expect(requestBody.image).toBe(`data:image/png;base64,${INPUT_BYTES.toString('base64')}`);
      expect(progress).toEqual([
        '图片编辑请求已提交。',
        '图片正在编辑中。',
        '图片已编辑，正在保存结果。',
        '图片编辑完成。',
      ]);
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts a public HTTPS image input after decoding its bytes and does not forward gateway credentials', async () => {
    const userId = 'official-image-edit-remote-input-user';
    const remoteInput = 'https://media.example.test/source.png?signature=private';
    const redactedRemoteInput = 'https://media.example.test/source.png';
    configureOfficialImageEdit(userId);
    vi.spyOn(dns, 'lookup').mockImplementation(async () => ([{ address: '8.8.8.8', family: 4 }] as any));

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OFFICIAL_BASE_URL}/models`) {
        return jsonResponse({
          object: 'list',
          data: [{ id: EDIT_MODEL, capability: 'image_edit' }],
        });
      }
      if (url === remoteInput) {
        return new Response(INPUT_BYTES, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      if (url === `${OFFICIAL_BASE_URL}/images/generations`) {
        return jsonResponse({
          model: EDIT_MODEL,
          data: [{ b64_json: OUTPUT_BYTES.toString('base64') }],
        });
      }
      throw new Error(`Unexpected official API request: ${url} ${init?.method || 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    let outputPath = '';
    try {
      const result = JSON.parse(await createImageRegistry().execute(
        'ai_edit_image',
        { filePath: remoteInput, prompt: 'Make the scene warmer' },
        { userId, userConfirmed: true },
      ));
      outputPath = result.outputPath;

      expect(result).toMatchObject({
        status: 'edited',
        verified: true,
        verificationStatus: 'verified',
        inputPaths: [redactedRemoteInput],
      });
      const remoteCall = fetchMock.mock.calls.find(call => String(call[0]) === remoteInput);
      expect(remoteCall).toBeDefined();
      expect((remoteCall?.[1]?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      const generationCall = fetchMock.mock.calls.find(call => String(call[0]) === `${OFFICIAL_BASE_URL}/images/generations`);
      const requestBody = JSON.parse(String(generationCall?.[1]?.body));
      expect(requestBody.image).toBe(`data:image/png;base64,${INPUT_BYTES.toString('base64')}`);
      expect(fs.readFileSync(outputPath)).toEqual(OUTPUT_BYTES);
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
    }
  });

  it('serializes one primary and one reference image with the official comma-delimited data URL contract', async () => {
    const userId = 'official-image-edit-two-input-user';
    configureOfficialImageEdit(userId);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-image-edit-'));
    const inputPath = path.join(tempDir, 'primary.png');
    const referencePath = path.join(tempDir, 'reference.png');
    fs.writeFileSync(inputPath, INPUT_BYTES);
    fs.writeFileSync(referencePath, INPUT_BYTES);

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${OFFICIAL_BASE_URL}/models`) {
        return jsonResponse({
          object: 'list',
          data: [{ id: EDIT_MODEL, capability: 'image_edit' }],
        });
      }
      if (url === `${OFFICIAL_BASE_URL}/images/generations`) {
        return jsonResponse({
          model: EDIT_MODEL,
          data: [{ b64_json: OUTPUT_BYTES.toString('base64') }],
        });
      }
      throw new Error(`Unexpected official API request: ${url} ${init?.method || 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    let outputPath = '';
    try {
      const result = JSON.parse(await createImageRegistry().execute(
        'ai_edit_image',
        { filePath: inputPath, referencePaths: [referencePath], prompt: 'Use image 2 colors for image 1' },
        { userId },
      ));
      outputPath = result.outputPath;

      const generationCall = fetchMock.mock.calls.find(call => String(call[0]) === `${OFFICIAL_BASE_URL}/images/generations`);
      const requestBody = JSON.parse(String(generationCall?.[1]?.body));
      const dataUrl = `data:image/png;base64,${INPUT_BYTES.toString('base64')}`;
      expect(requestBody.image).toBe(`${dataUrl},${dataUrl}`);
      expect(result).toMatchObject({
        verified: true,
        inputPaths: [inputPath, referencePath],
      });
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects excess reference images instead of silently dropping them', async () => {
    const userId = 'official-image-edit-excess-reference-user';
    configureOfficialImageEdit(userId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createImageRegistry().execute(
      'ai_edit_image',
      {
        filePath: 'D:\\primary.png',
        referencePaths: ['D:\\reference-one.png', 'D:\\reference-two.png'],
        prompt: 'Fuse these images',
      },
      { userId },
    )).rejects.toThrow(/at most one reference image/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects provider text bytes masquerading as an edited image', async () => {
    const userId = 'official-image-edit-invalid-output-user';
    configureOfficialImageEdit(userId);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-image-edit-'));
    const inputPath = path.join(tempDir, 'source.png');
    fs.writeFileSync(inputPath, INPUT_BYTES);
    const outputDir = getGeneratedOutputDir();
    fs.mkdirSync(outputDir, { recursive: true });
    const beforeOutputs = new Set(fs.readdirSync(outputDir));

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${OFFICIAL_BASE_URL}/models`) {
        return jsonResponse({
          object: 'list',
          data: [{ id: EDIT_MODEL, capability: 'image_edit' }],
        });
      }
      if (url === `${OFFICIAL_BASE_URL}/images/generations`) {
        return jsonResponse({
          model: EDIT_MODEL,
          data: [
            { b64_json: `data:image/png;base64,${OUTPUT_BYTES.toString('base64')}` },
            { b64_json: `data:image/png;base64,${INVALID_IMAGE_BYTES.toString('base64')}` },
          ],
        });
      }
      throw new Error(`Unexpected official API request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(createImageRegistry().execute(
        'ai_edit_image',
        { filePath: inputPath, prompt: 'Change the background' },
        { userId },
      )).rejects.toThrow(/not a decodable .* image/i);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const newEditOutputs = fs.readdirSync(outputDir)
        .filter(fileName => fileName.startsWith('official_image_edit_') && !beforeOutputs.has(fileName));
      expect(newEditOutputs).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed after catalog discovery when no image-edit model is exposed', async () => {
    const userId = 'official-image-edit-missing-catalog-user';
    configureOfficialImageEdit(userId);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-image-edit-'));
    const inputPath = path.join(tempDir, 'source.png');
    fs.writeFileSync(inputPath, INPUT_BYTES);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url !== `${OFFICIAL_BASE_URL}/models`) throw new Error(`Unexpected provider call: ${url}`);
      return jsonResponse({
        object: 'list',
        data: [{ id: 'huawei_maas/qwen-image', capability: 'image_generation' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(createImageRegistry().execute(
        'ai_edit_image',
        { filePath: inputPath, prompt: 'Change the background' },
        { userId },
      )).rejects.toThrow(/catalog does not currently expose .* as an image editing model/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(`${OFFICIAL_BASE_URL}/models`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

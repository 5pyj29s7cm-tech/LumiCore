import './helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { ToolRegistry } from '../server/tools/registry';

const EDIT_MODEL = 'huawei_maas/qwen-image-edit-2509';
const OFFICIAL_BASE_URL = 'https://official-image-edit.test/v1';
const INPUT_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x49, 0x48, 0x44, 0x52,
]);
const OUTPUT_BYTES = Buffer.from('verified edited image bytes');

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
    try {
      const result = JSON.parse(await createImageRegistry().execute(
        'ai_edit_image',
        { filePath: inputPath, prompt: 'Replace the background with a quiet blue studio', seed: 44 },
        { userId },
      ));
      outputPath = result.outputPath;

      expect(result).toMatchObject({
        ok: true,
        status: 'edited',
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
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
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

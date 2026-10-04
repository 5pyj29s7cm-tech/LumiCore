import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { getDataPath } from '../server/config/data_path';
import { loadKeys, saveKeys, recoverKeysFromBackup, getAllKeyNames } from '../server/config/keys';
const file = getDataPath('keys.json');
let previous: string | undefined;
beforeEach(() => {
 previous = process.env.OPENAI_API_KEY;
 fs.mkdirSync(path.dirname(file), { recursive: true });
 for (const target of [file, file + '.bak']) if (fs.existsSync(target)) fs.unlinkSync(target);
});
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
describe('real key store persistence', () => {
 it('treats only a missing file as an empty store', () => { expect(loadKeys()).toEqual({}); });
 it('merges actual stored keys and removes empty updates', () => {
  saveKeys({ OPENAI_API_KEY: 'primary', GEMINI_API_KEY: 'secondary' });
  saveKeys({ OPENAI_API_KEY: '', QWEN_API_KEY: 'added' });
  expect(loadKeys()).toEqual({ GEMINI_API_KEY: 'secondary', QWEN_API_KEY: 'added' });
 });
 it.each(['{bad json', '[]', '{"OPENAI_API_KEY":42}'])('refuses overwriting damaged data: %s', body => {
  fs.writeFileSync(file, body);
  expect(() => saveKeys({ OPENAI_API_KEY: 'new' })).toThrow('Cannot read keys.json');
  expect(fs.readFileSync(file, 'utf8')).toBe(body);
  expect(process.env.OPENAI_API_KEY).toBe(previous);
 });
 it('does not turn an access error into an empty store', () => {
  saveKeys({ OPENAI_API_KEY: 'old' }); const bytes = fs.readFileSync(file);
  const original = fs.readFileSync;
  const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((target: any, ...args: any[]) => {
   if (String(target) === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
   return (original as any)(target, ...args);
  }) as any);
  expect(() => saveKeys({ GEMINI_API_KEY: 'new' })).toThrow('Cannot read keys.json');
  read.mockRestore(); expect(fs.readFileSync(file)).toEqual(bytes);
 });
 it.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)('keeps the previous store and environment after %s fails', operation => {
  saveKeys({ OPENAI_API_KEY: 'old' }); const bytes = fs.readFileSync(file);
  const failure = vi.spyOn(fs, operation).mockImplementation(() => { throw new Error('injected write failure'); });
  expect(() => saveKeys({ OPENAI_API_KEY: 'new' })).toThrow('injected write failure');
  failure.mockRestore(); expect(fs.readFileSync(file)).toEqual(bytes); expect(process.env.OPENAI_API_KEY).toBe('old');
 });
 it('recovers the last valid backup only through an explicit operation', () => {
  saveKeys({ OPENAI_API_KEY: 'first' }); saveKeys({ OPENAI_API_KEY: 'second' });
  fs.writeFileSync(file, '{interrupted');
  expect(() => loadKeys()).toThrow(); recoverKeysFromBackup();
  expect(loadKeys().OPENAI_API_KEY).toBe('first');
 });
 it('does not persist or expose a retired credential during a read', () => {
  fs.writeFileSync(file, '{"DOUBAO_SPEECH_KEY":"appid:retired","GEMINI_API_KEY":"valid"}');
  const bytes = fs.readFileSync(file); expect(loadKeys()).toEqual({ GEMINI_API_KEY: 'valid' });
  expect(fs.readFileSync(file)).toEqual(bytes);
 });
 it('uses the real supported name list and rejects environment controls', () => {
  const names=getAllKeyNames(); expect(new Set(names).size).toBe(names.length);
  expect(names).toContain('OPENAI_API_KEY'); expect(names).not.toContain('FISHAUDIO_API_KEY');
  expect(() => saveKeys({ NODE_OPTIONS: '--unsafe' })).toThrow('Invalid key name');
 });
});

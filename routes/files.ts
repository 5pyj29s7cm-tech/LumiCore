/**
 * AI Knowledge Base API — manages files in Lumi's knowledge vault.
 *
 * Files stored in data/knowledge/. Each file tracked with metadata:
 *   - source: 'upload' | 'generated' | 'ingested' | 'obsidian'
 *   - agentIds: which agents have ingested this file
 *   - status: 'ready' | 'indexing' | 'indexed'
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { readDB, writeDB } from '../db_layer';
import { chunkText, ingestDocument, verifyIngestedDocument } from '../server/agents/rag';
import type { KnowledgeIngestionManifest } from '../server/knowledge/ingestion_manifest';
import { buildKnowledgeIngestionManifest, evaluateKnowledgeManifest, hashKnowledgeContent } from '../server/knowledge/ingestion_manifest';
import { getDataPath, getGeneratedOutputDir } from '../server/config/data_path';
import { getJwtSecret } from '../server/config/local_identity';
import {
  requireAdmin as requireUnifiedAdmin,
  requireAuth as requireUnifiedAuth,
  requireLocalRequest as requireUnifiedLocalRequest,
} from '../server/middleware/auth';
import * as OrgKB from '../server/org/kb';
import { getMember } from '../server/org/db';
import { analyzeScreen } from '../server/llm/adapter';
import { getUserPreferredVision, type VisionProvider } from '../server/llm/vision_preferences';
import { AUDIO_FILE_EXTS, isAudioTranscriptionUnavailable, transcribeAudioFile } from '../server/stt/file_transcription';
import { extractPptxText } from '../server/knowledge/pptx';
import { extractRtfText } from '../server/knowledge/rtf';
import { workbookToText } from '../server/utils/spreadsheet';
import {
  enrichMarkdownKnowledgeContent,
  normalizeKnowledgeLinkTarget,
  type MarkdownKnowledgeMetadata,
} from '../server/knowledge/markdown';

const PERSONAL_KNOWLEDGE_DIR = getDataPath('knowledge');
fs.mkdirSync(PERSONAL_KNOWLEDGE_DIR, { recursive: true });

const router = Router();

const JWT_SECRET = getJwtSecret();

function requireAuth(req: Request, res: Response, next: () => void): void {
  let token = req.cookies.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  if (!token) { res.status(401).json({ error: 'Login required' }); return; }
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function getUserId(req: Request): string {
  try {
    let token = req.cookies.token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) token = req.headers.authorization.slice(7);
    if (token) return (jwt.verify(token, JWT_SECRET) as any).uid;
  } catch {}
  return 'anonymous';
}

function getAuthPayload(req: Request): any | null {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) token = req.headers.authorization.slice(7);
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET) as any;
  } catch {
    return null;
  }
}

// ── Multer: files staged in OS temp, then moved to knowledge dir ──
const tmpDir = path.join(os.tmpdir(), 'lumi-uploads');
fs.mkdirSync(tmpDir, { recursive: true });
const MAX_UPLOAD_FILES = Math.max(20, Number(process.env.KNOWLEDGE_UPLOAD_MAX_FILES || 200));
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES } });

type KnowledgeStatus = 'ready' | 'indexing' | 'indexed' | 'partial' | 'unsupported' | 'failed';
type ExtractionMethod = 'text' | 'markdown' | 'rtf' | 'docx' | 'spreadsheet' | 'presentation' | 'pdf' | 'image-vision' | 'image-metadata' | 'audio-transcript' | 'unsupported';

export interface KnowledgeExtractionResult {
  content: string | null;
  method: ExtractionMethod;
  status: Extract<KnowledgeStatus, 'indexed' | 'partial' | 'unsupported' | 'failed'>;
  warning?: string;
  error?: string;
  failureKind?: KnowledgeIngestionManifest['extraction']['failureKind'];
  provider?: VisionProvider | string;
  model?: string;
  sourceMetadata?: MarkdownKnowledgeMetadata;
}

interface KnowledgeExtractionDeps {
  llmGetters?: Record<string, (() => any) | undefined>;
}

let knowledgeExtractionDeps: KnowledgeExtractionDeps = {};
let sharpLoader: Promise<any> | null = null;
let legacyRevalidationTimer: ReturnType<typeof setTimeout> | null = null;
let legacyRevalidationRunning = false;

export function configureKnowledgeFileRoutes(deps: KnowledgeExtractionDeps): void {
  knowledgeExtractionDeps = { ...knowledgeExtractionDeps, ...deps };
  scheduleLegacyKnowledgeRevalidation();
}

async function getSharp() {
  if (!sharpLoader) {
    sharpLoader = import('sharp').then(mod => mod.default || mod);
  }
  return sharpLoader;
}

// ── Helpers ──

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface KnowledgeEntry {
  id: string;
  name: string;
  displayName: string;
  path?: string;
  domain: 'personal' | 'work';
  orgId?: string;
  size: string;
  rawSize: number;
  type: 'file';
  source: KnowledgeFileSource;
  agentIds: string[];
  status: KnowledgeStatus;
  extractionStatus?: KnowledgeExtractionResult['status'];
  extractionMethod?: ExtractionMethod;
  extractionWarning?: string;
  extractionError?: string;
  extractionFailureKind?: KnowledgeExtractionResult['failureKind'];
  extractionProvider?: string;
  extractionModel?: string;
  contentChars?: number;
  ingestionStatus?: KnowledgeIngestionManifest['status'];
  ingestionManifestId?: string;
  ingestionCoverage?: KnowledgeIngestionManifest['coverage'];
  sourceTitle?: string;
  sourceAliases?: string[];
  sourceTags?: string[];
  sourceLinks?: string[];
  sourceBacklinks?: string[];
  sourceProperties?: Record<string, unknown>;
  obsidianVaultId?: string;
  obsidianVaultName?: string;
  obsidianVaultPath?: string;
  obsidianRelativePath?: string;
  obsidianSourcePath?: string;
  updatedAt: string;
  createdAt: string;
}

type KnowledgeFileSource = 'upload' | 'generated' | 'ingested' | 'obsidian';

interface ObsidianVaultConfig {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  name: string;
  path: string;
  enabled: boolean;
  isObsidianVault: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastScanAt?: string;
  lastNoteCount?: number;
  lastSyncResult?: {
    synced: number;
    skipped: number;
    failed: number;
    noteCount: number;
  };
}

interface ObsidianNoteFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface FileScope {
  domain: 'personal' | 'work';
  userId: string;
  orgId?: string;
  dir: string;
  legacyPersonalOwner?: boolean;
}

interface KnowledgeFileInput {
  sourcePath: string;
  originalName: string;
  size?: number;
  mimeType?: string;
  move?: boolean;
}

const MOJIBAKE_TOKENS = [
  '\u00c3',
  '\u00c2',
  '\ufffd',
  '\u00e6',
  '\u00e9',
  '\u00e8',
  '\u00e7',
  '\u00e5',
  '\u00e4',
  '\u951f',
  '\u93c2',
  '\u6d93',
  '\u7f01',
  '\u7015',
  '\u6fc2',
  '\u5a34',
  '\u6d7c',
  '\u5fe1',
  '\u9439',
  '\u9359',
];

function looksMojibake(value: string): boolean {
  return /[\u0080-\u009f]/.test(value)
    || /[\u00c0-\u00ff][\u0080-\u00bf]/.test(value)
    || MOJIBAKE_TOKENS.some(token => value.includes(token));
}

function textScore(value: string): number {
  let score = 0;
  const replacement = (value.match(/\ufffd/g) || []).length;
  const mojibake = MOJIBAKE_TOKENS.reduce((sum, token) => sum + (value.includes(token) ? 1 : 0), 0);
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (value.match(/[A-Za-z0-9._ -]/g) || []).length;
  score += cjk * 2 + ascii * 0.15;
  score -= replacement * 8 + mojibake * 2;
  return score;
}

function repairFilename(value: string): string {
  const original = String(value || '').normalize('NFC');
  if (!original || !looksMojibake(original)) return original;
  const candidates = new Set<string>([original]);
  try { candidates.add(Buffer.from(original, 'latin1').toString('utf8').normalize('NFC')); } catch {}
  try { candidates.add(iconv.decode(iconv.encode(original, 'gbk'), 'utf8').normalize('NFC')); } catch {}
  try { candidates.add(iconv.decode(iconv.encode(original, 'gb18030'), 'utf8').normalize('NFC')); } catch {}
  return [...candidates].sort((a, b) => textScore(b) - textScore(a))[0] || original;
}

function sanitizeKnowledgeFilename(value: string, fallback = 'untitled'): string {
  const repaired = repairFilename(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
  const safe = repaired && repaired !== '.' && repaired !== '..' ? repaired : fallback;
  return path.basename(safe);
}

const TEXT_KNOWLEDGE_EXTS = /\.(txt|md|json|csv|log|xml|yaml|yml|ts|tsx|js|jsx|py|html|css|env|toml|ini|cfg)$/i;
const RTF_KNOWLEDGE_EXTS = /\.rtf$/i;
const EXTRACTABLE_KNOWLEDGE_EXTS = /\.(docx|xlsx|xls|pptx|pdf)$/i;
const IMAGE_KNOWLEDGE_EXTS = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const AUDIO_KNOWLEDGE_EXTS = AUDIO_FILE_EXTS;
const GENERATED_FILE_EXTS = /\.(docx?|pptx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|webp|gif|svg|html|dxf|dwg)$/i;
const OBSIDIAN_NOTE_EXTS = /\.(md|markdown)$/i;
const OBSIDIAN_MAX_NOTE_BYTES = Math.max(256 * 1024, Number(process.env.OBSIDIAN_NOTE_MAX_BYTES || 5 * 1024 * 1024));
const OBSIDIAN_DEFAULT_MAX_FILES = Math.max(50, Number(process.env.OBSIDIAN_SYNC_MAX_FILES || 500));
const OBSIDIAN_HARD_MAX_FILES = Math.max(OBSIDIAN_DEFAULT_MAX_FILES, Number(process.env.OBSIDIAN_SYNC_HARD_MAX_FILES || 2000));
const OBSIDIAN_SKIP_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  '.recycle',
  'node_modules',
  '.DS_Store',
]);

const DOWNLOAD_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.rtf': 'application/rtf',
  '.log': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm',
  '.dxf': 'application/dxf',
  '.dwg': 'application/octet-stream',
};

function getDownloadMime(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase() || (filePath.startsWith('.') ? filePath.toLowerCase() : '');
  return DOWNLOAD_MIME_TYPES[ext];
}

function isInsideRoot(filePath: string, root: string): boolean {
  const normalizedFile = path.normalize(filePath).toLowerCase();
  const normalizedRoot = path.normalize(root).toLowerCase();
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(normalizedRoot + path.sep.toLowerCase());
}

function resolveGeneratedDownloadPath(value: unknown): string {
  const rawInput = String(value || '').trim();
  const normalizedRawInput = rawInput.replace(/\\/g, '/');
  const raw = normalizedRawInput.startsWith('/lumi_output/')
    ? path.join(getGeneratedOutputDir(), normalizedRawInput.slice('/lumi_output/'.length))
    : rawInput;
  if (!raw) {
    const err: any = new Error('path is required');
    err.status = 400;
    throw err;
  }
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  if (!GENERATED_FILE_EXTS.test(resolved)) {
    const err: any = new Error('Unsupported generated file type');
    err.status = 400;
    throw err;
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const err: any = new Error('Generated file not found');
    err.status = 404;
    throw err;
  }
  const generatedRoot = fs.realpathSync.native(getGeneratedOutputDir());
  const realPath = fs.realpathSync.native(resolved);
  if (!isInsideRoot(realPath, generatedRoot)) {
    const err: any = new Error('Generated file path is outside the generated-output directory');
    err.status = 403;
    throw err;
  }
  return realPath;
}

function resolveKnowledgeFilePath(req: Request, idValue: unknown): string {
  const scope = getFileScope(req);
  const safeName = path.basename(String(idValue || '').trim());
  if (!safeName) {
    const err: any = new Error('id is required');
    err.status = 400;
    throw err;
  }

  const filePath = path.resolve(path.join(scope.dir, safeName));
  const scopeDir = path.resolve(scope.dir);
  if (!isInsideRoot(filePath, scopeDir)) {
    const err: any = new Error('File path is outside allowed directories');
    err.status = 403;
    throw err;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const err: any = new Error('File not found');
    err.status = 404;
    throw err;
  }
  return fs.realpathSync.native(filePath);
}

function openPathWithDefaultApp(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
    const args = process.platform === 'win32'
      ? [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '$ErrorActionPreference = "Stop"; $target = $args[0]; if (-not (Test-Path -LiteralPath $target)) { throw "Path not found: $target" }; Start-Process -LiteralPath $target',
        filePath,
      ]
      : [filePath];
    const proc = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Open command timed out'));
    }, 8000);
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error((stderr || `Open command failed with exit code ${code}`).trim()));
      }
    });
  });
}

function visionModelFor(provider: VisionProvider): string {
  switch (provider) {
    case 'qwen': return 'qwen-vl-max';
    case 'ark': return 'doubao-1-5-vision-pro-32k';
    case 'ollama': return 'qwen2.5vl:7b';
    case 'lmstudio': return 'local-vision-model';
    case 'relay': return 'qwen2.5-vl-7b-instruct';
    case 'openai': return 'gpt-4o';
    case 'gemini':
    default:
      return 'gemini-2.0-flash';
  }
}

function resolveKnowledgeVisionProvider(userId: string): VisionProvider | null {
  const g = knowledgeExtractionDeps.llmGetters || {};
  const provider = getUserPreferredVision(userId).provider;
  if (provider === 'openai' && g.getOpenAI?.()) return 'openai';
  if (provider === 'gemini' && g.getGemini?.()) return 'gemini';
  if (provider === 'ark' && g.getArk?.()) return 'ark';
  if (provider === 'qwen' && g.getQwen?.()) return 'qwen';
  if (provider === 'ollama' && g.getOllama?.()) return 'ollama';
  if (provider === 'lmstudio' && g.getLmStudio?.()) return 'lmstudio';
  if (provider === 'relay' && g.getRelay?.()) return 'relay';
  return null;
}

async function extractImageKnowledge(filePath: string, userId: string): Promise<KnowledgeExtractionResult> {
  let meta: any = {};
  try {
    const sharp = await getSharp();
    meta = await sharp(filePath).metadata();
    const provider = resolveKnowledgeVisionProvider(userId);
    const displayName = repairFilename(path.basename(filePath));
    const imageInfo = [
      `[Image File] ${displayName}`,
      `Format: ${meta.format || path.extname(filePath).replace(/^\./, '') || 'unknown'}`,
      `Size: ${meta.width || '?'} x ${meta.height || '?'} px`,
    ].join('\n');

    if (!provider) {
      return {
        content: `${imageInfo}\n\nVisual analysis was not run because no configured vision model is available for this user.`,
        method: 'image-metadata',
        status: 'partial',
        warning: 'No configured vision model is available. Configure a vision provider to extract text and visual content from images.',
      };
    }

    const g = knowledgeExtractionDeps.llmGetters || {};
    const buffer = await sharp(filePath)
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const base64 = buffer.toString('base64');
    const preferred = getUserPreferredVision(userId);
    const model = preferred.model || visionModelFor(provider);
    const prompt = [
      'Prepare this uploaded image for Lumi knowledge-base retrieval.',
      'Extract every readable text exactly as visible. Then summarize the visual content, tables, diagrams, screenshots, documents, labels, entities, and relationships that may be useful later.',
      'Return structured plain text in the image language when possible. Do not invent details that are not visible.',
      `File name: ${displayName}`,
    ].join('\n');
    const imagePayload = JSON.stringify({
      image_base64: base64,
      format: 'jpeg',
      width: meta.width || null,
      height: meta.height || null,
    });
    const analysis = await analyzeScreen(
      imagePayload,
      prompt,
      { provider, model, userId, maxTokens: 2200 },
      g.getDeepSeek,
      g.getGemini,
      g.getOpenAI,
      g.getAnthropic,
      g.getQwen,
      g.getOllama,
      g.getLmStudio,
      g.getArk,
      g.getXiaomi,
      g.getKimi,
      g.getGlm,
      g.getRelay,
    );
    const extracted = String(analysis || '').trim();
    if (!extracted) {
      return {
        content: imageInfo,
        method: 'image-metadata',
        status: 'partial',
        provider,
        model,
        warning: 'The vision provider returned no extractable text or visual description; only image metadata was indexed.',
        failureKind: 'empty_extraction',
      };
    }

    return {
      content: `${imageInfo}\nVision provider: ${provider}/${model}\n\nExtracted visual knowledge:\n${extracted}`,
      method: 'image-vision',
      status: 'indexed',
      provider,
      model,
    };
  } catch (err: any) {
    const fallback = [
      `[Image File] ${repairFilename(path.basename(filePath))}`,
      meta?.format ? `Format: ${meta.format}` : '',
      meta?.width || meta?.height ? `Size: ${meta.width || '?'} x ${meta.height || '?'} px` : '',
    ].filter(Boolean).join('\n');
    return {
      content: fallback || null,
      method: fallback ? 'image-metadata' : 'unsupported',
      ...classifyKnowledgeExtractionFailure(err),
      status: fallback ? 'partial' : 'failed',
      warning: fallback ? 'Image vision extraction failed; only file metadata was indexed.' : undefined,
    };
  }
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const pdfModule: any = await import('pdf-parse');
  const legacyParser = typeof pdfModule.default === 'function'
    ? pdfModule.default
    : typeof pdfModule === 'function'
      ? pdfModule
      : null;

  if (legacyParser) {
    const result = await legacyParser(buffer);
    return String(result?.text || '');
  }

  const PDFParse = pdfModule.PDFParse || pdfModule.default?.PDFParse;
  if (typeof PDFParse !== 'function') {
    throw new Error('Unsupported pdf-parse API');
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || '');
  } finally {
    await parser.destroy?.();
  }
}

async function extractAudioKnowledge(filePath: string): Promise<KnowledgeExtractionResult> {
  const displayName = repairFilename(path.basename(filePath));
  try {
    const result = await transcribeAudioFile(fs.readFileSync(filePath), {
      fileName: displayName,
      language: 'zh',
    });
    const transcript = result.text.trim();
    if (!transcript) {
      return {
        content: null,
        method: 'audio-transcript',
        status: 'failed',
        error: 'No speech was transcribed from this audio file.',
        failureKind: 'empty_extraction',
      };
    }
    return {
      content: [
        `[Audio File] ${displayName}`,
        `Transcription provider: ${result.provider}/${result.model}`,
        '',
        'Transcript:',
        transcript,
      ].join('\n'),
      method: 'audio-transcript',
      status: 'indexed',
      provider: result.provider,
      model: result.model,
      warning: result.warnings?.length ? `Fallbacks used before success: ${result.warnings.join('; ')}` : undefined,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    const classified = classifyKnowledgeExtractionFailure(err);
    return {
      content: null,
      method: 'audio-transcript',
      status: 'failed',
      error: isAudioTranscriptionUnavailable(err)
        ? 'No audio transcription provider is configured. Configure OpenAI Whisper, DashScope SenseVoice, Doubao Speech, or local Whisper, then retry.'
        : message,
      failureKind: isAudioTranscriptionUnavailable(err) ? 'provider_unavailable' : classified.failureKind,
    };
  }
}

function extractTextKnowledge(filePath: string): KnowledgeExtractionResult {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (/\.md(?:own)?$/i.test(path.extname(filePath))) {
    const enriched = enrichMarkdownKnowledgeContent(raw, repairFilename(path.basename(filePath)));
    return {
      content: enriched.content,
      method: 'markdown',
      status: 'indexed',
      sourceMetadata: enriched.metadata,
    };
  }
  return { content: raw, method: 'text', status: 'indexed' };
}

function extractGeneratedTextKnowledge(filename: string, content: string): KnowledgeExtractionResult {
  if (/\.md(?:own)?$/i.test(path.extname(filename))) {
    const enriched = enrichMarkdownKnowledgeContent(content, repairFilename(filename));
    return {
      content: enriched.content,
      method: 'markdown',
      status: 'indexed',
      sourceMetadata: enriched.metadata,
    };
  }
  return { content, method: 'text', status: 'indexed' };
}

export async function extractKnowledgeFileContent(filePath: string, userId = 'anonymous'): Promise<KnowledgeExtractionResult> {
  const extName = path.extname(filePath);
  try {
    if (TEXT_KNOWLEDGE_EXTS.test(extName)) {
      const result = extractTextKnowledge(filePath);
      return result.content?.trim()
        ? result
        : { ...result, content: null, status: 'partial', warning: 'The text source is empty.', failureKind: 'empty_extraction' };
    }
    if (RTF_KNOWLEDGE_EXTS.test(extName)) {
      const content = extractRtfText(fs.readFileSync(filePath, 'utf-8'));
      return content.trim()
        ? { content, method: 'rtf', status: 'indexed' }
        : { content: null, method: 'rtf', status: 'partial', warning: 'The RTF source contained no extractable text.', failureKind: 'empty_extraction' };
    }
    if (/\.docx$/i.test(extName)) {
      const mammoth = await import('mammoth');
      const content = (await mammoth.extractRawText({ path: filePath })).value;
      return content.trim()
        ? { content, method: 'docx', status: 'indexed' }
        : { content: null, method: 'docx', status: 'partial', warning: 'The document contained no extractable text.', failureKind: 'empty_extraction' };
    }
    if (/\.xlsx$/i.test(extName)) {
      const content = await workbookToText(filePath);
      return content.trim()
        ? { content, method: 'spreadsheet', status: 'indexed' }
        : { content: null, method: 'spreadsheet', status: 'partial', warning: 'The workbook contained no extractable cell content.', failureKind: 'empty_extraction' };
    }
    if (/\.xls$/i.test(extName)) {
      throw new Error('Legacy .xls files are not supported by the safe spreadsheet reader. Convert the file to .xlsx or .csv first.');
    }
    if (/\.pptx$/i.test(extName)) {
      const content = await extractPptxText(filePath);
      return content.trim()
        ? { content, method: 'presentation', status: 'indexed' }
        : { content: null, method: 'presentation', status: 'partial', warning: 'The presentation contained no extractable text.', failureKind: 'empty_extraction' };
    }
    if (/\.pdf$/i.test(extName)) {
      const content = await extractPdfText(filePath);
      const meaningfulContent = content
        .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '')
        .replace(/[\f\u0000]/g, '')
        .trim();
      return meaningfulContent
        ? { content, method: 'pdf', status: 'indexed' }
        : {
            content: null,
            method: 'pdf',
            status: 'partial',
            warning: 'The PDF contained no extractable text. It may be scanned or image-only and requires OCR before it can be verified as absorbed.',
            failureKind: 'empty_extraction',
          };
    }
    if (AUDIO_KNOWLEDGE_EXTS.test(extName)) {
      return await extractAudioKnowledge(filePath);
    }
    if (IMAGE_KNOWLEDGE_EXTS.test(extName)) {
      return await extractImageKnowledge(filePath, userId);
    }
  } catch (err: any) {
    console.warn(`[Files] Failed to extract "${path.basename(filePath)}": ${err.message}`);
    return { content: null, method: 'unsupported', ...classifyKnowledgeExtractionFailure(err) };
  }
  return {
    content: null,
    method: 'unsupported',
    status: 'unsupported',
    warning: 'This file type has no supported text or visual extraction path yet.',
    failureKind: 'unsupported_format',
  };
}

function normalizeFileDomain(value: unknown): 'personal' | 'work' {
  return String(value || '').toLowerCase() === 'work' ? 'work' : 'personal';
}

function getRequestedDomain(req: Request): 'personal' | 'work' | null {
  const value = req.query.domain ?? req.body?.domain;
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return normalizeFileDomain(value);
}

function isPrimaryLocalOwner(userId: string): boolean {
  const db = readDB();
  const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
  return Boolean(primaryAdmin?.uid && primaryAdmin.uid === userId);
}

function getPersonalKnowledgeDirectory(userId: string): { dir: string; legacyPersonalOwner: boolean } {
  // Preserve the original on-device owner's vault location. Any additional local
  // account gets a separate directory so an organization member cannot enter a
  // personal token context and see the host owner's files.
  if (isPrimaryLocalOwner(userId)) {
    return { dir: PERSONAL_KNOWLEDGE_DIR, legacyPersonalOwner: true };
  }
  const directoryId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  const dir = path.join(PERSONAL_KNOWLEDGE_DIR, '_users', directoryId);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, legacyPersonalOwner: false };
}

function assertLocalHostRequest(req: Request): void {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  const loopback = address === '::1'
    || address === '127.0.0.1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
  if (loopback) return;
  const err: any = new Error('This operation is available only from the local Lumi desktop client.');
  err.status = 403;
  throw err;
}

function assertKnowledgeWriteAccess(scope: FileScope, adminOnly = false): void {
  if (scope.domain === 'personal') return;
  const membership = scope.orgId ? getMember(scope.orgId, scope.userId) : null;
  const allowedRoles = adminOnly ? ['owner', 'admin'] : ['owner', 'admin', 'member'];
  if (!membership || !allowedRoles.includes(membership.role)) {
    const err: any = new Error(adminOnly
      ? 'Organization owner or administrator access required.'
      : 'This organization role has read-only knowledge access.');
    err.status = 403;
    throw err;
  }
}

function getFileScope(req: Request): FileScope {
  const payload = getAuthPayload(req);
  if (!payload?.uid) {
    const err: any = new Error('Authentication required');
    err.status = 401;
    throw err;
  }

  const requestedDomain = getRequestedDomain(req);
  const authenticatedDomain = payload.orgId ? 'work' : 'personal';
  if (requestedDomain && requestedDomain !== authenticatedDomain) {
    const err: any = new Error(authenticatedDomain === 'work'
      ? 'Personal knowledge is unavailable in organization context. Switch to personal Lumi first.'
      : 'Organization knowledge requires an active organization context.');
    err.status = 403;
    throw err;
  }

  if (authenticatedDomain === 'personal') {
    assertLocalHostRequest(req);
    const personal = getPersonalKnowledgeDirectory(payload.uid);
    return {
      domain: 'personal',
      userId: payload.uid,
      dir: personal.dir,
      legacyPersonalOwner: personal.legacyPersonalOwner,
    };
  }

  const requestedOrgId = String(req.query.orgId || req.body?.orgId || '').trim();
  const orgId = requestedOrgId || String(payload.orgId || '').trim();
  if (!orgId || !payload.orgId) {
    const err: any = new Error('Organization context required');
    err.status = 403;
    throw err;
  }
  if (orgId !== payload.orgId) {
    const err: any = new Error('Organization context does not match the requested organization');
    err.status = 403;
    throw err;
  }
  const membership = getMember(orgId, payload.uid);
  if (!membership || membership.status !== 'active') {
    const err: any = new Error('Active organization membership required');
    err.status = 403;
    throw err;
  }

  const dir = getDataPath(path.join('org', orgId, 'knowledge'));
  fs.mkdirSync(dir, { recursive: true });
  return { domain: 'work', userId: payload.uid, orgId, dir };
}

function metaMatchesScope(meta: any, scope: FileScope): boolean {
  const metaDomain = normalizeFileDomain(meta?.domain || (meta?.orgId ? 'work' : 'personal'));
  if (metaDomain !== scope.domain) return false;
  if (scope.domain === 'work') return String(meta?.orgId || '') === scope.orgId;
  if (meta?.orgId) return false;
  if (meta?.userId) return String(meta.userId) === scope.userId;
  return scope.legacyPersonalOwner === true;
}

function findFileMeta(db: any, filename: string, scope: FileScope): any | undefined {
  return (db.knowledgeFiles || []).find((m: any) => m.filename === filename && metaMatchesScope(m, scope));
}

function removeFileMeta(db: any, filename: string, scope: FileScope): void {
  db.knowledgeFiles = (db.knowledgeFiles || []).filter((m: any) => !(m.filename === filename && metaMatchesScope(m, scope)));
}

function applyExtractionMeta(meta: any, extraction: KnowledgeExtractionResult, content: string | null): void {
  if (!meta) return;
  meta.extractionStatus = extraction.status;
  meta.extractionMethod = extraction.method;
  meta.extractionWarning = extraction.warning || '';
  meta.extractionError = extraction.error || '';
  meta.extractionFailureKind = extraction.failureKind || '';
  meta.extractionProvider = extraction.provider || '';
  meta.extractionModel = extraction.model || '';
  meta.contentChars = content?.length || 0;
  if (extraction.sourceMetadata) {
    meta.sourceTitle = extraction.sourceMetadata.title;
    meta.sourceAliases = extraction.sourceMetadata.aliases;
    meta.sourceTags = extraction.sourceMetadata.tags;
    meta.sourceLinks = extraction.sourceMetadata.links;
    meta.sourceProperties = extraction.sourceMetadata.frontmatter;
  } else {
    delete meta.sourceTitle;
    delete meta.sourceAliases;
    delete meta.sourceTags;
    delete meta.sourceLinks;
    delete meta.sourceProperties;
  }
  meta.updatedAt = new Date().toISOString();
}

function buildNonIndexedManifest(
  sourceId: string,
  extraction: KnowledgeExtractionResult,
): KnowledgeIngestionManifest {
  return buildKnowledgeIngestionManifest({
    sourceId,
    content: '',
    chunks: [],
    extraction,
  });
}

function personalKnowledgeDirectoryForMeta(meta: any, db: any): string {
  const userId = String(meta?.userId || '');
  const primaryAdmin = (db.users || []).find((user: any) => user?.role === 'admin');
  if (primaryAdmin?.uid && primaryAdmin.uid === userId) return PERSONAL_KNOWLEDGE_DIR;
  const directoryId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return getDataPath(path.join('knowledge', '_users', directoryId));
}

export async function revalidateOneLegacyKnowledgeFile(): Promise<'verified' | 'unverified' | 'failed' | 'idle'> {
  if (legacyRevalidationRunning) return 'idle';
  legacyRevalidationRunning = true;
  let activeIdentity: { userId: string; filename: string } | null = null;
  try {
    const db = readDB();
    const now = Date.now();
    const meta = (db.knowledgeFiles || []).find((item: any) => {
      const domain = normalizeFileDomain(item?.domain || (item?.orgId ? 'work' : 'personal'));
      if (domain !== 'personal') return false;
      const storedManifest = item?.ingestionManifest as KnowledgeIngestionManifest | undefined;
      if (storedManifest?.schemaVersion === 1) {
        return storedManifest.coverage?.verified === true
          && storedManifest.retrieval?.method !== 'golden_qa_v1';
      }
      const legacyStatus = String(item?.extractionStatus || item?.status || '').toLowerCase();
      const attempts = Number(item?.legacyRevalidationAttempts || 0);
      const retryAt = Number(item?.legacyRevalidationRetryAt || 0);
      return (legacyStatus === 'indexed' || Boolean(item?.agentIds?.length))
        && attempts < 3
        && retryAt <= now;
    });
    if (!meta) return 'idle';

    const userId = String(meta.userId || '');
    const filename = String(meta.filename || '');
    activeIdentity = { userId, filename };
    const storedManifest = meta.ingestionManifest as KnowledgeIngestionManifest | undefined;
    if (storedManifest?.schemaVersion === 1
      && storedManifest.coverage?.verified === true
      && storedManifest.retrieval?.method !== 'golden_qa_v1') {
      const invalidated = { ...storedManifest, ...evaluateKnowledgeManifest(storedManifest) };
      applyIngestionManifest(meta, invalidated);
      meta.status = 'indexed';
      meta.legacyRevalidationLastAt = new Date().toISOString();
      meta.legacyRevalidationError = 'Prior synthetic retrieval probes are not golden QA; owner-supplied cases are required.';
      writeDB(db);
      return 'unverified';
    }
    const filePath = path.join(personalKnowledgeDirectoryForMeta(meta, db), filename);
    meta.legacyRevalidationAttempts = Number(meta.legacyRevalidationAttempts || 0) + 1;
    meta.legacyRevalidationLastAt = new Date().toISOString();
    if (!userId || !filename || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const extraction: KnowledgeExtractionResult = {
        content: null,
        method: 'unsupported',
        status: 'failed',
        error: 'Legacy knowledge source is missing; existing index remains read-only and unverified.',
        failureKind: 'extraction_error',
      };
      applyExtractionMeta(meta, extraction, null);
      applyIngestionManifest(meta, buildNonIndexedManifest(filePath || filename, extraction));
      meta.status = 'failed';
      writeDB(db);
      return 'failed';
    }

    const extraction = await extractKnowledgeFileContent(filePath, userId);
    if (!extraction.content?.trim()) {
      applyExtractionMeta(meta, extraction, null);
      applyIngestionManifest(meta, buildNonIndexedManifest(filePath, extraction));
      meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
      writeDB(db);
      return 'failed';
    }

    const legacyMemories = findExistingFileMemories(db, filename, {
      domain: 'personal',
      userId,
      orgId: '',
      dir: personalKnowledgeDirectoryForMeta(meta, db),
      legacyPersonalOwner: Boolean((db.users || []).find((user: any) => user?.role === 'admin' && user.uid === userId)),
    }, { userId });
    const agentIds = Array.from(new Set<string>(
      (Array.isArray(meta.agentIds) && meta.agentIds.length ? meta.agentIds : ['lumi'])
        .map((value: unknown) => String(value || '').trim())
        .filter((value: string): value is string => Boolean(value)),
    ));
    let latestResult: Awaited<ReturnType<typeof ingestDocument>> | null = null;
    for (const agentId of agentIds) {
      latestResult = await ingestDocument(userId, agentId, filename, extraction.content, {
        filePath,
        domain: 'personal',
        sourceMetadata: extraction.sourceMetadata,
        extraction,
      });
    }
    if (!latestResult) throw new Error('No target agent was available for legacy knowledge revalidation.');

    const oldIds = new Set(legacyMemories.map((memory: any) => String(memory.id || '')));
    if (oldIds.size) db.memories = (db.memories || []).filter((memory: any) => !oldIds.has(String(memory.id || '')));
    applyExtractionMeta(meta, extraction, extraction.content);
    applyIngestionManifest(meta, latestResult.manifest);
    meta.status = latestResult.manifest.status === 'partial' ? 'partial' : 'indexed';
    delete meta.legacyRevalidationRetryAt;
    writeDB(db);
    return latestResult.manifest.coverage.verified ? 'verified' : 'unverified';
  } catch (error: any) {
    try {
      const db = readDB();
      const candidate = activeIdentity
        ? (db.knowledgeFiles || []).find((item: any) => (
            String(item.userId || '') === activeIdentity!.userId
            && String(item.filename || '') === activeIdentity!.filename
          ))
        : null;
      if (candidate) {
        const attempts = Number(candidate.legacyRevalidationAttempts || 1);
        candidate.legacyRevalidationError = String(error?.message || error).slice(0, 500);
        candidate.legacyRevalidationRetryAt = Date.now() + Math.min(24 * 60 * 60_000, 2 ** attempts * 60_000);
        writeDB(db);
      }
    } catch {}
    return 'failed';
  } finally {
    legacyRevalidationRunning = false;
  }
}

export function scheduleLegacyKnowledgeRevalidation(delayMs = 60_000): void {
  if (legacyRevalidationTimer) return;
  legacyRevalidationTimer = setTimeout(async () => {
    legacyRevalidationTimer = null;
    const result = await revalidateOneLegacyKnowledgeFile();
    if (result !== 'idle') scheduleLegacyKnowledgeRevalidation(60_000);
  }, Math.max(1_000, delayMs));
  if (typeof (legacyRevalidationTimer as any).unref === 'function') (legacyRevalidationTimer as any).unref();
}

export function classifyKnowledgeExtractionFailure(error: unknown): Pick<KnowledgeExtractionResult, 'status' | 'failureKind' | 'error'> {
  const message = String((error as any)?.message || error || 'Knowledge extraction failed.').slice(0, 500);
  const lower = message.toLowerCase();
  const failureKind: NonNullable<KnowledgeExtractionResult['failureKind']> = /password|encrypted|decrypt|encryption/.test(lower)
    ? 'encrypted_or_password_required'
    : /corrupt|invalid|malformed|unexpected end|central directory|zip|xref/.test(lower)
      ? 'corrupt_source'
      : /provider|model.*configured|transcri.*unavailable|vision.*unavailable/.test(lower)
        ? 'provider_unavailable'
        : 'extraction_error';
  return { status: 'failed', failureKind, error: message };
}

function applyIngestionManifest(meta: any, manifest: KnowledgeIngestionManifest): void {
  if (!meta) return;
  meta.ingestionManifest = manifest;
  meta.ingestionManifestId = manifest.manifestId;
  meta.ingestionStatus = manifest.status;
  meta.ingestionCoverage = manifest.coverage;
  meta.chunkCount = manifest.chunks.length;
  meta.sourceRevision = manifest.sourceRevision;
  meta.updatedAt = new Date().toISOString();
}

function readCurrentIngestionManifest(meta: any): KnowledgeIngestionManifest | null {
  const manifest = meta?.ingestionManifest as KnowledgeIngestionManifest | undefined;
  if (!manifest || manifest.schemaVersion !== 1) return null;
  return { ...manifest, ...evaluateKnowledgeManifest(manifest) };
}

function hasCurrentVerifiedManifest(meta: any, content: string, existingMemoryIds: string[]): boolean {
  const manifest = meta?.ingestionManifest as KnowledgeIngestionManifest | undefined;
  if (!manifest || manifest.schemaVersion !== 1) return false;
  if (manifest.sourceRevision !== hashKnowledgeContent(content)) return false;
  const existing = new Set(existingMemoryIds);
  return manifest.chunks.length > 0
    && manifest.chunks.every(chunk => Boolean(chunk.memoryId) && existing.has(String(chunk.memoryId)))
    && manifest.coverage?.chunkStorageCoverage === 1;
}

function buildOrgArticleTags(filename: string, metadata?: MarkdownKnowledgeMetadata): string[] {
  const ext = path.extname(filename).replace(/^\./, '');
  return [
    'upload',
    ext,
    ...(metadata?.tags || []),
    ...(metadata?.aliases || []).map(alias => `alias:${alias}`),
  ].map(tag => String(tag || '').trim()).filter(Boolean).slice(0, 20);
}

async function ensureOrgArticleFromFile(
  scope: FileScope,
  userId: string,
  filename: string,
  content: string | null,
  articleId?: string,
  metadata?: MarkdownKnowledgeMetadata,
): Promise<any | null> {
  if (scope.domain !== 'work' || !scope.orgId) return null;
  const articleContent = (content && content.trim())
    ? content
    : `文件已上传到组织知识库。\n\n文件名：${repairFilename(filename)}`;
  const articleTags = buildOrgArticleTags(filename, metadata);
  if (articleId && OrgKB.getArticle(scope.orgId, articleId)) {
    const article = OrgKB.updateArticle(scope.orgId, userId, articleId, {
      title: repairFilename(filename),
      content: articleContent,
      category: 'files',
      tags: articleTags,
      status: 'published',
    }, { index: false });
    if (!article) return null;
    await OrgKB.indexArticle(scope.orgId, article.id);
    return OrgKB.getArticle(scope.orgId, article.id) || article;
  }
  const article = OrgKB.createArticle(scope.orgId, userId, {
    title: repairFilename(filename),
    content: articleContent,
    category: 'files',
    tags: articleTags,
    status: 'published',
  }, { index: false });
  await OrgKB.indexArticle(scope.orgId, article.id);
  return OrgKB.getArticle(scope.orgId, article.id) || article;
}

function uniqueKnowledgeDestination(scope: FileScope, originalName: string): string {
  const uploadName = sanitizeKnowledgeFilename(originalName, 'upload');
  let dest = path.join(scope.dir, uploadName);
  let counter = 1;
  const ext = path.extname(uploadName);
  const base = path.basename(uploadName, ext);
  while (fs.existsSync(dest)) {
    dest = path.join(scope.dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return dest;
}

function copyOrMoveKnowledgeSource(input: KnowledgeFileInput, dest: string): void {
  if (!input.move) {
    fs.copyFileSync(input.sourcePath, dest);
    return;
  }

  try {
    fs.renameSync(input.sourcePath, dest);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    fs.copyFileSync(input.sourcePath, dest);
    fs.unlinkSync(input.sourcePath);
  }
}

async function saveKnowledgeFile(
  input: KnowledgeFileInput,
  userId: string,
  scope: FileScope,
  db: any,
): Promise<any> {
  const dest = uniqueKnowledgeDestination(scope, input.originalName || path.basename(input.sourcePath));
  copyOrMoveKnowledgeSource(input, dest);
  const finalName = path.basename(dest);
  const ext = path.extname(finalName);
  const stats = fs.statSync(dest);
  const mimeType = input.mimeType || getDownloadMime(dest) || '';

  const existing = findFileMeta(db, finalName, scope);
  if (existing) {
    existing.source = 'upload';
    existing.domain = scope.domain;
    existing.orgId = scope.orgId || '';
    existing.userId = scope.domain === 'personal' ? scope.userId : existing.userId;
    existing.updatedAt = new Date().toISOString();
  } else {
    db.knowledgeFiles.push({
      filename: finalName,
      displayName: repairFilename(finalName),
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId || '',
      source: 'upload',
      agentIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const isImageUpload = IMAGE_KNOWLEDGE_EXTS.test(ext) || mimeType.startsWith('image/');
  const isAudioUpload = AUDIO_KNOWLEDGE_EXTS.test(ext) || mimeType.startsWith('audio/');
  const entry: any = {
    id: finalName,
    name: repairFilename(finalName),
    displayName: repairFilename(finalName),
    type: 'file',
    kind: isImageUpload ? 'image' : isAudioUpload ? 'audio' : 'file',
    mimeType,
    size: formatSize(input.size || stats.size),
    rawSize: input.size || stats.size,
    path: dest,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  let extraction: KnowledgeExtractionResult = {
    content: null,
    method: 'unsupported',
    status: 'unsupported',
    warning: 'This file type has no supported text or visual extraction path yet.',
    failureKind: 'unsupported_format',
  };
  let extractedContent: string | null = null;

  // Extract supported document/media content so Lumi can retrieve it later.
  if (TEXT_KNOWLEDGE_EXTS.test(ext) || RTF_KNOWLEDGE_EXTS.test(ext) || EXTRACTABLE_KNOWLEDGE_EXTS.test(ext) || IMAGE_KNOWLEDGE_EXTS.test(ext) || AUDIO_KNOWLEDGE_EXTS.test(ext) || isAudioUpload) {
    extraction = isAudioUpload && !AUDIO_KNOWLEDGE_EXTS.test(ext)
      ? await extractAudioKnowledge(dest)
      : await extractKnowledgeFileContent(dest, userId);
    extractedContent = extraction.content;
    if (extractedContent) {
      entry.content = extractedContent.slice(0, 50000); // cap at 50KB for chat context
      entry.preview = extractedContent.slice(0, 1000);
      entry.extracted = true;
    }
  }
  entry.extractionStatus = extraction.status;
  entry.extractionMethod = extraction.method;
  entry.extractionWarning = extraction.warning;
  entry.extractionError = extraction.error;
  entry.extractionFailureKind = extraction.failureKind;
  entry.extractionProvider = extraction.provider;
  entry.extractionModel = extraction.model;

  // Personal files are ingested into personal memory; work files become org KB articles.
  if (scope.domain === 'work') {
    try {
      const meta = findFileMeta(db, finalName, scope);
      if (meta) applyExtractionMeta(meta, extraction, extractedContent);
      if (extractedContent?.trim()) {
        const article = await ensureOrgArticleFromFile(scope, userId, finalName, extractedContent, meta?.orgArticleId, extraction.sourceMetadata);
        const manifest = article?.id && scope.orgId
          ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
          : null;
        if (meta) {
          if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
          meta.orgArticleId = article?.id;
          meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
          if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
          if (manifest) applyIngestionManifest(meta, manifest);
        }
        entry.orgArticleId = article?.id;
        entry.ingested = true;
        entry.partial = extraction.status === 'partial';
        if (manifest) {
          entry.ingestionStatus = manifest.status;
          entry.ingestionManifestId = manifest.manifestId;
          entry.ingestionCoverage = manifest.coverage;
        }
      } else if (meta) {
        const manifest = buildNonIndexedManifest(dest, extraction);
        meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
        applyIngestionManifest(meta, manifest);
        entry.ingestionStatus = manifest.status;
        entry.ingestionManifestId = manifest.manifestId;
        entry.ingestionCoverage = manifest.coverage;
        entry.syncError = extraction.error || extraction.warning || 'No extractable content found';
      }
    } catch (orgErr: any) {
      console.warn(`[OrgKB] Failed to sync "${finalName}": ${orgErr.message}`);
      entry.syncError = orgErr.message;
    }
  } else if (extractedContent?.trim()) {
    try {
      const result = await ingestDocument(userId, 'lumi', finalName, extractedContent, {
        filePath: dest,
        domain: scope.domain,
        orgId: scope.orgId || '',
        sourceMetadata: extraction.sourceMetadata,
        extraction,
      });
      const meta = findFileMeta(db, finalName, scope);
      if (meta) {
        if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
        if (!meta.agentIds.includes('lumi')) meta.agentIds.push('lumi');
        meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
        applyExtractionMeta(meta, extraction, extractedContent);
        applyIngestionManifest(meta, result.manifest);
      }
      entry.ingested = true;
      entry.partial = extraction.status === 'partial';
      console.log(`[AutoIngest] "${finalName}" -> ${result.chunkCount} chunks`);
    } catch (ingestErr: any) {
      console.warn(`[AutoIngest] Failed for "${finalName}": ${ingestErr.message}`);
      const meta = findFileMeta(db, finalName, scope);
      if (meta) {
        meta.status = 'failed';
        meta.extractionError = ingestErr.message;
      }
      entry.syncError = ingestErr.message;
    }
  } else {
    const meta = findFileMeta(db, finalName, scope);
    if (meta) {
      applyExtractionMeta(meta, extraction, extractedContent);
      const manifest = buildNonIndexedManifest(dest, extraction);
      meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
      applyIngestionManifest(meta, manifest);
      entry.ingestionStatus = manifest.status;
      entry.ingestionManifestId = manifest.manifestId;
      entry.ingestionCoverage = manifest.coverage;
      entry.syncError = extraction.error || extraction.warning || 'No extractable content found';
    }
  }

  return entry;
}

function resolveLocalImportPath(value: unknown): string {
  let raw = String(value || '').trim();
  if (!raw) {
    const err: any = new Error('File path is required');
    err.status = 400;
    throw err;
  }
  if (/^file:\/\//i.test(raw)) {
    raw = decodeURIComponent(raw.replace(/^file:\/\/\/?/i, ''));
  }
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    const err: any = new Error('File not found');
    err.status = 404;
    throw err;
  }
  return fs.realpathSync.native(resolved);
}

function stableHash(value: string, length = 12): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function obsidianSettingsKey(userId: string, scope: FileScope): string {
  return `obsidian_vaults:${userId}:${scope.domain}:${scope.orgId || 'personal'}`;
}

function readObsidianVaults(db: any, userId: string, scope: FileScope): ObsidianVaultConfig[] {
  const key = obsidianSettingsKey(userId, scope);
  const row = (db.settings || []).find((s: any) => s.key === key);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter(v => v?.id && v?.path) : [];
  } catch {
    return [];
  }
}

function writeObsidianVaults(db: any, userId: string, scope: FileScope, vaults: ObsidianVaultConfig[]): void {
  if (!db.settings) db.settings = [];
  const key = obsidianSettingsKey(userId, scope);
  const value = JSON.stringify(vaults);
  const idx = db.settings.findIndex((s: any) => s.key === key);
  if (idx >= 0) db.settings[idx].value = value;
  else db.settings.push({ key, value });
}

function resolveObsidianVaultPath(value: unknown): { path: string; isObsidianVault: boolean } {
  const resolved = resolveLocalImportPath(value);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    const err: any = new Error('Obsidian vault path must be a folder');
    err.status = 400;
    throw err;
  }
  return {
    path: resolved,
    isObsidianVault: fs.existsSync(path.join(resolved, '.obsidian')),
  };
}

function defaultObsidianVaultName(vaultPath: string): string {
  return repairFilename(path.basename(vaultPath)) || 'Obsidian Vault';
}

function makeObsidianVaultId(userId: string, scope: FileScope, vaultPath: string): string {
  return `obs_${stableHash(`${userId}|${scope.domain}|${scope.orgId || ''}|${vaultPath}`, 16)}`;
}

function upsertObsidianVault(
  db: any,
  userId: string,
  scope: FileScope,
  input: { vaultPath: string; name?: string },
): ObsidianVaultConfig {
  const resolved = resolveObsidianVaultPath(input.vaultPath);
  const now = new Date().toISOString();
  const vaults = readObsidianVaults(db, userId, scope);
  const id = makeObsidianVaultId(userId, scope, resolved.path);
  const existing = vaults.find(v => v.id === id || v.path === resolved.path);
  const name = String(input.name || existing?.name || defaultObsidianVaultName(resolved.path)).trim();
  const vault: ObsidianVaultConfig = {
    ...(existing || {}),
    id,
    userId,
    domain: scope.domain,
    orgId: scope.orgId || '',
    name,
    path: resolved.path,
    enabled: true,
    isObsidianVault: resolved.isObsidianVault,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const next = existing
    ? vaults.map(v => (v.id === existing.id ? vault : v))
    : [...vaults, vault];
  writeObsidianVaults(db, userId, scope, next);
  return vault;
}

function scanObsidianVault(vaultPath: string, maxFiles = OBSIDIAN_DEFAULT_MAX_FILES): {
  notes: ObsidianNoteFile[];
  skipped: Array<{ path: string; error: string }>;
  truncated: boolean;
} {
  const limit = Math.max(1, Math.min(Math.floor(Number(maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES), OBSIDIAN_HARD_MAX_FILES));
  const root = fs.realpathSync.native(vaultPath);
  const notes: ObsidianNoteFile[] = [];
  const skipped: Array<{ path: string; error: string }> = [];
  let truncated = false;

  const walk = (dir: string) => {
    if (notes.length >= limit) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
      skipped.push({ path: path.relative(root, dir) || '.', error: err?.message || String(err) });
      return;
    }
    for (const entry of entries) {
      if (notes.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (OBSIDIAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !OBSIDIAN_NOTE_EXTS.test(entry.name)) continue;
      const relativePath = path.relative(root, full).replace(/\\/g, '/');
      try {
        const stat = fs.statSync(full);
        if (stat.size > OBSIDIAN_MAX_NOTE_BYTES) {
          skipped.push({ path: relativePath, error: `Note is larger than ${formatSize(OBSIDIAN_MAX_NOTE_BYTES)}` });
          continue;
        }
        notes.push({
          absolutePath: full,
          relativePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch (err: any) {
        skipped.push({ path: relativePath, error: err?.message || String(err) });
      }
    }
  };

  walk(root);
  notes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { notes, skipped, truncated };
}

function obsidianDestinationName(vault: ObsidianVaultConfig, relativePath: string): string {
  const parsed = path.posix.parse(relativePath.replace(/\\/g, '/'));
  const folder = parsed.dir ? `${parsed.dir.replace(/[\\/]+/g, ' - ')} - ` : '';
  const readable = sanitizeKnowledgeFilename(`${folder}${parsed.name}`, 'note')
    .replace(/\s+/g, ' ')
    .slice(0, 110)
    .trim() || 'note';
  const vaultSlug = sanitizeKnowledgeFilename(vault.name || defaultObsidianVaultName(vault.path), 'obsidian')
    .replace(/\s+/g, ' ')
    .slice(0, 48)
    .trim() || 'obsidian';
  const hash = stableHash(`${vault.path}|${relativePath}`, 10);
  return sanitizeKnowledgeFilename(`${vaultSlug} - ${readable} [obsidian-${hash}].md`, `${hash}.md`);
}

function removeExistingFileMemories(db: any, filename: string, scope: FileScope, options: { userId?: string; agentId?: string } = {}): void {
  const existing = findExistingFileMemories(db, filename, scope, options);
  if (existing.length === 0) return;
  const ids = new Set(existing.map((m: any) => m.id));
  db.memories = (db.memories || []).filter((m: any) => !ids.has(m.id));
}

async function syncObsidianNote(
  vault: ObsidianVaultConfig,
  note: ObsidianNoteFile,
  userId: string,
  scope: FileScope,
  db: any,
): Promise<{ status: 'synced' | 'skipped'; file?: any }> {
  const finalName = obsidianDestinationName(vault, note.relativePath);
  const dest = path.join(scope.dir, finalName);
  const existingMemories = scope.domain === 'personal'
    ? findExistingFileMemories(db, finalName, scope, { userId, agentId: 'lumi' })
    : [];
  if (fs.existsSync(dest)) {
    const destStat = fs.statSync(dest);
    const unchanged = destStat.mtimeMs >= note.mtimeMs - 1000
      && (scope.domain === 'work' || existingMemories.length > 0);
    if (unchanged) {
      const meta = findFileMeta(db, finalName, scope);
      const agentIds = Array.isArray(meta?.agentIds) && meta.agentIds.length > 0
        ? meta.agentIds
        : scope.domain === 'work' ? ['org-kb'] : ['lumi'];
      return { status: 'skipped', file: buildEntry(finalName, 'obsidian', agentIds, scope, meta?.status || 'indexed', meta) };
    }
  }

  fs.copyFileSync(note.absolutePath, dest);
  const sourceStat = fs.statSync(note.absolutePath);
  try { fs.utimesSync(dest, sourceStat.atime, sourceStat.mtime); } catch {}

  if (!db.knowledgeFiles) db.knowledgeFiles = [];
  let meta = findFileMeta(db, finalName, scope);
  if (!meta) {
    meta = {
      filename: finalName,
      displayName: repairFilename(finalName),
      userId: scope.userId,
      domain: scope.domain,
      orgId: scope.orgId || '',
      source: 'obsidian',
      agentIds: [],
      createdAt: new Date().toISOString(),
    };
    db.knowledgeFiles.push(meta);
  }
  if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
  meta.source = 'obsidian';
  meta.obsidianVaultId = vault.id;
  meta.obsidianVaultName = vault.name;
  meta.obsidianVaultPath = vault.path;
  meta.obsidianRelativePath = note.relativePath;
  meta.obsidianSourcePath = note.absolutePath;
  meta.updatedAt = new Date().toISOString();

  const extraction = extractTextKnowledge(dest);
  const content = extraction.content || '';
  applyExtractionMeta(meta, extraction, content);

  if (scope.domain === 'work') {
    const article = await ensureOrgArticleFromFile(scope, userId, finalName, content, meta.orgArticleId, extraction.sourceMetadata);
    meta.orgArticleId = article?.id;
    if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
    meta.status = 'indexed';
    const manifest = article?.id && scope.orgId
      ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
      : null;
    if (manifest) applyIngestionManifest(meta, manifest);
  } else {
    removeExistingFileMemories(db, finalName, scope, { userId, agentId: 'lumi' });
    const result = await ingestDocument(userId, 'lumi', finalName, content, {
      filePath: dest,
      domain: scope.domain,
      orgId: scope.orgId || '',
      sourceMetadata: extraction.sourceMetadata,
      extraction,
    });
    if (!meta.agentIds.includes('lumi')) meta.agentIds.push('lumi');
    meta.status = 'indexed';
    meta.chunkCount = result.chunkCount;
    applyIngestionManifest(meta, result.manifest);
  }

  return { status: 'synced', file: buildEntry(finalName, 'obsidian', meta.agentIds, scope, meta.status, meta) };
}

async function syncObsidianVault(
  vault: ObsidianVaultConfig,
  userId: string,
  scope: FileScope,
  db: any,
  options: { maxFiles?: number } = {},
): Promise<{
  vault: ObsidianVaultConfig;
  noteCount: number;
  synced: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  files: any[];
  errors: Array<{ path: string; error: string }>;
}> {
  const scan = scanObsidianVault(vault.path, options.maxFiles);
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const files: any[] = [];
  const errors = [...scan.skipped];

  for (const note of scan.notes) {
    try {
      const result = await syncObsidianNote(vault, note, userId, scope, db);
      if (result.status === 'synced') synced++;
      else skipped++;
      if (result.file) files.push(result.file);
    } catch (err: any) {
      failed++;
      errors.push({ path: note.relativePath, error: err?.message || String(err) });
    }
  }

  const now = new Date().toISOString();
  vault.lastScanAt = now;
  vault.lastSyncAt = now;
  vault.lastNoteCount = scan.notes.length;
  vault.lastSyncResult = { synced, skipped, failed, noteCount: scan.notes.length };
  vault.updatedAt = now;

  return {
    vault,
    noteCount: scan.notes.length,
    synced,
    skipped,
    failed,
    truncated: scan.truncated,
    files,
    errors,
  };
}

function sendRouteError(res: Response, err: any, fallbackStatus = 400): void {
  res.status(err?.status || fallbackStatus).json({ error: err?.message || 'Request failed' });
}

function buildEntry(filename: string, source: KnowledgeFileSource, agentIds: string[] = [], scope: FileScope, status?: KnowledgeStatus, meta?: any): KnowledgeEntry {
  const filePath = path.join(scope.dir, filename);
  const displayName = repairFilename(filename);
  let st: fs.Stats;
  try { st = fs.statSync(filePath); }
  catch { st = { size: 0, mtime: new Date(), birthtime: new Date() } as fs.Stats; }
  const currentManifest = readCurrentIngestionManifest(meta);
  return {
    id: filename,
    name: displayName,
    displayName,
    path: filePath,
    domain: scope.domain,
    orgId: scope.orgId,
    size: formatSize(st.size),
    rawSize: st.size,
    type: 'file',
    source,
    agentIds,
    status: status || (agentIds.length > 0 ? 'indexed' : 'ready'),
    extractionStatus: meta?.extractionStatus,
    extractionMethod: meta?.extractionMethod,
    extractionWarning: meta?.extractionWarning || undefined,
    extractionError: meta?.extractionError || undefined,
    extractionFailureKind: meta?.extractionFailureKind || undefined,
    extractionProvider: meta?.extractionProvider || undefined,
    extractionModel: meta?.extractionModel || undefined,
    contentChars: meta?.contentChars || undefined,
    ingestionStatus: currentManifest?.status || meta?.ingestionStatus || (meta?.status === 'indexed' ? 'indexed_unverified' : undefined),
    ingestionManifestId: meta?.ingestionManifestId || undefined,
    ingestionCoverage: currentManifest?.coverage || meta?.ingestionCoverage || undefined,
    sourceTitle: meta?.sourceTitle || undefined,
    sourceAliases: Array.isArray(meta?.sourceAliases) ? meta.sourceAliases : undefined,
    sourceTags: Array.isArray(meta?.sourceTags) ? meta.sourceTags : undefined,
    sourceLinks: Array.isArray(meta?.sourceLinks) ? meta.sourceLinks : undefined,
    sourceBacklinks: Array.isArray(meta?.sourceBacklinks) ? meta.sourceBacklinks : undefined,
    sourceProperties: meta?.sourceProperties || undefined,
    obsidianVaultId: meta?.obsidianVaultId || undefined,
    obsidianVaultName: meta?.obsidianVaultName || undefined,
    obsidianVaultPath: meta?.obsidianVaultPath || undefined,
    obsidianRelativePath: meta?.obsidianRelativePath || undefined,
    obsidianSourcePath: meta?.obsidianSourcePath || undefined,
    updatedAt: st.mtime.toISOString(),
    createdAt: st.birthtime.toISOString(),
  };
}

// ── GET /files/list — list knowledge base files ──
function fileMemoryMatchesScope(memory: any, scope: FileScope): boolean {
  const domain = memory?.domain || 'personal';
  const orgId = memory?.orgId || '';
  return domain === scope.domain && orgId === (scope.orgId || '');
}

function fileMemoryMatchesName(memory: any, filename: string): boolean {
  const target = filename.normalize('NFC').toLowerCase();
  const source = String(memory?.sourceInteractionId || '');
  const sourceBase = source ? path.basename(source).normalize('NFC').toLowerCase() : '';
  if (sourceBase === target) return true;

  const keywords = Array.isArray(memory?.keywords) ? memory.keywords : [];
  if (keywords.some((kw: any) => String(kw || '').normalize('NFC').toLowerCase() === `source:${target}`)) return true;

  return String(memory?.content || '').normalize('NFC').startsWith(`[${filename} #`);
}

function findExistingFileMemories(
  db: any,
  filename: string,
  scope: FileScope,
  options: { userId?: string; agentId?: string } = {},
): any[] {
  return (db.memories || []).filter((memory: any) => {
    if (memory?.type !== 'knowledge') return false;
    if (options.userId && memory.userId !== options.userId) return false;
    if (options.agentId && (memory.agentId || '') !== options.agentId) return false;
    return fileMemoryMatchesScope(memory, scope) && fileMemoryMatchesName(memory, filename);
  });
}

function removeFileMemoryReferences(db: any, filename: string, scope: FileScope): number {
  if (scope.domain !== 'personal') return 0;
  const ids = new Set(
    findExistingFileMemories(db, filename, scope, { userId: scope.userId })
      .map((memory: any) => memory.id)
      .filter(Boolean),
  );
  if (ids.size === 0) return 0;
  db.memories = (db.memories || []).filter((memory: any) => !ids.has(memory.id));
  return ids.size;
}

function renameFileMemoryReferences(
  db: any,
  oldName: string,
  newName: string,
  newPath: string,
  scope: FileScope,
): number {
  if (scope.domain !== 'personal') return 0;
  const memories = findExistingFileMemories(db, oldName, scope, { userId: scope.userId });
  const normalizedOldName = oldName.normalize('NFC').toLowerCase();
  const oldSourceKeyword = `source:${oldName}`.normalize('NFC').toLowerCase();
  for (const memory of memories) {
    const content = String(memory.content || '');
    if (content.startsWith(`[${oldName} #`)) {
      memory.content = `[${newName} #${content.slice(oldName.length + 3)}`;
    }
    memory.keywords = (Array.isArray(memory.keywords) ? memory.keywords : []).map((keyword: unknown) => {
      const value = String(keyword || '');
      const normalized = value.normalize('NFC').toLowerCase();
      if (normalized === normalizedOldName) return newName;
      if (normalized === oldSourceKeyword) return `source:${newName}`;
      return value;
    });
    memory.sourceInteractionId = newPath;
    memory.updatedAt = new Date().toISOString();
  }
  return memories.length;
}

function normalizedKnowledgeFileKeys(filename: string): string[] {
  const repaired = repairFilename(filename);
  const stem = path.basename(repaired, path.extname(repaired));
  return [
    normalizeKnowledgeLinkTarget(repaired),
    normalizeKnowledgeLinkTarget(stem),
  ].filter(Boolean);
}

function buildSourceBacklinkMap(metaByName: Record<string, any>, filenames: string[]): Map<string, string[]> {
  const filenameByKey = new Map<string, string>();
  for (const filename of filenames) {
    for (const key of normalizedKnowledgeFileKeys(filename)) {
      if (!filenameByKey.has(key)) filenameByKey.set(key, filename);
    }
  }

  const backlinks = new Map<string, Set<string>>();
  for (const sourceName of filenames) {
    const meta = metaByName[sourceName];
    const links = Array.isArray(meta?.sourceLinks) ? meta.sourceLinks : [];
    for (const link of links) {
      const targetName = filenameByKey.get(normalizeKnowledgeLinkTarget(link));
      if (!targetName || targetName === sourceName) continue;
      if (!backlinks.has(targetName)) backlinks.set(targetName, new Set());
      backlinks.get(targetName)!.add(repairFilename(sourceName));
    }
  }

  return new Map([...backlinks.entries()].map(([filename, sources]) => [filename, [...sources].sort()]));
}

function getSourceBacklinks(db: any, scope: FileScope, filename: string): string[] {
  const scopedMeta: Record<string, any> = {};
  const names = fs.existsSync(scope.dir)
    ? fs.readdirSync(scope.dir).filter(name => !name.startsWith('.') && !name.startsWith('_'))
    : [];
  for (const m of db.knowledgeFiles || []) {
    if (metaMatchesScope(m, scope)) scopedMeta[m.filename] = m;
  }
  return buildSourceBacklinkMap(scopedMeta, names).get(filename) || [];
}

router.get('/files/list', (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const db = readDB();
    const fileMeta: Record<string, any> = {};
    if (db.knowledgeFiles) {
      for (const m of db.knowledgeFiles) {
        if (!metaMatchesScope(m, scope)) continue;
        fileMeta[m.filename] = m;
      }
    }

    const entries = fs.readdirSync(scope.dir);
    const visibleNames = entries.filter(name => !name.startsWith('.') && !name.startsWith('_'));
    const backlinkMap = buildSourceBacklinkMap(fileMeta, visibleNames);
    const files: KnowledgeEntry[] = [];
    for (const name of entries) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const inferredMemories = findExistingFileMemories(
        db,
        name,
        scope,
        scope.domain === 'personal' ? { userId: scope.userId } : {},
      );
      const inferredAgentIds = [...new Set(inferredMemories.map((m: any) => String(m.agentId || '').trim()).filter(Boolean))];
      const meta = {
        ...(fileMeta[name] || { source: 'upload' as const, agentIds: [] as string[] }),
        agentIds: [...new Set([...(fileMeta[name]?.agentIds || []), ...inferredAgentIds])],
        sourceBacklinks: backlinkMap.get(name) || [],
      };
      if (inferredMemories.length > 0 && (!meta.status || meta.status === 'ready' || meta.status === 'failed')) {
        meta.status = 'indexed';
      }
      const source = (meta.source as KnowledgeFileSource) || 'upload';
      files.push(buildEntry(name, source, meta.agentIds, scope, meta.status, meta));
    }

    files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json({ files });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});

// ── Obsidian vault connection and sync ──
router.get('/files/obsidian/status', requireAuth, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    const db = readDB();
    const vaults = readObsidianVaults(db, userId, scope).map(vault => {
      const exists = fs.existsSync(vault.path);
      const isDirectory = exists && fs.statSync(vault.path).isDirectory();
      const isObsidianVault = isDirectory && fs.existsSync(path.join(vault.path, '.obsidian'));
      let noteCount = vault.lastNoteCount || 0;
      if (isDirectory && req.query.scan === '1') {
        try {
          noteCount = scanObsidianVault(vault.path, Number(req.query.maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES).notes.length;
        } catch {}
      }
      return {
        ...vault,
        exists,
        isDirectory,
        isObsidianVault,
        noteCount,
      };
    });
    res.json({ success: true, vaults });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});

router.post('/files/obsidian/connect', requireAuth, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const { vaultPath, name } = req.body || {};
    if (!vaultPath) return res.status(400).json({ error: 'vaultPath is required' });
    const db = readDB();
    const vault = upsertObsidianVault(db, userId, scope, { vaultPath, name });
    const scan = scanObsidianVault(vault.path, Number(req.body?.maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES);
    vault.lastScanAt = new Date().toISOString();
    vault.lastNoteCount = scan.notes.length;
    writeObsidianVaults(db, userId, scope, readObsidianVaults(db, userId, scope).map(v => v.id === vault.id ? vault : v));
    writeDB(db);
    res.json({
      success: true,
      vault,
      noteCount: scan.notes.length,
      skipped: scan.skipped,
      truncated: scan.truncated,
      warning: vault.isObsidianVault ? undefined : 'This folder has no .obsidian directory; Lumi will treat it as a Markdown notes folder.',
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

router.post('/files/obsidian/sync', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readDB();
    const vaultId = String(req.body?.vaultId || req.query.vaultId || '').trim();
    const vaults = readObsidianVaults(db, userId, scope);
    const targets = vaultId
      ? vaults.filter(v => v.id === vaultId)
      : vaults.filter(v => v.enabled !== false);
    if (targets.length === 0) {
      return res.status(404).json({ error: vaultId ? 'Obsidian vault not found' : 'No enabled Obsidian vault is connected' });
    }

    const results = [];
    const updatedVaults = [...vaults];
    for (const vault of targets) {
      const sync = await syncObsidianVault(vault, userId, scope, db, {
        maxFiles: Number(req.body?.maxFiles) || OBSIDIAN_DEFAULT_MAX_FILES,
      });
      const idx = updatedVaults.findIndex(v => v.id === vault.id);
      if (idx >= 0) updatedVaults[idx] = sync.vault;
      results.push(sync);
    }
    writeObsidianVaults(db, userId, scope, updatedVaults);
    writeDB(db);

    res.json({
      success: true,
      results,
      synced: results.reduce((sum, item) => sum + item.synced, 0),
      skipped: results.reduce((sum, item) => sum + item.skipped, 0),
      failed: results.reduce((sum, item) => sum + item.failed, 0),
      files: results.flatMap(item => item.files),
      errors: results.flatMap(item => item.errors),
    });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});

router.delete('/files/obsidian/:id', requireAuth, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readDB();
    const vaults = readObsidianVaults(db, userId, scope);
    const next = vaults.filter(v => v.id !== req.params.id);
    if (next.length === vaults.length) return res.status(404).json({ error: 'Obsidian vault not found' });
    writeObsidianVaults(db, userId, scope, next);
    writeDB(db);
    res.json({ success: true });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── POST /files/upload — upload files + auto-ingest into Lumi's memory ──
router.post('/files/upload', requireAuth, upload.array('files', MAX_UPLOAD_FILES), async (req: Request, res: Response) => {
  try {
    const uploadedFiles = req.files as Express.Multer.File[];
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readDB();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];

    const saved: any[] = [];
    for (const file of uploadedFiles) {
      saved.push(await saveKnowledgeFile({
        sourcePath: file.path,
        originalName: file.originalname,
        size: file.size,
        mimeType: file.mimetype || '',
        move: true,
      }, userId, scope, db));
    }
    writeDB(db);
    res.json({ success: true, files: saved });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── POST /files/import-paths — import local files dropped into the desktop widget ──
router.post('/files/import-paths', requireUnifiedAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const requestedPaths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const uniquePaths: string[] = [...new Set<string>(
      requestedPaths.map((p: unknown) => String(p || '').trim()).filter(Boolean),
    )].slice(0, MAX_UPLOAD_FILES);
    if (uniquePaths.length === 0) {
      return res.status(400).json({ error: 'No file paths provided' });
    }

    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const db = readDB();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];

    const saved: any[] = [];
    const skipped: Array<{ path: string; error: string }> = [];
    for (const rawPath of uniquePaths) {
      try {
        const sourcePath = resolveLocalImportPath(rawPath);
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) {
          skipped.push({ path: rawPath, error: 'Only files can be imported' });
          continue;
        }
        if (stat.size > MAX_UPLOAD_BYTES) {
          skipped.push({ path: rawPath, error: 'File is larger than 500 MB' });
          continue;
        }
        saved.push(await saveKnowledgeFile({
          sourcePath,
          originalName: path.basename(sourcePath),
          size: stat.size,
          mimeType: getDownloadMime(sourcePath) || '',
          move: false,
        }, userId, scope, db));
      } catch (err: any) {
        skipped.push({ path: rawPath, error: err?.message || String(err) });
      }
    }

    if (saved.length === 0) {
      return res.status(400).json({ error: skipped[0]?.error || 'No files imported', skipped });
    }

    writeDB(db);
    res.json({ success: true, files: saved, skipped });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── POST /files/save — save generated content as a file ──
router.post('/files/save', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, content } = req.body;
    if (!name || content === undefined) return res.status(400).json({ error: 'name and content required' });

    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const safeName = sanitizeKnowledgeFilename(name);
    const contentText = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const filePath = path.join(scope.dir, safeName);
    fs.writeFileSync(filePath, contentText, 'utf-8');

    const db = readDB();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];
    const existing = findFileMeta(db, safeName, scope);
    if (existing) {
      existing.source = 'generated';
      existing.domain = scope.domain;
      existing.orgId = scope.orgId || '';
      existing.userId = scope.domain === 'personal' ? scope.userId : existing.userId;
      existing.updatedAt = new Date().toISOString();
    } else {
      db.knowledgeFiles.push({
        filename: safeName,
        displayName: repairFilename(safeName),
        userId: scope.userId,
        domain: scope.domain,
        orgId: scope.orgId || '',
        source: 'generated',
        agentIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const meta = findFileMeta(db, safeName, scope);
    const generatedExtraction = extractGeneratedTextKnowledge(safeName, contentText);
    const generatedKnowledgeContent = generatedExtraction.content || contentText;
    if (meta) applyExtractionMeta(meta, generatedExtraction, generatedKnowledgeContent);
    let orgArticleId: string | undefined;
    if (scope.domain === 'work') {
      const article = await ensureOrgArticleFromFile(scope, userId, safeName, generatedKnowledgeContent, meta?.orgArticleId, generatedExtraction.sourceMetadata);
      orgArticleId = article?.id;
      if (meta) {
        if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
        meta.orgArticleId = orgArticleId;
        meta.status = 'indexed';
        if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
        const manifest = article?.id && scope.orgId
          ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
          : null;
        if (manifest) applyIngestionManifest(meta, manifest);
      }
    } else if (meta) {
      try {
        const result = await ingestDocument(userId, 'lumi', safeName, generatedKnowledgeContent, {
          filePath,
          domain: scope.domain,
          orgId: scope.orgId || '',
          sourceMetadata: generatedExtraction.sourceMetadata,
          extraction: generatedExtraction,
        });
        if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
        if (!meta.agentIds.includes('lumi')) meta.agentIds.push('lumi');
        meta.status = 'indexed';
        applyExtractionMeta(meta, generatedExtraction, generatedKnowledgeContent);
        applyIngestionManifest(meta, result.manifest);
        console.log(`[AutoIngest] "${safeName}" -> ${result.chunkCount} chunks`);
      } catch (ingestErr: any) {
        console.warn(`[AutoIngest] Failed for generated "${safeName}": ${ingestErr.message}`);
      }
    }
    writeDB(db);

    res.json({ success: true, filename: safeName, orgArticleId, entry: buildEntry(safeName, 'generated', meta?.agentIds || [], scope, meta?.status, meta) });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── GET /files/generated?path=... — download a generated work artifact ──
router.get('/files/generated', requireUnifiedAuth, requireUnifiedAdmin, requireUnifiedLocalRequest, (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const filePath = resolveGeneratedDownloadPath(req.query.path);
    const fileName = path.basename(filePath);
    const mime = getDownloadMime(filePath);
    if (mime) res.setHeader('Content-Type', mime);
    const inline = req.query.inline === '1';
    const disposition = inline ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// Open a knowledge/generated file with the OS default application.
router.post('/files/open', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const id = req.body?.id || req.query.id;
    const rawPath = req.body?.path || req.query.path;
    if (!id && getAuthPayload(req)?.role !== 'admin') {
      return res.status(403).json({ error: 'Generated artifacts may be opened only by the local Lumi administrator.' });
    }
    const filePath = id
      ? resolveKnowledgeFilePath(req, id)
      : resolveGeneratedDownloadPath(rawPath);
    await openPathWithDefaultApp(filePath);
    res.json({ success: true, path: filePath, fileName: repairFilename(path.basename(filePath)) });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── GET /files/download/:id — download or preview a file ──
router.get('/files/download/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!safeName || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(safeName).toLowerCase();
    const mime = getDownloadMime(ext);
    if (mime) res.setHeader('Content-Type', mime);

    const inline = req.query.inline === '1';
    if (inline) {
      res.setHeader('Content-Disposition', 'inline');
    } else {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(repairFilename(safeName))}`);
    }
    fs.createReadStream(filePath).pipe(res);
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── GET /files/open-folder/:id — open the file's containing folder in the OS ──
router.get('/files/open-folder', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const scope = getFileScope(req);
    const folder = path.resolve(scope.dir);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    await openPathWithDefaultApp(folder);
    res.json({ success: true, path: folder });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

router.get('/files/open-folder/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    assertLocalHostRequest(req);
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!safeName || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

    const folder = path.resolve(path.dirname(filePath));
    await openPathWithDefaultApp(folder);
    res.json({ success: true, path: folder });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── DELETE /files/delete/:id ──
router.delete('/files/delete/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope, scope.domain === 'work');
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!safeName || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const db = readDB();
    const meta = findFileMeta(db, safeName, scope);
    const removedMemoryCount = removeFileMemoryReferences(db, safeName, scope);
    fs.unlinkSync(filePath);
    if (db.knowledgeFiles) {
      removeFileMeta(db, safeName, scope);
    }
    writeDB(db);
    const removedOrgArticle = scope.domain === 'work' && scope.orgId && meta?.orgArticleId
      ? OrgKB.deleteArticle(scope.orgId, scope.userId, meta.orgArticleId)
      : false;
    res.json({ success: true, removedMemoryCount, removedOrgArticle });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── POST /files/rename ──
router.post('/files/rename', requireAuth, (req: Request, res: Response) => {
  try {
    const { id, newName } = req.body;
    if (!id || !newName) return res.status(400).json({ error: 'id and newName required' });

    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const oldPath = path.join(scope.dir, path.basename(id));
    const safeNewName = sanitizeKnowledgeFilename(newName);
    const newPath = path.join(scope.dir, safeNewName);

    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Not found' });
    if (fs.existsSync(newPath)) return res.status(409).json({ error: 'Name already taken' });

    fs.renameSync(oldPath, newPath);

    const db = readDB();
    const oldName = path.basename(id);
    const renamedMemoryCount = renameFileMemoryReferences(db, oldName, safeNewName, newPath, scope);
    let orgArticleId = '';
    if (db.knowledgeFiles) {
      const meta = findFileMeta(db, oldName, scope);
      if (meta) {
        meta.filename = safeNewName;
        meta.displayName = repairFilename(safeNewName);
        meta.updatedAt = new Date().toISOString();
        orgArticleId = String(meta.orgArticleId || '');
      }
    }
    writeDB(db);
    if (scope.domain === 'work' && scope.orgId && orgArticleId) {
      OrgKB.updateArticle(scope.orgId, scope.userId, orgArticleId, { title: repairFilename(safeNewName) });
    }
    res.json({
      success: true,
      id: safeNewName,
      name: repairFilename(safeNewName),
      displayName: repairFilename(safeNewName),
      renamedMemoryCount,
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── GET /files/info/:id ──
router.get('/files/info/:id', (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const filePath = path.join(scope.dir, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const st = fs.statSync(filePath);
    const db = readDB();
    const meta = findFileMeta(db, safeName, scope);
    const currentManifest = readCurrentIngestionManifest(meta);
    res.json({
      id: safeName,
      name: repairFilename(safeName),
      displayName: repairFilename(safeName),
      domain: scope.domain,
      orgId: scope.orgId,
      size: st.size,
      formattedSize: formatSize(st.size),
      type: 'file',
      source: meta?.source || 'upload',
      agentIds: meta?.agentIds || [],
      status: meta?.status || ((meta?.agentIds || []).length > 0 ? 'indexed' : 'ready'),
      extractionStatus: meta?.extractionStatus,
      extractionMethod: meta?.extractionMethod,
      extractionWarning: meta?.extractionWarning || undefined,
      extractionError: meta?.extractionError || undefined,
      extractionFailureKind: meta?.extractionFailureKind || undefined,
      extractionProvider: meta?.extractionProvider || undefined,
      extractionModel: meta?.extractionModel || undefined,
      contentChars: meta?.contentChars || undefined,
      ingestionStatus: currentManifest?.status || meta?.ingestionStatus || (meta?.status === 'indexed' ? 'indexed_unverified' : undefined),
      ingestionManifestId: meta?.ingestionManifestId || undefined,
      ingestionCoverage: currentManifest?.coverage || meta?.ingestionCoverage || undefined,
      sourceTitle: meta?.sourceTitle || undefined,
      sourceAliases: Array.isArray(meta?.sourceAliases) ? meta.sourceAliases : undefined,
      sourceTags: Array.isArray(meta?.sourceTags) ? meta.sourceTags : undefined,
      sourceLinks: Array.isArray(meta?.sourceLinks) ? meta.sourceLinks : undefined,
      sourceBacklinks: getSourceBacklinks(db, scope, safeName),
      sourceProperties: meta?.sourceProperties || undefined,
      obsidianVaultId: meta?.obsidianVaultId || undefined,
      obsidianVaultName: meta?.obsidianVaultName || undefined,
      obsidianVaultPath: meta?.obsidianVaultPath || undefined,
      obsidianRelativePath: meta?.obsidianRelativePath || undefined,
      obsidianSourcePath: meta?.obsidianSourcePath || undefined,
      updatedAt: st.mtime.toISOString(),
      createdAt: meta?.createdAt || st.birthtime.toISOString(),
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

// ── Verifiable knowledge absorption: manifest + owner-supplied golden QA ──
router.get('/files/ingestion/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    const safeName = path.basename(req.params.id);
    const db = readDB();
    const meta = findFileMeta(db, safeName, scope);
    if (!meta) return res.status(404).json({ error: 'Knowledge file metadata not found' });
    const manifest = scope.domain === 'work' && scope.orgId && meta.orgArticleId
      ? OrgKB.getArticleIngestionManifest(scope.orgId, meta.orgArticleId)
      : readCurrentIngestionManifest(meta);
    if (!manifest) return res.status(404).json({ error: 'Knowledge ingestion manifest not found' });
    res.json({
      filename: safeName,
      domain: scope.domain,
      orgId: scope.orgId,
      agentIds: meta.agentIds || [],
      ingestionManifest: manifest,
    });
  } catch (err: any) {
    sendRouteError(res, err);
  }
});

router.post('/files/ingestion/:id/verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope, scope.domain === 'work');
    const cases = req.body?.cases;
    if (!Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ error: 'cases must contain at least one golden question with a reference answer and expected chunk indexes' });
    }
    const safeName = path.basename(req.params.id);
    const db = readDB();
    const meta = findFileMeta(db, safeName, scope);
    if (!meta) return res.status(404).json({ error: 'Knowledge file metadata not found' });

    let verified: KnowledgeIngestionManifest;
    if (scope.domain === 'work') {
      if (!scope.orgId || !meta.orgArticleId) {
        return res.status(409).json({ error: 'The work knowledge file is not linked to an indexed organization article' });
      }
      verified = await OrgKB.verifyArticleKnowledge(scope.orgId, meta.orgArticleId, scope.userId, cases);
    } else {
      const manifest = readCurrentIngestionManifest(meta);
      if (!manifest) return res.status(409).json({ error: 'Index the knowledge file before golden verification' });
      const filePath = path.join(scope.dir, safeName);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(409).json({ error: 'The source file is missing; the existing index cannot be verified' });
      }
      const extraction = await extractKnowledgeFileContent(filePath, scope.userId);
      if (!extraction.content?.trim() || hashKnowledgeContent(extraction.content) !== manifest.sourceRevision) {
        return res.status(409).json({ error: 'The source content changed after indexing; re-index it before golden verification' });
      }
      const agentIds = Array.isArray(meta.agentIds)
        ? meta.agentIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : [];
      const requestedAgentId = String(req.body?.agentId || '').trim();
      const agentId = requestedAgentId || (agentIds.includes('lumi') ? 'lumi' : agentIds[0]);
      if (!agentId || !agentIds.includes(agentId)) {
        return res.status(400).json({ error: 'agentId must identify an agent that indexed this exact file' });
      }
      verified = await verifyIngestedDocument(
        scope.userId,
        agentId,
        manifest,
        cases,
        { domain: 'personal', orgId: '' },
      );
    }

    const latestDb = readDB();
    const latestMeta = findFileMeta(latestDb, safeName, scope);
    if (!latestMeta) return res.status(409).json({ error: 'Knowledge file metadata changed during verification' });
    applyIngestionManifest(latestMeta, verified);
    writeDB(latestDb);
    res.json({
      success: true,
      ingestionStatus: verified.status,
      coverage: verified.coverage,
      retrieval: verified.retrieval,
      ingestionManifestId: verified.manifestId,
    });
  } catch (err: any) {
    sendRouteError(res, err, 400);
  }
});

// ── POST /files/ingest — chunk into agent memory (RAG) ──
router.post('/files/ingest', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const scope = getFileScope(req);
    assertKnowledgeWriteAccess(scope);
    const { fileId, agentId } = req.body;
    if (!fileId || !agentId) return res.status(400).json({ error: 'fileId and agentId required' });

    const safeName = path.basename(fileId);
    const filePath = path.join(scope.dir, safeName);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const extraction = await extractKnowledgeFileContent(filePath, userId);
    const content = extraction.content;

    // Mark as indexing
    const db = readDB();
    if (!db.knowledgeFiles) db.knowledgeFiles = [];
    let meta = findFileMeta(db, safeName, scope);
    if (!meta) {
      meta = {
        filename: safeName,
        displayName: repairFilename(safeName),
        userId: scope.userId,
        domain: scope.domain,
        orgId: scope.orgId || '',
        source: 'upload',
        agentIds: [],
        createdAt: new Date().toISOString(),
      };
      db.knowledgeFiles.push(meta);
    }
    if (!Array.isArray(meta.agentIds)) meta.agentIds = [];
    const existingMemories = scope.domain === 'personal'
      ? findExistingFileMemories(db, safeName, scope, { userId, agentId })
      : [];
    const canReuseExisting = existingMemories.length > 0
      && !['partial', 'failed'].includes(String(meta.status || meta.extractionStatus || ''));
    const expectedChunks = content?.trim() ? chunkText(content).length : 0;
    const hasCompleteExisting = canReuseExisting
      && (expectedChunks === 0 || existingMemories.length >= expectedChunks)
      && Boolean(content?.trim())
      && hasCurrentVerifiedManifest(meta, content!, existingMemories.map((memory: any) => String(memory.id || '')));
    if (hasCompleteExisting) {
      const currentManifest = readCurrentIngestionManifest(meta);
      if (currentManifest) applyIngestionManifest(meta, currentManifest);
      if (!meta.agentIds.includes(agentId)) meta.agentIds.push(agentId);
      meta.status = 'indexed';
      if (content?.trim()) applyExtractionMeta(meta, extraction, content);
      delete meta.indexingAt;
      writeDB(db);
      return res.json({
        success: true,
        reused: true,
        chunkCount: existingMemories.length,
        memoryIds: existingMemories.map((m: any) => m.id).filter(Boolean),
        extractionStatus: content?.trim() ? extraction.status : (meta.extractionStatus || 'indexed'),
        ingestionStatus: currentManifest?.status || 'indexed_unverified',
        ingestionManifestId: meta.ingestionManifestId,
      });
    }
    applyExtractionMeta(meta, extraction, content);
    if (!content || !content.trim()) {
      const manifest = buildNonIndexedManifest(filePath, extraction);
      meta.status = extraction.status === 'partial' ? 'partial' : extraction.status;
      applyIngestionManifest(meta, manifest);
      writeDB(db);
      return res.status(415).json({
        error: extraction.error || extraction.warning || 'This file type has no extractable text or visual content for Lumi to absorb',
        extractionStatus: extraction.status,
        extractionMethod: extraction.method,
        extractionFailureKind: extraction.failureKind,
        ingestionStatus: manifest.status,
        ingestionManifestId: manifest.manifestId,
        coverage: manifest.coverage,
      });
    }
    meta.indexingAt = new Date().toISOString();
    writeDB(db);

    if (scope.domain === 'work') {
      const article = await ensureOrgArticleFromFile(scope, userId, safeName, content, meta?.orgArticleId, extraction.sourceMetadata);
      if (!meta.agentIds.includes('org-kb')) meta.agentIds.push('org-kb');
      meta.orgArticleId = article?.id;
      meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
      applyExtractionMeta(meta, extraction, content);
      const manifest = article?.id && scope.orgId
        ? OrgKB.getArticleIngestionManifest(scope.orgId, article.id)
        : null;
      if (manifest) applyIngestionManifest(meta, manifest);
      delete meta.indexingAt;
      writeDB(db);
      res.json({
        success: true,
        orgArticleId: article?.id,
        memoryIds: [],
        extractionStatus: extraction.status,
        ingestionStatus: manifest?.status || 'indexed_unverified',
        ingestionManifestId: manifest?.manifestId,
        ingestionCoverage: manifest?.coverage,
      });
      return;
    }

    const result = await ingestDocument(userId, agentId, safeName, content, {
      filePath,
      domain: scope.domain,
      orgId: scope.orgId || '',
      sourceMetadata: extraction.sourceMetadata,
      extraction,
    });

    // Mark as indexed
    if (!meta.agentIds.includes(agentId)) meta.agentIds.push(agentId);
    meta.status = extraction.status === 'partial' ? 'partial' : 'indexed';
    applyExtractionMeta(meta, extraction, content);
    applyIngestionManifest(meta, result.manifest);
    delete meta.indexingAt;
    writeDB(db);

    res.json({
      success: true,
      chunkCount: result.chunkCount,
      memoryIds: result.memoryIds,
      extractionStatus: extraction.status,
      ingestionStatus: result.manifest.status,
      ingestionManifestId: result.manifest.manifestId,
      coverage: result.manifest.coverage,
    });
  } catch (err: any) {
    sendRouteError(res, err, 500);
  }
});

export default router;

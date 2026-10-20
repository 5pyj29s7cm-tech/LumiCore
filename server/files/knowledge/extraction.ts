import { providerGetterArguments } from "../../llm/provider_getters";
import path from "path";
import fs from "fs";
import { analyzeScreen } from "../../llm/adapter";
import { getUserPreferredVision, type VisionProvider } from "../../llm/vision_preferences";
import { isAudioTranscriptionUnavailable, transcribeAudioFile } from "../../stt/file_transcription";
import { extractPptxText } from "../../knowledge/pptx";
import { extractRtfText } from "../../knowledge/rtf";
import { workbookToText } from "../../utils/spreadsheet";
import { enrichMarkdownKnowledgeContent } from "../../knowledge/markdown";
import type { KnowledgeExtractionResult } from './contracts';
import { repairFilename, TEXT_KNOWLEDGE_EXTS, RTF_KNOWLEDGE_EXTS, AUDIO_KNOWLEDGE_EXTS, IMAGE_KNOWLEDGE_EXTS } from './formats';

export interface KnowledgeExtractionDeps {
  llmGetters?: Record<string, (() => any) | undefined>;
}

export let knowledgeExtractionDeps: KnowledgeExtractionDeps = {};

export let sharpLoader: Promise<any> | null = null;

export async function getSharp() {
  if (!sharpLoader) {
    sharpLoader = import('sharp').then(mod => mod.default || mod);
  }
  return sharpLoader;
}

export function visionModelFor(provider: VisionProvider): string {
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

export function resolveKnowledgeVisionProvider(userId: string): VisionProvider | null {
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

export async function extractImageKnowledge(filePath: string, userId: string, signal?: AbortSignal): Promise<KnowledgeExtractionResult> {
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
      .png()
      .toBuffer();
    const base64 = buffer.toString('base64');
    const preferred = getUserPreferredVision(userId);
    const model = preferred.model || visionModelFor(provider);
    const prompt = [
      'Extract readable text exactly as visible, preserving names, numbers, dates, negation and uncertainty; mark unreadable text without guessing. Then describe only directly visible objects, layout, tables and diagrams.',
      'Return only visible text and direct observations in the image language. Do not add interpretations, keyword suggestions, current-time judgments or facts absent from the pixels, or infer application features from icons or file names.',
    ].join('\n');
    const imagePayload = JSON.stringify({
      image_base64: base64,
      format: 'png',
      width: meta.width || null,
      height: meta.height || null,
    });
    const analysis = await analyzeScreen(
      imagePayload,
      prompt,
      { provider, model, userId, maxTokens: 2200, signal },
      ...providerGetterArguments(g),
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
      content: `${imageInfo}\nVision provider: ${provider}/${model}\n\nVisible image content (model extraction, not independently verified):\n${extracted}`,
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

export async function extractPdfText(filePath: string): Promise<string> {
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

export async function extractAudioKnowledge(filePath: string, signal?: AbortSignal): Promise<KnowledgeExtractionResult> {
  const displayName = repairFilename(path.basename(filePath));
  try {
    const result = await transcribeAudioFile(fs.readFileSync(filePath), {
      fileName: displayName,
      language: 'zh',
      signal,
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

export function extractTextKnowledge(filePath: string): KnowledgeExtractionResult {
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

export function extractGeneratedTextKnowledge(filename: string, content: string): KnowledgeExtractionResult {
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

export function captureKnowledgeSource(filePath: string): () => void {
  const before = fs.statSync(filePath);
  return () => {
    let after: fs.Stats;
    try { after = fs.statSync(filePath); } catch {
      throw Object.assign(new Error('Knowledge source was removed during processing.'), { status: 409 });
    }
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw Object.assign(new Error('Knowledge source changed during processing. Retry with the current file.'), { status: 409 });
    }
  };
}

export async function extractKnowledgeFileContent(filePath: string, userId = 'anonymous', signal?: AbortSignal): Promise<KnowledgeExtractionResult> {
  signal?.throwIfAborted();
  const assertSourceCurrent = captureKnowledgeSource(filePath);
  const result = await extractKnowledgeFileContentUnchecked(filePath, userId, signal);
  signal?.throwIfAborted();
  assertSourceCurrent();
  return result;
}

export async function extractKnowledgeFileContentUnchecked(filePath: string, userId: string, signal?: AbortSignal): Promise<KnowledgeExtractionResult> {
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
      return await extractAudioKnowledge(filePath, signal);
    }
    if (IMAGE_KNOWLEDGE_EXTS.test(extName)) {
      return await extractImageKnowledge(filePath, userId, signal);
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

export function updateKnowledgeExtractionDependencies(deps: KnowledgeExtractionDeps): void {
knowledgeExtractionDeps = { ...knowledgeExtractionDeps, ...deps };
}

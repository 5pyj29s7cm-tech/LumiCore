import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export type PdfPasswordErrorCode = 'PDF_PASSWORD_REQUIRED' | 'PDF_PASSWORD_INCORRECT';

export class PdfPasswordError extends Error {
  readonly code: PdfPasswordErrorCode;

  constructor(code: PdfPasswordErrorCode, filePath: string) {
    const fileName = path.basename(filePath);
    const message = code === 'PDF_PASSWORD_INCORRECT'
      ? `The password for PDF "${fileName}" is incorrect. Ask the user for the correct password and retry with the password argument. Never repeat the password in the response.`
      : `PDF "${fileName}" is password-protected. Ask the user for the password and retry with the password argument. Never repeat the password in the response.`;
    super(`${code}: ${message}`);
    this.name = 'PdfPasswordError';
    this.code = code;
  }
}

export interface PdfTextContent {
  text: string;
  pageCount: number;
  info: Record<string, unknown>;
}

function normalizePassword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const password = String(value);
  return password.length > 0 ? password : undefined;
}

function isPasswordException(pdfModule: any, error: unknown): boolean {
  const PasswordException = pdfModule?.PasswordException || pdfModule?.default?.PasswordException;
  if (typeof PasswordException === 'function' && error instanceof PasswordException) return true;
  const name = String((error as any)?.name || '');
  const message = String((error as any)?.message || error || '');
  return name === 'PasswordException'
    || /password exception|password required|need password|no password|incorrect password|invalid password/i.test(message);
}

function mapPdfError(pdfModule: any, error: unknown, filePath: string, password?: string): never {
  if (isPasswordException(pdfModule, error)) {
    throw new PdfPasswordError(password ? 'PDF_PASSWORD_INCORRECT' : 'PDF_PASSWORD_REQUIRED', filePath);
  }
  throw error;
}

/**
 * Extract text and metadata from a PDF. The optional password exists only in
 * this call's stack and is never included in returned data or error messages.
 */
export async function extractPdfTextContent(filePath: string, rawPassword?: unknown): Promise<PdfTextContent> {
  const password = normalizePassword(rawPassword);
  const data = fs.readFileSync(filePath);
  const pdfModule: any = require('pdf-parse');
  const PDFParse = pdfModule.PDFParse || pdfModule.default?.PDFParse;

  if (typeof PDFParse === 'function') {
    const parser = new PDFParse({ data, ...(password ? { password } : {}) });
    try {
      const textResult = await parser.getText();
      const infoResult = await parser.getInfo();
      return {
        text: String(textResult?.text || ''),
        pageCount: Number(textResult?.total || infoResult?.total || 0),
        info: infoResult?.info && typeof infoResult.info === 'object' ? infoResult.info : {},
      };
    } catch (error) {
      mapPdfError(pdfModule, error, filePath, password);
    } finally {
      try {
        await parser.destroy?.();
      } catch {}
    }
  }

  const legacyParser = typeof pdfModule === 'function'
    ? pdfModule
    : typeof pdfModule.default === 'function'
      ? pdfModule.default
      : null;
  if (!legacyParser) throw new Error('Unsupported pdf-parse API');

  try {
    const result = await legacyParser(data, password ? { password } : undefined);
    return {
      text: String(result?.text || ''),
      pageCount: Number(result?.numpages || result?.numPages || 0),
      info: result?.info && typeof result.info === 'object' ? result.info : {},
    };
  } catch (error) {
    mapPdfError(pdfModule, error, filePath, password);
  }
}

export async function extractPdfText(filePath: string, password?: unknown): Promise<string> {
  return (await extractPdfTextContent(filePath, password)).text;
}

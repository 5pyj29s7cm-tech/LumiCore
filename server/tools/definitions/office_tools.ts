import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import nodemailer from 'nodemailer';
import PptxGenJS from 'pptxgenjs';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { ToolRegistry } from '../registry';
import { getGeneratedOutputDir } from '../../config/data_path';

const execFileAsync = promisify(execFile);
const OUTPUT_DIR = getGeneratedOutputDir();

let broadcastFn: ((event: string, data: any) => void) | null = null;

export function setOfficeBroadcast(fn: (event: string, data: any) => void): void {
  broadcastFn = fn;
}

interface PresentationSlideInput {
  title: string;
  bullets?: string[];
  layout?: 'bullets' | 'image-left' | 'image-right' | 'image-full' | 'quote';
  image?: string;
  subtitle?: string;
}

const PRESENTATION_THEMES: Record<string, {
  background: string;
  surface: string;
  accent: string;
  accent2: string;
  text: string;
  muted: string;
  white: string;
}> = {
  dark: { background: '0B1020', surface: '151D32', accent: 'FF9966', accent2: 'AEC6CF', text: 'F5F7FA', muted: 'AFB8C8', white: 'FFFFFF' },
  midnight: { background: '10182A', surface: '18243B', accent: 'F3C969', accent2: '6C8CD5', text: 'F4F7FB', muted: 'A9B4C7', white: 'FFFFFF' },
  ocean: { background: 'EFF8FC', surface: 'FFFFFF', accent: '0077B6', accent2: '48CAE4', text: '1E293B', muted: '64748B', white: 'FFFFFF' },
  sunset: { background: 'FFF8F0', surface: 'FFFFFF', accent: 'E85D04', accent2: 'FFB703', text: '242424', muted: '747474', white: 'FFFFFF' },
  forest: { background: 'F3FAF4', surface: 'FFFFFF', accent: '2D6A4F', accent2: '74C69D', text: '1D2A22', muted: '66756B', white: 'FFFFFF' },
};

function ensureOutputDir(): string {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function presentationOutputPath(filename: unknown, title: string): string {
  const requested = String(filename || '').trim();
  const rawBase = path.basename(requested || title).replace(/\.pptx$/i, '');
  const safeBase = rawBase.replace(/[\\/:*?"<>|]/g, '_').trim() || `presentation_${Date.now()}`;
  const parent = requested && path.isAbsolute(requested)
    ? path.dirname(requested)
    : ensureOutputDir();
  fs.mkdirSync(parent, { recursive: true });
  return path.join(parent, `${safeBase}.pptx`);
}

async function resolvePresentationImage(
  source: string | undefined,
  tmpDir: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const value = String(source || '').trim();
  if (!value) return null;
  if (cache.has(value)) return cache.get(value) || null;
  if (!/^https?:\/\//i.test(value)) {
    const local = fs.existsSync(value) ? path.resolve(value) : null;
    cache.set(value, local);
    return local;
  }
  try {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '');
    const ext = /png/i.test(contentType) ? '.png'
      : /webp/i.test(contentType) ? '.webp'
        : /gif/i.test(contentType) ? '.gif'
          : value.match(/\.(png|jpe?g|webp|gif)(?:$|[?#])/i)?.[0] || '.jpg';
    const outputPath = path.join(tmpDir, `image_${cache.size}_${Date.now()}${ext}`);
    fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
    cache.set(value, outputPath);
    return outputPath;
  } catch {
    cache.set(value, null);
    return null;
  }
}

function addPresentationHeading(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  title: string,
  theme: typeof PRESENTATION_THEMES.dark,
  sectionNumber: number,
): void {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.08, line: { color: theme.accent }, fill: { color: theme.accent } });
  slide.addText(String(sectionNumber).padStart(2, '0'), { x: 0.65, y: 0.62, w: 0.75, h: 0.32, fontFace: 'Aptos', fontSize: 13, bold: true, color: theme.accent });
  slide.addText(title, { x: 1.45, y: 0.48, w: 10.9, h: 0.62, fontFace: 'Aptos Display', fontSize: 26, bold: true, color: theme.text, margin: 0 });
  slide.addShape(pptx.ShapeType.line, { x: 1.45, y: 1.18, w: 1.15, h: 0, line: { color: theme.accent2, width: 2.5 } });
}

async function createPptHandler(args: Record<string, any>): Promise<string> {
  const title = String(args.title || '').trim();
  const slides = Array.isArray(args.slides) ? args.slides as PresentationSlideInput[] : [];
  if (!title || slides.length === 0) throw new Error('Title and at least one content slide are required.');
  if (slides.some(slide => !String(slide?.title || '').trim())) throw new Error('Every presentation slide requires a title.');

  const themeName = String(args.theme || 'dark').toLowerCase();
  const theme = PRESENTATION_THEMES[themeName] || PRESENTATION_THEMES.dark;
  const outputPath = presentationOutputPath(args.filename, title);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-ppt-'));
  const cache = new Map<string, string | null>();
  const topLevelImages = Array.isArray(args.images) ? args.images.map(String) : [];
  const bc = broadcastFn || (() => {});
  bc('mcp:activity', { device: 'desktop', action: 'create_ppt', status: 'started', title, slidesCount: slides.length });

  try {
    const resolvedTopImages = await Promise.all(topLevelImages.map(image => resolvePresentationImage(image, tmpDir, cache)));
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Lumi';
    pptx.company = 'LumiOS';
    pptx.subject = title;
    pptx.title = title;
    pptx.theme = {
      headFontFace: 'Aptos Display',
      bodyFontFace: 'Aptos',
    };

    const cover = pptx.addSlide();
    cover.background = { color: theme.background };
    const coverImage = resolvedTopImages[0];
    if (coverImage) {
      cover.addImage({ path: coverImage, x: 0, y: 0, w: 13.333, h: 7.5, transparency: 15 });
      cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, line: { transparency: 100 }, fill: { color: theme.background, transparency: 30 } });
    }
    cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.1, line: { color: theme.accent }, fill: { color: theme.accent } });
    cover.addText(title, { x: 1.1, y: 2.05, w: 11.1, h: 1.45, fontFace: 'Aptos Display', fontSize: 36, bold: true, color: theme.white, margin: 0.02, breakLine: false });
    cover.addShape(pptx.ShapeType.line, { x: 1.1, y: 3.72, w: 1.45, h: 0, line: { color: theme.accent, width: 4 } });
    cover.addText(`${slides.length} chapters · Lumi`, { x: 1.1, y: 3.95, w: 7.5, h: 0.45, fontSize: 15, color: theme.muted, margin: 0 });

    for (let index = 0; index < slides.length; index += 1) {
      const input = slides[index];
      const layout = input.layout || 'bullets';
      const fallbackImage = resolvedTopImages[index + 1] || null;
      const imagePath = await resolvePresentationImage(input.image, tmpDir, cache) || fallbackImage;
      const slide = pptx.addSlide();
      slide.background = { color: layout === 'image-full' ? theme.background : theme.surface };

      if (layout === 'image-full' && imagePath) {
        slide.addImage({ path: imagePath, x: 0, y: 0, w: 13.333, h: 7.5, transparency: 8 });
        slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, line: { transparency: 100 }, fill: { color: theme.background, transparency: 38 } });
        slide.addText(input.title, { x: 1.1, y: 2.55, w: 11.1, h: 0.95, fontSize: 31, bold: true, align: 'center', color: theme.white, margin: 0 });
        if (input.subtitle) slide.addText(input.subtitle, { x: 1.45, y: 3.7, w: 10.4, h: 0.55, fontSize: 16, align: 'center', color: theme.muted, margin: 0 });
        continue;
      }

      if (layout === 'quote') {
        slide.background = { color: theme.background };
        slide.addText('“', { x: 0.75, y: 0.7, w: 1.2, h: 1.3, fontSize: 86, bold: true, color: theme.accent, margin: 0 });
        slide.addText(input.title, { x: 1.55, y: 1.65, w: 10.25, h: 2.6, fontSize: 27, color: theme.white, valign: 'middle', margin: 0.04 });
        if (input.subtitle) slide.addText(input.subtitle, { x: 1.55, y: 4.65, w: 9, h: 0.45, fontSize: 15, color: theme.muted, margin: 0 });
        continue;
      }

      addPresentationHeading(pptx, slide, input.title, theme, index + 1);
      const hasSideImage = Boolean(imagePath && (layout === 'image-left' || layout === 'image-right'));
      if (hasSideImage && imagePath) {
        const imageX = layout === 'image-left' ? 0.65 : 7.2;
        slide.addImage({ path: imagePath, x: imageX, y: 1.55, w: 5.5, h: 4.95 });
      }
      const textX = layout === 'image-left' ? 6.55 : 0.8;
      const textW = hasSideImage ? 5.75 : 11.75;
      const bulletText = (input.bullets || []).map(item => `• ${String(item)}`).join('\n\n');
      if (bulletText) {
        slide.addText(bulletText, { x: textX, y: 1.62, w: textW, h: 4.85, fontSize: 17, color: theme.text, breakLine: false, margin: 0.08, valign: 'top', paraSpaceAfter: 12, fit: 'shrink' });
      } else if (input.subtitle) {
        slide.addText(input.subtitle, { x: textX, y: 1.8, w: textW, h: 2.2, fontSize: 20, color: theme.muted, margin: 0.06, valign: 'middle' });
      }
    }

    const ending = pptx.addSlide();
    ending.background = { color: theme.background };
    ending.addText('Created with Lumi', { x: 1.1, y: 2.65, w: 11.1, h: 0.72, fontSize: 29, bold: true, align: 'center', color: theme.white, margin: 0 });
    ending.addShape(pptx.ShapeType.line, { x: 5.45, y: 3.63, w: 2.45, h: 0, line: { color: theme.accent, width: 3 } });
    ending.addText(title, { x: 1.4, y: 3.95, w: 10.5, h: 0.55, fontSize: 15, align: 'center', color: theme.muted, margin: 0 });

    await pptx.writeFile({ fileName: outputPath, compression: true });
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('Presentation writer returned without creating a non-empty PPTX file.');
    }
    bc('mcp:activity', { device: 'desktop', action: 'create_ppt', status: 'completed', path: outputPath, slidesCount: slides.length });
    return JSON.stringify({
      ok: true,
      status: 'created',
      outputPath,
      artifact: { type: 'presentation', path: outputPath },
      title,
      contentSlides: slides.length,
      totalSlides: slides.length + 2,
      theme: themeName,
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function sendEmailWithAttachments(args: Record<string, any>): Promise<string> {
  const to = String(args.to || '').trim();
  const subject = String(args.subject || '').trim();
  if (!to) throw new Error('Recipient is required.');
  if (!subject) throw new Error('Subject is required.');

  const host = String(args.smtpHost || process.env.SMTP_HOST || '').trim();
  const port = Number(args.smtpPort || process.env.SMTP_PORT || 587);
  const user = String(args.smtpUser || process.env.SMTP_USER || '').trim();
  const pass = String(args.smtpPass || process.env.SMTP_PASS || '');
  if (!host || !user || !pass) throw new Error('SMTP host, username, and password are required.');

  const filePaths = Array.isArray(args.filePaths) ? args.filePaths.map(String) : [];
  const attachments = filePaths.map(filePath => {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Attachment not found: ${filePath}`);
    return { path: filePath };
  });
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  const info = await transporter.sendMail({ from: user, to, subject, text: String(args.body || ''), attachments });
  const accepted = Array.isArray(info.accepted) ? info.accepted.map(String) : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : [];
  if (!info.messageId && accepted.length === 0) throw new Error('SMTP server returned no delivery-acceptance receipt.');

  return JSON.stringify({
    ok: true,
    status: 'sent',
    sent: true,
    provider: 'smtp',
    recipient: to,
    messageId: String(info.messageId || ''),
    accepted,
    rejected,
    attachmentCount: attachments.length,
  });
}

async function readEmailAttachments(args: Record<string, any>): Promise<string> {
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace('MAPI')
$items = $namespace.GetDefaultFolder(6).Items
$items.Sort('[ReceivedTime]', $true)
$result = @()
foreach ($item in $items) {
  if ($result.Count -ge ${limit}) { break }
  $attachments = @()
  foreach ($attachment in $item.Attachments) {
    $attachments += [PSCustomObject]@{ name = [string]$attachment.FileName; size = [int]$attachment.Size }
  }
  $result += [PSCustomObject]@{ subject = [string]$item.Subject; from = [string]$item.SenderName; received = $item.ReceivedTime.ToString('o'); attachments = $attachments }
}
[PSCustomObject]@{ ok = $true; status = 'observed'; provider = 'outlook'; items = $result } | ConvertTo-Json -Compress -Depth 6
`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true });
    return String(stdout || '').trim();
  }
  if (process.platform === 'darwin') {
    const script = `
function run(argv) {
  const limit = Number(argv[0] || 10);
  const app = Application('Mail');
  const items = app.inbox.messages().slice(0, limit).map(message => ({
    subject: String(message.subject() || ''),
    from: String(message.sender() || ''),
    received: new Date(message.dateReceived()).toISOString(),
    attachments: message.mailAttachments().map(item => ({ name: String(item.name() || ''), size: Number(item.fileSize() || 0) }))
  }));
  return JSON.stringify({ ok: true, status: 'observed', provider: 'macos_mail', items });
}`;
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script, '--', String(limit)], { timeout: 30_000 });
    return String(stdout || '').trim();
  }
  throw new Error(`Email attachment inspection is unavailable on platform "${process.platform}".`);
}

export function registerOfficeTools(registry: ToolRegistry): void {
  registry.register({
    name: 'create_ppt',
    description: 'Create a cross-platform PPTX presentation with cover, content, and ending slides. Images may be local paths or HTTP(S) URLs. The tool creates the file but does not claim it was opened; use desktop_open separately when requested.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Presentation title' },
        slides: {
          type: 'array',
          description: 'Content slides with layout options',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Slide heading or quote text' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points' },
              layout: { type: 'string', description: 'bullets | image-left | image-right | image-full | quote' },
              image: { type: 'string', description: 'Local image path or HTTP(S) image URL' },
              subtitle: { type: 'string', description: 'Subtitle or attribution' },
            },
            required: ['title'],
          },
        },
        filename: { type: 'string', description: 'Optional absolute output path or file name' },
        theme: { type: 'string', description: 'dark | midnight | ocean | sunset | forest' },
        images: { type: 'array', items: { type: 'string' }, description: 'Optional local paths or HTTP(S) URLs used across slides' },
      },
      required: ['title', 'slides'],
    },
    handler: createPptHandler,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      ...capabilityContract({
        id: 'office.presentation.create',
        family: 'presentation',
        lane: 'office',
        operation: 'create',
        risk: 'medium',
        sideEffects: [{ type: 'local_write', scope: 'generated PPTX presentation', reversible: true }],
        verification: {
          strategy: 'artifact',
          required: true,
          requiredFields: ['ok', 'status', 'outputPath', 'totalSlides'],
          requiredValues: { ok: true, status: 'created' },
          successStatuses: ['created'],
          failureStatuses: ['failed'],
          requiredArtifacts: ['outputPath'],
          successSignals: ['non-empty PPTX artifact exists at the declared output path'],
          limitations: ['Artifact existence does not prove subjective presentation quality or successful opening in an Office application.'],
        },
      }),
      source: 'adapter',
      adapter: {
        id: 'office.presentation-file',
        operations: ['presentation.create'],
        implementations: { windows: 'node.pptxgenjs', macos: 'node.pptxgenjs' },
      },
    },
    evidence: capabilityEvidence({
      id: 'office.presentation.create',
      operation: 'create',
      subjectArgument: 'filename',
      limitations: ['Opening and visual review are separate actions with separate receipts.'],
    }),
  });

  registry.register({
    name: 'send_email_with_attachments',
    description: 'Send an email with optional file attachments through the configured SMTP server and return its acceptance receipt.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Plain text email body' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Optional attachment file paths' },
        smtpHost: { type: 'string', description: 'Optional SMTP server hostname' },
        smtpPort: { type: 'number', description: 'Optional SMTP port; defaults to 587' },
        smtpUser: { type: 'string', description: 'Optional SMTP username' },
        smtpPass: { type: 'string', description: 'Optional SMTP password' },
      },
      required: ['to', 'subject'],
    },
    handler: sendEmailWithAttachments,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'messaging.email.send_with_attachments',
      family: 'email',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'high',
      sideEffects: [
        { type: 'external_communication', scope: 'SMTP recipient and attachments', reversible: false },
        { type: 'credential_access', scope: 'configured SMTP credentials', reversible: true },
        { type: 'local_read', scope: 'declared attachment files', reversible: true },
      ],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok', 'status', 'sent', 'provider', 'recipient', 'messageId', 'attachmentCount'],
        requiredValues: { ok: true, status: 'sent', sent: true, provider: 'smtp' },
        successStatuses: ['sent'],
        failureStatuses: ['failed', 'rejected'],
        successSignals: ['SMTP server accepted the message and returned a message id or accepted recipient'],
        limitations: ['SMTP acceptance does not prove inbox delivery or that the recipient read the message.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'messaging.email.send_with_attachments',
      operation: 'communicate',
      subjectArgument: 'to',
      limitations: ['The receipt proves SMTP acceptance, not final mailbox delivery.'],
    }),
  });

  registry.register({
    name: 'read_email_attachments',
    description: 'Inspect recent email attachment metadata through Outlook on Windows or Mail on macOS under one shared schema.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum messages to inspect; defaults to 10' } },
      required: [],
    },
    handler: readEmailAttachments,
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.email.attachments.read',
      family: 'email',
      lane: 'messaging',
      source: 'adapter',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'recent message and attachment metadata', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'items'],
        requiredValues: { ok: true, status: 'observed' },
        successStatuses: ['observed'],
        failureStatuses: ['failed'],
        successSignals: ['platform mail adapter returned a message collection'],
        limitations: ['This reads attachment metadata, not attachment contents.'],
      },
      adapter: {
        id: 'messaging.email-attachments',
        operations: ['email.attachments.read'],
        implementations: { windows: 'windows.outlook_com', macos: 'macos.mail_jxa' },
      },
    },
    evidence: capabilityEvidence({
      id: 'messaging.email.attachments.read',
      operation: 'observe',
      limitations: ['Attachment content requires a separate explicit read or save action.'],
    }),
  });
}

import os from 'os';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ToolRegistry } from '../registry';

const require = createRequire(import.meta.url);

let broadcastFn: ((event: string, data: any) => void) | null = null;

export function setOfficeBroadcast(fn: (event: string, data: any) => void) {
  broadcastFn = fn;
}

async function downloadImage(url: string, tmpDir: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = url.match(/\.(png|jpg|jpeg|webp)/i)?.[0] || '.jpg';
    const fpath = path.join(tmpDir, `img_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
    fs.writeFileSync(fpath, buf);
    return fpath;
  } catch {
    return null;
  }
}

async function createPptHandler(args: Record<string, any>): Promise<string> {
  const title = args.title as string;
  const slides = args.slides as Array<{
    title: string;
    bullets?: string[];
    layout?: string;
    image?: string;
    subtitle?: string;
  }>;
  const filename = args.filename as string | undefined;
  const theme = (args.theme as string) || 'dark';
  const images = (args.images || []) as string[];

  if (!title || !slides || !Array.isArray(slides) || slides.length === 0) {
    return 'Error: title and slides (non-empty array) are required.';
  }

  const bc = broadcastFn || (() => {});
  let safeName = (filename || title).replace(/[\\/:*?"<>|]/g, '_');
  if (safeName.toLowerCase().endsWith('.pptx')) safeName = safeName.slice(0, -5);

  bc('mcp:activity', { device: 'xiaozhi', action: 'create_ppt', status: 'started', title, slidesCount: slides.length });

  // Download images if URLs provided
  const tmpDir = path.join(os.tmpdir(), `lumi_ppt_imgs`);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const imagePaths: (string | null)[] = [];
  for (const imgUrl of images) {
    const p = await downloadImage(imgUrl, tmpDir);
    imagePaths.push(p);
    if (p) bc('mcp:activity', { device: 'xiaozhi', action: 'ppt_image', url: imgUrl, path: p });
  }

  // Professional color palettes
  const palettes: Record<string, { bg: number; surface: number; accent: number; accent2: number; text: number; textDim: number; white: number; darkBg: number }> = {
    dark:    { bg: 0, surface: 2105376, accent: 16750848, accent2: 11456512, text: 15658734, textDim: 11119017, white: 16777215, darkBg: 1973790 },
    midnight:{ bg: 1315860, surface: 1973790, accent: 16763904, accent2: 6724044, text: 15658734, textDim: 10526880, white: 16777215, darkBg: 657930 },
    ocean:   { bg: 15921906, surface: 16777215, accent: 33023, accent2: 5275647, text: 2105376, textDim: 8421504, white: 16777215, darkBg: 3355443 },
    sunset:  { bg: 16777215, surface: 16775416, accent: 23295, accent2: 16740693, text: 2368548, textDim: 10526880, white: 16777215, darkBg: 3355443 },
    forest:  { bg: 15794175, surface: 16777215, accent: 5287936, accent2: 6730752, text: 1973790, textDim: 7368816, white: 16777215, darkBg: 2631720 },
  };
  const c = palettes[theme] || palettes.dark;

  // Helper: BGR int from RGB
  const psLines: string[] = [
    `function RGB($r,$g,$b) { return [int]($b*65536 + $g*256 + $r) }`,
    '',
    `$ppt = New-Object -ComObject PowerPoint.Application`,
    `$ppt.Visible = $true`,
    `$pres = $ppt.Presentations.Add()`,
    `$pres.PageSetup.SlideSize = 13`,
    `$pres.PageSetup.SlideWidth = 960`,
    `$pres.PageSetup.SlideHeight = 540`,
    '',
    `$W = 960; $H = 540`,
    // Color variables
    `$Bg       = ${c.bg}`,
    `$Surface  = ${c.surface}`,
    `$Accent   = ${c.accent}`,
    `$Accent2  = ${c.accent2}`,
    `$Text     = ${c.text}`,
    `$TextDim  = ${c.textDim}`,
    `$White    = ${c.white}`,
    `$DarkBg   = ${c.darkBg}`,
    '',
    // ── Shape helpers ──
    'function AddShape($slide, $type, $L, $T, $W, $H, $fill, $text, $fs, $fc, $bold) {',
    '  $s = $slide.Shapes.AddShape($type, $L, $T, $W, $H)',
    '  $s.Fill.ForeColor.RGB = $fill',
    '  $s.Line.Visible = $false',
    '  $s.TextFrame.WordWrap = $true',
    '  if ($text) {',
    '    $s.TextFrame.TextRange.Text = $text',
    '    $s.TextFrame.TextRange.Font.Name = "Microsoft YaHei"',
    '    if ($fs) { $s.TextFrame.TextRange.Font.Size = $fs }',
    '    if ($fc -ne $null) { $s.TextFrame.TextRange.Font.Color.RGB = $fc }',
    '    if ($bold) { $s.TextFrame.TextRange.Font.Bold = $true }',
    '  }',
    '  return $s',
    '}',
    '',
    'function AddTextBox($slide, $L, $T, $W, $H, $text, $fs, $fc, $bold, $align) {',
    '  $s = $slide.Shapes.AddTextbox(1, $L, $T, $W, $H)',
    '  $s.TextFrame.WordWrap = $true',
    '  $s.TextFrame.TextRange.Text = $text',
    '  $s.TextFrame.TextRange.Font.Name = "Microsoft YaHei"',
    '  if ($fs) { $s.TextFrame.TextRange.Font.Size = $fs }',
    '  if ($fc -ne $null) { $s.TextFrame.TextRange.Font.Color.RGB = $fc }',
    '  if ($bold) { $s.TextFrame.TextRange.Font.Bold = $true }',
    '  if ($align) { $s.TextFrame.TextRange.ParagraphFormat.Alignment = $align }',
    '  return $s',
    '}',
    '',
    'function AddImage($slide, $path, $L, $T, $W, $H) {',
    '  try {',
    '    $img = $slide.Shapes.AddPicture($path, 0, $true, $L, $T, $W, $H)',
    '    return $img',
    '  } catch { return $null }',
    '}',
    '',
    // ═══════════════ COVER SLIDE ═══════════════
    `$cover = $pres.Slides.Add(1, 12)`,
    `AddShape $cover 1 0 0 $W $H $DarkBg "" 0 0 $false`,
  ];

  // If we have an image for cover, use it as full-bleed background
  if (imagePaths[0]) {
    const coverImg = imagePaths[0].replace(/\\/g, '\\\\');
    psLines.push(
      `AddImage $cover '${coverImg}' 0 0 $W $H`,
      // Dark overlay for text readability
      `AddShape $cover 1 0 0 $W $H (RGB 0 0 0) "" 0 0 $false`,
      `$cover.Shapes[$cover.Shapes.Count].Fill.Transparency = 0.35`,
    );
  }

  psLines.push(
    // Large decorative accent bar across top
    `AddShape $cover 1 0 0 $W 6 $Accent "" 0 0 $false`,
    // Main title - big and bold
    `AddTextBox $cover 80 150 800 180 '${esc(title)}' 42 $White $true 0`,
    // Accent underline
    `AddShape $cover 1 80 345 100 5 $Accent "" 0 0 $false`,
    // Subtitle
    `AddTextBox $cover 80 365 800 60 '${esc(slides.length + ' chapters · Lumi AI')}' 16 $TextDim $false 0`,
    // Bottom accent bar
    `AddShape $cover 1 0 534 $W 6 $Accent2 "" 0 0 $false`,
    // Remove default slide
    '$pres.Slides[2].Delete()',
  );

  let imgIdx = imagePaths[0] ? 1 : 0; // cover used image[0] if available

  // ═══════════════ CONTENT SLIDES ═══════════════
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const slideName = `$s${i}`;
    const slideNum = i + 2;
    const st = esc(s.title);
    const layout = s.layout || 'bullets';

    psLines.push('', `# === Slide ${i + 1}: ${st} (${layout}) ===`);
    psLines.push(`${slideName} = $pres.Slides.Add(${slideNum}, 12)`);

    if (layout === 'image-full' && s.image) {
      // ── Full-bleed image with text overlay ──
      const imgPath = s.image.replace(/\\/g, '\\\\');
      psLines.push(
        `AddImage ${slideName} '${imgPath}' 0 0 $W $H`,
        // Dark gradient overlay
        `AddShape ${slideName} 1 0 0 $W $H $DarkBg "" 0 0 $false`,
        `${slideName}.Shapes[${slideName}.Shapes.Count].Fill.Transparency = 0.5`,
        // Title overlaid
        `AddTextBox ${slideName} 60 200 840 100 '${st}' 34 $White $true 1`,
        `AddShape ${slideName} 1 370 260 240 4 $Accent "" 0 0 $false`,
      );
      if (s.subtitle) {
        psLines.push(`AddTextBox ${slideName} 60 280 840 60 '${esc(s.subtitle)}' 18 $TextDim $false 1`);
      }
    } else if (layout === 'image-left' && s.image) {
      // ── Image left, text right ──
      const imgPath = s.image.replace(/\\/g, '\\\\');
      psLines.push(
        `AddShape ${slideName} 1 0 0 $W $H $Surface "" 0 0 $false`,
        `AddShape ${slideName} 1 0 0 $W 4 $Accent "" 0 0 $false`,
        `AddImage ${slideName} '${imgPath}' 40 60 400 420`,
        // Right side title
        `AddTextBox ${slideName} 480 50 440 50 '${st}' 28 $Text $true 0`,
        `AddShape ${slideName} 1 480 108 80 4 $Accent "" 0 0 $false`,
      );
      if (s.bullets && s.bullets.length > 0) {
        const yStart = 130;
        const lineH = Math.min(44, Math.floor(380 / s.bullets.length));
        for (let b = 0; b < s.bullets.length; b++) {
          const y = yStart + b * lineH;
          psLines.push(
            `AddShape ${slideName} 9 490 ${y + 8} 8 8 $Accent2 "" 0 0 $false`,
            `AddTextBox ${slideName} 515 ${y} 400 ${lineH} '${esc(s.bullets[b])}' 15 $Text $false 0`,
          );
        }
      }
    } else if (layout === 'image-right' && s.image) {
      // ── Text left, image right ──
      const imgPath = s.image.replace(/\\/g, '\\\\');
      psLines.push(
        `AddShape ${slideName} 1 0 0 $W $H $Surface "" 0 0 $false`,
        `AddShape ${slideName} 1 0 0 $W 4 $Accent "" 0 0 $false`,
        `AddImage ${slideName} '${imgPath}' 520 60 400 420`,
        `AddTextBox ${slideName} 40 50 440 50 '${st}' 28 $Text $true 0`,
        `AddShape ${slideName} 1 40 108 80 4 $Accent "" 0 0 $false`,
      );
      if (s.bullets && s.bullets.length > 0) {
        const yStart = 130;
        const lineH = Math.min(44, Math.floor(380 / s.bullets.length));
        for (let b = 0; b < s.bullets.length; b++) {
          const y = yStart + b * lineH;
          psLines.push(
            `AddShape ${slideName} 9 55 ${y + 8} 8 8 $Accent2 "" 0 0 $false`,
            `AddTextBox ${slideName} 80 ${y} 400 ${lineH} '${esc(s.bullets[b])}' 15 $Text $false 0`,
          );
        }
      }
    } else if (layout === 'quote') {
      // ── Quote slide: large text centered ──
      psLines.push(
        `AddShape ${slideName} 1 0 0 $W $H $DarkBg "" 0 0 $false`,
        `AddShape ${slideName} 1 0 0 $W 4 $Accent "" 0 0 $false`,
        // Large quote mark
        `AddTextBox ${slideName} 60 80 100 120 '"' 120 $Accent $true 0`,
        // Quote text
        `AddTextBox ${slideName} 110 100 750 260 '${st}' 28 $White $false 0`,
        // Attribution
      );
      if (s.subtitle) {
        psLines.push(
          `AddShape ${slideName} 1 110 340 80 3 $Accent "" 0 0 $false`,
          `AddTextBox ${slideName} 110 360 750 40 '${esc(s.subtitle)}' 16 $TextDim $false 0`,
        );
      }
    } else {
      // ── Default: clean bullets layout ──
      psLines.push(
        `AddShape ${slideName} 1 0 0 $W $H $Surface "" 0 0 $false`,
        `AddShape ${slideName} 1 0 0 $W 4 $Accent "" 0 0 $false`,
        // Left decorative bar
        `AddShape ${slideName} 1 40 50 4 440 $Accent "" 0 0 $false`,
        // Section number pill
        `$pill${i} = AddShape ${slideName} 12 40 58 200 36 $Accent "${slideNum}" 16 $White $true`,
        `$pill${i}.TextFrame.TextRange.ParagraphFormat.Alignment = 1`,
        // Title
        `AddTextBox ${slideName} 260 53 660 50 '${st}' 28 $Text $true 0`,
        // Accent line
        `AddShape ${slideName} 1 260 112 100 4 $Accent2 "" 0 0 $false`,
      );
      if (s.bullets && s.bullets.length > 0) {
        const yStart = 140;
        const lineH = Math.min(52, Math.floor(370 / s.bullets.length));
        for (let b = 0; b < s.bullets.length; b++) {
          const y = yStart + b * lineH;
          psLines.push(
            `AddShape ${slideName} 9 280 ${y + 10} 10 10 $Accent2 "" 0 0 $false`,
            `AddTextBox ${slideName} 310 ${y} 590 ${lineH} '${esc(s.bullets[b])}' 16 $Text $false 0`,
          );
        }
      }
      // If an image is available for this slide, put it as a small decorative element
      const slideImg = s.image || (imgIdx < imagePaths.length ? imagePaths[imgIdx] : null);
      if (slideImg && layout !== 'image-left' && layout !== 'image-right' && layout !== 'image-full') {
        const imgPath = slideImg.replace(/\\/g, '\\\\');
        psLines.push(`AddImage ${slideName} '${imgPath}' 680 360 240 150`);
        imgIdx++;
      }
    }
  }

  // ═══════════════ ENDING SLIDE ═══════════════
  const endSlideNum = slides.length + 2;
  psLines.push(
    '',
    '# === Ending Slide ===',
    `$end = $pres.Slides.Add(${endSlideNum}, 12)`,
    `AddShape $end 1 0 0 $W $H $DarkBg "" 0 0 $false`,
    `AddShape $end 1 0 0 $W 6 $Accent "" 0 0 $false`,
    // Center card
    `AddShape $end 1 160 150 640 260 $Surface "" 0 0 $false`,
    `AddTextBox $end 200 170 560 70 'Created with Lumi AI' 28 $Text $true 1`,
    `AddShape $end 1 350 240 260 4 $Accent "" 0 0 $false`,
    `AddTextBox $end 200 260 560 50 '${esc(title)}' 16 $TextDim $false 1`,
    `AddTextBox $end 200 480 560 40 'lumi-os.ai' 13 $Accent $false 1`,
  );

  // Save & cleanup
  psLines.push(
    '',
    `$desktop = [Environment]::GetFolderPath('Desktop')`,
    `$out = Join-Path $desktop '${esc(safeName)}.pptx'`,
    `$pres.SaveAs($out)`,
    `$pres.Close()`,
    `$ppt.Quit()`,
    `Write-Output $out`,
  );

  const tmpFile = path.join(os.tmpdir(), `lumi_ppt_${Date.now()}.ps1`);
  fs.writeFileSync(tmpFile, '﻿' + psLines.join('\n'), 'utf-8');

  const { execSync } = await import('child_process');
  // Use -File to avoid cmd.exe encoding corruption of UTF-8 content
  const result = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`,
    { timeout: 60000, encoding: 'utf-8' },
  );
  try { fs.unlinkSync(tmpFile); } catch {}
  const savedPath = result.trim().split(/\r?\n/).pop()?.trim() || '';

  // Cleanup temp images (keep for a bit so PowerPoint can embed them)
  setTimeout(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }, 5000);

  bc('mcp:activity', { device: 'xiaozhi', action: 'create_ppt', status: 'completed', path: savedPath, slidesCount: slides.length });

  try { execSync(`start "" "${savedPath}"`, { timeout: 5000 }); } catch {}

  return `PPT created and opened: ${savedPath} (${slides.length} slides, theme: ${theme})`;
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

// ── Email with Attachment Handlers ──

async function sendEmailWithAttachments(args: Record<string, any>): Promise<string> {
  const { to, subject, body, filePaths, smtpHost, smtpPort, smtpUser, smtpPass } = args;
  if (!to) throw new Error('to (recipient) is required');
  if (!subject) throw new Error('subject is required');

  // Read SMTP config from args or environment
  const host = smtpHost || process.env.SMTP_HOST;
  const port = smtpPort || parseInt(process.env.SMTP_PORT || '587', 10);
  const user = smtpUser || process.env.SMTP_USER;
  const pass = smtpPass || process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP configuration required. Set SMTP_HOST/SMTP_USER/SMTP_PASS env vars or pass smtpHost/smtpUser/smtpPass.');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });

  const attachments = (filePaths || []).map((fp: string) => {
    if (!fs.existsSync(fp)) throw new Error(`Attachment not found: ${fp}`);
    return { path: fp };
  });

  await transporter.sendMail({
    from: user,
    to,
    subject,
    text: body || '',
    attachments,
  });

  return `Email sent to ${to}${attachments.length ? ` with ${attachments.length} attachment(s)` : ''}`;
}

async function readEmailAttachments(args: Record<string, any>): Promise<string> {
  const { limit } = args;
  const count = limit || 10;

  // Use Outlook COM on Windows
  if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    const psScript = `
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace("MAPI")
$inbox = $ns.GetDefaultFolder(6)
$items = $inbox.Items | Sort-Object ReceivedTime -Descending | Select-Object -First ${count}
$results = @()
foreach ($item in $items) {
  $attachments = @()
  foreach ($att in $item.Attachments) {
    $attachments += "$($att.FileName) ($($att.Size) bytes)"
  }
  $results += [PSCustomObject]@{
    Subject = $item.Subject
    From = $item.SenderName
    Received = $item.ReceivedTime.ToString('yyyy-MM-dd HH:mm')
    HasAttachments = $item.Attachments.Count -gt 0
    AttachmentCount = $item.Attachments.Count
    Attachments = $attachments -join '; '
  }
}
$results | ConvertTo-Json -Depth 2
`.trim();

    try {
      const output = execSync(`powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`, {
        encoding: 'utf-8', timeout: 30000,
      });
      const parsed = JSON.parse(output);
      return JSON.stringify(parsed, null, 2);
    } catch (err: any) {
      return `Outlook access failed: ${err.message}. Try setting up SMTP in Settings > Email.`;
    }
  }

  return 'Email reading is currently supported on Windows via Outlook. Configure SMTP for cross-platform email sending.';
}

export function registerOfficeTools(registry: ToolRegistry): void {
  registry.register({
    name: 'create_ppt',
    description: `Create a visually stunning PowerPoint presentation.

Layouts per slide: "bullets" (default), "image-left", "image-right", "image-full" (image as background), "quote" (large centered text).

The "images" array (top-level) accepts image URLs — first image becomes cover background, subsequent images decorate slides or match with slides that specify layout: image-left/image-right/image-full and include their own "image" field.

Slide structure: { title, bullets?: string[], layout?: string, image?: string, subtitle?: string }

Themes: dark (default), midnight (deep blue-black), ocean (light), sunset (warm), forest (green).

IMPORTANT: For visually impressive results, ALWAYS search for relevant images first (use url_fetch or web_search to find image URLs), then pass those URLs in the "images" array. Use image-left and image-right layouts for impact.`,
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
              layout: { type: 'string', description: 'Slide layout: bullets, image-left, image-right, image-full, quote' },
              image: { type: 'string', description: 'Image URL for image-left/image-right/image-full layouts' },
              subtitle: { type: 'string', description: 'Subtitle or attribution' },
            },
            required: ['title'],
          },
        },
        filename: { type: 'string', description: 'Output filename (default: <title>.pptx)' },
        theme: { type: 'string', description: 'Color theme: dark, midnight, ocean, sunset, forest' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Image URLs to embed in presentation. First image becomes cover background. Subsequent images used for image-left/image-right/image-full slides.',
        },
      },
      required: ['title', 'slides'],
    },
    handler: createPptHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  // ── Email Tools ──

  registry.register({
    name: 'send_email_with_attachments',
    description: 'Send an email with optional file attachments via SMTP. Configure SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in environment or pass inline.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Plain text email body' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Optional: paths to attachment files' },
        smtpHost: { type: 'string', description: 'Optional: SMTP server hostname' },
        smtpPort: { type: 'number', description: 'Optional: SMTP port (default 587)' },
        smtpUser: { type: 'string', description: 'Optional: SMTP username' },
        smtpPass: { type: 'string', description: 'Optional: SMTP password' },
      },
      required: ['to', 'subject'],
    },
    handler: sendEmailWithAttachments,
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'read_email_attachments',
    description: 'Read recent emails from Outlook inbox (Windows only). Lists subject, sender, time, and attachment details.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max emails to list (default 10)' },
      },
      required: [],
    },
    handler: readEmailAttachments,
    permission: 'user',
    securityLevel: 'confirm',
  });
}

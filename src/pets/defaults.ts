import { PetConfig, DEFAULT_ATLAS, PetPalette, CustomPetTags, PetSpecies, BUILTIN_PALETTES } from './types';

const CW = 192;
const CH = 208;
const COLS = 8;
const ROWS = 9;

function createSpritesheetCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CW;
  canvas.height = ROWS * CH;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return [canvas, ctx];
}

type FrameDrawer = (ctx: CanvasRenderingContext2D, cx: number, cy: number, frame: number, total: number) => void;

function drawRow(ctx: CanvasRenderingContext2D, row: number, frameCount: number, draw: FrameDrawer) {
  for (let f = 0; f < frameCount; f++) {
    const cx = f * CW;
    const cy = row * CH;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.rect(0, 0, CW, CH);
    ctx.clip();
    draw(ctx, cx, cy, f, frameCount);
    ctx.restore();
  }
}

function canvasToDataURL(canvas: HTMLCanvasElement): string {
  // PNG for max compatibility across WebView2 / all browsers
  return canvas.toDataURL('image/png');
}

// ── Drawing helpers ──

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function drawEyes(ctx: CanvasRenderingContext2D, cx: number, cy: number, eyeShape: string, eyeColor: string, eyeWhite: string, blink: number, scale: number) {
  const s = scale;
  if (blink > 0.85) {
    ctx.strokeStyle = eyeColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 12 * s, cy);
    ctx.lineTo(cx - 4 * s, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 4 * s, cy);
    ctx.lineTo(cx + 12 * s, cy);
    ctx.stroke();
    return;
  }
  // White
  ctx.fillStyle = eyeWhite;
  if (eyeShape === 'star') {
    drawStar(ctx, cx - 11 * s, cy, 7 * s, 5, 0.5);
    drawStar(ctx, cx + 11 * s, cy, 7 * s, 5, 0.5);
  } else if (eyeShape === 'heart') {
    drawHeart(ctx, cx - 11 * s, cy, 6 * s);
    drawHeart(ctx, cx + 11 * s, cy, 6 * s);
  } else if (eyeShape === 'slit') {
    ctx.beginPath();
    ctx.ellipse(cx - 11 * s, cy, 7 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 11 * s, cy, 7 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(cx - 11 * s, cy, 6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 11 * s, cy, 6 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pupil
  ctx.fillStyle = eyeColor;
  if (eyeShape === 'slit') {
    ctx.beginPath();
    ctx.ellipse(cx - 11 * s, cy, 2.5 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 11 * s, cy, 2.5 * s, 5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (eyeShape === 'star') {
    ctx.beginPath();
    ctx.arc(cx - 11 * s, cy, 3 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 11 * s, cy, 3 * s, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(cx - 10 * s, cy, 3.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 10 * s, cy, 3.5 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shine
  ctx.fillStyle = eyeWhite;
  ctx.beginPath();
  ctx.arc(cx - 13 * s, cy - 3 * s, 2 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 8 * s, cy - 3 * s, 2 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, points: number, inset: number) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? r : r * inset;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawHeart(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s);
  ctx.quadraticCurveTo(cx - s * 1.5, cy, cx, cy - s * 0.5);
  ctx.quadraticCurveTo(cx + s * 1.5, cy, cx, cy + s);
  ctx.fill();
}

// ── Pattern rendering ──

function applyPattern(ctx: CanvasRenderingContext2D, cx: number, cy: number, bodyW: number, bodyH: number, pattern: string, patternColor: string, frame: number) {
  ctx.save();
  ctx.fillStyle = patternColor;
  ctx.globalAlpha = 0.4;
  if (pattern === 'striped') {
    const stripeW = 6;
    ctx.beginPath();
    ctx.rect(cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH);
    ctx.clip();
    for (let i = -bodyW / 2; i < bodyW; i += stripeW * 2) {
      ctx.fillRect(cx + i, cy - bodyH / 2, stripeW, bodyH);
    }
  } else if (pattern === 'spotted') {
    ctx.beginPath();
    ctx.rect(cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH);
    ctx.clip();
    for (let i = 0; i < 8; i++) {
      const sx = cx - bodyW / 3 + (i % 3) * bodyW / 3 + Math.sin(i * 2 + frame) * 4;
      const sy = cy - bodyH / 3 + Math.floor(i / 3) * bodyH / 3;
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (pattern === 'bicolor') {
    ctx.beginPath();
    ctx.rect(cx - bodyW / 2, cy - bodyH / 2, bodyW / 2, bodyH);
    ctx.clip();
    ctx.fillRect(cx - bodyW / 2, cy - bodyH / 2, bodyW / 2, bodyH);
  } else if (pattern === 'gradient') {
    const grad = ctx.createLinearGradient(cx, cy - bodyH / 2, cx, cy + bodyH / 2);
    grad.addColorStop(0, patternColor);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.rect(cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH);
    ctx.clip();
    ctx.fillRect(cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH);
  }
  ctx.restore();
}

// ── Special effects ──

function drawSpecialEffect(ctx: CanvasRenderingContext2D, cx: number, cy: number, special: string, frame: number) {
  if (special === 'glowing') {
    ctx.fillStyle = 'rgba(255,255,200,0.08)';
    ctx.beginPath();
    ctx.arc(cx, cy, 50 + Math.sin(frame * 0.5) * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,200,0.15)';
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (special === 'sparkly') {
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 5; i++) {
      const sx = cx - 40 + (i * 20) + Math.sin(frame * 0.7 + i) * 10;
      const sy = cy - 40 + Math.cos(frame * 0.7 + i) * 10 + i * 15;
      ctx.globalAlpha = 0.3 + Math.sin(frame * 0.5 + i) * 0.3;
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ── Mouth drawing ──

function drawMouth(ctx: CanvasRenderingContext2D, cx: number, cy: number, style: string, color: string, scale: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (style) {
    case 'open':
      ctx.beginPath();
      ctx.ellipse(cx, cy + 2, 6 * scale, 4 * scale, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#330000';
      ctx.fill();
      ctx.fillStyle = '#ff6666';
      ctx.beginPath();
      ctx.ellipse(cx, cy - 1, 4 * scale, 2 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'shocked':
      ctx.beginPath();
      ctx.arc(cx, cy + 2, 6 * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#1a0000';
      ctx.fill();
      return;
    case 'tongue':
      ctx.beginPath();
      ctx.arc(cx, cy, 5 * scale, 0.1, Math.PI - 0.1);
      ctx.stroke();
      ctx.fillStyle = '#ff8888';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 5 * scale, 4 * scale, 3 * scale, 0, 0, Math.PI);
      ctx.fill();
      return;
    case 'neutral':
      ctx.beginPath();
      ctx.moveTo(cx - 6 * scale, cy);
      ctx.lineTo(cx + 6 * scale, cy);
      ctx.stroke();
      return;
    default: // smile
      ctx.beginPath();
      ctx.arc(cx, cy, 6 * scale, 0.1, Math.PI - 0.1);
      ctx.stroke();
  }
}

// ═══════════════════════════════════════════
// Species drawers — each draws one complete creature in one cell
// ═══════════════════════════════════════════

type CreatureDrawer = (
  ctx: CanvasRenderingContext2D,
  anim: { bounceY: number; extra: number; blink: number; frame: number; frameCount: number },
  p: PetPalette,
  tags: CustomPetTags,
  scale: number,
) => void;

// ── Cat ──

function drawCat(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number; frame: number }, p: PetPalette, _tags: CustomPetTags, s: number) {
  const cx = 96, cy = 100 + a.bounceY;

  // Tail
  ctx.strokeStyle = p.body;
  ctx.lineWidth = 8 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(30, 150 + a.bounceY);
  ctx.quadraticCurveTo(10 + a.extra * 15, 120 + a.bounceY, 25 + a.extra * 10, 80 + a.bounceY);
  ctx.stroke();

  // Feet
  ctx.fillStyle = p.bodyDark;
  roundRect(ctx, 55, 155 + a.bounceY, 30 * s, 20 * s, 8);
  roundRect(ctx, 105, 155 + a.bounceY, 30 * s, 20 * s, 8);

  // Body
  ctx.fillStyle = p.body;
  roundRect(ctx, 48, 90 + a.bounceY, 95 * s, 75 * s, 25);

  // Belly
  ctx.fillStyle = p.belly;
  roundRect(ctx, 65, 110 + a.bounceY, 60 * s, 45 * s, 18);

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx, 68 + a.bounceY, 40 * s, 0, Math.PI * 2);
  ctx.fill();

  // Ears
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(62 + a.extra, 48 + a.bounceY);
  ctx.lineTo(50 + a.extra, 8 + a.bounceY);
  ctx.lineTo(78 + a.extra, 35 + a.bounceY);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(130 - a.extra, 48 + a.bounceY);
  ctx.lineTo(142 - a.extra, 8 + a.bounceY);
  ctx.lineTo(114 - a.extra, 35 + a.bounceY);
  ctx.fill();

  // Eyes
  drawEyes(ctx, 96, 62 + a.bounceY, _tags.eyeShape || 'round', p.eye, p.eyeWhite, a.blink, 1);

  // Nose
  ctx.fillStyle = '#ff9999';
  ctx.beginPath();
  ctx.moveTo(96, 72 + a.bounceY);
  ctx.lineTo(91, 78 + a.bounceY);
  ctx.lineTo(101, 78 + a.bounceY);
  ctx.fill();

  // Whiskers
  ctx.strokeStyle = p.pattern;
  ctx.lineWidth = 1;
  for (const side of [-1, 1]) {
    const bx = 96 + side * 15;
    ctx.beginPath();
    ctx.moveTo(bx, 74 + a.bounceY);
    ctx.lineTo(bx + side * 25, 68 + a.bounceY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, 76 + a.bounceY);
    ctx.lineTo(bx + side * 25, 78 + a.bounceY);
    ctx.stroke();
  }

  drawMouth(ctx, 96, 80 + a.bounceY, _tags.mouthStyle || 'smile', p.bodyDark, 1);
}

// ── Blob ──

function drawBlob(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number }, p: PetPalette, _tags: CustomPetTags, s: number) {
  const cx = 96, cy = 110 + a.bounceY;
  const w = 80 + a.extra * 15;
  const h = 70 - a.extra * 10;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + h / 2 + 5, w / 2, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body gradient
  const grad = ctx.createRadialGradient(cx - 10, cy - 10, 5, cx, cy, w / 2);
  grad.addColorStop(0, p.accent);
  grad.addColorStop(0.6, p.body);
  grad.addColorStop(1, p.bodyDark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx - 15, cy - 15, w * 0.22, h * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();

  // Pattern
  if (_tags.pattern && _tags.pattern !== 'solid') {
    applyPattern(ctx, cx, cy, w, h, _tags.pattern, _tags.patternColor || p.pattern, a.blink > 0 ? 0 : 1);
  }

  // Eyes
  const eyeS = a.blink > 0.85 ? 0.1 : 1;
  const eyeY = cy - 8;
  ctx.fillStyle = p.eyeWhite;
  ctx.beginPath();
  ctx.ellipse(cx - 18, eyeY, 13 * eyeS, 15 * eyeS, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.eye;
  ctx.beginPath();
  ctx.arc(cx - 18, eyeY, 7 * eyeS, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.eyeWhite;
  ctx.beginPath();
  ctx.ellipse(cx + 18, eyeY, 13 * eyeS, 15 * eyeS, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.eye;
  ctx.beginPath();
  ctx.arc(cx + 18, eyeY, 7 * eyeS, 0, Math.PI * 2);
  ctx.fill();

  // Mouth
  ctx.strokeStyle = p.bodyDark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy + 5, 10, 0.1, Math.PI - 0.1);
  ctx.stroke();
}

// ── Bird ──

function drawBird(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number; frame: number }, p: PetPalette, _tags: CustomPetTags, s: number) {
  const cx = 96, cy = 100 + a.bounceY;

  // Tail feathers
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.moveTo(55, cy + 5);
  ctx.lineTo(20, cy - 15);
  ctx.lineTo(40, cy + 15);
  ctx.fill();
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(50, cy + 5);
  ctx.lineTo(15, cy - 5);
  ctx.lineTo(35, cy + 20);
  ctx.fill();

  // Body
  const bodyGrad = ctx.createRadialGradient(cx - 5, cy - 8, 8, cx, cy, 40);
  bodyGrad.addColorStop(0, p.body);
  bodyGrad.addColorStop(0.7, p.accent);
  bodyGrad.addColorStop(1, p.bodyDark);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 38 * s, 32 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wing
  ctx.save();
  ctx.translate(cx - 8, cy - 5);
  ctx.rotate(a.extra);
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.ellipse(0, 0, 25, 15, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.ellipse(0, 8, 20, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx + 15, cy - 28, 18 * s, 0, Math.PI * 2);
  ctx.fill();

  // Beak
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.moveTo(cx + 33, cy - 28);
  ctx.lineTo(cx + 50, cy - 24);
  ctx.lineTo(cx + 33, cy - 20);
  ctx.fill();

  // Eye
  ctx.fillStyle = p.eyeWhite;
  ctx.beginPath();
  ctx.arc(cx + 22, cy - 31, 8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.eye;
  ctx.beginPath();
  ctx.arc(cx + 23, cy - 31, 4.5 * s, 0, Math.PI * 2);
  ctx.fill();

  // Feet
  ctx.strokeStyle = p.pattern;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy + 32);
  ctx.lineTo(cx - 5, cy + 48);
  ctx.moveTo(cx - 5, cy + 48);
  ctx.lineTo(cx - 15, cy + 54);
  ctx.moveTo(cx - 5, cy + 48);
  ctx.lineTo(cx, cy + 54);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + 10, cy + 32);
  ctx.lineTo(cx + 10, cy + 48);
  ctx.moveTo(cx + 10, cy + 48);
  ctx.lineTo(cx, cy + 54);
  ctx.moveTo(cx + 10, cy + 48);
  ctx.lineTo(cx + 15, cy + 54);
  ctx.stroke();
}

// ── Dragon ──

function drawDragon(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number; frame: number }, p: PetPalette, tags: CustomPetTags, s: number) {
  // Dragon = cat body shape + spikes + wings + horns + slit eyes + open mouth
  const bounceY = a.bounceY;
  const cy = 100 + bounceY;

  // Back spikes (drawn BEFORE body so they sit behind)
  ctx.fillStyle = p.bodyDark;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(81 + i * 20, 72 + bounceY);
    ctx.lineTo(91 + i * 20, 52 + bounceY);
    ctx.lineTo(101 + i * 20, 72 + bounceY);
    ctx.fill();
  }

  // Wings
  if (tags.hasWings) {
    ctx.save();
    ctx.translate(96, 100 + bounceY);
    ctx.rotate(-0.3 + a.extra * 0.5);
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.moveTo(-20, 0);
    ctx.quadraticCurveTo(-45, -30, -20, -55);
    ctx.quadraticCurveTo(-5, -30, -20, 0);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Tail (spiked)
  ctx.strokeStyle = p.body;
  ctx.lineWidth = 8 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(30, 150 + bounceY);
  ctx.quadraticCurveTo(10 + a.extra * 15, 120 + bounceY, 25 + a.extra * 10, 80 + bounceY);
  ctx.stroke();
  // Tail spike
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.moveTo(25, 80 + bounceY);
  ctx.lineTo(15, 62 + bounceY);
  ctx.lineTo(33, 78 + bounceY);
  ctx.fill();

  // Feet
  ctx.fillStyle = p.bodyDark;
  roundRect(ctx, 55, 155 + bounceY, 30 * s, 20 * s, 8);
  roundRect(ctx, 105, 155 + bounceY, 30 * s, 20 * s, 8);

  // Body
  ctx.fillStyle = p.body;
  roundRect(ctx, 48, 90 + bounceY, 95 * s, 75 * s, 25);

  // Belly
  ctx.fillStyle = p.belly;
  roundRect(ctx, 65, 110 + bounceY, 60 * s, 45 * s, 18);

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(96, 68 + bounceY, 40 * s, 0, Math.PI * 2);
  ctx.fill();

  // Horns
  if (tags.hasHorns) {
    ctx.fillStyle = '#e8d44d';
    ctx.beginPath();
    ctx.moveTo(68, 30 + bounceY);
    ctx.lineTo(55, 5 + bounceY);
    ctx.lineTo(80, 28 + bounceY);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(124, 30 + bounceY);
    ctx.lineTo(137, 5 + bounceY);
    ctx.lineTo(112, 28 + bounceY);
    ctx.fill();
  }

  // Dragon ears (side nubs)
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(56, 48 + bounceY);
  ctx.lineTo(46, 28 + bounceY);
  ctx.lineTo(70, 40 + bounceY);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(136, 48 + bounceY);
  ctx.lineTo(146, 28 + bounceY);
  ctx.lineTo(122, 40 + bounceY);
  ctx.fill();

  // Eyes (dragon has slit pupils)
  drawEyes(ctx, 96, 62 + bounceY, 'slit', p.eye, p.eyeWhite, a.blink, 1);

  // Nose
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.moveTo(96, 72 + bounceY);
  ctx.lineTo(91, 78 + bounceY);
  ctx.lineTo(101, 78 + bounceY);
  ctx.fill();

  // Mouth (open, showing fire-breath potential)
  drawMouth(ctx, 96, 80 + bounceY, 'open', p.bodyDark, 0.9);

  // Small flame puff in mouth when extra is positive
  if (a.extra > 0.1) {
    ctx.fillStyle = 'rgba(255,150,30,0.3)';
    ctx.beginPath();
    ctx.arc(96 + a.extra * 20, 80 + bounceY, 5 + a.extra * 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Fox ──

function drawFox(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number }, p: PetPalette, tags: CustomPetTags, s: number) {
  const cx = 96, cy = 100 + a.bounceY;

  // Bushy tail with white tip
  ctx.strokeStyle = p.body;
  ctx.lineWidth = 12 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(35, cy + 10);
  ctx.quadraticCurveTo(5 + a.extra * 15, cy - 15, 20, cy - 35);
  ctx.stroke();
  // Tail tip
  ctx.strokeStyle = p.pattern;
  ctx.lineWidth = 8 * s;
  ctx.beginPath();
  ctx.moveTo(18, cy - 28);
  ctx.lineTo(22, cy - 38);
  ctx.stroke();

  // Feet
  ctx.fillStyle = p.bodyDark;
  roundRect(ctx, 52, 152 + a.bounceY, 26 * s, 18 * s, 7);
  roundRect(ctx, 108, 152 + a.bounceY, 26 * s, 18 * s, 7);

  // Body
  ctx.fillStyle = p.body;
  roundRect(ctx, 46, 85 + a.bounceY, 92 * s, 72 * s, 22);

  // Belly
  ctx.fillStyle = p.belly;
  roundRect(ctx, 62, 108 + a.bounceY, 58 * s, 40 * s, 16);

  // Pattern on body
  if (tags.pattern && tags.pattern !== 'solid') {
    applyPattern(ctx, cx, cy, 92, 72, tags.pattern, tags.patternColor || p.pattern, a.blink);
  }

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx, 62 + a.bounceY, 38 * s, 0, Math.PI * 2);
  ctx.fill();

  // Large triangular ears
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(60 + a.extra * 3, 40 + a.bounceY);
  ctx.lineTo(42 + a.extra * 3, -2 + a.bounceY);
  ctx.lineTo(80 + a.extra * 3, 28 + a.bounceY);
  ctx.fill();
  // Inner ear
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.moveTo(62 + a.extra * 3, 38 + a.bounceY);
  ctx.lineTo(48 + a.extra * 3, 5 + a.bounceY);
  ctx.lineTo(75 + a.extra * 3, 28 + a.bounceY);
  ctx.fill();

  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(132 - a.extra * 3, 40 + a.bounceY);
  ctx.lineTo(150 - a.extra * 3, -2 + a.bounceY);
  ctx.lineTo(112 - a.extra * 3, 28 + a.bounceY);
  ctx.fill();
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.moveTo(130 - a.extra * 3, 38 + a.bounceY);
  ctx.lineTo(144 - a.extra * 3, 5 + a.bounceY);
  ctx.lineTo(117 - a.extra * 3, 28 + a.bounceY);
  ctx.fill();

  // Face white markings
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.ellipse(cx, 72 + a.bounceY, 25 * s, 15 * s, 0, 0, Math.PI);
  ctx.fill();

  // Eyes
  drawEyes(ctx, 96, 60 + a.bounceY, tags.eyeShape || 'oval', p.eye, p.eyeWhite, a.blink, s);

  // Nose
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.moveTo(96, 68 + a.bounceY);
  ctx.lineTo(92, 73 + a.bounceY);
  ctx.lineTo(100, 73 + a.bounceY);
  ctx.fill();

  drawMouth(ctx, 96, 76 + a.bounceY, tags.mouthStyle || 'smile', p.bodyDark, s);
}

// ── Rabbit ──

function drawRabbit(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number }, p: PetPalette, tags: CustomPetTags, s: number) {
  const cx = 96, cy = 100 + a.bounceY;

  // Round tail
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.arc(30, cy + 20, 12 * s, 0, Math.PI * 2);
  ctx.fill();

  // Feet
  ctx.fillStyle = p.bodyDark;
  roundRect(ctx, 50, 148 + a.bounceY, 28 * s, 16 * s, 8);
  roundRect(ctx, 110, 148 + a.bounceY, 28 * s, 16 * s, 8);

  // Body
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 5, 38 * s, 36 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Belly
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 10, 24 * s, 22 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx, cy - 30, 34 * s, 0, Math.PI * 2);
  ctx.fill();

  // Cheeks
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.arc(cx - 18, cy - 24, 8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 18, cy - 24, 8 * s, 0, Math.PI * 2);
  ctx.fill();

  // Long ears
  const earWobble = Math.sin(a.extra * 2) * 3;
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.ellipse(cx - 18 + earWobble, cy - 75, 10 * s, 30 * s, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.ellipse(cx - 18 + earWobble, cy - 75, 6 * s, 22 * s, -0.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.ellipse(cx + 18 - earWobble, cy - 75, 10 * s, 30 * s, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.ellipse(cx + 18 - earWobble, cy - 75, 6 * s, 22 * s, 0.1, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  drawEyes(ctx, 96, cy - 32, tags.eyeShape || 'round', p.eye, p.eyeWhite, a.blink, s);

  // Nose
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.moveTo(96, cy - 24);
  ctx.lineTo(91, cy - 19);
  ctx.lineTo(101, cy - 19);
  ctx.fill();

  // Buck teeth
  ctx.fillStyle = '#fff';
  ctx.fillRect(94, cy - 14, 4, 6);
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(94, cy - 14, 4, 6);

  // Whiskers
  ctx.strokeStyle = p.pattern;
  ctx.lineWidth = 1;
  for (const side of [-1, 1]) {
    const bx = 96 + side * 14;
    ctx.beginPath();
    ctx.moveTo(bx, cy - 22);
    ctx.lineTo(bx + side * 20, cy - 25);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx, cy - 19);
    ctx.lineTo(bx + side * 20, cy - 18);
    ctx.stroke();
  }
}

// ── Bear ──

function drawBear(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number }, p: PetPalette, tags: CustomPetTags, s: number) {
  const cx = 96, cy = 100 + a.bounceY;

  // Short tail
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.arc(30, cy + 15, 8 * s, 0, Math.PI * 2);
  ctx.fill();

  // Feet
  ctx.fillStyle = p.bodyDark;
  roundRect(ctx, 48, 148 + a.bounceY, 32 * s, 22 * s, 10);
  roundRect(ctx, 108, 148 + a.bounceY, 32 * s, 22 * s, 10);
  // Paw pads
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.arc(60, 158 + a.bounceY, 5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(120, 158 + a.bounceY, 5 * s, 0, Math.PI * 2);
  ctx.fill();

  // Body (stocky)
  const bodyGrad = ctx.createLinearGradient(cx, cy - 20, cx, cy + 30);
  bodyGrad.addColorStop(0, p.accent);
  bodyGrad.addColorStop(1, p.bodyDark);
  ctx.fillStyle = bodyGrad;
  roundRect(ctx, 40, 80 + a.bounceY, 108 * s, 78 * s, 28);

  // Belly
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 12, 32 * s, 28 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx, 58 + a.bounceY, 42 * s, 0, Math.PI * 2);
  ctx.fill();

  // Round ears
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(cx - 30, 24 + a.bounceY, 14 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.arc(cx - 30, 24 + a.bounceY, 8 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(cx + 30, 24 + a.bounceY, 14 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.arc(cx + 30, 24 + a.bounceY, 8 * s, 0, Math.PI * 2);
  ctx.fill();

  // Snout
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.ellipse(cx, 68 + a.bounceY, 18 * s, 12 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  drawEyes(ctx, 96, 52 + a.bounceY, tags.eyeShape || 'round', p.eye, p.eyeWhite, a.blink, s);

  // Nose
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.moveTo(96, 63 + a.bounceY);
  ctx.lineTo(91, 68 + a.bounceY);
  ctx.lineTo(101, 68 + a.bounceY);
  ctx.fill();

  drawMouth(ctx, 96, 72 + a.bounceY, tags.mouthStyle || 'neutral', p.bodyDark, s);
}

// ── Hamster ──

function drawHamster(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number }, p: PetPalette, tags: CustomPetTags, s: number) {
  const cx = 96, cy = 105 + a.bounceY;

  // Tiny tail
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(34, cy + 20, 4 * s, 0, Math.PI * 2);
  ctx.fill();

  // Feet (tiny)
  ctx.fillStyle = p.pattern;
  roundRect(ctx, 58, 152 + a.bounceY, 20 * s, 12 * s, 6);
  roundRect(ctx, 112, 152 + a.bounceY, 20 * s, 12 * s, 6);

  // Body (round)
  const bodyGrad = ctx.createRadialGradient(cx - 5, cy - 5, 5, cx, cy, 42);
  bodyGrad.addColorStop(0, p.accent);
  bodyGrad.addColorStop(0.7, p.body);
  bodyGrad.addColorStop(1, p.bodyDark);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 40 * s, 35 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Belly
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 5, 26 * s, 20 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Pattern on body
  if (tags.pattern && tags.pattern !== 'solid') {
    applyPattern(ctx, cx, cy, 80, 70, tags.pattern, tags.patternColor || p.pattern, a.blink);
  }

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx, cy - 28, 30 * s, 0, Math.PI * 2);
  ctx.fill();

  // Chubby cheeks
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.arc(cx - 20, cy - 18, 10 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 20, cy - 18, 10 * s, 0, Math.PI * 2);
  ctx.fill();

  // Tiny ears
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(cx - 24, cy - 48, 8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.arc(cx - 24, cy - 48, 4 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(cx + 24, cy - 48, 8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.belly;
  ctx.beginPath();
  ctx.arc(cx + 24, cy - 48, 4 * s, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  drawEyes(ctx, 96, cy - 30, tags.eyeShape || 'round', p.eye, p.eyeWhite, a.blink, s * 0.9);

  // Nose
  ctx.fillStyle = p.pattern;
  ctx.beginPath();
  ctx.moveTo(96, cy - 18);
  ctx.lineTo(92, cy - 13);
  ctx.lineTo(100, cy - 13);
  ctx.fill();

  // Mouth (often open / eating)
  drawMouth(ctx, 96, cy - 10, tags.mouthStyle || 'smile', p.bodyDark, s * 0.8);

  // Cheek pouch lines
  ctx.strokeStyle = p.pattern;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(cx - 16, cy - 16, 5 * s, 0, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 16, cy - 16, 5 * s, 0, Math.PI);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ── Generic / Custom creature ──

function drawGeneric(ctx: CanvasRenderingContext2D, a: { bounceY: number; extra: number; blink: number }, p: PetPalette, tags: CustomPetTags, s: number) {
  const cx = 96, cy = 100 + a.bounceY;
  const size = tags.size === 'tiny' ? 0.6 : tags.size === 'small' ? 0.8 : tags.size === 'large' ? 1.2 : 1;
  const ss = s * size;

  // Tail (for non-round)
  if (tags.species !== 'blob') {
    ctx.strokeStyle = p.body;
    ctx.lineWidth = 8 * ss;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(35, cy + 10);
    ctx.quadraticCurveTo(10 + a.extra * 10, cy - 10, 25, cy - 25);
    ctx.stroke();
  }

  // Feet
  ctx.fillStyle = p.bodyDark;
  roundRect(ctx, 55, 155 + a.bounceY, 28 * ss, 18 * ss, 7);
  roundRect(ctx, 105, 155 + a.bounceY, 28 * ss, 18 * ss, 7);

  // Body
  const bodyGrad = ctx.createLinearGradient(cx, cy - 20 * ss, cx, cy + 30 * ss);
  bodyGrad.addColorStop(0, p.accent);
  bodyGrad.addColorStop(1, p.bodyDark);
  ctx.fillStyle = bodyGrad;
  if (tags.species === 'blob') {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 50 * ss, 42 * ss, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundRect(ctx, cx - 35 * ss, cy - 18 * ss, 70 * ss, 50 * ss, 22 * ss);
  }

  // Belly
  ctx.fillStyle = p.belly;
  if (tags.species === 'blob') {
    ctx.beginPath();
    ctx.ellipse(cx, cy + 5, 30 * ss, 22 * ss, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundRect(ctx, cx - 18 * ss, cy + 5, 36 * ss, 22 * ss, 12 * ss);
  }

  // Pattern
  if (tags.pattern && tags.pattern !== 'solid') {
    applyPattern(ctx, cx, cy, 70 * ss, 50 * ss, tags.pattern, tags.patternColor || p.pattern, a.blink);
  }

  // Wings
  if (tags.hasWings && tags.species !== 'blob') {
    ctx.save();
    ctx.translate(cx - 5, cy - 10);
    ctx.rotate(-0.2 + a.extra * 0.5);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-22, -28, -8, -45);
    ctx.quadraticCurveTo(4, -24, 0, 0);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Horns
  if (tags.hasHorns && tags.species !== 'blob') {
    ctx.fillStyle = '#e8d44d';
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 30);
    ctx.lineTo(cx - 16, cy - 50);
    ctx.lineTo(cx, cy - 28);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 4, cy - 30);
    ctx.lineTo(cx + 2, cy - 50);
    ctx.lineTo(cx + 12, cy - 28);
    ctx.fill();
  }

  // Ears (for no wings/no horns)
  if (!tags.hasWings && !tags.hasHorns && tags.species !== 'blob') {
    ctx.fillStyle = p.body;
    ctx.beginPath();
    ctx.moveTo(62, 52);
    ctx.lineTo(52, 18);
    ctx.lineTo(78, 42);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(130, 52);
    ctx.lineTo(140, 18);
    ctx.lineTo(114, 42);
    ctx.fill();
  }

  // Head
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.arc(cx, cy - 22 * ss, 36 * ss, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  drawEyes(ctx, 96, cy - 27 * ss, tags.eyeShape || 'round', p.eye, p.eyeWhite, a.blink, ss);

  // Nose/beak
  if (tags.hasWings && !tags.hasHorns) {
    ctx.fillStyle = p.pattern;
    ctx.beginPath();
    ctx.moveTo(cx + 32 * ss, cy - 22 * ss);
    ctx.lineTo(cx + 48 * ss, cy - 18 * ss);
    ctx.lineTo(cx + 32 * ss, cy - 14 * ss);
    ctx.fill();
  } else if (tags.species !== 'blob') {
    ctx.fillStyle = p.pattern;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 15 * ss);
    ctx.lineTo(cx - 4, cy - 10 * ss);
    ctx.lineTo(cx + 4, cy - 10 * ss);
    ctx.fill();
  }

  // Mouth
  if (tags.species !== 'blob') {
    drawMouth(ctx, cx, cy - 8 * ss, tags.mouthStyle || 'smile', p.bodyDark, ss);
  }
}

// ═══════════════════════════════════════════
// Species registry
// ═══════════════════════════════════════════

const SPECIES_DRAWERS: Record<PetSpecies, CreatureDrawer> = {
  cat: drawCat,
  blob: drawBlob,
  bird: drawBird,
  dragon: drawDragon,
  fox: drawFox,
  rabbit: drawRabbit,
  bear: drawBear,
  hamster: drawHamster,
  custom: drawGeneric,
};

// ═══════════════════════════════════════════
// Spritesheet generator — shared across all species
// ═══════════════════════════════════════════

function generateSpritesheet(drawer: CreatureDrawer, palette: PetPalette, tags: CustomPetTags): string {
  const [canvas, ctx] = createSpritesheetCanvas();

  const rowDefs: { row: number; frames: number; anim: (f: number, t: number) => { bounceY: number; extra: number; blink: number } }[] = [
    { row: 0, frames: 6, anim: (f) => ({ bounceY: Math.sin(f * Math.PI / 3) * 3, extra: 0, blink: f === 0 ? 0.9 : 0 }) },
    { row: 1, frames: 8, anim: (f) => ({ bounceY: Math.abs(Math.sin(f * Math.PI / 4)) * 8, extra: Math.sin(f * 0.5), blink: 0 }) },
    { row: 2, frames: 8, anim: (f) => ({ bounceY: Math.abs(Math.sin(f * Math.PI / 4)) * 8, extra: Math.sin(f * 0.5), blink: 0 }) },
    { row: 3, frames: 4, anim: (f) => ({ bounceY: Math.sin(f * Math.PI / 2) * 4, extra: 0.6, blink: 0 }) },
    { row: 4, frames: 6, anim: (f) => ({ bounceY: f < 3 ? -20 - f * 8 : -20 + (f - 3) * 12, extra: 0.5, blink: 0 }) },
    { row: 5, frames: 4, anim: (f) => ({ bounceY: 0, extra: -0.2, blink: f >= 2 ? 0.95 : 0 }) },
    { row: 6, frames: 4, anim: (f) => ({ bounceY: Math.sin(f * Math.PI / 2) * 2, extra: 0, blink: 0 }) },
    { row: 7, frames: 8, anim: (f) => ({ bounceY: Math.abs(Math.sin(f * Math.PI / 4)) * 12, extra: Math.sin(f * 0.6), blink: 0 }) },
    { row: 8, frames: 4, anim: (f) => ({ bounceY: 0, extra: 0, blink: 0 }) },
  ];

  for (const def of rowDefs) {
    drawRow(ctx, def.row, def.frames, (_c, _x, _y, f, t) => {
      const a = def.anim(f, t);
      if (def.row === 2) {
        // Run left — mirror
        _c.save();
        _c.translate(CW / 2, 0);
        _c.scale(-1, 1);
        _c.translate(-CW / 2, 0);
      }
      drawer(_c, { ...a, frame: f, frameCount: def.frames }, palette, tags, 1);
      // Special effects
      if (tags.special === 'glowing' || tags.special === 'sparkly') {
        drawSpecialEffect(_c, 96, 104, tags.special, f);
      }
      if (def.row === 2) {
        _c.restore();
      }
      // Dizzy stars / Zzz for special rows
      if (def.row === 5 && f % 2 === 0) {
        _c.fillStyle = '#ffdd44';
        _c.font = '18px sans-serif';
        _c.fillText('✦', 130, 25);
      }
      if (def.row === 6 && f > 0) {
        _c.fillStyle = '#aaddff';
        _c.font = `${10 + f * 3}px sans-serif`;
        _c.fillText('Z', 135 + f * 8, 40 - f * 8);
      }
      if (def.row === 3) {
        // Wave paw overlay
        const waveAngle = Math.sin(f * Math.PI / 2) * 0.5;
        _c.save();
        _c.translate(130, 60);
        _c.rotate(-0.3 + waveAngle);
        _c.fillStyle = palette.bodyDark;
        if (tags.species !== 'blob') {
          roundRect(_c, -8, -15, 18, 22, 8);
          _c.fillStyle = palette.accent;
          roundRect(_c, -4, -12, 10, 10, 5);
        }
        _c.restore();
      }
    });
  }

  return canvasToDataURL(canvas);
}

// ═══════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════

export function generateCustomPet(name: string, tags: CustomPetTags): PetConfig {
  const palette = BUILTIN_PALETTES[tags.species] || BUILTIN_PALETTES.cat;
  // If a custom color is specified, override the palette
  const colorOverride = tags.color && tags.color !== palette.body;
  const effectivePalette: PetPalette = colorOverride
    ? { ...palette, body: tags.color, bodyDark: darken(tags.color), accent: lighten(tags.color), pattern: tags.patternColor || palette.pattern }
    : { ...palette, pattern: tags.patternColor || palette.pattern };
  if (tags.eyeColor) effectivePalette.eye = tags.eyeColor;

  const drawer = SPECIES_DRAWERS[tags.species] || drawGeneric;
  const sheet = generateSpritesheet(drawer, effectivePalette, tags);

  return {
    id: `custom-${Date.now()}`,
    name,
    author: 'AI Generated',
    spritesheet: sheet,
    atlas: DEFAULT_ATLAS,
    thumbnail: sheet,
    palette: effectivePalette,
    tags,
  };
}

export function recolorPet(pet: PetConfig, palette: PetPalette): PetConfig {
  const drawer = SPECIES_DRAWERS[pet.tags?.species || 'custom'];
  const tags = pet.tags || { species: 'custom' as PetSpecies, color: palette.body };
  const sheet = generateSpritesheet(drawer, palette, tags);
  return { ...pet, id: `recolor-${Date.now()}`, spritesheet: sheet, thumbnail: sheet, palette, tags };
}

// Simple color math
function darken(hex: string): string { return shiftColor(hex, -25); }
function lighten(hex: string): string { return shiftColor(hex, 25); }
function hexToRgba(hex: string, alpha: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = (num >> 16) & 0xFF;
  const g = (num >> 8) & 0xFF;
  const b = num & 0xFF;
  return `rgba(${r},${g},${b},${alpha})`;
}

function shiftColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, ((num >> 16) & 0xFF) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xFF) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xFF) + amount));
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

// ── Built-in pets (generated once, cached) ──

let _defaults: PetConfig[] | null = null;

export function getDefaultPets(): PetConfig[] {
  if (_defaults) return _defaults;

  _defaults = [
    { id: 'lumi-cat',    name: 'Lumi Cat',    author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.cat,    tags: { species: 'cat', color: BUILTIN_PALETTES.cat.body, eyeShape: 'round', mouthStyle: 'smile', size: 'normal' } },
    { id: 'lumi-blob',   name: 'Lumi Blob',   author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.blob,   tags: { species: 'blob', color: BUILTIN_PALETTES.blob.body, eyeShape: 'round', mouthStyle: 'smile', size: 'normal' } },
    { id: 'lumi-bird',   name: 'Lumi Bird',   author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.bird,   tags: { species: 'bird', color: BUILTIN_PALETTES.bird.body, eyeShape: 'round', mouthStyle: 'neutral', size: 'normal' } },
    { id: 'lumi-dragon', name: 'Lumi Dragon', author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.dragon, tags: { species: 'dragon', color: BUILTIN_PALETTES.dragon.body, eyeShape: 'slit', mouthStyle: 'open', size: 'normal', hasWings: true, hasHorns: true } },
    { id: 'lumi-fox',    name: 'Lumi Fox',    author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.fox,    tags: { species: 'fox', color: BUILTIN_PALETTES.fox.body, eyeShape: 'oval', mouthStyle: 'smile', size: 'normal' } },
    { id: 'lumi-rabbit', name: 'Lumi Rabbit', author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.rabbit, tags: { species: 'rabbit', color: BUILTIN_PALETTES.rabbit.body, eyeShape: 'round', mouthStyle: 'smile', size: 'normal' } },
    { id: 'lumi-bear',   name: 'Lumi Bear',   author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.bear,   tags: { species: 'bear', color: BUILTIN_PALETTES.bear.body, eyeShape: 'round', mouthStyle: 'neutral', size: 'large' } },
    { id: 'lumi-hamster',name: 'Lumi Hamster',author: 'LumiCore', spritesheet: '', atlas: DEFAULT_ATLAS, palette: BUILTIN_PALETTES.hamster,tags: { species: 'hamster', color: BUILTIN_PALETTES.hamster.body, eyeShape: 'round', mouthStyle: 'smile', size: 'small' } },
  ];

  // Generate spritesheets
  for (const pet of _defaults) {
    try {
      const drawer = SPECIES_DRAWERS[pet.tags!.species] || drawGeneric;
      pet.spritesheet = generateSpritesheet(drawer, pet.palette!, pet.tags!);
      pet.thumbnail = pet.spritesheet;
    } catch (err) {
      console.error(`[PetGen] Failed to generate spritesheet for ${pet.id}:`, err);
      // Fallback: use a tiny placeholder
      pet.spritesheet = 'data:image/webp;base64,';
      pet.thumbnail = pet.spritesheet;
    }
  }

  return _defaults;
}

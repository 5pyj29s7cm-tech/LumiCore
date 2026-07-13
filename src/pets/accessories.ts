// Pet accessory definitions — procedurally drawn overlays composited on Canvas

export type AccessoryCategory = 'hat' | 'glasses' | 'scarf' | 'collar' | 'ears' | 'tail' | 'mask' | 'back' | 'faceMark' | 'aura';

export interface AccessoryDef {
  id: string;
  name: string;
  category: AccessoryCategory;
  /** Draw the accessory on canvas context at given cell dimensions */
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, frameIndex: number) => void;
}

function hatPropeller(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  // Beanie base
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.08, w * 0.18, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(w * 0.28, h * 0, w * 0.44, h * 0.08);
  // Propeller
  ctx.fillStyle = '#f39c12';
  ctx.fillRect(w * 0.48, h * 0 - h * 0.04, w * 0.04, h * 0.04);
  const bladeAngle = (_f * 0.6) % (Math.PI * 2);
  ctx.save();
  ctx.translate(w * 0.5, h * 0 - h * 0.04);
  ctx.rotate(bladeAngle);
  ctx.fillStyle = '#3498db';
  ctx.fillRect(-w * 0.12, -h * 0.01, w * 0.24, h * 0.02);
  ctx.restore();
}

function hatCrown(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#f1c40f';
  ctx.beginPath();
  // Crown base
  ctx.moveTo(w * 0.25, h * 0.1);
  ctx.lineTo(w * 0.75, h * 0.1);
  ctx.lineTo(w * 0.75, h * 0.03);
  ctx.lineTo(w * 0.68, h * 0);
  ctx.lineTo(w * 0.62, h * 0.06);
  ctx.lineTo(w * 0.56, h * 0 - h * 0.04);
  ctx.lineTo(w * 0.5, h * 0.03);
  ctx.lineTo(w * 0.44, h * 0 - h * 0.04);
  ctx.lineTo(w * 0.38, h * 0.06);
  ctx.lineTo(w * 0.32, h * 0);
  ctx.lineTo(w * 0.25, h * 0.03);
  ctx.closePath();
  ctx.fill();
  // Jewels
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath(); ctx.arc(w * 0.5, h * 0.05, w * 0.02, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(w * 0.4, h * 0.06, w * 0.015, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(w * 0.6, h * 0.06, w * 0.015, 0, Math.PI * 2); ctx.fill();
}

function glassesRound(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.strokeStyle = '#2c3e50';
  ctx.lineWidth = w * 0.015;
  // Left lens
  ctx.beginPath();
  ctx.arc(w * 0.38, h * 0.22, w * 0.1, 0, Math.PI * 2);
  ctx.stroke();
  // Right lens
  ctx.beginPath();
  ctx.arc(w * 0.62, h * 0.22, w * 0.1, 0, Math.PI * 2);
  ctx.stroke();
  // Bridge
  ctx.beginPath();
  ctx.moveTo(w * 0.48, h * 0.22);
  ctx.lineTo(w * 0.52, h * 0.22);
  ctx.stroke();
  // Lens tint
  ctx.fillStyle = 'rgba(52,152,219,0.1)';
  ctx.beginPath(); ctx.arc(w * 0.38, h * 0.22, w * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(w * 0.62, h * 0.22, w * 0.09, 0, Math.PI * 2); ctx.fill();
}

function glassesSunglasses(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#1a1a2e';
  ctx.beginPath();
  ctx.rect(w * 0.24, h * 0.17, w * 0.22, h * 0.1);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(w * 0.54, h * 0.17, w * 0.22, h * 0.1);
  ctx.fill();
  // Bridge
  ctx.fillStyle = '#333';
  ctx.fillRect(w * 0.46, h * 0.2, w * 0.08, h * 0.03);
  // Reflection
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(w * 0.26, h * 0.18, w * 0.1, h * 0.03);
  ctx.fillRect(w * 0.56, h * 0.18, w * 0.1, h * 0.03);
}

function scarfWarm(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.moveTo(w * 0.35, h * 0.16);
  ctx.lineTo(w * 0.65, h * 0.16);
  ctx.lineTo(w * 0.7, h * 0.22);
  ctx.lineTo(w * 0.3, h * 0.22);
  ctx.closePath();
  ctx.fill();
  // Dangling end
  ctx.beginPath();
  ctx.moveTo(w * 0.32, h * 0.2);
  ctx.lineTo(w * 0.38, h * 0.2);
  ctx.lineTo(w * 0.38, h * 0.32);
  ctx.lineTo(w * 0.32, h * 0.3);
  ctx.closePath();
  ctx.fill();
  // Stripe
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(w * 0.32, h * 0.19, w * 0.36, h * 0.02);
}

function collarSpiked(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(w * 0.3, h * 0.17, w * 0.4, h * 0.04);
  // Spikes
  ctx.fillStyle = '#95a5a6';
  for (let i = 0; i < 5; i++) {
    const cx = w * (0.32 + i * 0.08);
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.02, h * 0.17);
    ctx.lineTo(cx, h * 0.12);
    ctx.lineTo(cx + w * 0.02, h * 0.17);
    ctx.closePath();
    ctx.fill();
  }
}

function earsBunny(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#f5c6d0';
  // Left ear
  ctx.beginPath();
  ctx.ellipse(w * 0.34, h * 0.02, w * 0.06, h * 0.12, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffb3c1';
  ctx.beginPath();
  ctx.ellipse(w * 0.34, h * 0.03, w * 0.035, h * 0.08, -0.2, 0, Math.PI * 2);
  ctx.fill();
  // Right ear
  ctx.fillStyle = '#f5c6d0';
  ctx.beginPath();
  ctx.ellipse(w * 0.66, h * 0.02, w * 0.06, h * 0.12, 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffb3c1';
  ctx.beginPath();
  ctx.ellipse(w * 0.66, h * 0.03, w * 0.035, h * 0.08, 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function earsCat(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#ff9f43';
  // Left ear
  ctx.beginPath();
  ctx.moveTo(w * 0.28, h * 0.08);
  ctx.lineTo(w * 0.4, h * 0.08);
  ctx.lineTo(w * 0.32, h - h * 0.01);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffbe76';
  ctx.beginPath();
  ctx.moveTo(w * 0.3, h * 0.08);
  ctx.lineTo(w * 0.37, h * 0.07);
  ctx.lineTo(w * 0.33, h * 0.02);
  ctx.closePath();
  ctx.fill();
  // Right ear
  ctx.fillStyle = '#ff9f43';
  ctx.beginPath();
  ctx.moveTo(w * 0.72, h * 0.08);
  ctx.lineTo(w * 0.6, h * 0.08);
  ctx.lineTo(w * 0.68, h - h * 0.01);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffbe76';
  ctx.beginPath();
  ctx.moveTo(w * 0.7, h * 0.08);
  ctx.lineTo(w * 0.63, h * 0.07);
  ctx.lineTo(w * 0.67, h * 0.02);
  ctx.closePath();
  ctx.fill();
}

function tailCat(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  const sway = Math.sin(_f * 0.3) * w * 0.03;
  ctx.strokeStyle = '#ff9f43';
  ctx.lineWidth = w * 0.04;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(w * 0.82, h * 0.7);
  ctx.quadraticCurveTo(w * 0.95 + sway, h * 0.55, w * 0.9 + sway, h * 0.4);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(w * 0.9 + sway, h * 0.38, w * 0.025, 0, Math.PI * 2);
  ctx.fill();
}

// ── Mask accessories ──

function maskSurgical(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#e8f0fe';
  ctx.beginPath();
  ctx.rect(w * 0.3, h * 0.18, w * 0.4, h * 0.1);
  ctx.fill();
  ctx.strokeStyle = '#c0d0e0';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Pleats
  ctx.strokeStyle = '#d0d8e8';
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(w * 0.3, h * 0.18 + i * h * 0.03);
    ctx.lineTo(w * 0.7, h * 0.18 + i * h * 0.03);
    ctx.stroke();
  }
  // Ear loops
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w * 0.3, h * 0.2);
  ctx.lineTo(w * 0.22, h * 0.12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.7, h * 0.2);
  ctx.lineTo(w * 0.78, h * 0.12);
  ctx.stroke();
}

function maskFox(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#f0a060';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.22, w * 0.2, h * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(w * 0.38, h * 0.2, w * 0.04, h * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w * 0.62, h * 0.2, w * 0.04, h * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();
  // Ear holes
  ctx.fillStyle = '#a06030';
  ctx.beginPath();
  ctx.moveTo(w * 0.35, h * 0.14);
  ctx.lineTo(w * 0.42, h * 0.18);
  ctx.lineTo(w * 0.38, h * 0.12);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(w * 0.65, h * 0.14);
  ctx.lineTo(w * 0.58, h * 0.18);
  ctx.lineTo(w * 0.62, h * 0.12);
  ctx.fill();
}

// ── Back accessories ──

function backBackpack(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#e85d3a';
  roundRect(ctx, w * 0.62, h * 0.25, w * 0.16, h * 0.18, 6);
  ctx.fillStyle = '#d04020';
  roundRect(ctx, w * 0.66, h * 0.28, w * 0.08, h * 0.06, 3);
  // Straps
  ctx.strokeStyle = '#8B4513';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.62, h * 0.28);
  ctx.lineTo(w * 0.52, h * 0.22);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.62, h * 0.38);
  ctx.lineTo(w * 0.52, h * 0.34);
  ctx.stroke();
}

function backBow(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#f07080';
  ctx.beginPath();
  ctx.ellipse(w * 0.68, h * 0.28, w * 0.06, h * 0.04, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w * 0.82, h * 0.28, w * 0.06, h * 0.04, -0.4, 0, Math.PI * 2);
  ctx.fill();
  // Center knot
  ctx.fillStyle = '#d04050';
  ctx.beginPath();
  ctx.arc(w * 0.75, h * 0.28, w * 0.02, 0, Math.PI * 2);
  ctx.fill();
  // Ribbon tails
  ctx.strokeStyle = '#f07080';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(w * 0.75, h * 0.29);
  ctx.lineTo(w * 0.72, h * 0.36);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.75, h * 0.29);
  ctx.lineTo(w * 0.78, h * 0.37);
  ctx.stroke();
}

function backMiniWings(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  const flap = Math.sin(_f * 0.5) * 0.15;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  // Left wing
  ctx.save();
  ctx.translate(w * 0.6, h * 0.25);
  ctx.rotate(flap);
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.1, h * 0.04, -0.3, Math.PI * 0.6, Math.PI * 1.8);
  ctx.fill();
  ctx.restore();
  // Right wing
  ctx.save();
  ctx.translate(w * 0.8, h * 0.25);
  ctx.rotate(-flap);
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.1, h * 0.04, 0.3, Math.PI * 1.2, Math.PI * 2.4);
  ctx.fill();
  ctx.restore();
}

// ── Face mark accessories ──

function faceMarkBlush(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = 'rgba(255,150,150,0.3)';
  ctx.beginPath();
  ctx.arc(w * 0.32, h * 0.24, w * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(w * 0.68, h * 0.24, w * 0.06, 0, Math.PI * 2);
  ctx.fill();
}

function faceMarkStar(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = 'rgba(255,215,0,0.5)';
  const cx = w * 0.5, cy = h * 0.14;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? w * 0.03 : w * 0.015;
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function faceMarkHeart(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = 'rgba(255,100,150,0.4)';
  const cx = w * 0.5, cy = h * 0.13;
  const s = w * 0.035;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s);
  ctx.quadraticCurveTo(cx - s * 1.5, cy, cx, cy - s * 0.5);
  ctx.quadraticCurveTo(cx + s * 1.5, cy, cx, cy + s);
  ctx.fill();
}

// ── Aura accessories ──

function auraHalo(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.strokeStyle = 'rgba(255,215,0,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.02, w * 0.18, Math.PI, 0);
  ctx.stroke();
  // Glow
  ctx.strokeStyle = 'rgba(255,215,0,0.08)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.02, w * 0.18, Math.PI, 0);
  ctx.stroke();
}

function auraSparkles(ctx: CanvasRenderingContext2D, w: number, h: number, _f: number) {
  ctx.fillStyle = '#ffd700';
  const positions = [
    { x: 0.25, y: 0.05 }, { x: 0.7, y: 0.02 }, { x: 0.5, y: -0.02 },
    { x: 0.15, y: 0.15 }, { x: 0.8, y: 0.1 },
  ];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const twinkle = Math.sin(_f * 0.4 + i) * 0.4 + 0.6;
    ctx.globalAlpha = twinkle * 0.5;
    ctx.beginPath();
    ctx.arc(w * p.x, h * p.y, w * 0.015, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

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

export const ALL_ACCESSORIES: AccessoryDef[] = [
  { id: 'hat_propeller', name: 'Propeller Hat', category: 'hat', draw: hatPropeller },
  { id: 'hat_crown', name: 'Crown', category: 'hat', draw: hatCrown },
  { id: 'glasses_round', name: 'Round Glasses', category: 'glasses', draw: glassesRound },
  { id: 'glasses_sunglasses', name: 'Sunglasses', category: 'glasses', draw: glassesSunglasses },
  { id: 'scarf_warm', name: 'Warm Scarf', category: 'scarf', draw: scarfWarm },
  { id: 'collar_spiked', name: 'Spiked Collar', category: 'collar', draw: collarSpiked },
  { id: 'ears_bunny', name: 'Bunny Ears', category: 'ears', draw: earsBunny },
  { id: 'ears_cat', name: 'Cat Ears', category: 'ears', draw: earsCat },
  { id: 'tail_cat', name: 'Cat Tail', category: 'tail', draw: tailCat },
  // New: Masks
  { id: 'mask_surgical', name: 'Surgical Mask', category: 'mask', draw: maskSurgical },
  { id: 'mask_fox', name: 'Fox Mask', category: 'mask', draw: maskFox },
  // New: Back items
  { id: 'back_backpack', name: 'Tiny Backpack', category: 'back', draw: backBackpack },
  { id: 'back_bow', name: 'Back Bow', category: 'back', draw: backBow },
  { id: 'back_miniwings', name: 'Mini Wings', category: 'back', draw: backMiniWings },
  // New: Face marks
  { id: 'face_blush', name: 'Blush', category: 'faceMark', draw: faceMarkBlush },
  { id: 'face_star', name: 'Star Mark', category: 'faceMark', draw: faceMarkStar },
  { id: 'face_heart', name: 'Heart Mark', category: 'faceMark', draw: faceMarkHeart },
  // New: Auras
  { id: 'aura_halo', name: 'Halo', category: 'aura', draw: auraHalo },
  { id: 'aura_sparkles', name: 'Sparkles', category: 'aura', draw: auraSparkles },
];

export function getAccessoryById(id: string): AccessoryDef | undefined {
  return ALL_ACCESSORIES.find(a => a.id === id);
}

export function getAccessoriesByCategory(cat: AccessoryDef['category']): AccessoryDef[] {
  return ALL_ACCESSORIES.filter(a => a.category === cat);
}

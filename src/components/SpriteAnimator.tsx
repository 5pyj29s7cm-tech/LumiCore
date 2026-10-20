import { useRef, useEffect, useState, useCallback } from 'react';
import { getAccessoryById } from '../pets/accessories';

export interface AtlasDef {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  animations: Record<string, { row: number; frameCount: number; frameDuration: number }>;
}

export type PetBehavior = 'default' | 'cuddly' | 'playful' | 'calm' | 'curious' | 'energetic';

function behaviorToAnimation(behavior: PetBehavior, base: string): string {
  const overrides: Record<PetBehavior, Record<string, string>> = {
    default: {},
    cuddly: { idle: 'wave', waiting: 'idle' },
    playful: { idle: 'jump', waiting: 'wave', review: 'jump' },
    calm: { idle: 'waiting', run: 'idle' },
    curious: { idle: 'review', waiting: 'review' },
    energetic: { idle: 'runFast', waiting: 'jump', review: 'run' },
  };
  return overrides[behavior]?.[base] || base;
}

export function SpriteAnimator({
  spritesheet,
  atlas,
  animation = 'idle',
  scale = 1,
  className = '',
  style,
  onFrame,
  onAnimationEnd,
  accessoryIds,
}: {
  spritesheet: string;
  atlas: AtlasDef;
  animation?: string;
  scale?: number;
  className?: string;
  style?: React.CSSProperties;
  onFrame?: (frame: number) => void;
  onAnimationEnd?: (animName: string) => void;
  accessoryIds?: string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number>(0);
  const [loaded, setLoaded] = useState(false);
  const frameRef = useRef(0);
  const lastTimeRef = useRef(0);
  const elapsedRef = useRef(0);
  const animRef = useRef(animation);
  animRef.current = animation;

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setLoaded(true);
    };
    img.onerror = () => {
      console.warn('[SpriteAnimator] Failed to load spritesheet');
    };
    img.src = spritesheet;
    return () => { img.onload = null; img.onerror = null; };
  }, [spritesheet]);

  const drawFrame = useCallback((frameIndex: number) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !atlas) return;

    const { cellWidth, cellHeight, animations } = atlas;
    const anim = animations[animRef.current];
    if (!anim) return;

    const col = frameIndex % atlas.columns;
    const row = anim.row;
    const sx = col * cellWidth;
    const sy = row * cellHeight;

    canvas.width = cellWidth * scale;
    canvas.height = cellHeight * scale;

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, cellWidth, cellHeight, 0, 0, cellWidth * scale, cellHeight * scale);

    // Draw accessory overlays
    if (accessoryIds && accessoryIds.length > 0) {
      ctx.save();
      ctx.scale(scale, scale);
      for (const aid of accessoryIds) {
        const acc = getAccessoryById(aid);
        if (acc) {
          ctx.save();
          acc.draw(ctx, cellWidth, cellHeight, frameIndex);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    onFrame?.(frameIndex);
  }, [atlas, scale, onFrame, accessoryIds]);

  useEffect(() => {
    if (!loaded || !atlas) return;

    const { animations } = atlas;
    const anim = animations[animRef.current];
    if (!anim) return;

    frameRef.current = 0;
    elapsedRef.current = 0;
    lastTimeRef.current = 0;

    const tick = (time: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const delta = time - lastTimeRef.current;
      lastTimeRef.current = time;
      elapsedRef.current += delta;

      const currentAnim = animations[animRef.current];
      if (!currentAnim) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (elapsedRef.current >= currentAnim.frameDuration) {
        elapsedRef.current -= currentAnim.frameDuration;
        frameRef.current++;

        if (frameRef.current >= currentAnim.frameCount) {
          frameRef.current = 0;
          onAnimationEnd?.(animRef.current);
        }
      }

      drawFrame(frameRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [loaded, atlas, animation, drawFrame, onAnimationEnd]);

  // Initial draw
  useEffect(() => {
    if (loaded) drawFrame(0);
  }, [loaded, drawFrame]);

  const w = (atlas?.cellWidth || 192) * scale;
  const h = (atlas?.cellHeight || 208) * scale;

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className={className}
      style={{
        width: w,
        height: h,
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  );
}

export function PetAvatar({
  pet,
  animation = 'idle',
  scale = 1,
  className = '',
  style,
  audioLevel = 0,
  callState = 'idle',
  behavior = 'default',
  accessoryIds,
}: {
  pet: { spritesheet: string; atlas: AtlasDef };
  animation?: string;
  scale?: number;
  className?: string;
  style?: React.CSSProperties;
  audioLevel?: number;
  callState?: string;
  behavior?: PetBehavior;
  accessoryIds?: string[];
}) {
  // Audio-reactive: scale up slightly when speaking, mouth-like pulse on audioLevel
  const audioScale = callState !== 'idle' ? 1 + audioLevel * 0.15 : 1;
  // Behavior-driven animation override
  const effectiveAnim = behaviorToAnimation(behavior, animation);

  return (
    <div
      style={{
        transform: `scale(${audioScale})`,
        transition: 'transform 0.08s ease-out',
        ...(callState === 'speaking' ? { filter: `drop-shadow(0 0 ${6 + audioLevel * 20}px rgba(200,255,200,0.5))` } : {}),
      }}
    >
      <SpriteAnimator
        spritesheet={pet.spritesheet}
        atlas={pet.atlas}
        animation={effectiveAnim}
        scale={scale}
        className={className}
        style={style}
        accessoryIds={accessoryIds}
      />
    </div>
  );
}

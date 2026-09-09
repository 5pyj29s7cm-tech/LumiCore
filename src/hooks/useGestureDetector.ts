import { useEffect, useRef, useState, useCallback } from 'react';
import { initMediaPipe, detectHands, detectFaces, isMediaPipeReady } from '../lib/mediapipe/loader';
import { requestCameraStream } from '@/services/sensorPermissionService';

export interface GestureState {
  handOpenness: number;
  handPosition: { x: number; y: number };
  gesture: 'none' | 'fist' | 'open' | 'pinch' | 'point' | 'wave';
  handVisible: boolean;
  facePresent: boolean;
}

// MediaPipe Hand Landmark model indices
const WRIST = 0;
const THUMB_CMC = 1;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_TIP = 12;
const RING_TIP = 16;
const PINKY_TIP = 20;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;

function palmCenter(landmarks: Array<{ x: number; y: number; z: number }>) {
  const pts = [WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP];
  let cx = 0, cy = 0;
  for (const i of pts) { cx += landmarks[i].x; cy += landmarks[i].y; }
  return { x: cx / pts.length, y: cy / pts.length };
}

function fingerOpenness(
  tip: { x: number; y: number; z: number },
  mcp: { x: number; y: number; z: number },
  wrist: { x: number; y: number; z: number },
): number {
  const tipDist = Math.hypot(tip.x - wrist.x, tip.y - wrist.y, (tip.z - wrist.z) * 2);
  const mcpDist = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y, (mcp.z - wrist.z) * 2);
  const raw = tipDist / Math.max(mcpDist, 0.001);
  return Math.max(0, Math.min(1, (raw - 1.1) / 0.5));
}

function shallowEqual(a: GestureState, b: GestureState): boolean {
  return (
    a.handOpenness === b.handOpenness &&
    a.handPosition.x === b.handPosition.x &&
    a.handPosition.y === b.handPosition.y &&
    a.gesture === b.gesture &&
    a.handVisible === b.handVisible &&
    a.facePresent === b.facePresent
  );
}

export function useGestureDetector(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const animRef = useRef<number>(0);
  const faceTickRef = useRef(0);
  const lastWristX = useRef<number>(0);
  const wristVelocity = useRef<number>(0);
  const lastFrameTime = useRef(0);
  const lastFacePresent = useRef(false);

  // Hysteresis: confidence counter [0..5], >=3 = visible, <=2 = not visible
  const handConfidence = useRef(0);
  // Smoothed openness (exponential moving average)
  const smoothOpenness = useRef(0);
  // Gesture hysteresis: prevent flicker at classification boundaries
  const lastGesture = useRef<GestureState['gesture']>('none');

  const [state, setState] = useState<GestureState>({
    handOpenness: 0,
    handPosition: { x: 0, y: 0 },
    gesture: 'none',
    handVisible: false,
    facePresent: false,
  });

  const prevStateRef = useRef(state);
  const maybeSetState = useCallback((next: GestureState) => {
    if (!shallowEqual(prevStateRef.current, next)) {
      prevStateRef.current = next;
      setState(next);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let running = true;

    const start = async () => {
      try {
        await initMediaPipe();
        if (!running) return;

        const video = document.createElement('video');
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        video.muted = true;

        stream = await requestCameraStream({
          width: 480,
          height: 360,
          facingMode: 'user',
        });
        if (!running) { stream.getTracks().forEach(track => track.stop()); stream = null; return; }
        video.srcObject = stream;
        await video.play();

        lastFrameTime.current = performance.now();

        const loop = () => {
          if (!running) return;

          const now = performance.now();
          const frameDelta = Math.max(now - lastFrameTime.current, 1);
          lastFrameTime.current = now;

          if (video.readyState >= 2 && isMediaPipeReady()) {
            const hands = detectHands(video);

            if (hands.length > 0) {
              handConfidence.current = Math.min(handConfidence.current + 1, 5);
            } else {
              handConfidence.current = Math.max(handConfidence.current - 1, 0);
            }
            const handVisible = handConfidence.current >= 3;

            if (hands.length > 0) {
              const h = hands[0];
              const lm = h.landmarks;

              // Openness: average finger extension
              const fingers = [
                { tip: THUMB_TIP, mcp: THUMB_MCP },
                { tip: INDEX_TIP, mcp: INDEX_MCP },
                { tip: MIDDLE_TIP, mcp: MIDDLE_MCP },
                { tip: RING_TIP, mcp: RING_MCP },
                { tip: PINKY_TIP, mcp: PINKY_MCP },
              ];
              let opennessSum = 0;
              for (const f of fingers) {
                opennessSum += fingerOpenness(lm[f.tip], lm[f.mcp], lm[WRIST]);
              }
              const rawOpenness = opennessSum / fingers.length;

              // Exponential moving average — rise fast, fall slow
              const emaRate = rawOpenness > smoothOpenness.current ? 0.5 : 0.25;
              smoothOpenness.current += (rawOpenness - smoothOpenness.current) * emaRate;
              let openness = smoothOpenness.current;

              // Finger direction: index tip relative to palm center, normalized
              const palm = palmCenter(lm);
              const idxTip = lm[INDEX_TIP];
              const fdx = idxTip.x - palm.x;
              const fdy = idxTip.y - palm.y;
              const fmag = Math.hypot(fdx, fdy) || 0.001;
              const fx = (fdx / fmag) * 2; // scale to ~[-2, 2]
              const fy = -(fdy / fmag) * 2;

              // Wrist velocity (for wave detection)
              const wristPos = lm[WRIST];
              const wx = wristPos.x;
              const deltaSec = frameDelta * 0.001;
              wristVelocity.current = (wx - lastWristX.current) / deltaSec;
              lastWristX.current = wx;

              // Pinch detection
              const pinchDist = Math.hypot(
                lm[THUMB_TIP].x - lm[INDEX_TIP].x,
                lm[THUMB_TIP].y - lm[INDEX_TIP].y,
              );


              // Gesture classification (with hysteresis)
              let gesture: GestureState['gesture'] = 'none';
              const prev = lastGesture.current;
              if (openness < 0.3) {
                gesture = 'fist';
              } else if (openness > 0.5) {
                gesture = 'open';
              } else if (prev === 'fist' && openness < 0.4) {
                gesture = 'fist'; // hold fist until hand clearly opens
              } else if (prev === 'open' && openness > 0.35) {
                gesture = 'open'; // hold open until hand clearly closes
              } else if (pinchDist < 0.05) {
                gesture = 'pinch';
              }
              if (gesture !== 'none') lastGesture.current = gesture;

              if (Math.abs(wristVelocity.current) > 0.3 && openness < 0.5 && gesture !== 'fist') {
                gesture = 'wave';
              }

              // Point check
              const indexOpen = fingerOpenness(lm[INDEX_TIP], lm[INDEX_MCP], lm[WRIST]);
              const middleCurl = 1 - fingerOpenness(lm[MIDDLE_TIP], lm[MIDDLE_MCP], lm[WRIST]);
              const ringCurl = 1 - fingerOpenness(lm[RING_TIP], lm[RING_MCP], lm[WRIST]);
              const pinkyCurl = 1 - fingerOpenness(lm[PINKY_TIP], lm[PINKY_MCP], lm[WRIST]);
              if (indexOpen > 0.7 && middleCurl > 0.5 && ringCurl > 0.5 && pinkyCurl > 0.5) {
                gesture = 'point';
              }

              // Face detection (every 5 frames)
              faceTickRef.current++;
              if (faceTickRef.current % 5 === 0) {
                const faces = detectFaces(video);
                lastFacePresent.current = faces.length > 0;
                faceTickRef.current = 0;
              }

              maybeSetState({
                handOpenness: Math.round(openness * 100) / 100,
                handPosition: { x: Math.round(fx * 100) / 100, y: Math.round(fy * 100) / 100 },
                gesture,
                handVisible,
                facePresent: lastFacePresent.current,
              });
            } else {
              lastWristX.current = 0;
              wristVelocity.current = 0;
              smoothOpenness.current *= 0.7;
              lastGesture.current = 'none';

              faceTickRef.current++;
              if (faceTickRef.current % 5 === 0) {
                const faces = detectFaces(video);
                lastFacePresent.current = faces.length > 0;
                faceTickRef.current = 0;
              }
              maybeSetState({
                handOpenness: Math.round(smoothOpenness.current * 100) / 100,
                handPosition: { x: 0, y: 0 },
                gesture: 'none',
                handVisible,
                facePresent: lastFacePresent.current,
              });
            }
          }

          animRef.current = requestAnimationFrame(loop);
        };

        animRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.warn('[GestureDetector] Camera or MediaPipe init failed:', err);
      }
    };

    start();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    };
  }, [enabled, maybeSetState]);

  return { ...state };
}

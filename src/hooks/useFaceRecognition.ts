import { useEffect, useRef, useState, useCallback } from 'react';
import { requestCameraStream } from '@/services/sensorPermissionService';

type MediaPipeLoader = typeof import('../lib/mediapipe/loader');
let mediaPipeLoaderPromise: Promise<MediaPipeLoader> | null = null;

function loadMediaPipeLoader() {
  mediaPipeLoaderPromise ||= import('../lib/mediapipe/loader');
  return mediaPipeLoaderPromise;
}

// ── Cosine similarity ──

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA < 1e-10 || normB < 1e-10) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Types ──

export interface FaceMatch {
  faceId: string;
  uid: string;
  label: string;
  confidence: number;
}

export interface FaceRecognitionResult {
  facePresent: boolean;
  ownerPresent: boolean;
  confidence: number;
  bestMatch: FaceMatch | null;
  allMatches: FaceMatch[];
  threshold: 'high' | 'medium' | 'low' | 'reject';
  faceCount: number;
}

interface FaceTemplate {
  uid: string;
  label: string;
  faceId: string;
  embedding: number[];
}

const FACE_RECOGNITION_INTERVAL_MS = 700;
const FACE_LOST_GRACE_FRAMES = Math.ceil(3000 / FACE_RECOGNITION_INTERVAL_MS);

function faceResultKey(result: FaceRecognitionResult): string {
  return [
    result.facePresent,
    result.ownerPresent,
    result.confidence,
    result.bestMatch?.faceId || '',
    result.threshold,
    result.faceCount,
  ].join(':');
}

// ── Hook ──

interface UseFaceRecognitionOptions {
  enabled?: boolean;
  socket?: any;
}

export function useFaceRecognition(options?: UseFaceRecognitionOptions) {
  const enabled = options?.enabled ?? true;
  const socketRef = useRef(options?.socket);

  useEffect(() => { socketRef.current = options?.socket; }, [options?.socket]);

  const [result, setResult] = useState<FaceRecognitionResult>({
    facePresent: false,
    ownerPresent: false,
    confidence: 0,
    bestMatch: null,
    allMatches: [],
    threshold: 'reject',
    faceCount: 0,
  });

  const templatesRef = useRef<FaceTemplate[]>([]);
  const animRef = useRef(0);
  const faceLostRef = useRef(0);           // consecutive frames without face
  const lastKnownFaceResult = useRef<FaceRecognitionResult | null>(null);
  const lastProcessTimeRef = useRef(0);
  const lastResultKeyRef = useRef('');
  const isEnrollingRef = useRef(false);

  // ── Load templates from server ──
  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/biometric/list', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        templatesRef.current = (data.faces || []) as FaceTemplate[];
      }
    } catch {}
  }, []);

  // ── Face recognition loop ──
  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let running = true;

    const start = async () => {
      try {
        const mediaPipe = await loadMediaPipeLoader();
        await mediaPipe.initMediaPipe();
        await loadTemplates();
        if (!running) return;

        const video = document.createElement('video');
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        video.muted = true;

        stream = await requestCameraStream({
          width: 320,
          height: 240,
          facingMode: 'user',
        });
        video.srcObject = stream;
        await video.play();

        const publishFaceResult = (nextResult: FaceRecognitionResult) => {
          const nextKey = faceResultKey(nextResult);
          if (nextKey === lastResultKeyRef.current) return;
          lastResultKeyRef.current = nextKey;
          lastKnownFaceResult.current = nextResult;
          setResult(nextResult);
          socketRef.current?.emit('face:result', {
            facePresent: nextResult.facePresent,
            ownerPresent: nextResult.ownerPresent,
            confidence: nextResult.confidence,
            faceCount: nextResult.faceCount,
          });
        };

        const loop = () => {
          if (!running) return;

          const now = performance.now();
          if (
            now - lastProcessTimeRef.current >= FACE_RECOGNITION_INTERVAL_MS &&
            video.readyState >= 2 &&
            mediaPipe.isMediaPipeReady()
          ) {
            lastProcessTimeRef.current = now;
            const faces = mediaPipe.detectFaceLandmarks(video);

            if (faces.length > 0) {
              faceLostRef.current = 0;
              const bestMatches: FaceMatch[] = [];

              for (const face of faces) {
                const embedding = mediaPipe.extractFaceEmbedding(face.landmarks);
                if (embedding.length === 0) continue;

                // Compare against all stored templates
                for (const tpl of templatesRef.current) {
                  if (!tpl.embedding || tpl.embedding.length === 0) continue;
                  const sim = cosineSimilarity(embedding, tpl.embedding);
                  bestMatches.push({
                    faceId: tpl.faceId,
                    uid: tpl.uid,
                    label: tpl.label,
                    confidence: Math.round(sim * 100) / 100,
                  });
                }
              }

              bestMatches.sort((a, b) => b.confidence - a.confidence);
              const best = bestMatches[0] || null;
              const bestConf = best?.confidence ?? 0;

              let threshold: FaceRecognitionResult['threshold'] = 'reject';
              if (bestConf >= 0.80) threshold = 'high';
              else if (bestConf >= 0.60) threshold = 'medium';
              else if (bestConf >= 0.45) threshold = 'low';

              const faceResult: FaceRecognitionResult = {
                facePresent: true,
                ownerPresent: bestConf >= 0.60,
                confidence: bestConf,
                bestMatch: best,
                allMatches: bestMatches.slice(0, 5),
                threshold,
                faceCount: faces.length,
              };

              publishFaceResult(faceResult);
            } else {
              // Face lost counting
              faceLostRef.current++;
              const stillPresent = faceLostRef.current < FACE_LOST_GRACE_FRAMES;
              const lastKnown = lastKnownFaceResult.current;

              if (stillPresent && lastKnown) {
                // Grace period: keep last known state but mark facePresent as fading
                publishFaceResult({ ...lastKnown, facePresent: true });
              } else {
                // Face definitely gone
                const goneResult: FaceRecognitionResult = {
                  facePresent: false,
                  ownerPresent: false,
                  confidence: 0,
                  bestMatch: null,
                  allMatches: [],
                  threshold: 'reject',
                  faceCount: 0,
                };
                publishFaceResult(goneResult);
              }
            }
          }

          animRef.current = requestAnimationFrame(loop);
        };

        animRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.warn('[FaceRecognition] Camera or MediaPipe init failed:', err);
      }
    };

    start();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, [enabled, loadTemplates]);

  // ── Enrollment ──
  const enrollFace = useCallback(async (label: string): Promise<{ success: boolean; faceId?: string }> => {
    // Use the last known face detection
    // In practice, this should capture a fresh embedding from the next detection tick
    return new Promise(async (resolve) => {
      try {
        const mediaPipe = await loadMediaPipeLoader();
        await mediaPipe.initMediaPipe();

        const video = document.createElement('video');
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        video.muted = true;

        const stream = await requestCameraStream({
          width: 480,
          height: 360,
          facingMode: 'user',
        });
        video.srcObject = stream;
        await video.play();

        // Wait for a good face detection
        let attempts = 0;
        const captureInterval = setInterval(() => {
          attempts++;
          if (attempts > 60 || !mediaPipe.isMediaPipeReady()) {
            clearInterval(captureInterval);
            stream.getTracks().forEach(t => t.stop());
            resolve({ success: false });
            return;
          }

          const faces = mediaPipe.detectFaceLandmarks(video);
          if (faces.length > 0) {
            clearInterval(captureInterval);
            const embedding = mediaPipe.extractFaceEmbedding(faces[0].landmarks);
            stream.getTracks().forEach(t => t.stop());

            if (embedding.length === 0) {
              resolve({ success: false });
              return;
            }

            // Submit to server
            fetch('/api/auth/biometric/face/enroll', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ label, embedding }),
            }).then(async (res) => {
              if (res.ok) {
                const data = await res.json();
                templatesRef.current.push({
                  uid: 'owner',
                  label,
                  faceId: data.face.id,
                  embedding,
                });
                resolve({ success: true, faceId: data.face.id });
              } else {
                resolve({ success: false });
              }
            }).catch(() => resolve({ success: false }));
          }
        }, 300);
      } catch {
        resolve({ success: false });
      }
    });
  }, []);

  return {
    result,
    loadTemplates,
    enrollFace,
    isEnrolling: isEnrollingRef.current,
  };
}

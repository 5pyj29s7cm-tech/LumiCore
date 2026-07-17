import { useEffect, useRef, useState, useCallback } from 'react';
import { releaseSensorStream, requestCameraStream } from '@/services/sensorPermissionService';

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

const FACE_RECOGNITION_INTERVAL_MS = 3000;
const FACE_LOST_GRACE_FRAMES = Math.ceil(6000 / FACE_RECOGNITION_INTERVAL_MS);

function emptyFaceRecognitionResult(): FaceRecognitionResult {
  return {
    facePresent: false,
    ownerPresent: false,
    confidence: 0,
    bestMatch: null,
    allMatches: [],
    threshold: 'reject',
    faceCount: 0,
  };
}

function stopCameraStream(stream: MediaStream | null) {
  releaseSensorStream('camera', stream);
}

function releaseVideoElement(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.srcObject = null;
  video.removeAttribute('src');
  video.load();
}

function waitForNextCapture(delayMs: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, delayMs));
}

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

  const [result, setResult] = useState<FaceRecognitionResult>(() => emptyFaceRecognitionResult());
  const [hasTemplates, setHasTemplates] = useState(false);
  const [templateRevision, setTemplateRevision] = useState(0);

  const templatesRef = useRef<FaceTemplate[]>([]);
  const faceLostRef = useRef(0);           // consecutive frames without face
  const lastKnownFaceResult = useRef<FaceRecognitionResult | null>(null);
  const lastResultKeyRef = useRef('');
  const isEnrollingRef = useRef(false);

  // ── Load templates from server ──
  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/biometric/list', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const templates = (data.faces || []) as FaceTemplate[];
        templatesRef.current = templates;
        return templates;
      }
    } catch {}
    templatesRef.current = [];
    return [];
  }, []);

  useEffect(() => {
    const handleBiometricsUpdated = (event: Event) => {
      const type = String((event as CustomEvent<{ type?: string }>).detail?.type || '');
      if (!type || type === 'face') setTemplateRevision(revision => revision + 1);
    };
    window.addEventListener('lumi:biometrics-updated', handleBiometricsUpdated);
    return () => window.removeEventListener('lumi:biometrics-updated', handleBiometricsUpdated);
  }, []);

  useEffect(() => {
    if (enabled) return;
    faceLostRef.current = 0;
    lastKnownFaceResult.current = null;
    lastResultKeyRef.current = '';
    setResult(current => current.facePresent || current.ownerPresent
      ? emptyFaceRecognitionResult()
      : current);
  }, [enabled]);

  // ── Face recognition loop ──
  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let releaseFaceLandmarker: (() => void) | null = null;
    let detectionTimer: number | null = null;
    let running = true;

    const disposeResources = () => {
      if (detectionTimer !== null) {
        window.clearTimeout(detectionTimer);
        detectionTimer = null;
      }
      stopCameraStream(stream);
      stream = null;
      releaseVideoElement(video);
      video = null;
      releaseFaceLandmarker?.();
      releaseFaceLandmarker = null;
    };

    const publishFaceResult = (nextResult: FaceRecognitionResult) => {
      if (!running) return;
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

    const start = async () => {
      try {
        // Camera permission alone is not enough for permanent background capture:
        // recognition only starts after the owner has enrolled a face template.
        const templates = await loadTemplates();
        if (!running) return;
        setHasTemplates(templates.length > 0);
        if (templates.length === 0) return;

        const mediaPipe = await loadMediaPipeLoader();
        const acquiredRelease = await mediaPipe.acquireFaceLandmarker();
        if (!running) {
          acquiredRelease();
          return;
        }
        releaseFaceLandmarker = acquiredRelease;

        video = document.createElement('video');
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        video.muted = true;

        const requestedStream = await requestCameraStream({
          width: 320,
          height: 240,
          facingMode: 'user',
        });
        // Cleanup may have run while getUserMedia awaited user/system input.
        if (!running) {
          stopCameraStream(requestedStream);
          return;
        }
        stream = requestedStream;
        video.srcObject = stream;
        await video.play();
        if (!running) return;

        const scheduleNextDetection = (delay = FACE_RECOGNITION_INTERVAL_MS) => {
          if (!running) return;
          detectionTimer = window.setTimeout(runDetection, delay);
        };

        const runDetection = () => {
          if (!running) return;
          try {
            if (
              video &&
              video.readyState >= 2 &&
              mediaPipe.isFaceLandmarkerReady() &&
              !document.hidden
            ) {
              const faces = mediaPipe.detectFaceLandmarks(video);

              if (faces.length > 0) {
                faceLostRef.current = 0;
                const bestMatches: FaceMatch[] = [];

                for (const face of faces) {
                  const embedding = mediaPipe.extractFaceEmbedding(face.landmarks);
                  if (embedding.length === 0) continue;

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

                publishFaceResult({
                  facePresent: true,
                  ownerPresent: bestConf >= 0.60,
                  confidence: bestConf,
                  bestMatch: best,
                  allMatches: bestMatches.slice(0, 5),
                  threshold,
                  faceCount: faces.length,
                });
              } else {
                faceLostRef.current++;
                const stillPresent = faceLostRef.current < FACE_LOST_GRACE_FRAMES;
                const lastKnown = lastKnownFaceResult.current;

                if (stillPresent && lastKnown) {
                  publishFaceResult({ ...lastKnown, facePresent: true });
                } else {
                  publishFaceResult(emptyFaceRecognitionResult());
                }
              }
            }
          } catch (error) {
            console.warn('[FaceRecognition] Detection failed:', error);
          } finally {
            scheduleNextDetection();
          }
        };

        scheduleNextDetection(0);
      } catch (err) {
        disposeResources();
        if (running) {
          console.warn('[FaceRecognition] Camera or MediaPipe init failed:', err);
        }
      }
    };

    void start();

    return () => {
      running = false;
      disposeResources();
    };
  }, [enabled, loadTemplates, templateRevision]);

  // ── Enrollment ──
  const enrollFace = useCallback(async (label: string): Promise<{ success: boolean; faceId?: string }> => {
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let releaseFaceLandmarker: (() => void) | null = null;
    isEnrollingRef.current = true;

    try {
      const mediaPipe = await loadMediaPipeLoader();
      releaseFaceLandmarker = await mediaPipe.acquireFaceLandmarker();

      video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('autoplay', '');
      video.muted = true;

      stream = await requestCameraStream({
        width: 480,
        height: 360,
        facingMode: 'user',
      });
      video.srcObject = stream;
      await video.play();

      for (let attempts = 0; attempts < 60; attempts++) {
        if (video.readyState >= 2 && mediaPipe.isFaceLandmarkerReady()) {
          const faces = mediaPipe.detectFaceLandmarks(video);
          if (faces.length > 0) {
            const embedding = mediaPipe.extractFaceEmbedding(faces[0].landmarks);
            if (embedding.length === 0) return { success: false };

            const res = await fetch('/api/auth/biometric/face/enroll', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ label, embedding }),
            });
            if (!res.ok) return { success: false };

            const data = await res.json();
            const faceId = String(data.face?.id || '');
            if (!faceId) return { success: false };
            templatesRef.current = [...templatesRef.current, {
              uid: 'owner',
              label,
              faceId,
              embedding,
            }];
            setHasTemplates(true);
            return { success: true, faceId };
          }
        }
        await waitForNextCapture(300);
      }
      return { success: false };
    } catch {
      return { success: false };
    } finally {
      stopCameraStream(stream);
      releaseVideoElement(video);
      releaseFaceLandmarker?.();
      isEnrollingRef.current = false;
    }
  }, []);

  return {
    result,
    hasTemplates,
    loadTemplates,
    enrollFace,
    isEnrolling: isEnrollingRef.current,
  };
}

import { HandLandmarker, FaceDetector, FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
const FACE_LANDMARK_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

let handLandmarker: HandLandmarker | null = null;
let faceDetector: FaceDetector | null = null;
let faceLandmarker: FaceLandmarker | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let faceLandmarkerInitPromise: Promise<void> | null = null;
let visionPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;
let faceLandmarkerReferences = 0;

function getVisionFileset() {
  visionPromise ||= FilesetResolver.forVisionTasks(WASM_URL);
  return visionPromise;
}

async function initFaceLandmarker(): Promise<void> {
  if (faceLandmarker) return;
  if (faceLandmarkerInitPromise) return faceLandmarkerInitPromise;

  faceLandmarkerInitPromise = (async () => {
    const vision = await getVisionFileset();
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: FACE_LANDMARK_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
    });
  })().catch((error) => {
    faceLandmarkerInitPromise = null;
    throw error;
  });

  return faceLandmarkerInitPromise;
}

function closeFaceLandmarkerIfUnused() {
  if (faceLandmarkerReferences > 0 || !faceLandmarker) return;
  const landmarker = faceLandmarker;
  faceLandmarker = null;
  faceLandmarkerInitPromise = null;
  try {
    landmarker.close();
  } catch (error) {
    console.warn('[MediaPipe] Failed to close FaceLandmarker:', error);
  }
}

export async function acquireFaceLandmarker(): Promise<() => void> {
  // Reserve before awaiting initialization so a concurrent release cannot close
  // the shared task between initialization and this consumer becoming active.
  faceLandmarkerReferences += 1;
  try {
    await initFaceLandmarker();
  } catch (error) {
    faceLandmarkerReferences = Math.max(0, faceLandmarkerReferences - 1);
    closeFaceLandmarkerIfUnused();
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    faceLandmarkerReferences = Math.max(0, faceLandmarkerReferences - 1);
    closeFaceLandmarkerIfUnused();
  };
}

export async function initMediaPipe(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const vision = await getVisionFileset();

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HAND_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: FACE_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.6,
    });

    initialized = true;
  })().catch((error) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
}

export type HandResult = {
  handedness: 'Left' | 'Right';
  landmarks: Array<{ x: number; y: number; z: number }>;
};

export type FaceResult = {
  boundingBox: { x: number; y: number; width: number; height: number };
  score: number;
};

export function detectHands(video: HTMLVideoElement): HandResult[] {
  if (!handLandmarker) return [];
  const now = performance.now();
  const result = handLandmarker.detectForVideo(video, now);
  const hands: HandResult[] = [];
  for (let i = 0; i < result.handednesses.length; i++) {
    const h = result.handednesses[i];
    const lm = result.landmarks[i];
    if (!lm) continue;
    hands.push({
      handedness: h[0]?.categoryName as 'Left' | 'Right',
      landmarks: lm.map(l => ({ x: l.x, y: l.y, z: l.z })),
    });
  }
  return hands;
}

export function detectFaces(video: HTMLVideoElement): FaceResult[] {
  if (!faceDetector) return [];
  const now = performance.now();
  const result = faceDetector.detectForVideo(video, now);
  return result.detections.map(d => ({
    boundingBox: {
      x: d.boundingBox.originX,
      y: d.boundingBox.originY,
      width: d.boundingBox.width,
      height: d.boundingBox.height,
    },
    score: d.categories[0]?.score ?? 0,
  }));
}

export type FaceLandmarkResult = {
  landmarks: Array<{ x: number; y: number; z: number }>;
  boundingBox: { x: number; y: number; width: number; height: number };
  score: number;
};

export function detectFaceLandmarks(video: HTMLVideoElement): FaceLandmarkResult[] {
  if (!faceLandmarker) return [];
  const now = performance.now();
  const result = faceLandmarker.detectForVideo(video, now);
  if (!result.faceLandmarks) return [];
  return result.faceLandmarks.map((lm) => {
    let minX = 1;
    let minY = 1;
    let maxX = 0;
    let maxY = 0;
    for (const landmark of lm) {
      minX = Math.min(minX, landmark.x);
      minY = Math.min(minY, landmark.y);
      maxX = Math.max(maxX, landmark.x);
      maxY = Math.max(maxY, landmark.y);
    }
    return {
      landmarks: lm.map(l => ({ x: l.x, y: l.y, z: l.z })),
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      score: 0.9, // FaceLandmarker doesn't return per-face scores
    };
  });
}

/**
 * Extract a normalized face embedding from 478 MediaPipe landmarks.
 * Normalizes relative to face center and inter-eye distance,
 * returns a compact float vector suitable for cosine-similarity matching.
 */
export function extractFaceEmbedding(landmarks: Array<{ x: number; y: number; z: number }>): number[] {
  if (landmarks.length === 0) return [];

  // Compute face center (mean of all landmarks)
  let cx = 0, cy = 0, cz = 0;
  for (const l of landmarks) { cx += l.x; cy += l.y; cz += l.z; }
  cx /= landmarks.length; cy /= landmarks.length; cz /= landmarks.length;

  // Inter-eye distance for scale normalization (left eye = 33/133, right eye = 362/263)
  // Simplified: use bounding box diagonal
  const xs = landmarks.map(l => l.x), ys = landmarks.map(l => l.y);
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.01);

  // Key identity-discriminative landmark groups:
  // Eyes (16), Eyebrows (10), Nose (9), Mouth (20), Jaw (17) = 72 landmarks × 3 = 216 dimensions
  const keyIndices = [
    // Left eye region
    33, 133, 155, 154, 153, 145, 144, 163, 7, 173, 157, 158, 159, 160, 161, 246,
    // Right eye region
    362, 263, 387, 386, 385, 374, 373, 390, 249, 398, 384, 381, 380, 379, 378, 466,
    // Nose
    1, 2, 3, 4, 5, 6, 168, 197, 195,
    // Mouth
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88,
    // Jaw / chin / cheek
    162, 21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  ];

  const embedding: number[] = [];
  for (const idx of keyIndices) {
    if (idx < landmarks.length) {
      const l = landmarks[idx];
      embedding.push((l.x - cx) / scale);
      embedding.push((l.y - cy) / scale);
      embedding.push((l.z - cz) / scale);
    }
  }

  // L2-normalize
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;
  }

  return embedding;
}

export function isMediaPipeReady(): boolean {
  return initialized;
}

export function isFaceLandmarkerReady(): boolean {
  return Boolean(faceLandmarker);
}

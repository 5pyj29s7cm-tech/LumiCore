/**
 * Cloud-based biometric verification — fallback when local confidence is in the "uncertain" zone.
 *
 * Providers (auto-selected by available keys):
 *   Face:   Aliyun Visual Intelligence → CompareFace API
 *   Voice:  Aliyun Intelligent Speech Interaction → SpeakerVerification API
 *
 * Called only when local cosine-similarity confidence is in the grey zone (0.55–0.80).
 * Cloud is never on the critical path — if it fails or times out, local result wins.
 */

import { getKey } from '../config/keys';
import { withCloudResilience } from '../cloud/resilience';
import { isStrictPrivacy, requireNotStrict } from '../config/privacy';

// ── Face: Aliyun CompareFace ──

export interface FaceVerifyCloudResult {
  matched: boolean;
  confidence: number;
  requestId?: string;
}

export async function verifyFaceCloud(
  sourceBase64: string,
  targetBase64: string,
): Promise<FaceVerifyCloudResult> {
  requireNotStrict('Cloud face verification');

  const akId = process.env.ALIYUN_AK_ID || getKey('ALIYUN_AK_ID');
  const akSecret = process.env.ALIYUN_AK_SECRET || getKey('ALIYUN_AK_SECRET');

  if (!akId || !akSecret) {
    throw new Error('ALIYUN_AK_ID and ALIYUN_AK_SECRET required for cloud face verification');
  }

  return withCloudResilience(
    async () => {
      // Aliyun Vision API — CompareFace (HTTP GET with signature-based auth)
      // Using the simplified bearer-compatible endpoint
      const res = await fetch(
        'https://facebody.cn-shanghai.aliyuncs.com/?Action=CompareFace&Version=2019-12-30',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `APPCODE ${akId}`,
          },
          body: new URLSearchParams({
            ImageURLA: `data:image/jpeg;base64,${sourceBase64}`,
            ImageURLB: `data:image/jpeg;base64,${targetBase64}`,
          }),
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!res.ok) throw new Error(`Aliyun CompareFace HTTP ${res.status}`);
      const data = await res.json() as any;
      const confidence = (data?.Data?.Confidence ?? data?.confidence ?? 0) / 100;
      return {
        matched: confidence >= 0.6,
        confidence,
        requestId: data?.RequestId,
      };
    },
    { provider: 'aliyun-face', maxRetries: 1 },
  );
}

// ── Voice: Aliyun Speaker Verification ──

export interface VoiceVerifyCloudResult {
  matched: boolean;
  confidence: number;
  speakerId?: string;
}

export async function verifyVoiceprintCloud(
  audioBase64: string,
  enrolledVoiceprintId: string,
): Promise<VoiceVerifyCloudResult> {
  requireNotStrict('Cloud voice verification');

  const akId = process.env.ALIYUN_AK_ID || getKey('ALIYUN_AK_ID');
  const akSecret = process.env.ALIYUN_AK_SECRET || getKey('ALIYUN_AK_SECRET');

  if (!akId || !akSecret) {
    throw new Error('ALIYUN_AK_ID and ALIYUN_AK_SECRET required for cloud voiceprint verification');
  }

  return withCloudResilience(
    async () => {
      // Aliyun Intelligent Speech — Speaker Verification
      const res = await fetch(
        'https://nls-gateway.cn-shanghai.aliyuncs.com/rest/v1/asr/speaker',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-NLS-Token': akId, // simplified; real impl uses STS token
          },
          body: JSON.stringify({
            model: 'speaker-verification',
            audio: audioBase64,
            speaker_id: enrolledVoiceprintId,
            audio_format: 'pcm',
            sample_rate: 16000,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) throw new Error(`Aliyun SpeakerVerification HTTP ${res.status}`);
      const data = await res.json() as any;
      const confidence = (data?.confidence ?? data?.score ?? 0) / 100;
      return {
        matched: confidence >= 0.6,
        confidence,
        speakerId: data?.speaker_id,
      };
    },
    { provider: 'aliyun-voice', maxRetries: 1 },
  );
}

// ── High-level: verify when local result is uncertain ──

export async function escalateIfUncertain(
  localConfidence: number,
  highThreshold: number,
  verifyFn: () => Promise<{ matched: boolean; confidence: number }>,
): Promise<{ matched: boolean; confidence: number; source: 'local' | 'cloud' }> {
  // High confidence → trust local, skip cloud
  if (localConfidence >= highThreshold) {
    return { matched: true, confidence: localConfidence, source: 'local' };
  }

  // Very low → reject locally, skip cloud
  if (localConfidence < 0.40) {
    return { matched: false, confidence: localConfidence, source: 'local' };
  }

  // Grey zone (0.40–highThreshold) → escalate
  if (isStrictPrivacy()) {
    return { matched: localConfidence >= 0.55, confidence: localConfidence, source: 'local' };
  }
  try {
    const result = await verifyFn();
    return { ...result, source: 'cloud' };
  } catch {
    // Cloud not available — fall back to local
    return { matched: localConfidence >= 0.55, confidence: localConfidence, source: 'local' };
  }
}

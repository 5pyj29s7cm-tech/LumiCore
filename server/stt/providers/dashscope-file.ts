import path from 'path';
import { getKey } from '../../config/keys';
import type { STTResult, STTSegment } from '../types';

type FetchLike = typeof fetch;

interface DashScopeFileOptions {
  fileName?: string;
  mimeType?: string;
  fetchImpl?: FetchLike;
  onProgress?: (message: string) => void;
  diarization?: boolean;
  speakerCount?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface UploadPolicyData {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  oss_access_key_id: string;
  x_oss_object_acl?: string;
  x_oss_forbid_overwrite?: string;
  max_file_size_mb?: number;
}

const DEFAULT_MODEL = 'fun-asr';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function getApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (!key) throw new Error('DASHSCOPE_API_KEY is not configured. Add it in Settings -> Voice Services.');
  return key;
}

function baseUrl(): string {
  return (process.env.DASHSCOPE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function uploadBaseUrl(): string {
  return (process.env.DASHSCOPE_UPLOAD_BASE_URL || baseUrl()).replace(/\/+$/, '');
}

function taskBaseUrl(): string {
  const workspaceId = (process.env.DASHSCOPE_WORKSPACE_ID || '').trim();
  if (workspaceId) {
    const region = (process.env.DASHSCOPE_REGION || 'cn-beijing').trim();
    return `https://${workspaceId}.${region}.maas.aliyuncs.com`;
  }
  return baseUrl();
}

function getModel(): string {
  return (process.env.DASHSCOPE_FILE_ASR_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getSubmitUrl(): string {
  return `${taskBaseUrl()}/api/v1/services/audio/asr/transcription`;
}

function getTaskUrl(taskId: string): string {
  return `${taskBaseUrl()}/api/v1/tasks/${encodeURIComponent(taskId)}`;
}

function getPolicyUrl(model: string): string {
  return `${uploadBaseUrl()}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
}

function safeOssFileName(fileName?: string): string {
  const ext = (path.extname(String(fileName || '')) || '.wav').toLowerCase().replace(/[^\w.]/g, '') || '.wav';
  const base = path.basename(String(fileName || 'audio'), path.extname(String(fileName || '')))
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'audio';
  return `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
}

function normalizeLanguage(language: string): string | null {
  const value = String(language || '').toLowerCase();
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('en')) return 'en';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return value ? value.split(/[-_]/)[0] : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseChannelIds(): number[] {
  const raw = process.env.DASHSCOPE_ASR_CHANNEL_ID || '0';
  const values = raw.split(',').map(item => Number(item.trim())).filter(Number.isInteger);
  return values.length > 0 ? values : [0];
}

async function readJsonResponse(res: Response, label: string): Promise<any> {
  const text = await res.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`${label} failed (${res.status}): ${text}`);
      throw new Error(`${label} returned invalid JSON: ${text.slice(0, 500)}`);
    }
  }
  if (!res.ok) {
    const detail = data?.message || data?.error?.message || data?.code || text || res.statusText;
    throw new Error(`${label} failed (${res.status}): ${detail}`);
  }
  return data;
}

function requirePolicyData(data: any): UploadPolicyData {
  const policy = data?.data || data?.output || data;
  const required = ['policy', 'signature', 'upload_dir', 'upload_host', 'oss_access_key_id'];
  const missing = required.filter(key => !policy?.[key]);
  if (missing.length) throw new Error(`DashScope upload policy missing fields: ${missing.join(', ')}`);
  return policy as UploadPolicyData;
}

async function uploadToDashScopeOss(
  audioBuffer: Buffer,
  fileName: string,
  mimeType: string,
  model: string,
  apiKey: string,
  fetchImpl: FetchLike,
  onProgress?: (message: string) => void,
): Promise<string> {
  onProgress?.('正在向 DashScope 申请临时上传地址');
  const policyRes = await fetchImpl(getPolicyUrl(model), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const policy = requirePolicyData(await readJsonResponse(policyRes, 'DashScope upload policy'));
  const maxBytes = Number(policy.max_file_size_mb || 0) * 1024 * 1024;
  if (maxBytes > 0 && audioBuffer.byteLength > maxBytes) {
    throw new Error(`Audio file is too large for DashScope temporary upload (${policy.max_file_size_mb} MB limit).`);
  }

  const objectName = safeOssFileName(fileName);
  const uploadDir = String(policy.upload_dir).replace(/\/+$/, '');
  const objectKey = `${uploadDir}/${objectName}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', policy.oss_access_key_id);
  form.append('Signature', policy.signature);
  form.append('policy', policy.policy);
  form.append('key', objectKey);
  form.append('x-oss-object-acl', policy.x_oss_object_acl || 'private');
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite || 'true');
  form.append('success_action_status', '200');
  form.append('file', new Blob([audioBuffer as any], { type: mimeType }), objectName);

  onProgress?.('正在上传音频到 DashScope 临时存储');
  const uploadRes = await fetchImpl(policy.upload_host, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => '');
    throw new Error(`DashScope temporary upload failed (${uploadRes.status}): ${detail || uploadRes.statusText}`);
  }
  return `oss://${objectKey}`;
}

function buildParameters(language: string, options: DashScopeFileOptions): Record<string, any> {
  const params: Record<string, any> = {
    channel_id: parseChannelIds(),
  };
  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage) params.language_hints = [normalizedLanguage];

  const diarization = options.diarization !== false && process.env.DASHSCOPE_ASR_DIARIZATION !== '0';
  if (diarization) {
    params.diarization_enabled = true;
    const speakerCount = options.speakerCount
      || parsePositiveInt(process.env.DASHSCOPE_ASR_SPEAKER_COUNT);
    if (speakerCount && speakerCount >= 2 && speakerCount <= 100) params.speaker_count = speakerCount;
  }

  const vocabularyId = (process.env.DASHSCOPE_ASR_VOCABULARY_ID || '').trim();
  if (vocabularyId) params.vocabulary_id = vocabularyId;
  if (process.env.DASHSCOPE_ASR_TIMESTAMP_ALIGNMENT === '1') params.timestamp_alignment_enabled = true;
  return params;
}

async function submitTask(
  ossUrl: string,
  language: string,
  model: string,
  apiKey: string,
  fetchImpl: FetchLike,
  options: DashScopeFileOptions,
): Promise<string> {
  const payload = {
    model,
    input: { file_urls: [ossUrl] },
    parameters: buildParameters(language, options),
  };
  const res = await fetchImpl(getSubmitUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse(res, 'DashScope ASR submit');
  const taskId = data?.output?.task_id || data?.task_id;
  if (!taskId) throw new Error(`DashScope ASR submit did not return task_id: ${JSON.stringify(data).slice(0, 500)}`);
  return String(taskId);
}

function getTaskOutput(data: any): any {
  return data?.output || data || {};
}

function pickSucceededResult(output: any): any {
  const results = Array.isArray(output?.results) ? output.results : [];
  const succeeded = results.find((item: any) => item?.subtask_status === 'SUCCEEDED' && item?.transcription_url);
  if (succeeded) return succeeded;
  const failed = results.find((item: any) => item?.subtask_status === 'FAILED');
  if (failed) {
    throw new Error(`DashScope ASR subtask failed: ${failed.code || ''} ${failed.message || ''}`.trim());
  }
  return results.find((item: any) => item?.transcription_url);
}

async function pollTask(
  taskId: string,
  apiKey: string,
  fetchImpl: FetchLike,
  onProgress?: (message: string) => void,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const startedAt = Date.now();
  const interval = Math.max(1000, pollIntervalMs);
  let attempts = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const res = await fetchImpl(getTaskUrl(taskId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await readJsonResponse(res, 'DashScope ASR task query');
    const output = getTaskOutput(data);
    const status = String(output?.task_status || '').toUpperCase();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    onProgress?.(`DashScope 正在转写中：${status || 'UNKNOWN'}，已等待 ${elapsed} 秒`);

    if (status === 'SUCCEEDED') {
      const result = pickSucceededResult(output);
      if (!result?.transcription_url) {
        throw new Error(`DashScope ASR task succeeded without transcription_url: ${JSON.stringify(output).slice(0, 500)}`);
      }
      return String(result.transcription_url);
    }
    if (['FAILED', 'CANCELED', 'CANCELLED', 'UNKNOWN'].includes(status)) {
      const reason = output?.message || output?.code || JSON.stringify(output).slice(0, 500);
      throw new Error(`DashScope ASR task ${status}: ${reason}`);
    }

    await new Promise(resolve => setTimeout(resolve, Math.min(interval + attempts * 250, 15000)));
  }
  throw new Error('DashScope ASR task timed out.');
}

function formatMs(ms?: number): string {
  const value = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

function speakerLabel(speakerId: number | null | undefined): string {
  return typeof speakerId === 'number' && Number.isFinite(speakerId)
    ? `\u8bf4\u8bdd\u4eba${speakerId + 1}`
    : '\u672a\u77e5\u8bf4\u8bdd\u4eba';
}

function normalizeSpeakerId(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function formatDashScopeTranscript(data: any): { text: string; segments: STTSegment[]; speakerCount: number } {
  const segments: STTSegment[] = [];
  const transcripts = Array.isArray(data?.transcripts) ? data.transcripts : [];
  for (const transcript of transcripts) {
    const channelId = Number.isInteger(Number(transcript?.channel_id)) ? Number(transcript.channel_id) : undefined;
    const sentences = Array.isArray(transcript?.sentences) ? transcript.sentences : [];
    if (sentences.length === 0 && transcript?.text) {
      segments.push({
        text: String(transcript.text).trim(),
        channelId,
        speakerId: null,
        speakerLabel: '\u672a\u77e5\u8bf4\u8bdd\u4eba',
      });
      continue;
    }
    for (const sentence of sentences) {
      const text = String(sentence?.text || '').trim();
      if (!text) continue;
      const speakerId = normalizeSpeakerId(sentence?.speaker_id);
      segments.push({
        text,
        beginMs: Number.isFinite(Number(sentence?.begin_time)) ? Number(sentence.begin_time) : undefined,
        endMs: Number.isFinite(Number(sentence?.end_time)) ? Number(sentence.end_time) : undefined,
        speakerId,
        speakerLabel: speakerLabel(speakerId),
        channelId,
      });
    }
  }

  if (segments.length === 0) {
    const text = String(data?.text || data?.transcript || '').trim();
    return { text, segments: [], speakerCount: 0 };
  }

  const hasSpeakerIds = segments.some(segment => typeof segment.speakerId === 'number');
  const speakerIds = new Set<number>();
  const grouped: STTSegment[] = [];
  for (const segment of segments) {
    if (typeof segment.speakerId === 'number') speakerIds.add(segment.speakerId);
    const last = grouped[grouped.length - 1];
    const sameSpeaker = last && last.speakerId === segment.speakerId && last.channelId === segment.channelId;
    const closeEnough = !last?.endMs || !segment.beginMs || segment.beginMs - last.endMs <= 2500;
    if (sameSpeaker && closeEnough) {
      last.text = `${last.text}${/[，。！？,.!?]$/.test(last.text) ? '' : ' '}${segment.text}`;
      last.endMs = segment.endMs ?? last.endMs;
      continue;
    }
    grouped.push({ ...segment });
  }

  const lines = grouped.map(segment => {
    const prefix = typeof segment.beginMs === 'number' ? `[${formatMs(segment.beginMs)}] ` : '';
    const label = hasSpeakerIds ? `${speakerLabel(segment.speakerId)}\uff1a` : '';
    return `${prefix}${label}${segment.text}`.trim();
  });
  return { text: lines.join('\n'), segments, speakerCount: speakerIds.size };
}

export async function transcribe(
  audioBuffer: Buffer,
  language: string = 'zh',
  options: DashScopeFileOptions = {},
): Promise<STTResult> {
  const apiKey = getApiKey();
  const fetchImpl = options.fetchImpl || fetch;
  const model = getModel();
  const fileName = path.basename(String(options.fileName || 'audio.wav')) || 'audio.wav';
  const mimeType = options.mimeType || 'audio/wav';
  options.onProgress?.(`正在使用 DashScope ${model} 非实时识别`);
  const ossUrl = await uploadToDashScopeOss(audioBuffer, fileName, mimeType, model, apiKey, fetchImpl, options.onProgress);
  options.onProgress?.('DashScope 音频已上传，正在提交非实时转写任务');
  const taskId = await submitTask(ossUrl, language, model, apiKey, fetchImpl, options);
  options.onProgress?.(`DashScope 已创建转写任务：${taskId}`);
  const transcriptionUrl = await pollTask(
    taskId,
    apiKey,
    fetchImpl,
    options.onProgress,
    options.pollIntervalMs || parsePositiveInt(process.env.DASHSCOPE_ASR_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    options.timeoutMs || parsePositiveInt(process.env.DASHSCOPE_ASR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  );

  options.onProgress?.('DashScope 转写完成，正在下载识别结果');
  const resultRes = await fetchImpl(transcriptionUrl, { method: 'GET' });
  const resultJson = await readJsonResponse(resultRes, 'DashScope ASR result download');
  const formatted = formatDashScopeTranscript(resultJson);
  return {
    text: formatted.text,
    isFinal: true,
    model,
    segments: formatted.segments,
    speakerCount: formatted.speakerCount,
    taskId,
  };
}

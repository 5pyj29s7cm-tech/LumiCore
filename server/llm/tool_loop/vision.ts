import { type NormalizedMessage, makeLLMCall, type LLMResponseFormat } from "../providers";
import { recordTokenUsage } from "../token_tracker";

// ── Vision Integration ──

/** Parse screenshot relay result — handles JSON wrapper { image_base64, format, width, height } or raw base64 */
export function parseScreenshotBase64(relayResult: string): { base64: string; mime: string } {
  try {
    const parsed = JSON.parse(relayResult);
    if (parsed.image_base64) {
      return {
        base64: parsed.image_base64,
        mime: parsed.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      };
    }
  } catch {}
  // Fallback: raw base64 string (legacy)
  return { base64: relayResult, mime: 'image/png' };
}

/** Analyze a screenshot with a vision-capable model. */
export async function analyzeScreen(
  imageBase64: string,
  query: string,
  config: { provider: string; model: string; userId?: string; maxTokens?: number; responseFormat?: LLMResponseFormat; signal?: AbortSignal; source?: string; requestId?: string; conversationId?: string },
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<string> {
  config.signal?.throwIfAborted();
  const { base64, mime } = parseScreenshotBase64(imageBase64);

  // Determine which vision model to use
  let provider = config.provider;
  let model = config.model;

  // World-model calls respect the exact configured model. Silent substitution
  // can route data to an endpoint the user did not select.
  if (provider === 'qwen' && !model.includes('vl')) {
    throw new Error(`Configured Qwen model '${model}' is not a vision model. Choose a Qwen-VL model in Settings > World Model.`);
  } else if (provider === 'ark' && !model.includes('vision')) {
    throw new Error(`Configured Ark model '${model}' is not a vision model. Choose an Ark vision model in Settings > World Model.`);
  } else if (provider === 'deepseek') {
    throw new Error('DeepSeek does not support visual perception. Choose a visual-perception model in Settings > World Model.');
  }

  const messages: NormalizedMessage[] = [
    {
      role: 'system',
      content: 'You are a screen reader AI. Analyze the screenshot and answer the user\'s question about what is visible on screen. Describe UI elements, text content, error messages, and anything relevant to the query. Be thorough but concise.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: query },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
      ],
    },
  ];

  const result = await makeLLMCall(
    messages, [],
    {
      provider: provider as any,
      model,
      maxTokens: config.maxTokens || 1000,
      userId: config.userId,
      source: config.source,
      requestId: config.requestId,
      conversationId: config.conversationId,
      responseFormat: config.responseFormat,
      signal: config.signal,
    },
    getDeepSeek || (() => null), getGemini || (() => null),
    getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk,
    getXiaomi, getKimi, getGlm, getRelay,
  );
  config.signal?.throwIfAborted();
  if (config.userId) {
    recordTokenUsage(config.userId, provider, model, result.usage, `vision_screen_${Date.now()}`, 'vision');
  }

  return result.text || 'Vision analysis returned no text.';
}

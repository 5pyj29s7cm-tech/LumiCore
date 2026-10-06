import type { ProviderArguments } from "../provider_getters";
import { ensureLocalModelReady, type LocalModelProvider } from "../local_models";
import { prepareLocalModelRequest } from "../local_context_budget";
import { loadedLocalContextTokens } from "../local_model_capacity";
import { assertRegisteredProviderModel, getRegisteredOpenAIClient, isRegisteredProviderLocal } from "../../extensions/registry";
import type { NormalizedMessage, ToolDeclaration, LLMCallConfig } from './contracts';
import { messagesNeedVision } from './content';
import { formatQwenRequest, formatDeepSeekRequest, formatOpenAIRequest, isReasoningModel } from './openai_compatible';

export async function prepareCompatibleModelRequest(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  maxTokens: number | undefined,
  getters: ProviderArguments,
  extensionProvider: boolean,
  streaming: boolean,
) {
  const [getDeepSeek, , getOpenAI, , getQwen, getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay] = getters;
  const supervisedLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
  const isLocal = supervisedLocal || (extensionProvider && isRegisteredProviderLocal(config.provider, config.userId));
  if (supervisedLocal) await ensureLocalModelReady(config.provider as LocalModelProvider, config.model, { timeoutMs: 8_000 });
  if (extensionProvider) {
    assertRegisteredProviderModel(config.provider, config.model, {
      userId: config.userId,
      needsVision: messagesNeedVision(messages),
      needsTools: toolDeclarations.length > 0,
      needsJson: config.responseFormat === 'json_object',
      ...(streaming ? { needsStreaming: true } : {}),
    });
  }
  const client = extensionProvider ? getRegisteredOpenAIClient(config.provider, config.userId)
    : config.provider === 'deepseek' ? getDeepSeek()
    : config.provider === 'openai' ? getOpenAI?.()
    : config.provider === 'qwen' ? getQwen?.()
    : config.provider === 'ark' ? getArk?.()
    : config.provider === 'lmstudio' ? getLmStudio?.()
    : config.provider === 'xiaomi' ? getXiaomi?.()
    : config.provider === 'kimi' ? getKimi?.()
    : config.provider === 'glm' ? getGlm?.()
    : config.provider === 'relay' ? getRelay?.()
    : getOllama?.();
  if (!client) throw new Error(config.provider === 'openai' && !streaming
    ? 'OpenAI not configured (OPENAI_API_KEY missing)' : `${config.provider} not configured`);

  const fmt = config.provider === 'qwen'
    ? formatQwenRequest
    : config.provider === 'deepseek'
      ? formatDeepSeekRequest
      : formatOpenAIRequest;
  const localRequest = isLocal
    ? prepareLocalModelRequest({
        messages,
        toolDeclarations,
        maxTokens,
        compactToolDeclarations: true,
        requiredToolNames: config.localRequiredToolNames,
        contextTokens: await loadedLocalContextTokens(config.provider, client, config.model, config.signal),
      })
    : null;
  const params: any = fmt({
    model: config.model,
    messages: localRequest?.messages || messages,
    toolDeclarations: localRequest?.toolDeclarations || toolDeclarations,
    maxTokens: localRequest?.maxTokens || maxTokens,
    responseFormat: config.responseFormat,
    ...(isLocal ? {} : { userId: config.userId }),
  });
  if (config.provider === 'xiaomi' || (config.provider === 'openai' && isReasoningModel(config.model))) {
    if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
    delete params.max_tokens;
  }
  if (config.thinkingMode === 'disabled' && (config.provider === 'deepseek'
    || (config.provider === 'relay' && /(?:^|\/)deepseek-/i.test(config.model)))) {
    params.thinking = { type: 'disabled' };
  }

  return { client, supervisedLocal, localRequest, params };
}

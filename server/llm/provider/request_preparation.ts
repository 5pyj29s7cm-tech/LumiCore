import type { ProviderArguments } from "../provider_getters";
import { ensureLocalModelReady, type LocalModelProvider } from "../local_models";
import { prepareLocalModelRequest } from "../local_context_budget";
import { loadedLocalContextTokens } from "../local_model_capacity";
import { assertRegisteredProviderModel, getRegisteredOpenAIClient, isRegisteredProviderLocal } from "../../extensions/registry";
import type { NormalizedMessage, ToolDeclaration, LLMCallConfig } from './contracts';
import { localPrivacyFetch } from "../../config/privacy";
import { prepareModelRequestContext } from '../request_context_budget';
import { getCachedOfficialApiModelDescriptor } from '../official_api';
import { documentedModelContextLimits, type ModelContextLimits } from '../../../shared/model_provider_capabilities';
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
  let client = extensionProvider ? getRegisteredOpenAIClient(config.provider, config.userId)
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
  if (supervisedLocal && config.dataRoutingPolicy === 'local_only' && client?.withOptions) {
    client = client.withOptions({ fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => localPrivacyFetch(input, init, true) });
  }
  if (!client) throw new Error(config.provider === 'openai' && !streaming
    ? 'OpenAI not configured (OPENAI_API_KEY missing)' : `${config.provider} not configured`);

  const deepseekProtocol = config.provider === 'deepseek'
    || (config.provider === 'relay' && /(?:^|\/)deepseek-/i.test(config.model));
  const kimiToolProtocol = (config.provider === 'relay'
    && (config.model === 'aliyun/kimi-k3' || config.model === 'tencent_cloud/kimi-k3'))
    || (config.provider === 'kimi' && /^kimi-k3$/i.test(config.model));
  const preserveAssistantReasoning = (deepseekProtocol || kimiToolProtocol) && toolDeclarations.length > 0;
  const fmt = config.provider === 'qwen'
    ? formatQwenRequest
    : config.provider === 'deepseek' || preserveAssistantReasoning
      ? formatDeepSeekRequest
      : formatOpenAIRequest;
  const catalogModel = config.provider === 'relay' ? getCachedOfficialApiModelDescriptor(config.model) : undefined;
  const documentedLimits = documentedModelContextLimits(config.provider, config.model, catalogModel?.upstreamModel);
  const modelLimits: ModelContextLimits = extensionProvider
    ? assertRegisteredProviderModel(config.provider, config.model, { userId: config.userId })
    : { ...documentedLimits,
        ...(catalogModel?.contextWindow !== undefined ? { contextWindow: catalogModel.contextWindow } : {}),
        ...(catalogModel?.maxInputTokens !== undefined ? { maxInputTokens: catalogModel.maxInputTokens } : {}),
        ...(catalogModel?.maxOutputTokens !== undefined ? { maxOutputTokens: catalogModel.maxOutputTokens } : {}) };
  const candidateInputCapacity = Math.min(modelLimits.maxInputTokens ?? Infinity,
    modelLimits.contextWindow !== undefined ? Math.max(0, modelLimits.contextWindow - (maxTokens ?? 0)) : Infinity);
  const localRequest = isLocal
    ? prepareLocalModelRequest({
        messages,
        toolDeclarations,
        maxTokens,
        inputTokenBudget: config.inputTokenBudget,
        compactToolDeclarations: true,
        requiredToolNames: [...new Set([...(config.protectedToolNames || []), ...(config.localRequiredToolNames || [])])],
        contextTokens: await loadedLocalContextTokens(config.provider, client, config.model, config.signal),
      })
    : null;
  const preparedContext = localRequest || prepareModelRequestContext({ messages, toolDeclarations, inputTokenBudget: config.inputTokenBudget,
    maxInputTokens: candidateInputCapacity, protectedToolNames: config.protectedToolNames, preserveAssistantReasoning });
  if (extensionProvider) {
    assertRegisteredProviderModel(config.provider, config.model, {
      userId: config.userId,
      needsVision: messagesNeedVision(preparedContext.messages),
      needsTools: preparedContext.toolDeclarations.length > 0,
      needsJson: config.responseFormat === 'json_object',
      ...(streaming ? { needsStreaming: true } : {}),
    });
  }
  if (supervisedLocal) await ensureLocalModelReady(config.provider as LocalModelProvider, config.model, { timeoutMs: 8_000 });
  const params: any = fmt({
    model: config.model,
    messages: preparedContext.messages,
    toolDeclarations: preparedContext.toolDeclarations,
    maxTokens: localRequest?.maxTokens || maxTokens,
    responseFormat: config.provider === 'lmstudio' && config.responseFormat === 'json_object'
      ? { type: 'json_schema', json_schema: { name: 'json_response', schema: { type: 'object', additionalProperties: true } } } : config.responseFormat,
    ...(isLocal ? {} : { userId: config.userId }),
  });
  if (config.provider === 'xiaomi' || (config.provider === 'openai' && isReasoningModel(config.model))) {
    if (params.max_tokens !== undefined) params.max_completion_tokens = params.max_tokens;
    delete params.max_tokens;
  }
  if (config.thinkingMode === 'disabled') {
    if (config.provider === 'qwen' || (config.provider === 'relay' && /(?:^|\/)qwen/i.test(config.model))) params.enable_thinking = false;
    if (deepseekProtocol) params.thinking = { type: 'disabled' };
  }

  if (config.reasoningEffort && config.thinkingMode !== 'disabled'
    && ['deepseek', 'relay'].includes(config.provider) && /(?:^|\/)deepseek-(?:v4|flash)/i.test(config.model)) params.reasoning_effort = config.reasoningEffort;
  return { client, supervisedLocal, localRequest, params, preparedContext };
}

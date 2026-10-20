import type { ProviderArguments } from "../provider_getters";
import type { NormalizedLLMResponse } from "../../tools/types";
import { withCloudResilience } from "../../cloud/resilience";
import { runLocalModelInference, type LocalModelProvider } from "../local_models";
import { buildProviderOutboundMessagesEvidence } from "../outbound_message_evidence";
import { prepareModelRequestContext } from "../request_context_budget";
import type { NormalizedMessage, ToolDeclaration, LLMCallConfig } from './contracts';
import { assertQwenAllowedByUserPrefs, assertProviderAllowedByPrivacy, extensionProviderForCall, extensionProviderFailure } from './access_policy';
import { resolveModelMaxTokens } from './dispatch_preferences';
import { prepareCompatibleModelRequest } from './request_preparation';
import { providerSourceUserSlot } from './request_context';
import { resolveModelAttemptTimeouts, ModelAttemptSupervisor } from './deadlines';
import { executeWithProviderOutboundEvidence } from './outbound_evidence';
import { parseOpenAIResponse, parseOpenAICompatibleResponse } from './openai_compatible';
import { formatGeminiRequest, parseGeminiResponse } from './gemini';
import { formatAnthropicRequest, parseAnthropicResponse } from './anthropic';

export async function makeLLMCallDirect(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  ...getters: ProviderArguments
): Promise<NormalizedLLMResponse> {
  const [, getGemini, , getAnthropic] = getters;
  assertQwenAllowedByUserPrefs(config);

  // ── Privacy gate: strict mode blocks cloud providers ──
  // Reasoning models need high token budget — their CoT eats into max_tokens
  const maxTokens = resolveModelMaxTokens(config.model, config.maxTokens);

  if (config.provider === 'auto') {
    throw new Error('Automatic model routing must be resolved before direct provider execution');
  }

  assertProviderAllowedByPrivacy(config);

  // OpenAI-compatible path: DeepSeek, Qwen, Ark, Ollama, LM Studio
  const extensionProvider = extensionProviderForCall(config);
  if (extensionProvider || config.provider === 'deepseek' || config.provider === 'openai' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const { client, supervisedLocal, params, preparedContext } = await prepareCompatibleModelRequest(
      messages, toolDeclarations, config, maxTokens, getters, extensionProvider, false,
    );
    toolDeclarations = preparedContext.toolDeclarations;
    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'openai_compatible',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      ...outboundSourceSlot,
    });

    const attemptTimeouts = resolveModelAttemptTimeouts(config.attemptTimeouts);
    const execute = () => withCloudResilience(
        async operationSignal => {
          const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
          try {
            return await supervisor.completion(Promise.resolve().then(() => client.chat.completions.create(
              params, { signal: supervisor.signal },
            )));
          } catch (error) {
            supervisor.abort(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        },
        {
          provider: config.provider,
          model: config.model,
          // Dispatch already owns candidate fallback. A non-stream recovery
          // must not silently retry the same timed-out candidate three times.
          maxRetries: 0,
          signal: config.signal,
          timeoutMs: attemptTimeouts.absoluteMs,
        },
      );
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
      let response: any;
      try {
        response = supervisedLocal
          ? await runLocalModelInference(config.provider as LocalModelProvider, execute, { signal: config.signal, model: config.model })
          : await execute();
      } catch (error) {
        if (extensionProvider) throw extensionProviderFailure(config.provider, error);
        throw error;
      }
      return config.provider === 'openai' ? parseOpenAIResponse(response) : parseOpenAICompatibleResponse(response, toolDeclarations);
    }, preparedContext, toolDeclarations
      .map(declaration => declaration.function.name));
  }

  const preparedContext = prepareModelRequestContext({
    messages,
    toolDeclarations,
    inputTokenBudget: config.inputTokenBudget,
    protectedToolNames: config.protectedToolNames,
  });
  messages = preparedContext.messages;
  toolDeclarations = preparedContext.toolDeclarations;

  if (config.provider === 'gemini') {
    const client = getGemini();
    if (!client) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');

    const { modelConfig, contents } = formatGeminiRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      responseFormat: config.responseFormat,
    });

    const outboundSourceSlot = providerSourceUserSlot(contents);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'gemini',
      messages: contents,
      toolDeclarations: modelConfig.tools || [],
      system: modelConfig.systemInstruction,
      ...outboundSourceSlot,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
      const result = await withCloudResilience(
        operationSignal => (modelInstance as any).generateContent(
          { contents },
          operationSignal ? { signal: operationSignal } : undefined,
        ),
        {
          provider: 'gemini',
          maxRetries: 0,
          model: config.model,
          signal: config.signal,
          timeoutMs: resolveModelAttemptTimeouts(config.attemptTimeouts).absoluteMs,
        },
      );
      return parseGeminiResponse(result);
    }, preparedContext);
  }

  if (config.provider === 'anthropic') {
    const client = getAnthropic?.();
    if (!client) throw new Error('Anthropic not configured (ANTHROPIC_API_KEY missing)');

    const params = formatAnthropicRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'anthropic',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      system: params.system,
      ...outboundSourceSlot,
    });

    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
      const response = await withCloudResilience(
        operationSignal => client.messages.create(
          params,
          operationSignal ? { signal: operationSignal } : undefined,
        ),
        {
          provider: 'anthropic',
          maxRetries: 0,
          model: config.model,
          signal: config.signal,
          timeoutMs: resolveModelAttemptTimeouts(config.attemptTimeouts).absoluteMs,
        },
      );
      return parseAnthropicResponse(response);
    }, preparedContext);
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}

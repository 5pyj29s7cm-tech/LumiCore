import type { ProviderArguments } from "../provider_getters";
import type { ParsedToolCall, NormalizedLLMResponse } from "../../tools/types";
import { withCloudResilience } from "../../cloud/resilience";
import { runLocalModelInference, type LocalModelProvider } from "../local_models";
import { buildProviderOutboundMessagesEvidence } from "../outbound_message_evidence";
import { prepareModelRequestContext } from "../request_context_budget";
import type { NormalizedMessage, ToolDeclaration, LLMCallConfig, StreamCallback } from './contracts';
import { assertQwenAllowedByUserPrefs, assertProviderAllowedByPrivacy, extensionProviderForCall, extensionProviderFailure } from './access_policy';
import { resolveModelMaxTokens } from './dispatch_preferences';
import { prepareCompatibleModelRequest } from './request_preparation';
import { providerSourceUserSlot } from './request_context';
import { ModelAttemptSupervisor, stopIterator } from './deadlines';
import { createLegacyProtocolChunkFilter, parseLegacyXmlToolCalls } from './legacy_protocol';
import { extractUsage, assertToolResponseComplete, parseToolArguments, completionMetadata } from './response';
import { parseOpenAICompatibleResponse } from './openai_compatible';
import { executeWithProviderOutboundEvidence } from './outbound_evidence';
import { formatGeminiRequest, parseGeminiResponse } from './gemini';
import { formatAnthropicRequest } from './anthropic';

export async function makeLLMCallStreamingDirect(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  onChunk: StreamCallback,
  ...getters: ProviderArguments
): Promise<NormalizedLLMResponse> {
  const [, getGemini, , getAnthropic] = getters;
  assertQwenAllowedByUserPrefs(config);

  // ── Privacy gate ──
  if (config.provider !== 'auto') assertProviderAllowedByPrivacy(config);

  // Reasoning models need high token budget
  const maxTokens = resolveModelMaxTokens(config.model, config.maxTokens);

  // ── Auto/hybrid dispatch: local Ollama → cloud DeepSeek fallback ──
  if (config.provider === 'auto') {
    throw new Error('Automatic model routing must be resolved before direct provider execution');
  }

  // ── DeepSeek / OpenAI / Qwen / Ark / Ollama / LM Studio (OpenAI-compatible streaming) ──
  const extensionProvider = extensionProviderForCall(config);
  if (extensionProvider || config.provider === 'deepseek' || config.provider === 'openai' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const { client, supervisedLocal, params, preparedContext } = await prepareCompatibleModelRequest(
      messages, toolDeclarations, config, maxTokens, getters, extensionProvider, true,
    );
    toolDeclarations = preparedContext.toolDeclarations;
    // The official relay currently fails its SSE endpoint after an empty
    // handshake frame.  Use the reliable JSON response by default; callers
    // may explicitly opt in after verifying a relay deployment's streaming
    // contract.  Other OpenAI-compatible providers retain normal streaming.
    const relayStreamingEnabled = config.provider !== 'relay'
      || config.relayStreaming === true
      || /^(1|true|yes|on)$/i.test(String(process.env.RELAY_ENABLE_STREAMING || '').trim());
    params.stream = relayStreamingEnabled;

    const outboundSourceSlot = providerSourceUserSlot(params.messages);
    const outboundEvidence = buildProviderOutboundMessagesEvidence({
      provider: config.provider,
      model: config.model,
      requestFormat: 'openai_compatible',
      messages: params.messages,
      toolDeclarations: params.tools || [],
      ...outboundSourceSlot,
    });

    const consumeStream = async (operationSignal?: AbortSignal): Promise<NormalizedLLMResponse> => {
      const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
      const accumulatedText: string[] = [];
      const accumulatedReasoning: string[] = [];
      const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();
      const legacyProtocolFilter = createLegacyProtocolChunkFilter(onChunk);
      let streamUsage: any = undefined;
      let finishReason: unknown;
      let iterator: AsyncIterator<any> | undefined;

      try {
        const stream: any = await supervisor.request(() => client.chat.completions.create(
          params,
          { signal: supervisor.signal },
        ));
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await supervisor.next(iterator);
          if (next.done) break;
          const chunk = next.value;
          if (config.provider === 'relay' && chunk?.error) {
            const relayError = chunk.error;
            const detail = typeof relayError === 'string'
              ? relayError
              : String(relayError.message || relayError.code || 'relay stream error');
            const error = new Error(detail);
            if (relayError && typeof relayError === 'object' && relayError.code) {
              (error as any).code = relayError.code;
            }
            throw error;
          }
          if (chunk.choices?.[0]?.finish_reason != null) {
            finishReason = chunk.choices[0].finish_reason;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) {
              accumulatedText.push(delta.content);
              if (String(delta.content).trim()) {
                supervisor.markSemanticContent();
              }
              legacyProtocolFilter.emit(delta.content);
            }

            if (delta.reasoning_content) {
              accumulatedReasoning.push(delta.reasoning_content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulators.has(idx)) {
                  toolCallAccumulators.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
                }
                const acc = toolCallAccumulators.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
                if (tc.id || tc.function?.name || tc.function?.arguments) {
                  supervisor.markSemanticContent();
                }
              }
            }
          }
          if (chunk.usage) streamUsage = chunk.usage;
        }
        supervisor.assertSemanticContent({ ...completionMetadata(finishReason), usage: extractUsage({ usage: streamUsage }) });
        legacyProtocolFilter.flush();

        const usage = extractUsage({ usage: streamUsage });
        const text = accumulatedText.length > 0 ? accumulatedText.join('') : null;
        const reasoningContent = accumulatedReasoning.length > 0 ? accumulatedReasoning.join('') : null;
        if (toolCallAccumulators.size > 0) {
          assertToolResponseComplete(finishReason);
          const toolCalls: ParsedToolCall[] = [...toolCallAccumulators.values()].map(acc => ({
            id: acc.id,
            name: acc.name,
            arguments: parseToolArguments(acc.args),
          }));
          return { text, toolCalls, reasoningContent, usage, ...completionMetadata(finishReason) };
        }
        const legacyToolCalls = parseLegacyXmlToolCalls(text, toolDeclarations);
        if (legacyToolCalls) {
          return { text: null, toolCalls: legacyToolCalls, reasoningContent, usage, ...completionMetadata(finishReason) };
        }
        return { text, toolCalls: null, reasoningContent, usage, ...completionMetadata(finishReason) };
      } catch (error) {
        supervisor.abort(error instanceof Error ? error : new Error(String(error)));
        stopIterator(iterator);
        throw error;
      }
    };

    // Execute the explicitly selected JSON transport once; stream failures
    // remain visible to the existing caller and routing policy.
    const consumeRelayNonStreaming = async (operationSignal?: AbortSignal): Promise<NormalizedLLMResponse> => {
      const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
      const nonStreamingParams = { ...params, stream: false };
      try {
        // A non-stream request resolves only after the complete answer. The
        // connection/stream-handshake deadline must not truncate generation.
        const response = await supervisor.completion(Promise.resolve().then(() => client.chat.completions.create(
          nonStreamingParams,
          { signal: supervisor.signal },
        )));
        const parsed = parseOpenAICompatibleResponse(response, toolDeclarations);
        if (!String(parsed.text || '').trim() && !(parsed.toolCalls?.length)) {
          supervisor.assertSemanticContent();
        }
        supervisor.markSemanticContent();
        // The stream path has already buffered output until a semantic frame;
        // emit the completed non-stream result exactly once.
        if (parsed.text) onChunk(parsed.text);
        return parsed;
      } catch (error) {
        supervisor.abort(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    };

    const executeStream = () => withCloudResilience(
      config.provider === 'relay'
        ? (relayStreamingEnabled ? consumeStream : consumeRelayNonStreaming)
        : consumeStream,
      {
        provider: config.provider,
        model: config.model,
        // Retrying an acquired stream can replay partial output. Candidate
        // failover is owned by dispatch, which buffers until a full success.
        maxRetries: 0,
        signal: config.signal,
      },
    );
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => {
      try {
        return supervisedLocal
          ? await runLocalModelInference(config.provider as LocalModelProvider, executeStream, { signal: config.signal, model: config.model })
          : await executeStream();
      } catch (error) {
        if (extensionProvider) throw extensionProviderFailure(config.provider, error);
        throw error;
      }
    }, preparedContext, toolDeclarations
      .map(declaration => declaration.function.name));
  }

  const preparedContext = prepareModelRequestContext({ messages, toolDeclarations, inputTokenBudget: config.inputTokenBudget, protectedToolNames: config.protectedToolNames });
  messages = preparedContext.messages;
  toolDeclarations = preparedContext.toolDeclarations;

  // ── Gemini streaming ──
  if (config.provider === 'gemini') {
    const client = getGemini();
    if (!client) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');

    const { modelConfig, contents } = formatGeminiRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
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
    return executeWithProviderOutboundEvidence(outboundEvidence, async () => withCloudResilience(
      async operationSignal => {
        const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
        const accumulatedText: string[] = [];
        const toolCalls: ParsedToolCall[] = [];
        let iterator: AsyncIterator<any> | undefined;
        try {
          const result: any = await supervisor.request(() => (modelInstance as any).generateContentStream(
            { contents },
            { signal: supervisor.signal },
          ));
          iterator = result.stream[Symbol.asyncIterator]();
          while (true) {
            const next = await supervisor.next(iterator);
            if (next.done) break;
            const chunk = next.value;
            const text = chunk.text();
            if (text) {
              accumulatedText.push(text);
              if (String(text).trim()) supervisor.markSemanticContent();
              onChunk(text);
            }
            const calls = chunk.functionCalls();
            if (calls) {
              for (let i = 0; i < calls.length; i++) {
                toolCalls.push({
                  id: `gemini-${Date.now()}-${toolCalls.length}`,
                  name: calls[i].name || '',
                  arguments: calls[i].args || {},
                });
                supervisor.markSemanticContent();
              }
            }
          }

          // The aggregate promise is part of the same health attempt. A
          // handshake and terminal stream are not success until it settles.
          const aggregated = await supervisor.completion(result.response);
          const parsed = parseGeminiResponse(aggregated);
          if (parsed.text?.trim() || (parsed.toolCalls?.length || 0) > 0) supervisor.markSemanticContent();
          supervisor.assertSemanticContent();
          return {
            text: accumulatedText.length > 0 ? accumulatedText.join('') : parsed.text,
            toolCalls: parsed.toolCalls && parsed.toolCalls.length > 0 ? parsed.toolCalls : (toolCalls.length > 0 ? toolCalls : null),
            usage: parsed.usage,
          };
        } catch (error) {
          supervisor.abort(error instanceof Error ? error : new Error(String(error)));
          stopIterator(iterator);
          throw error;
        }
      },
      { provider: 'gemini', model: config.model, maxRetries: 0, signal: config.signal },
    ), preparedContext);
  }

  // ── Anthropic streaming ──
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

    return executeWithProviderOutboundEvidence(outboundEvidence, async () => withCloudResilience(
      async operationSignal => {
        const supervisor = new ModelAttemptSupervisor(operationSignal, config.attemptTimeouts);
        const textParts: string[] = [];
        const toolCalls: ParsedToolCall[] = [];
        let iterator: AsyncIterator<any> | undefined;
        try {
          const stream: any = await supervisor.request(() => client.messages.stream(
            params,
            { signal: supervisor.signal },
          ));
          iterator = stream[Symbol.asyncIterator]();
          while (true) {
            const next = await supervisor.next(iterator);
            if (next.done) break;
            const event = next.value;
            // The SDK iterator yields raw stream events; `text` is a separate
            // EventEmitter convenience callback, not an iterator event.
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              const text = String(event.delta.text || '');
              textParts.push(text);
              if (text.trim()) supervisor.markSemanticContent();
              if (text) onChunk(text);
            }
            if (event.type === 'content_block_start' && (event as any).content_block?.type === 'tool_use') {
              supervisor.markSemanticContent();
            }
            if (event.type === 'content_block_delta' && (event as any).delta?.type === 'input_json_delta') {
              if (event.delta.partial_json) supervisor.markSemanticContent();
            }
          }

          const finalMessage: any = await supervisor.completion<any>(stream.finalMessage());
          // The SDK assembles JSON fragments by content-block index. Use its
          // completed inputs so one tool can never consume another's fragment.
          for (const block of finalMessage.content || []) {
            if (block.type === 'tool_use') {
              assertToolResponseComplete(finalMessage.stop_reason);
              toolCalls.push({ id: block.id, name: block.name, arguments: parseToolArguments(block.input) });
              supervisor.markSemanticContent();
            }
          }
          const finalText = (finalMessage.content || [])
            .filter((block: any) => block.type === 'text')
            .map((block: any) => String(block.text || '')).join('');
          const streamedText = textParts.join('');
          if (finalText && finalText !== streamedText) {
            if (!finalText.startsWith(streamedText)) {
              throw new Error('Model final text does not match its streamed text');
            }
            const remainder = finalText.slice(streamedText.length);
            textParts.push(remainder);
            if (remainder) onChunk(remainder);
          }
          if (finalText.trim()) supervisor.markSemanticContent();
          supervisor.assertSemanticContent();
          return {
            text: textParts.length > 0 ? textParts.join('') : null,
            toolCalls: toolCalls.length > 0 ? toolCalls : null,
            usage: extractUsage(finalMessage),
          };
        } catch (error) {
          supervisor.abort(error instanceof Error ? error : new Error(String(error)));
          stopIterator(iterator);
          throw error;
        }
      },
      { provider: 'anthropic', model: config.model, maxRetries: 0, signal: config.signal },
    ), preparedContext);
  }

  throw new Error(`Unsupported streaming provider: ${config.provider}`);
}

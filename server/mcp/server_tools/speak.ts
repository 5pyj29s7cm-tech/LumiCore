import { finalizeLumiResponseForDelivery } from "../../cognition/response_delivery";
import { z } from "zod";
import { synthesizeSpeech, getActiveProvider } from "../../tts/adapter";
import { logger } from "../../../logger";
import { publicMcpToolFailure, sanitizeMcpLogValue } from "../public_security";
import type { McpToolRuntime } from './contracts';

export function registerLumiSpeakTool({ mcp, bc }: Pick<McpToolRuntime, "mcp" | "bc">) {



  // Tool: proactive speak — Lumi pushes TTS audio to xiaozhi
  mcp.registerTool(
    'lumi_speak',
    {
      description: 'Synthesize speech from text and return audio. Used for Lumi to proactively speak through the xiaozhi device — notifications, reminders, or unprompted comments.',
      inputSchema: {
        text: z.string().describe('The text Lumi should speak'),
        voiceId: z.string().optional().describe('TTS voice ID (default uses Lumi personality voice)'),
      },
    },
    async ({ text, voiceId }) => {
      try {
        const outbound = await finalizeLumiResponseForDelivery({
          taskText: `Proactive speech request: ${text}`,
          responseText: text,
          toolRecords: [],
          source: 'mcp_speak',
        });
        const finalized = outbound.finalization;
        if (finalized.blocked) {
          bc('mcp:activity', {
            device: 'xiaozhi',
            action: 'speak',
            status: 'blocked',
            finalized: true,
            blocked: true,
            reason: finalized.reason || '',
          });
          return {
            content: [{ type: 'text' as const, text: finalized.text }],
            isError: true,
            finalized: true,
            blocked: true,
            reason: finalized.reason || '',
          };
        }

        const provider = getActiveProvider();
        const vid = voiceId || 'longxiaochun_v3';
        const ttsResult = await synthesizeSpeech(finalized.text, { provider, voiceId: vid });
        const audioBase64 = ttsResult.audioBuffer.toString('base64');
        bc('mcp:activity', {
          device: 'xiaozhi',
          action: 'speak',
          bytes: ttsResult.audioBuffer.length,
          finalized: true,
          blocked: false,
          reason: '',
        });
        bc('mcp:proactive', {
          text: finalized.text,
          audio: audioBase64,
          format: ttsResult.format,
          finalized: true,
          blocked: false,
          reason: '',
        });
        return {
          content: [{ type: 'text' as const, text: `Speech synthesized (${ttsResult.audioBuffer.length} bytes, ${ttsResult.format})` }],
          audio: audioBase64,
          audioFormat: ttsResult.format,
          finalized: true,
          blocked: false,
          reason: '',
        };
      } catch (err: any) {
        logger.error(`[MCP Tool] speech synthesis failed: ${sanitizeMcpLogValue(err?.message || err)}`);
        return {
          content: [{ type: 'text' as const, text: publicMcpToolFailure() }],
          isError: true,
          finalized: true,
          blocked: true,
          reason: 'mcp_operation_failed',
        };
      }
    },
  );
}

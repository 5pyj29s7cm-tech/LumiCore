import { Router, Request, NextFunction } from 'express';
import { makeLLMCall } from '../llm/providers';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { requireAuth } from '../middleware/auth';
import { isAudioTranscriptionUnavailable, transcribeAudioFile } from '../stt/file_transcription';
import {
  buildPixelPetDesignPrompt,
  CN_CREATIVE_PET_PATTERNS,
} from '../regions/packs/cn/creative_pet_messages';

const asyncHandler = (fn: (req: Request, res: any, next?: NextFunction) => Promise<any>) =>
  (req: Request, res: any, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountCreativeRoutes(
  router: Router,
  _jwtSecret: string,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
    getOllama?: () => any;
    getLmStudio?: () => any;
    getArk?: () => any;
    getXiaomi?: () => any;
    getKimi?: () => any;
    getGlm?: () => any;
    getRelay?: () => any;
  },
) {
  router.post("/audio/transcribe", requireAuth, asyncHandler(async (req, res) => {
    const { audio, fileName } = req.body || {};
    if (!audio) return res.status(400).json({ error: "Audio data is required" });
    try {
      const result = await transcribeAudioFile(Buffer.from(audio, 'base64'), {
        fileName: fileName || 'audio.mp3',
        language: 'zh',
      });
      res.json({
        text: result.text,
        provider: result.provider,
        model: result.model,
        warnings: result.warnings,
      });
    } catch (err: any) {
      res.json({
        text: '',
        ...(isAudioTranscriptionUnavailable(err)
          ? { note: err.message }
          : { error: err?.message || String(err) }),
      });
    }
  }));

  router.post("/pets/generate", requireAuth, asyncHandler(async (req, res) => {
    const { prompt, mode } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: "Prompt is required" });
    const lower = prompt.toLowerCase();

    if (mode === 'ai_enhanced') {
      try {
        const llmPrompt = buildPixelPetDesignPrompt(prompt);
        const userId = (req as any).user?.uid || 'anonymous';
        const result = await makeLLMCall(
          [{ role: 'user', content: llmPrompt }],
          [],
          getUserPreferredLLMConfig(userId, { maxTokens: 500 }),
          llmGetters.getDeepSeek,
          llmGetters.getGemini,
          llmGetters.getOpenAI,
          llmGetters.getAnthropic,
          llmGetters.getQwen,
          llmGetters.getOllama,
          llmGetters.getLmStudio,
          llmGetters.getArk,
          llmGetters.getXiaomi,
          llmGetters.getKimi,
          llmGetters.getGlm,
          llmGetters.getRelay,
        );
        let aiDesign: any = {};
        try { aiDesign = JSON.parse((result.text || '').replace(/```json\s*|```/g, '').trim()); } catch { aiDesign = {}; }
        const colorMap: Record<string, string> = { white:'#f0f0f0',black:'#3a3a3a',red:'#e85545',blue:'#5599dd',green:'#5ddb5d',purple:'#9966cc',pink:'#f0a0b0',orange:'#f4a460',yellow:'#f5d442',brown:'#8B6914',cream:'#fff8dc',grey:'#888888' };
        const tags: any = {
          species: aiDesign.species || 'cat',
          color: colorMap[aiDesign.color] || aiDesign.color || '#f4a460',
          pattern: aiDesign.pattern || 'solid',
          patternColor: colorMap[aiDesign.patternColor] || aiDesign.patternColor || '',
          eyeShape: aiDesign.eyeShape || 'round',
          eyeColor: aiDesign.eyeColor || '',
          mouthStyle: aiDesign.mouthStyle || 'smile',
          size: aiDesign.size || 'normal',
          hasWings: !!aiDesign.hasWings,
          hasHorns: !!aiDesign.hasHorns,
          special: aiDesign.special || 'none',
        };
        return res.json({ generated: true, prompt, petId: `ai-${Date.now()}`, petName: aiDesign.petName || prompt.slice(0, 30), tags, aiEnhanced: true });
      } catch (err: any) { console.error('[Pet Gen] AI-enhanced failed:', err.message); }
    }

    // Procedural fallback: regex matching
    let species = 'cat';
    if (CN_CREATIVE_PET_PATTERNS.fox.test(lower)) species = 'fox';
    else if (CN_CREATIVE_PET_PATTERNS.rabbit.test(lower)) species = 'rabbit';
    else if (CN_CREATIVE_PET_PATTERNS.bear.test(lower)) species = 'bear';
    else if (CN_CREATIVE_PET_PATTERNS.hamster.test(lower)) species = 'hamster';
    else if (CN_CREATIVE_PET_PATTERNS.blob.test(lower)) species = 'blob';
    else if (CN_CREATIVE_PET_PATTERNS.bird.test(lower)) species = 'bird';
    else if (CN_CREATIVE_PET_PATTERNS.dragon.test(lower)) species = 'dragon';

    const colorMap: Record<string, string> = { white:'#f0f0f0',black:'#3a3a3a',red:'#e85545',blue:'#5599dd',green:'#5ddb5d',purple:'#9966cc',pink:'#f0a0b0',orange:'#f4a460',yellow:'#f5d442',brown:'#8B6914',cream:'#fff8dc',grey:'#888888' };
    const color = Object.keys(colorMap).find(c => lower.includes(c)) || 'orange';
    const pattern = CN_CREATIVE_PET_PATTERNS.pattern.test(lower) ? (CN_CREATIVE_PET_PATTERNS.spotted.test(lower) ? 'spotted' : 'striped') : 'solid';
    const eyeShape = CN_CREATIVE_PET_PATTERNS.starEye.test(lower) ? 'star' : CN_CREATIVE_PET_PATTERNS.heartEye.test(lower) ? 'heart' : CN_CREATIVE_PET_PATTERNS.slitEye.test(lower) ? 'slit' : 'round';
    const mouthStyle = CN_CREATIVE_PET_PATTERNS.openMouth.test(lower) ? 'open' : CN_CREATIVE_PET_PATTERNS.shockedMouth.test(lower) ? 'shocked' : CN_CREATIVE_PET_PATTERNS.tongueMouth.test(lower) ? 'tongue' : 'smile';
    const size = CN_CREATIVE_PET_PATTERNS.tiny.test(lower) ? 'tiny' : CN_CREATIVE_PET_PATTERNS.small.test(lower) ? 'small' : CN_CREATIVE_PET_PATTERNS.large.test(lower) ? 'large' : 'normal';
    const hasWings = CN_CREATIVE_PET_PATTERNS.wings.test(lower);
    const hasHorns = CN_CREATIVE_PET_PATTERNS.horns.test(lower);
    const special = CN_CREATIVE_PET_PATTERNS.glowing.test(lower) ? 'glowing' : CN_CREATIVE_PET_PATTERNS.sparkly.test(lower) ? 'sparkly' : 'none';

    res.json({ generated: true, prompt, petId: `custom-${Date.now()}`, petName: prompt.slice(0, 30), tags: { species, color: colorMap[color] || '#f4a460', pattern, patternColor: '', eyeShape, eyeColor: '', mouthStyle, size, hasWings, hasHorns, special } });
  }));
}

import React, { useState, useEffect } from 'react';
import { User, ChevronDown, ChevronRight, Activity, Users } from 'lucide-react';
import { toast } from 'sonner';
import { PersonalityEvolution } from './PersonalityEvolution';
import { ContactsPanel } from './ContactsPanel';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';

interface PersonalityConfig {
  id: string;
  name: string;
  version: string;
  coreMotivation: string;
  behavioralBoundaries: string[];
  expressionStyle: {
    persona: string;
    tone: string;
    verbosity: string;
    languages: string[];
    vocabularyHints?: string[];
  };
  toolPolicy: {
    allowedTools: string[];
    requireConfirmation: string[];
    forbiddenTools: string[];
    maxIterations: number;
    securityOverrides?: Record<string, string>;
  };
  memoryPolicy: {
    retrieveLimit: number;
    minConfidence: number;
    includeTypes: string[];
    autoExtract: boolean;
  };
  ttsVoiceId?: string;
  personalityVector?: {
    cognitiveStyle: { analytical: number; intuitive: number; systematic: number; creative: number };
    socialStyle: { warmth: number; directness: number; playfulness: number; formality: number };
  };
  evolutionConfig?: {
    plasticity: number;
    minMemoriesForEvolution: number;
    minConnectionForEvolution: number;
    cooldownMs: number;
    maxMutationsPerStep: number;
  };
  lastEvolvedAt?: string | null;
  growthState?: {
    version: number;
    lastUpdatedAt: string;
    ownerInterests: string[];
    ownerExpressions: string[];
    communicationPatterns: string[];
    adaptationNotes: string[];
    ownerProfile?: {
      memoryCount: number;
      dominantTone: string;
      formalityLevel: number;
      emotionalExpressiveness: number;
    };
  };
  evolutionFrozenAt?: string | null;
}

export function PersonalityEditor({ t }: { t?: any }) {
  const [tab, setTab] = useState<'personality' | 'contacts'>('personality');
  const [config, setConfig] = useState<PersonalityConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    identity: true,
    growth: true,
    boundaries: false,
    expression: false,
    evolution: true,
    tools: false,
    memory: false,
  });
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  const toggleSection = (s: string) => setExpandedSections(prev => ({ ...prev, [s]: !prev[s] }));

  useEffect(() => {
    fetch('/api/personalities')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setConfig(data[0]);
        }
      })
      .catch(() => toast.error(t?.failedToLoadPersonalities || uiMessage('personality-editor.failed-to-load-lumi-config.715c426961')))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="animate-in fade-in space-y-8 duration-500">
        <div className="lumi-panel flex items-center gap-3 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn">
            <User size={20} />
          </span>
          <h3 className="text-xl font-black uppercase tracking-[0.08em] text-white/90">{t?.lumiCore || uiMessage('personality-editor.lumi-core-config.8a4e9b757c')}</h3>
        </div>
        <p className="lumi-panel p-5 text-sm text-white/40">{t?.loadingPersonalities || uiMessage('personality-editor.loading.586f5af819')}</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="animate-in fade-in space-y-8 duration-500">
        <div className="lumi-panel flex items-center gap-3 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn">
            <User size={20} />
          </span>
          <h3 className="text-xl font-black uppercase tracking-[0.08em] text-white/90">{t?.lumiCore || uiMessage('personality-editor.lumi-core-config.8a4e9b757c')}</h3>
        </div>
        <p className="lumi-panel p-5 text-sm text-white/40">{t?.noPersonalitiesDefined || uiMessage('personality-editor.no-configuration-found.7f74a3d38a')}</p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 space-y-6 duration-500">
      {/* Tab bar */}
      <div className="lumi-panel flex items-center gap-1 p-1">
        {[
          { id: 'personality' as const, label: t?.lumiCore || uiMessage('personality-editor.personality.4be4c6883c'), icon: <User size={14} /> },
          { id: 'contacts' as const, label: t?.contacts || uiMessage('personality-editor.contacts.cafbf1d042'), icon: <Users size={14} /> },
        ].map(item => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
              tab === item.id ? 'border-celestial-saturn/25 bg-celestial-saturn/10 text-celestial-saturn' : 'border-transparent text-white/40 hover:bg-white/[0.05] hover:text-white/70'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'contacts' ? (
        <ContactsPanel />
      ) : (
        <>
      <div className="lumi-panel flex items-center gap-3 p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-celestial-saturn/20 bg-celestial-saturn/10 text-celestial-saturn">
          <User size={20} />
        </span>
        <h3 className="text-xl font-black uppercase tracking-[0.08em] text-white/90">{t?.lumiCore || uiMessage('personality-editor.lumi-core-config.8a4e9b757c')}</h3>
        <span className="text-xs font-mono text-white/45 bg-white/5 px-2 py-0.5 rounded-full">v{config.version}</span>
      </div>

      <p className="text-sm text-white/40 max-w-xl">
        {t?.lumiCoreDesc || uiMessage('personality-editor.lumi-s-core-personality-evolves.acdafbbf05')}
      </p>

      <div className="space-y-4">
        {/* Identity */}
        <Section title={t?.identitySection || uiMessage('personality-editor.identity.1cadaacdf5')} section="identity" expanded={expandedSections} onToggle={toggleSection}>
          <ReadonlyField label={t?.idLabel || 'ID'} value={config.id} mono />
          <ReadonlyField label={t?.nameLabel || uiMessage('personality-editor.name.dd4dc4c5a9')} value={config.name} />
          <ReadonlyField label={t?.versionLabel || uiMessage('personality-editor.version.7e42933b4f')} value={config.version} />
          <div className="space-y-1">
            <label className="text-xs font-black uppercase text-white/55">{t?.coreMotivationLabel || uiMessage('personality-editor.core-motivation.d1f6e12adf')}</label>
            <p className="text-sm text-white/60 bg-white/5 rounded-xl p-3">{config.coreMotivation}</p>
          </div>
          <ReadonlyField label={uiMessage('personality-editor.evolution.41ec4227e8')} value={config.evolutionFrozenAt ? formatUiMessage('personality-editor.frozen-since-value0.f2b8ec3578', { value0: new Date(config.evolutionFrozenAt).toLocaleString() }) : uiMessage('personality-editor.active.9d9aa763fa')} />
        </Section>

        {/* Growth State */}
        <Section title={uiMessage('personality-editor.local-growth-state.f74855c1e2')} section="growth" expanded={expandedSections} onToggle={toggleSection}>
          {config.growthState ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <ReadonlyField label={uiMessage('personality-editor.growth-version.6ebc4cb338')} value={String(config.growthState.version)} />
                <ReadonlyField label={uiMessage('personality-editor.last-updated.42ffb29852')} value={new Date(config.growthState.lastUpdatedAt).toLocaleString()} />
              </div>
              {config.growthState.ownerProfile && (
                <div className="grid grid-cols-2 gap-4">
                  <ReadonlyField label={uiMessage('personality-editor.observed-tone.3a7e68b82c')} value={config.growthState.ownerProfile.dominantTone} />
                  <ReadonlyField label={uiMessage('personality-editor.profile-memories.522a2727a9')} value={String(config.growthState.ownerProfile.memoryCount)} />
                </div>
              )}
              <ReadonlyField label={uiMessage('personality-editor.owner-interests.a496298f87')} value={(config.growthState.ownerInterests || []).join(', ') || uiMessage('personality-editor.none.a8d7c6c030')} />
              <ReadonlyField label={uiMessage('personality-editor.owner-expressions.b3caccbe86')} value={(config.growthState.ownerExpressions || []).join(', ') || uiMessage('personality-editor.none.a8d7c6c030')} />
              <ReadonlyField label={uiMessage('personality-editor.communication-patterns.6a1c892a7d')} value={(config.growthState.communicationPatterns || []).join('; ') || uiMessage('personality-editor.none.a8d7c6c030')} />
            </div>
          ) : (
            <p className="text-white/45 text-xs">{uiMessage('personality-editor.no-local-growth-state-yet.ff4cde88a2')}</p>
          )}
        </Section>

        {/* Evolution Vector */}
        <Section title={t?.evolutionVector || uiMessage('personality-editor.evolution-vector.f374c2f5a8')} section="evolution" expanded={expandedSections} onToggle={toggleSection}>
          {config.personalityVector ? (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-black uppercase text-white/55 block mb-2">{uiMessage('personality-editor.cognitive-style.8540467dab')}</label>
                <div className="grid grid-cols-4 gap-2">
                  {Object.entries(config.personalityVector.cognitiveStyle).map(([k, v]) => (
                    <div key={k} className="text-center p-3 bg-white/5 rounded-xl">
                      <div className="text-lg font-black text-celestial-saturn">{(v * 100).toFixed(0)}%</div>
                      <div className="text-[12px] text-white/55 uppercase">{k}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-black uppercase text-white/55 block mb-2">{uiMessage('personality-editor.social-style.b41db90dc0')}</label>
                <div className="grid grid-cols-4 gap-2">
                  {Object.entries(config.personalityVector.socialStyle).map(([k, v]) => (
                    <div key={k} className="text-center p-3 bg-white/5 rounded-xl">
                      <div className="text-lg font-black text-violet-400">{(v * 100).toFixed(0)}%</div>
                      <div className="text-[12px] text-white/55 uppercase">{k}</div>
                    </div>
                  ))}
                </div>
              </div>
              {config.evolutionConfig && (
                <div className="text-xs text-white/45 space-y-1">
                  <div>{uiMessage('personality-editor.plasticity.e3133824c0')}: {config.evolutionConfig.plasticity} | {uiMessage('personality-editor.cooldown.6fa612d542')}: {Math.round(config.evolutionConfig.cooldownMs / 86400000)}d | {uiMessage('personality-editor.max-mutations-step.96c2aa4764')}: {config.evolutionConfig.maxMutationsPerStep}</div>
                  {config.lastEvolvedAt && <div>{uiMessage('personality-editor.last-evolved.2d67cd3dca')}: {new Date(config.lastEvolvedAt).toLocaleDateString()}</div>}
                </div>
              )}
            </div>
          ) : (
            <p className="text-white/55 text-xs">{t?.evolutionNotInit || uiMessage('personality-editor.evolution-vector-not-yet-initialized.182b68c0c0')}</p>
          )}
        </Section>

        {/* Expression */}
        <Section title={t?.expressionStyleSection || uiMessage('personality-editor.expression-style.ceeea2ddc5')} section="expression" expanded={expandedSections} onToggle={toggleSection}>
          <ReadonlyField label={t?.personaField || uiMessage('personality-editor.persona.963e5b3100')} value={config.expressionStyle.persona} />
          <div className="grid grid-cols-2 gap-4">
            <ReadonlyField label={t?.toneField || uiMessage('personality-editor.tone.7ee6d53e70')} value={config.expressionStyle.tone} />
            <ReadonlyField label={t?.verbosityField || uiMessage('personality-editor.verbosity.8aaeddf240')} value={config.expressionStyle.verbosity} />
          </div>
          <ReadonlyField label={t?.languagesField || uiMessage('personality-editor.languages.984eac9c23')} value={config.expressionStyle.languages.join(', ')} />
          {config.expressionStyle.vocabularyHints && config.expressionStyle.vocabularyHints.length > 0 && (
            <ReadonlyField label={t?.vocabularyHints || uiMessage('personality-editor.vocabulary-hints.9828119f9d')} value={config.expressionStyle.vocabularyHints.join(', ')} />
          )}
          <ReadonlyField label={t?.ttsVoice || uiMessage('personality-editor.tts-voice.1c88f19158')} value={config.ttsVoiceId || t?.defaultVoice || uiMessage('personality-editor.default.a08f992da4')} />
        </Section>

        {/* Boundaries */}
        <Section title={t?.behavioralBoundariesSection || uiMessage('personality-editor.behavioral-boundaries.d2dd23c7c5')} section="boundaries" expanded={expandedSections} onToggle={toggleSection}>
          {config.behavioralBoundaries.map((b, i) => (
            <div key={i} className="flex items-center gap-2 p-3 bg-white/5 rounded-xl">
              <Activity size={12} className="text-celestial-saturn/50 shrink-0" />
              <span className="text-sm text-white/60">{b}</span>
            </div>
          ))}
          {config.behavioralBoundaries.length === 0 && (
            <p className="text-white/45 text-xs">{t?.noBoundariesDefined || uiMessage('personality-editor.no-boundaries-defined.0b96af5bb1')}</p>
          )}
        </Section>

        {/* Tool Policy */}
        <Section title={t?.toolPolicySection || uiMessage('personality-editor.tool-policy.73aa8685b2')} section="tools" expanded={expandedSections} onToggle={toggleSection}>
          <ReadonlyField label={t?.allowedToolsField || uiMessage('personality-editor.allowed-tools.6cf7d8b7ae')} value={(config.toolPolicy.allowedTools || ['*']).join(', ')} />
          <ReadonlyField label={t?.requireConfirmationField || uiMessage('personality-editor.require-confirmation.035cf9d53a')} value={(config.toolPolicy.requireConfirmation || []).join(', ') || uiMessage('personality-editor.none.a8d7c6c030')} />
          <ReadonlyField label={t?.forbiddenToolsField || uiMessage('personality-editor.forbidden-tools.f256e255a7')} value={(config.toolPolicy.forbiddenTools || []).join(', ') || uiMessage('personality-editor.none.a8d7c6c030')} />
          <ReadonlyField label={t?.maxIterationsField || uiMessage('personality-editor.max-iterations.3eb27b6f0f')} value={String(config.toolPolicy.maxIterations)} />
        </Section>

        {/* Memory Policy */}
        <Section title={t?.memoryPolicySection || uiMessage('personality-editor.memory-policy.576953859c')} section="memory" expanded={expandedSections} onToggle={toggleSection}>
          <div className="grid grid-cols-2 gap-4">
            <ReadonlyField label={t?.retrieveLimitField || uiMessage('personality-editor.retrieve-limit.a2051724cb')} value={String(config.memoryPolicy.retrieveLimit)} />
            <ReadonlyField label={t?.minConfidenceField || uiMessage('personality-editor.min-confidence.260018369d')} value={String(config.memoryPolicy.minConfidence)} />
          </div>
          <ReadonlyField label={t?.includeTypesField || uiMessage('personality-editor.include-types.36245f2666')} value={config.memoryPolicy.includeTypes.join(', ')} />
          <ReadonlyField label={t?.autoExtractLabel || uiMessage('personality-editor.auto-extract.d901fcd74d')} value={config.memoryPolicy.autoExtract ? uiMessage('personality-editor.yes.4e00e01840') : uiMessage('personality-editor.no.739dd5875e')} />
        </Section>

      </div>

      {/* Evolution History + Radar */}
      <div className="rounded-2xl overflow-hidden">
        <PersonalityEvolution />
      </div>
        </>
      )}
    </div>
  );
}

// Sub-components

function Section({ title, section, expanded, onToggle, children }: {
  title: string;
  section: string;
  expanded: Record<string, boolean>;
  onToggle: (s: string) => void;
  children: React.ReactNode;
}) {
  const open = expanded[section] !== false;
  return (
    <div className="lumi-panel space-y-3 p-4">
      <button onClick={() => onToggle(section)} className="flex w-full items-center gap-2 text-left text-xs font-black uppercase tracking-widest text-white/55 hover:text-white/85">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div className="space-y-3">{children}</div>}
    </div>
  );
}

function ReadonlyField({ label, value, mono }: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-black uppercase text-white/55">{label}</label>
      <div className={`lumi-panel w-full rounded-xl px-3 py-2 text-sm text-white/65 ${mono ? 'font-mono' : ''}`}>
        {value || <span className="text-white/45">—</span>}
      </div>
    </div>
  );
}

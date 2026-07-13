import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sparkles,
  Search,
  Zap,
  Mic,
  ChevronRight,
  MessageSquare,
  MousePointer2,
  Keyboard,
  CheckCircle2,
} from 'lucide-react';
import { uiMessage } from '../i18n/uiMessages';

interface OnboardingProps {
  isOpen: boolean;
  onFinish: () => void;
  t: any;
}

type PreviewType = 'desktop' | 'chat' | 'mode' | 'search';

interface TutorialStep {
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  bullets: string[];
  icon: React.ReactNode;
  accent: string;
  preview: PreviewType;
}

export function DesktopOnboarding({ isOpen, onFinish, t }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => isZh ? zh : en;

  const steps: TutorialStep[] = [
    {
      eyebrow: uiMessage('desktop-onboarding.01-desktop-entry.715d556b35'),
      title: uiMessage('desktop-onboarding.start-from-the-desktop.5848cb636a'),
      description: uiMessage('desktop-onboarding.lumi-keeps-the-main-abilities.6fae897ddc'),
      action: uiMessage('desktop-onboarding.try-opening-chat-or-skill.3e4c2375e5'),
      bullets: [
        uiMessage('desktop-onboarding.double-click-desktop-icons-to.8167e08e4c'),
        uiMessage('desktop-onboarding.the-dock-keeps-common-entries.3af5849d82'),
        uiMessage('desktop-onboarding.open-windows-appear-in-the.c9d878bd33'),
      ],
      icon: <Sparkles size={34} className="text-celestial-saturn" />,
      accent: 'bg-celestial-saturn',
      preview: 'desktop',
    },
    {
      eyebrow: uiMessage('desktop-onboarding.02-give-a-task.348efc58bf'),
      title: uiMessage('desktop-onboarding.tell-lumi-what-to-do.572cff600b'),
      description: uiMessage('desktop-onboarding.click-the-center-orb-open.66d5ce5682'),
      action: uiMessage('desktop-onboarding.type-or-speak-a-clear.35c1b49684'),
      bullets: [
        uiMessage('desktop-onboarding.text-is-best-for-complex.690d0e029b'),
        uiMessage('desktop-onboarding.voice-is-best-for-quick.d42ff25a77'),
        uiMessage('desktop-onboarding.key-execution-states-stay-visible.75817d9bff'),
      ],
      icon: <MessageSquare size={34} className="text-blue-300" />,
      accent: 'bg-blue-400',
      preview: 'chat',
    },
    {
      eyebrow: uiMessage('desktop-onboarding.03-execution-mode.11de7c150e'),
      title: uiMessage('desktop-onboarding.check-the-mode-before-lumi.82fed22ee3'),
      description: uiMessage('desktop-onboarding.modes-affect-how-lumi-acts.3ece03b3e6'),
      action: uiMessage('desktop-onboarding.switch-between-meeting-chat-assistant.1ae153b19f'),
      bullets: [
        uiMessage('desktop-onboarding.chat-answer-only-no-proactive.fb6dff28d4'),
        uiMessage('desktop-onboarding.assistant-use-tools-skills-and.365a60bd10'),
        uiMessage('desktop-onboarding.autonomy-multi-step-work-sensitive.5120c0cf2b'),
      ],
      icon: <MousePointer2 size={34} className="text-cyan-300" />,
      accent: 'bg-cyan-400',
      preview: 'mode',
    },
    {
      eyebrow: uiMessage('desktop-onboarding.04-quick-search.116b025c6a'),
      title: uiMessage('desktop-onboarding.search-when-you-cannot-find.3ce097a4dd'),
      description: uiMessage('desktop-onboarding.top-search-can-open-chat.212c36f151'),
      action: uiMessage('desktop-onboarding.search-a-feature-name-and.7662c9b428'),
      bullets: [
        uiMessage('desktop-onboarding.type-a-feature-name-to.4b6e7f297a'),
        uiMessage('desktop-onboarding.press-enter-to-open-the.30a6cec7d1'),
        uiMessage('desktop-onboarding.useful-for-switching-common-tools.77cd93e6f7'),
      ],
      icon: <Search size={34} className="text-purple-300" />,
      accent: 'bg-purple-400',
      preview: 'search',
    },
  ];

  const step = steps[currentStep];

  const renderPreview = () => {
    if (step.preview === 'desktop') {
      return (
        <div className="relative h-full min-h-[280px] overflow-hidden rounded-2xl border border-white/10 bg-[#10131d] p-5">
          <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.22em] text-white/35">
            <span>Lumi Desktop</span>
            <span>09:41</span>
          </div>
          <div className="mt-7 grid grid-cols-3 gap-4">
            {['Chat', 'Skills', 'Knowledge', 'Run Log', 'Settings', 'Tools'].map((label, index) => (
              <motion.div
                key={label}
                initial={false}
                animate={index === 0 ? { scale: [1, 1.04, 1] } : {}}
                transition={{ repeat: Infinity, duration: 1.8 }}
                className={`flex h-20 flex-col items-center justify-center gap-2 rounded-xl border ${
                  index === 0
                    ? 'border-celestial-saturn/70 bg-celestial-saturn/15 shadow-[0_0_28px_rgba(255,204,92,0.18)]'
                    : 'border-white/10 bg-white/[0.04]'
                }`}
              >
                <div className={`h-7 w-7 rounded-lg ${index === 0 ? 'bg-celestial-saturn' : 'bg-white/15'}`} />
                <span className="text-xs font-semibold text-white/70">{label}</span>
              </motion.div>
            ))}
          </div>
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2 rounded-2xl border border-white/10 bg-black/35 px-4 py-3 backdrop-blur-xl">
            {[0, 1, 2, 3].map(item => (
              <div key={item} className="h-8 w-8 rounded-lg bg-white/12" />
            ))}
          </div>
        </div>
      );
    }

    if (step.preview === 'chat') {
      return (
        <div className="flex h-full min-h-[280px] flex-col justify-between rounded-2xl border border-white/10 bg-[#0d1220] p-5">
          <div className="space-y-4">
            <div className="max-w-[78%] rounded-2xl rounded-tl-sm bg-white/10 px-4 py-3 text-sm text-white/72">
              {uiMessage('desktop-onboarding.open-the-browser-and-organize.f1531155e2')}
            </div>
            <div className="ml-auto max-w-[82%] rounded-2xl rounded-tr-sm border border-blue-300/25 bg-blue-400/12 px-4 py-3 text-sm text-blue-50">
              {uiMessage('desktop-onboarding.i-will-confirm-the-execution.2dc75bdc77')}
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/28 p-3">
            <div className="flex-1 rounded-xl bg-white/8 px-4 py-3 text-sm text-white/35">{uiMessage('desktop-onboarding.type-a-task.a6c14c57f7')}</div>
            <button className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-400 text-black">
              <Mic size={18} />
            </button>
          </div>
        </div>
      );
    }

    if (step.preview === 'mode') {
      return (
        <div className="h-full min-h-[280px] rounded-2xl border border-white/10 bg-[#0c1420] p-5">
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-black/25 p-2">
            {[
              [uiMessage('desktop-onboarding.chat.1594b2f45c'), uiMessage('desktop-onboarding.talk-only.a4314af6ff'), MessageSquare],
              [uiMessage('desktop-onboarding.assistant.90c4ae600c'), uiMessage('desktop-onboarding.use-abilities.4dfa5370d7'), MousePointer2],
              [uiMessage('desktop-onboarding.autonomy.6aea974e38'), uiMessage('desktop-onboarding.multi-step.931079ffc4'), Zap],
            ].map(([label, hint, Icon], index) => {
              const ActiveIcon = Icon as typeof MousePointer2;
              return (
                <div
                  key={label as string}
                  className={`rounded-xl border px-3 py-4 text-center ${
                    index === 0 ? 'border-cyan-300/60 bg-cyan-300/15 text-cyan-50' : 'border-white/8 bg-white/[0.03] text-white/45'
                  }`}
                >
                  <ActiveIcon size={20} className="mx-auto mb-2" />
                  <div className="text-sm font-black">{label as string}</div>
                  <div className="mt-1 text-[11px] font-semibold">{hint as string}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4">
            <div className="text-sm font-black text-cyan-50">{uiMessage('desktop-onboarding.current-assistant-mode.ca5457dfcc')}</div>
            <p className="mt-2 text-sm leading-relaxed text-cyan-50/68">
              {uiMessage('desktop-onboarding.lumi-can-choose-tools-skills.2767803032')}
            </p>
          </div>
          <div className="mt-4 space-y-2">
            {[
              uiMessage('desktop-onboarding.understand-the-task.324a5e7bc5'),
              uiMessage('desktop-onboarding.choose-the-right-ability.b8026c5b2e'),
              uiMessage('desktop-onboarding.show-execution-progress.549c05240e'),
            ].map(label => (
              <div key={label} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2 text-sm text-white/55">
                <CheckCircle2 size={16} className="text-cyan-300" />
                {label}
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="h-full min-h-[280px] rounded-2xl border border-white/10 bg-[#101020] p-5">
        <div className="flex items-center gap-3 rounded-2xl border border-purple-300/30 bg-purple-300/12 px-4 py-3">
          <Search size={18} className="text-purple-200" />
          <span className="text-sm font-semibold text-white">settings</span>
        </div>
        <div className="mt-4 space-y-2">
          {['Settings', 'Skill Center', 'Knowledge Base', 'Chat'].map((label, index) => (
            <div
              key={label}
              className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
                index === 0 ? 'border-purple-300/45 bg-purple-300/14' : 'border-white/8 bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`h-8 w-8 rounded-lg ${index === 0 ? 'bg-purple-300' : 'bg-white/12'}`} />
                <span className="text-sm font-bold text-white/78">{label}</span>
              </div>
              <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white/28">Open</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 pointer-events-auto">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/88 backdrop-blur-2xl"
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 18 }}
          className="relative grid w-full max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-[#080a10]/95 shadow-2xl md:min-h-[580px] md:grid-cols-[300px_1fr]"
        >
          <button
            onClick={onFinish}
            className="absolute right-5 top-5 z-10 text-xs font-black uppercase tracking-[0.2em] text-white/35 transition-colors hover:text-white/70"
          >
            {t.skip || uiMessage('desktop-onboarding.skip.8ff170db92')}
          </button>

          <aside className="border-b border-white/10 bg-white/[0.03] p-6 md:border-b-0 md:border-r">
            <div className="text-xs font-black uppercase tracking-[0.28em] text-white/32">First Run</div>
            <h2 className="mt-3 text-2xl font-black text-white">{uiMessage('desktop-onboarding.lumi-desktop-tutorial.85b3ea7a0c')}</h2>
            <p className="mt-3 text-sm leading-relaxed text-white/50">
              {uiMessage('desktop-onboarding.follow-four-steps-to-understand.f42473819c')}
            </p>

            <div className="mt-7 space-y-2">
              {steps.map((item, index) => (
                <button
                  key={item.title}
                  onClick={() => setCurrentStep(index)}
                  className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all ${
                    index === currentStep
                      ? 'border-white/18 bg-white/10 text-white'
                      : 'border-transparent bg-transparent text-white/45 hover:bg-white/[0.04] hover:text-white/70'
                  }`}
                >
                  <span className={`h-2.5 w-2.5 rounded-full ${index <= currentStep ? item.accent : 'bg-white/14'}`} />
                  <span className="min-w-0">
                    <span className="block text-[10px] font-black uppercase tracking-[0.18em] opacity-50">{item.eyebrow}</span>
                    <span className="mt-1 block truncate text-sm font-bold">{item.title}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="p-6 pt-14 md:p-8 md:pt-14">
            <div className="grid gap-7 lg:grid-cols-[1fr_360px]">
              <div className="flex min-h-[420px] flex-col">
                <motion.div
                  key={`copy-${currentStep}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex-1"
                >
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05]">
                    {step.icon}
                  </div>
                  <div className="mt-7 text-xs font-black uppercase tracking-[0.28em] text-white/35">{step.eyebrow}</div>
                  <h1 className="mt-3 text-4xl font-black tracking-normal text-white">{step.title}</h1>
                  <p className="mt-5 max-w-2xl text-base leading-8 text-white/62">{step.description}</p>

                  <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                    <div className="text-xs font-black uppercase tracking-[0.22em] text-white/35">{uiMessage('desktop-onboarding.do-now.ed7f46664e')}</div>
                    <div className="mt-2 text-lg font-black text-white">{step.action}</div>
                  </div>

                  <div className="mt-5 grid gap-2">
                    {step.bullets.map(item => (
                      <div key={item} className="flex items-center gap-3 text-sm font-semibold text-white/58">
                        <CheckCircle2 size={17} className="shrink-0 text-celestial-saturn" />
                        {item}
                      </div>
                    ))}
                  </div>
                </motion.div>

                <div className="mt-7 flex items-center gap-3">
                  {currentStep > 0 && (
                    <button
                      onClick={() => setCurrentStep(prev => prev - 1)}
                      className="h-12 rounded-2xl border border-white/10 px-5 text-sm font-black text-white/55 transition-colors hover:bg-white/8 hover:text-white"
                    >
                      {uiMessage('desktop-onboarding.previous.2c0f2a614c')}
                    </button>
                  )}
                  {currentStep < steps.length - 1 ? (
                    <button
                      onClick={() => setCurrentStep(prev => prev + 1)}
                      className="flex h-12 min-w-36 items-center justify-center gap-2 rounded-2xl bg-white px-6 text-sm font-black text-black transition-transform hover:scale-[1.02] active:scale-95"
                    >
                      {uiMessage('desktop-onboarding.next.b527069e7f')}
                      <ChevronRight size={18} />
                    </button>
                  ) : (
                    <button
                      onClick={onFinish}
                      className="flex h-12 min-w-40 items-center justify-center gap-2 rounded-2xl bg-celestial-saturn px-6 text-sm font-black text-black shadow-[0_0_34px_rgba(255,200,80,0.25)] transition-transform hover:scale-[1.02] active:scale-95"
                    >
                      {uiMessage('desktop-onboarding.enter-desktop.5bf6d1be68')}
                      <Zap size={18} fill="currentColor" />
                    </button>
                  )}
                </div>
              </div>

              <motion.div
                key={`preview-${currentStep}`}
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.08 }}
                className="lg:pt-2"
              >
                {renderPreview()}
              </motion.div>
            </div>
          </section>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

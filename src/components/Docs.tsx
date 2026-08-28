import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Book, Code, Terminal, Shield, Globe, Zap, Search, Sparkles, Layers } from 'lucide-react';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { useModuleData } from '@/hooks/useModuleData';
import { LoadingSpinner, GlassCard, IconBox } from './SharedUI';

export function Docs({ t }: { t: any }) {
  const { data, loading } = useModuleData<any>('/api/modules/docs');
  const [activeTab, setActiveTab] = React.useState('philosophy');

  if (loading) return <LoadingSpinner />;

  const tabs = [
    { id: 'philosophy', title: t.corePhilosophy, icon: <Sparkles size={18} /> },
    { id: 'hosts', title: t.smartHostProgram, icon: <Layers size={18} /> },
    { id: 'clients', title: t.multiClientTitle, icon: <Globe size={18} /> },
    { id: 'getting-started', title: t.gettingStarted || 'Getting Started', icon: <Book size={18} /> },
    { id: 'api', title: t.apiReference || 'API Reference', icon: <Code size={18} /> },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-12">
      <div className="text-center space-y-6">
        <h1 className="text-6xl font-bold tracking-tighter glow-text">{data?.title || t.docs}</h1>
        <p className="text-xl text-white/60 max-w-2xl mx-auto">{t.docsTagline || 'Learn how LumiCore uses tools, memory, workflows, and local device capabilities.'}</p>
        <div className="max-w-md mx-auto relative">
          <Input placeholder={t.searchDocs || "Search documentation..."} className="bg-white/5 border-white/10 rounded-2xl p-6 h-auto text-lg pl-12" />
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40" size={20} />
        </div>
      </div>

      {/* Secondary Navigation */}
      <div className="flex flex-wrap justify-center gap-4 border-b border-white/5 pb-8">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-6 py-3 rounded-full transition-all ${
              activeTab === tab.id 
                ? 'bg-celestial-nebula text-white shadow-[0_0_20px_rgba(255,45,85,0.3)]' 
                : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            {tab.icon}
            <span className="font-bold text-sm uppercase tracking-widest">{tab.title}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="space-y-12"
        >
          {activeTab === 'philosophy' && (
            <div className="space-y-12">
              <div className="text-center space-y-4">
                <h2 className="text-4xl font-bold tracking-tighter">{t.corePhilosophy}</h2>
                <p className="text-white/60 max-w-2xl mx-auto">{t.philosophyDesc}</p>
              </div>
              <div className="grid md:grid-cols-3 gap-8">
                <PhilosophyCard 
                  icon={<Shield className="text-celestial-nebula" size={32} />} 
                  title={t.philosophyPillar1} 
                  desc={t.philosophyPillar1Desc} 
                />
                <PhilosophyCard 
                  icon={<Zap className="text-celestial-saturn" size={32} />} 
                  title={t.philosophyPillar2} 
                  desc={t.philosophyPillar2Desc} 
                />
                <PhilosophyCard 
                  icon={<Globe className="text-celestial-glow" size={32} />} 
                  title={t.philosophyPillar3} 
                  desc={t.philosophyPillar3Desc} 
                />
              </div>
            </div>
          )}

          {activeTab === 'hosts' && (
            <div className="space-y-16">
              <div className="text-center space-y-4">
                <h2 className="text-4xl font-bold tracking-tighter glow-text">{t.smartHostProgram}</h2>
                <p className="text-white/60 max-w-2xl mx-auto italic">"{t.everythingCanBeLumi}"</p>
              </div>
              
              <div className="grid md:grid-cols-2 gap-12 items-center">
                <div className="space-y-6">
                  <h3 className="text-2xl font-bold text-celestial-saturn underline decoration-celestial-saturn/30 underline-offset-8">{t.hostArchitecture || 'Host Architecture'}</h3>
                  <p className="text-lg text-white/70 leading-relaxed">
                    {t.hostArchitectureDesc || "The Smart Host Program defines a hardware-agnostic communication protocol that allows the Lumi Neural Core to 'inhabit' existing physical systems."}
                  </p>
                  <ul className="space-y-4">
                    <li className="flex gap-4">
                      <div className="w-6 h-6 rounded-full bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn font-bold text-xs mt-1">1</div>
                      <p className="text-sm text-white/60"><strong className="text-white">{t.neuralEncapsulationLabel || 'Neural Encapsulation:'}</strong> {t.neuralEncapsulationDesc || 'Wrapping existing APIs into Lumi-compatible intent streams.'}</p>
                    </li>
                    <li className="flex gap-4">
                      <div className="w-6 h-6 rounded-full bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn font-bold text-xs mt-1">2</div>
                      <p className="text-sm text-white/60"><strong className="text-white">{t.symbioticFeedbackLabel || 'Learning Feedback:'}</strong> {t.symbioticFeedbackDesc || 'Verified local interaction feedback improves LumiCore while preserving user control.'}</p>
                    </li>
                  </ul>
                </div>
                <GlassCard className="p-8 aspect-video flex flex-col justify-center items-center text-center space-y-6">
                   <Layers size={64} className="text-celestial-saturn animate-pulse" />
                   <div className="space-y-2">
                     <h4 className="font-bold">{t.protocolStatusBeta || 'Protocol Status: Beta'}</h4>
                     <p className="text-xs text-white/40">{t.activeHostsStats || 'Active hosts: 12,400+ | Categories: Toys, Industry, Wearables'}</p>
                   </div>
                </GlassCard>
              </div>
            </div>
          )}

          {activeTab === 'clients' && (
            <div className="space-y-16">
              <div className="text-center space-y-4">
                <h2 className="text-4xl font-bold tracking-tighter glow-text">{t.multiClientTitle}</h2>
                <p className="text-white/60 max-w-2xl mx-auto">{t.syncMultiDesc || 'Seamless synchronization across all your dimensions.'}</p>
              </div>

              <div className="grid md:grid-cols-2 gap-8">
                <GlassCard className="p-8 space-y-4 border-t-2 border-t-celestial-saturn">
                  <div className="flex items-center gap-3">
                    <Terminal className="text-celestial-saturn" size={24} />
                    <h3 className="text-xl font-bold">{t.desktopNode}</h3>
                  </div>
                  <p className="text-sm text-white/40 leading-relaxed">{t.desktopDesc}</p>
                  <div className="pt-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <Zap size={12} className="text-celestial-saturn" />
                      <span>{t.desktopPlatforms || 'Windows / macOS / Linux (Electron Runtime)'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <Zap size={12} className="text-celestial-saturn" />
                      <span>{t.desktopHardwareAccess || 'Direct Hardware Access for Local Inference'}</span>
                    </div>
                  </div>
                </GlassCard>

                <GlassCard className="p-8 space-y-4 border-t-2 border-t-celestial-nebula">
                  <div className="flex items-center gap-3">
                    <Globe className="text-celestial-nebula" size={24} />
                    <h3 className="text-xl font-bold">{t.mobilePerception}</h3>
                  </div>
                  <p className="text-sm text-white/40 leading-relaxed">{t.mobileDesc}</p>
                  <div className="pt-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <Zap size={12} className="text-celestial-nebula" />
                      <span>{t.mobilePlatforms || 'iOS / Android (Capacitor Runtime)'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-white/60">
                      <Zap size={12} className="text-celestial-nebula" />
                      <span>{t.multimodalSensing || 'Multimodal Sensing & Voice Sync'}</span>
                    </div>
                  </div>
                </GlassCard>
              </div>

              <div className="p-12 bg-white/5 rounded-[32px] border border-white/10 space-y-8">
                <div className="text-center space-y-2">
                  <h3 className="text-2xl font-bold">{t.syncProtocol}</h3>
                  <p className="text-sm text-white/40">{t.syncProtocolDesc}</p>
                </div>
                <div className="flex flex-col md:flex-row items-center justify-center gap-8">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center text-celestial-saturn">
                      <Terminal size={32} />
                    </div>
                    <span className="text-xs font-bold uppercase tracking-tighter">{t.brainNode || 'Brain Node'}</span>
                  </div>
                  <div className="flex-1 h-px bg-gradient-to-r from-celestial-saturn via-white/20 to-celestial-nebula hidden md:block min-w-[100px]" />
                  <div className="px-4 py-2 rounded-full border border-white/10 bg-white/5 text-xs font-mono">
                    AES-256-GCM / Local encrypted sync
                  </div>
                  <div className="flex-1 h-px bg-gradient-to-r from-celestial-nebula via-white/20 to-celestial-saturn hidden md:block min-w-[100px]" />
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center text-celestial-nebula">
                      <Globe size={32} />
                    </div>
                    <span className="text-xs font-bold uppercase tracking-tighter">{t.senseNode || 'Sense Node'}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'getting-started' && (
            <div className="grid md:grid-cols-3 gap-8">
              <DocCard
                icon={<Book className="text-celestial-mars" />}
                title={t.gettingStarted || 'Getting Started'}
                desc={t.gettingStartedDesc || 'Learn the basics of LumiCore setup, conversation, tools, and local permissions.'}
                links={[t.installDoc || 'Installation', t.firstAgentDoc || 'First conversation', t.syncingDevicesDoc || 'Syncing Devices']}
              />
              <DocCard
                icon={<Zap className="text-celestial-saturn" />}
                title={t.quickStart || 'Quick Start'}
                desc={t.quickStartDesc || 'Get up and running in less than 5 minutes.'}
                links={[t.cliSetupDoc || 'CLI Setup', t.helloWorldDoc || 'Hello World', t.nodeConfigDoc || 'Node Config']}
              />
              <DocCard
                icon={<Globe className="text-celestial-glow" />}
                title={t.ecosystemDoc || 'Capabilities'}
                desc={t.ecosystemDocDesc || 'Explore LumiCore tools, skills, workflows, and device integrations.'}
                links={['Tools and skills', 'Task continuity', t.securityDoc || 'Security']}
              />
            </div>
          )}

          {activeTab === 'api' && (
            <div className="grid md:grid-cols-3 gap-8">
              <DocCard
                icon={<Code className="text-celestial-saturn" />}
                title={t.apiReference || 'API Reference'}
                desc={t.apiReferenceDesc || 'Deep dive into the LumiAI local SDK and neural synthesis API.'}
                links={[t.authDoc || 'Authentication', t.dataStreamsDoc || 'Data Streams', t.memoryCoreDoc || 'Memory Core']}
              />
              <DocCard
                icon={<Terminal className="text-celestial-glow" />}
                title={t.cliCommands || 'CLI Commands'}
                desc={t.cliCommandsDesc || 'Full reference for the LumiAI command line interface.'}
                links={['lumi generate', 'lumi sync', 'lumi status']}
              />
              <DocCard
                icon={<Shield className="text-celestial-mars" />}
                title={t.securityApi || 'Security API'}
                desc={t.securityApiDesc || 'Manage encryption and node permissions.'}
                links={[t.keyManagementDoc || 'Key Management', t.accessControlDoc || 'Access Control', t.privacyLevelsDoc || 'Privacy Levels']}
              />
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="grid md:grid-cols-3 gap-8">
              <DocCard
                icon={<Terminal className="text-celestial-glow" />}
                title={t.advancedGuides || 'Advanced Guides'}
                desc={t.advancedGuidesDesc || 'Build reliable LumiCore workflows and custom knowledge graphs.'}
                links={[t.orchestrationDoc || 'Task execution', t.customLLMsDoc || 'Custom LLMs', t.securityRulesDoc || 'Security Rules']}
              />
              <DocCard
                icon={<Zap className="text-celestial-saturn" />}
                title={t.performanceDoc || 'Performance'}
                desc={t.performanceDocDesc || 'Optimize your node for high-speed inference.'}
                links={[t.gpuAccelerationDoc || 'GPU Acceleration', t.memoryManagementDoc || 'Memory Management', t.cachingDoc || 'Caching']}
              />
              <DocCard
                icon={<Globe className="text-celestial-nebula" />}
                title={t.globalMeshDoc || 'Runtime Reliability'}
                desc={t.globalMeshDocDesc || 'Keep one LumiCore task continuous across tools, restarts, and model fallback.'}
                links={['Task continuity', 'Model fallback', 'Failure diagnostics']}
              />
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-12">
            {data?.sections?.map((section: any) => (
              <GlassCard key={section.id} className="space-y-6" hoverEffect={false}>
                <h3 className="text-2xl font-bold tracking-tighter">{section.title}</h3>
                <div className="space-y-4 text-white/60 leading-relaxed">
                  <p>{section.content}</p>
                  {section.id === 1 && (
                    <div className="p-6 bg-white/5 rounded-2xl border border-white/10 font-mono text-sm overflow-x-auto">
                      <code>
                        lumi status --details
                      </code>
                    </div>
                  )}
                </div>
              </GlassCard>
            ))}
            
            {!data?.sections && activeTab === 'philosophy' && (
              <>
                <GlassCard className="space-y-6" hoverEffect={false}>
                  <h3 className="text-2xl font-bold tracking-tighter">{t.neuralSynthesisProtocol || 'Neural Synthesis Protocol'}</h3>
                  <div className="space-y-4 text-white/60 leading-relaxed">
                    <p>{t.neuralSynthesisProtocolDesc || 'LumiCore combines local memory, approved tools, model routing, and verification. Local data remains within its configured privacy boundary.'}</p>
                    <div className="p-6 bg-white/5 rounded-2xl border border-white/10 font-mono text-sm overflow-x-auto">
                      <code>
                        lumi status --details
                      </code>
                    </div>
                    <p>{t.neuralSynthesisPrivacyDesc || 'By defining a high privacy level, the protocol will use advanced encryption and local-only processing for all neural weight calculations.'}</p>
                  </div>
                </GlassCard>

                <GlassCard className="space-y-6" hoverEffect={false}>
                  <h3 className="text-2xl font-bold tracking-tighter">{t.securityPrivacy || 'Security & Privacy'}</h3>
                  <div className="space-y-4 text-white/60 leading-relaxed">
                    <p>{t.securityPrivacyDesc || 'Privacy is the core of LumiAI. Our security architecture is built on three pillars:'}</p>
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3"><Zap size={16} className="text-celestial-saturn" /> {t.localFirstProcessing || 'Local-First Data Processing'}</li>
                      <li className="flex items-center gap-3"><Shield size={16} className="text-celestial-mars" /> {t.endToEndEncryption || 'End-to-End Node Encryption'}</li>
                      <li className="flex items-center gap-3"><Globe size={16} className="text-celestial-glow" /> {t.decentralizedIdentity || 'Decentralized Identity (DID)'}</li>
                    </ul>
                  </div>
                </GlassCard>
              </>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function PhilosophyCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <GlassCard className="p-8 rounded-3xl space-y-4 text-center border border-white/5 hover:border-celestial-nebula/30 transition-colors">
      <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mx-auto mb-2">
        {icon}
      </div>
      <h3 className="text-xl font-bold tracking-tight">{title}</h3>
      <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
    </GlassCard>
  );
}

function DocCard({ icon, title, desc, links }: { icon: React.ReactNode; title: string; desc: string; links: string[] }) {
  return (
    <GlassCard className="space-y-6 group">
      <IconBox icon={icon} />
      <div className="space-y-2">
        <h3 className="text-xl font-bold tracking-tighter">{title}</h3>
        <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
      </div>
      <ul className="space-y-2">
        {links.map((link, i) => (
          <li key={i} className="text-sm text-celestial-saturn hover:underline cursor-pointer flex items-center gap-2">
            <Zap size={12} />
            {link}
          </li>
        ))}
      </ul>
    </GlassCard>
  );
}

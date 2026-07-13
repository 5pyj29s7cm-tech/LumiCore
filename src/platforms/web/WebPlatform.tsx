import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Rocket, Smartphone } from 'lucide-react';
import { Navbar } from '../../components/Navbar';
import { Footer } from '../../components/Footer';
import { LandingSections } from '../../components/LandingSections';
import { LocalAgentSphere } from '../../components/LocalAgentSphere';
import { UnifiedAgent } from '../../components/UnifiedAgent';
import { FoundersSanctuary } from '../../components/FoundersSanctuary';
import { GlobalNodeMap } from '../../components/GlobalNodeMap';
import { DesktopIntro } from '../desktop/DesktopIntro';
import { MobileIntro } from '../mobile/MobileIntro';

interface WebPlatformProps {
  user: any;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  lang: 'en' | 'zh';
  setLang: (lang: 'en' | 'zh') => void;
  t: any;
  onLogin: () => void;
  onLogout: () => void;
  renderTabContent: (tab: string) => React.ReactNode;
  isDesktop: boolean;
}

export function WebPlatform({ 
  user, 
  activeTab, 
  setActiveTab, 
  lang, 
  setLang, 
  t, 
  onLogin, 
  onLogout, 
  renderTabContent,
  isDesktop
}: WebPlatformProps) {
  const [introView, setIntroView] = useState<'none' | 'desktop' | 'mobile'>('none');

  if (introView !== 'none') {
    return (
      <div className="min-h-screen bg-black">
        <Navbar 
          user={user} 
          onLogin={onLogin} 
          onLogout={onLogout} 
          activeTab={activeTab} 
          setActiveTab={(tab) => {
             setIntroView('none');
             setActiveTab(tab);
          }} 
          lang={lang}
          setLang={setLang}
          t={t}
        />
        <div className="pt-24 min-h-screen">
          <AnimatePresence mode="wait">
            {introView === 'desktop' ? (
              <DesktopIntro 
                key="desktop-intro"
                t={t} 
                onBack={() => setIntroView('none')} 
                onInitialize={() => setIntroView('none')} 
              />
            ) : (
              <MobileIntro 
                key="mobile-intro"
                t={t} 
                onBack={() => setIntroView('none')} 
                onPreview={() => setIntroView('none')} 
              />
            )}
          </AnimatePresence>
        </div>
        <Footer t={t} />
      </div>
    );
  }

  return (
    <motion.div
      key="web-mode"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="relative"
    >
      <Navbar 
        user={user} 
        onLogin={onLogin} 
        onLogout={onLogout} 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        lang={lang}
        setLang={setLang}
        t={t}
      />
      
      <main className="container mx-auto px-4 pt-24 pb-20">
        {activeTab === 'home' ? (
          <div className="space-y-32">
            {user ? (
              <div className="pt-8">
                <UnifiedAgent 
                  t={t} 
                  user={user} 
                  onEnterSanctuary={() => setActiveTab('founders')} 
                />
              </div>
            ) : (
              <header className="flex flex-col items-center justify-center min-h-[85vh] text-center relative">
                <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
                   <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-celestial-saturn/5 blur-[120px] rounded-full" />
                </div>
                <div className="mb-16 z-10">
                  <LocalAgentSphere t={t} />
                </div>
                 <div className="z-10 space-y-8">
                    <div className="flex flex-col items-center gap-4 mb-4">
                       <div className="inline-flex items-center gap-3 px-5 py-2.5 bg-white/5 border border-white/10 rounded-full scale-110 backdrop-blur-md shadow-[0_0_30px_rgba(255,204,0,0.1)]">
                          <div className="flex -space-x-1">
                             {[1, 2, 3].map(i => (
                                <div key={i} className="w-2.5 h-2.5 rounded-full bg-celestial-saturn animate-pulse shadow-[0_0_12px_#ffcc00]" style={{ animationDelay: `${i * 0.3}s` }} />
                             ))}
                          </div>
                          <span className="text-xs font-black uppercase tracking-[0.2em] text-white/90">{t.activeNodesLabel || 'Active Nodes'}: {t.nodeCount || '42,901'}</span>
                          <div className="w-px h-3 bg-white/20 mx-1" />
                          <span className="text-xs font-black uppercase tracking-[0.2em] text-celestial-saturn">{user ? (user.role === 'admin' ? (t.foundingArchitect || 'Founding Architect') : (t.verifiedNode || 'Verified Node')) : (t.verified || 'Verified')}</span>
                       </div>
                       
                       <div className="flex gap-8">
                          <button onClick={() => setActiveTab('solutions')} className="text-xs font-bold text-white/40 hover:text-celestial-saturn uppercase tracking-[0.3em] transition-all border-b border-transparent hover:border-celestial-saturn/60 pb-1">
                             {t.coreVision || 'Core Vision'}
                          </button>
                          <button onClick={() => setActiveTab('founders')} className="text-xs font-bold text-white/40 hover:text-celestial-saturn uppercase tracking-[0.3em] transition-all border-b border-transparent hover:border-celestial-saturn/60 pb-1">
                             {t.foundersSanctuary || "Founder's Sanctuary"}
                          </button>
                       </div>
                    </div>
                   
                   <h1 className="text-6xl md:text-9xl font-black bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-white/30 drop-shadow-2xl mb-6">
                     {t.heroTitle}
                   </h1>
                   <p className="text-xl text-white/40 max-w-2xl mx-auto italic mb-12">
                     {t.heroSubtitle}
                   </p>
                    <div className="flex flex-col items-center gap-6">
                       {isDesktop ? (
                         <div className="flex flex-col items-center gap-8">
                           <button
                             onClick={() => setIntroView('desktop')}
                             className="group px-12 py-6 bg-white text-black font-black rounded-2xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3 shadow-[0_0_60px_rgba(255,255,255,0.3)]"
                           >
                             <Rocket size={24} className="text-celestial-saturn group-hover:rotate-12 transition-transform" />
                             <span className="text-lg">{t.initializeNeuralOS || 'INITIALIZE NEURAL OS'}</span>
                           </button>
                         </div>
                       ) : (
                         <>
                           <div className="flex flex-wrap justify-center gap-6">
                             <button
                               onClick={user ? () => setActiveTab('generate') : onLogin}
                               className="px-8 py-5 bg-white text-black font-black rounded-2xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2 shadow-[0_0_50px_rgba(255,255,255,0.2)]"
                             >
                               <Sparkles size={20} />
                               {user ? (t.enterSpace || 'Enter Lab') : t.getStarted}
                             </button>
                           </div>
                         </>
                       )}
                    </div>
                 </div>
              </header>
            )}
            <LandingSections 
              t={t} 
              onNavigateToSolutions={() => setActiveTab('solutions')} 
              onSelectDesktop={() => setIntroView('desktop')}
              onSelectMobile={() => setIntroView('mobile')}
            />
          </div>
        ) : (
          <div className="max-w-7xl mx-auto">
            {renderTabContent(activeTab)}
          </div>
        )}
      </main>
      <Footer t={t} />
    </motion.div>
  );
}

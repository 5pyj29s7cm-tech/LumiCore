import React from 'react';
import { motion } from 'motion/react';
import { Zap, Shield, Cpu, Globe, Users, Database, Building2, ArrowRight, Layers, Sparkles, Network, Smartphone } from 'lucide-react';
import { GlobalNodeMap } from './GlobalNodeMap';
import { GlassCard, IconBox, FeatureItem } from './SharedUI';
import { Button } from './ui/button';

export function LandingSections({ t, onNavigateToSolutions, onSelectDesktop, onSelectMobile }: { t: any; onNavigateToSolutions?: () => void; onSelectDesktop?: () => void; onSelectMobile?: () => void }) {
  return (
    <div className="space-y-32 py-20">
      {/* Existing sections... */}
      
      {/* Smart Host Program Section */}
      <section className="space-y-16">
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-celestial-saturn/20 border border-celestial-saturn/30 text-xs font-bold uppercase tracking-widest text-celestial-saturn">
            <Sparkles size={12} />
            {t.experimentalProtocol}
          </div>
          <h2 className="text-5xl font-bold tracking-tighter glow-text">{t.smartHostProgram}</h2>
          <p className="text-white/40 max-w-2xl mx-auto font-mono text-sm italic">
            "{t.everythingCanBeLumi}"
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div className="relative aspect-square glass rounded-[3rem] p-12 flex items-center justify-center overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-tr from-celestial-saturn/10 via-transparent to-celestial-mars/10" />
            
            <div className="relative z-10 w-full h-full border border-white/10 rounded-2xl flex items-center justify-center">
              {/* Central Core */}
              <motion.div
                animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                className="w-24 h-24 bg-celestial-saturn rounded-full blur-2xl opacity-20 absolute"
              />
              <Cpu size={80} className="text-celestial-saturn relative z-20" />
              
              {/* Surrounding Hosts */}
              {[...Array(6)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{ 
                    rotate: 360,
                    scale: [1, 1.2, 1]
                  }}
                  transition={{ 
                    rotate: { duration: 20, repeat: Infinity, ease: "linear" },
                    scale: { duration: 4, repeat: Infinity, ease: "easeInOut", delay: i * 0.5 }
                  }}
                  className="absolute"
                  style={{ transform: `rotate(${i * 60}deg) translateX(140px)` }}
                >
                  <div className="p-4 glass rounded-xl border border-white/20">
                    <Layers size={24} className="text-white/40" />
                  </div>
                </motion.div>
              ))}
              
              {/* Connecting Lines */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20">
                <circle cx="50%" cy="50%" r="140" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" className="text-white/45" />
              </svg>
            </div>
          </div>

          <div className="space-y-8">
            <div className="space-y-4">
              <h3 className="text-3xl font-bold tracking-tight">{t.universalNeuralCore}</h3>
              <p className="text-lg text-white/60 leading-relaxed italic">
                {t.smartHostDesc}
              </p>
            </div>

            <div className="grid gap-6">
              <FeatureItem 
                icon={<Layers className="text-celestial-mars" size={20} />}
                title={t.symbioticIntelligence}
                desc={t.symbioticIntelDesc || "Architecture designed to inhabit any physical shell, from industrial machinery to consumer companions."}
              />
              <FeatureItem 
                icon={<Database className="text-celestial-saturn" size={20} />}
                title={t.rapidDataGenesis || "Rapid Data Genesis"}
                desc={t.rapidDataGenesisDesc || "Accelerating AI evolution through high-fidelity emotional and physical interaction data collected across millions of hosts."}
              />
              <FeatureItem 
                icon={<Network className="text-celestial-glow" size={20} />}
                title={t.hostMesh || "The Host Mesh"}
                desc={t.hostMeshDesc || "Turning the world into a distributed sensor array where intelligence empowers local environments."}
              />
            </div>

            <Button className="px-10 py-8 bg-white/5 border border-white/10 text-white font-bold rounded-2xl hover:bg-celestial-saturn hover:text-black transition-all flex items-center gap-3">
              {t.becomeHostPartner}
              <ArrowRight size={18} />
            </Button>
          </div>
        </div>
      </section>

      {/* How it Works - Holographic Carrier Concept */}
      <section className="relative py-24 rounded-[4rem] overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-r from-celestial-saturn/10 via-transparent to-celestial-mars/10 opacity-50" />
        <div className="absolute top-0 left-0 w-full h-full border border-white/5 rounded-[4rem]" />
        
        <div className="relative z-10 grid lg:grid-cols-2 gap-16 items-center px-12">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-bold uppercase tracking-widest text-white/40">
              <Building2 size={12} />
              {t.orgIndustry}
            </div>
            <h2 className="text-5xl font-bold tracking-tighter leading-tight">
              {t.scalingIntelligence}
            </h2>
            <p className="text-lg text-white/60 leading-relaxed">
              {t.organizationSovereignDesc}
            </p>
            <Button 
              onClick={onNavigateToSolutions}
              className="bg-celestial-saturn text-black rounded-full px-8 py-6 font-bold hover:scale-105 transition-transform flex items-center gap-2"
            >
              {t.exploreSolutions}
              <ArrowRight size={18} />
            </Button>
          </div>
          
          <div className="relative aspect-video glass rounded-3xl overflow-hidden flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" />
            <motion.div
              animate={{ 
                scale: [1, 1.05, 1],
                rotate: [0, 2, 0]
              }}
              transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
              className="relative z-10"
            >
              <Building2 size={120} className="text-celestial-saturn/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Cpu size={48} className="text-celestial-saturn animate-pulse" />
              </div>
            </motion.div>
            
            {/* Data Flow Lines */}
            <div className="absolute inset-0 pointer-events-none">
              {[...Array(5)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{ 
                    x: ['-100%', '200%'],
                    opacity: [0, 1, 0]
                  }}
                  transition={{ 
                    duration: 3, 
                    repeat: Infinity, 
                    delay: i * 0.8,
                    ease: "linear"
                  }}
                  className="absolute h-px w-32 bg-gradient-to-r from-transparent via-celestial-saturn/30 to-transparent"
                  style={{ top: `${20 * (i + 1)}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How it Works - Holographic Carrier Concept */}
      <section className="space-y-16">
        <div className="text-center space-y-4">
          <h2 className="text-4xl font-bold tracking-tighter glow-text">{t.holographicCarrier}</h2>
          <p className="text-white/40 max-w-2xl mx-auto font-mono text-sm">
            {t.holographicCarrierDesc}
          </p>
          <div className="w-24 h-1 bg-celestial-saturn mx-auto rounded-full" />
        </div>
        
        <div className="grid md:grid-cols-3 gap-8">
          <StepCard 
            number="01" 
            title={t.holographicEntrance} 
            desc={t.holographicEntranceDesc} 
            icon={<Database className="text-celestial-mars" />} 
          />
          <StepCard 
            number="02" 
            title={t.lifeLab} 
            desc={t.lifeLabDesc} 
            icon={<Cpu className="text-celestial-saturn" />} 
          />
          <StepCard 
            number="03" 
            title={t.digitalUniverse} 
            desc={t.digitalUniverseDesc} 
            icon={<Globe className="text-celestial-glow" />} 
          />
        </div>
      </section>

      {/* Features */}
      <section className="grid lg:grid-cols-2 gap-16 items-center">
        <div className="space-y-8">
          <h2 className="text-5xl font-bold tracking-tighter leading-tight">
            {t.featuresTitle}
          </h2>
          <div className="space-y-6">
            <FeatureItem 
              icon={<Shield size={24} />} 
              title={t.feature1} 
              desc={t.feature1Desc} 
            />
            <FeatureItem 
              icon={<Cpu size={24} />} 
              title={t.feature2} 
              desc={t.feature2Desc} 
            />
            <FeatureItem 
              icon={<Zap size={24} />} 
              title={t.feature3} 
              desc={t.feature3Desc} 
            />
          </div>
        </div>
        <div className="relative aspect-square glass rounded-[3rem] flex items-center justify-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-celestial-mars/20 to-celestial-saturn/20 animate-pulse" />
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
            className="w-64 h-64 border-2 border-dashed border-white/10 rounded-full flex items-center justify-center"
          >
            <div className="w-48 h-48 border border-white/20 rounded-full flex items-center justify-center">
               <Cpu size={64} className="text-celestial-saturn opacity-50" />
            </div>
          </motion.div>
        </div>
      </section>

      {/* Global Node Map Section */}
      <section className="space-y-12">
        <div className="flex justify-between items-end">
           <div className="space-y-2">
             <h2 className="text-3xl font-black italic tracking-tighter uppercase">{t.globalNeuralMesh}</h2>
             <p className="text-white/55 text-sm italic">{t.neuralMeshDesc}</p>
           </div>
           <div className="text-right hidden sm:block">
              <span className="px-4 py-2 bg-white/5 border border-white/10 rounded-full text-xs font-black text-white/40 uppercase tracking-widest">
                {t.nodesSynced}: {t.nodeCount || '42,901'}
              </span>
           </div>
        </div>
        <GlobalNodeMap />
      </section>

      {/* Multi-platform Ecosystem Section */}
      <section className="space-y-24 relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        
        <div className="text-center space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded-full text-xs font-black text-white/40 uppercase tracking-widest">
            {t.crossInterfaceContinuity || 'Cross-Interface Continuity'}
          </div>
          <h2 className="text-6xl font-black tracking-tighter italic uppercase text-glow">
            {t.anyInterfaceTitle}
          </h2>
          <p className="text-white/40 max-w-2xl mx-auto italic">
            {t.interfaceAdaptDesc}
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-12">
          {/* Desktop Node Card */}
          <motion.div 
            whileHover={{ y: -10 }}
            className="p-1 glass-dark rounded-[3.5rem] border border-white/5 relative group overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-celestial-saturn/20 via-transparent to-transparent opacity-50 transition-opacity group-hover:opacity-100" />
            <div className="p-12 space-y-8 relative z-10">
              <div className="flex justify-between items-start">
                <div className="w-20 h-20 rounded-[2rem] bg-black/60 border border-white/10 flex items-center justify-center text-celestial-saturn shadow-2xl">
                  <Network size={36} />
                </div>
                <div className="px-3 py-1 bg-celestial-saturn/10 border border-celestial-saturn/20 rounded-full text-xs font-black text-celestial-saturn uppercase tracking-widest">
                  Kernel v2.4.1
                </div>
              </div>
              <div className="space-y-4">
                <h3 className="text-4xl font-black tracking-tight italic uppercase">{t.desktopNode}</h3>
                <p className="text-lg text-white/40 leading-relaxed italic">
                  {t.desktopDesc}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                 <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-center">
                    <div className="text-sm font-black text-white/80">824 TOPs</div>
                    <div className="text-xs text-white/45 uppercase font-black">{t.peakLocalPower || 'Peak Local Power'}</div>
                 </div>
                 <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-center">
                    <div className="text-sm font-black text-white/80">0 ms</div>
                    <div className="text-xs text-white/45 uppercase font-black">{t.cloudLatency || 'Cloud Latency'}</div>
                 </div>
              </div>
              <Button 
                onClick={onSelectDesktop}
                className="w-full py-8 bg-celestial-saturn text-black font-black rounded-2xl hover:scale-[1.02] active:scale-95 transition-all shadow-lg"
              >
                {t.initializeDesktopHub}
              </Button>
            </div>
          </motion.div>

          {/* Mobile Node Card */}
          <motion.div 
            whileHover={{ y: -10 }}
            className="p-1 glass-dark rounded-[3.5rem] border border-white/5 relative group overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-celestial-nebula/20 via-transparent to-transparent opacity-50 transition-opacity group-hover:opacity-100" />
            <div className="p-12 space-y-8 relative z-10">
              <div className="flex justify-between items-start">
                <div className="w-20 h-20 rounded-[2rem] bg-black/60 border border-white/10 flex items-center justify-center text-celestial-nebula shadow-2xl">
                  <Smartphone size={36} />
                </div>
                <div className="px-3 py-1 bg-celestial-nebula/10 border border-celestial-nebula/20 rounded-full text-xs font-black text-celestial-nebula uppercase tracking-widest">
                  Gateway v1.02
                </div>
              </div>
              <div className="space-y-4">
                <h3 className="text-4xl font-black tracking-tight italic uppercase">{t.mobilePerception}</h3>
                <p className="text-lg text-white/40 leading-relaxed italic">
                   {t.mobileDesc}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                 <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-center">
                    <div className="text-sm font-black text-white/80">{t.sensorySync || 'Sensory Sync'}</div>
                    <div className="text-xs text-white/45 uppercase font-black">{t.meshActiveLabel || 'Mesh Active'}</div>
                 </div>
                 <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-center">
                    <div className="text-sm font-black text-white/80">{t.biometric || 'Biometric'}</div>
                    <div className="text-xs text-white/45 uppercase font-black">{t.neuralIDEncrypted || 'Neural ID Encrypted'}</div>
                 </div>
              </div>
              <Button 
                onClick={onSelectMobile}
                className="w-full py-8 bg-celestial-nebula text-white font-black rounded-2xl hover:scale-[1.02] active:scale-95 transition-all shadow-lg"
              >
                {t.deployMobileGateway}
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Download CTA */}
      <section className="text-center space-y-8 py-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="glass-dark rounded-[3rem] p-12 border border-white/10 space-y-6"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-celestial-saturn/20 border border-celestial-saturn/30 rounded-full text-xs font-bold uppercase tracking-widest text-celestial-saturn">
            <Smartphone size={12} />
            {t.desktopAppAvailable || 'Desktop App Available'}
          </div>
          <h2 className="text-4xl font-black tracking-tighter">{t.downloadTitle || 'Ready to go native?'}</h2>
          <p className="text-white/40 max-w-xl mx-auto">
            {t.downloadDesc || 'Download the Lumi OS desktop app for full system access — open apps, manage files, search the web, and control your desktop with AI. Available for Windows, with macOS and Linux coming soon.'}
          </p>
          <div className="flex gap-4 justify-center flex-wrap">
            <a
              href="https://releases.lumiai.asia/lumi-os/latest/download"
              className="px-8 py-4 bg-celestial-saturn text-black font-black rounded-2xl hover:scale-105 active:scale-95 transition-all inline-flex items-center gap-2 shadow-xl"
            >
              <Smartphone size={18} />
              {t.downloadForWindows || 'Download for Windows'}
            </a>
            <button
              onClick={onSelectDesktop}
              className="px-8 py-4 bg-white/5 border border-white/10 text-white font-black rounded-2xl hover:bg-white/10 transition-all inline-flex items-center gap-2"
            >
              <Globe size={18} />
              {t.launchWebApp || 'Launch Web App'}
            </button>
          </div>
          <p className="text-xs text-white/45 font-mono">{t.versionInfo || 'v3.0.2 · Windows 10+ · 120MB · Private Preview'}</p>
        </motion.div>
      </section>

      {/* Stats */}
      <GlassCard className="p-12 rounded-[3rem]" hoverEffect={false}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-12 text-center">
          <StatItem label={t.activeLumis} value="12.4k" />
          <StatItem label={t.dataSynced} value="850TB" />
          <StatItem label={t.spiritsBorn} value="3.2k" />
        </div>
      </GlassCard>
    </div>
  );
}

function StepCard({ number, title, desc, icon }: { number: string; title: string; desc: string; icon: React.ReactNode }) {
  return (
    <GlassCard className="p-8 rounded-3xl space-y-6 group" hoverEffect={true}>
      <div className="flex justify-between items-start">
        <IconBox icon={icon} className="group-hover:scale-110 transition-transform" />
        <span className="text-4xl font-black text-white/25 tracking-tighter">{number}</span>
      </div>
      <div className="space-y-2">
        <h3 className="text-xl font-bold">{title}</h3>
        <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
      </div>
    </GlassCard>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-4xl font-bold tracking-tighter text-celestial-saturn">{value}</div>
      <div className="text-xs uppercase tracking-widest text-white/40">{label}</div>
    </div>
  );
}

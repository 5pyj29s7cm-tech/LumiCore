import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
import { 
  Smartphone, 
  Orbit, 
  MessageSquare, 
  Globe, 
  Settings, 
  User, 
  ShieldCheck, 
  Activity, 
  Zap,
  Battery,
  Wifi,
  Signal,
  LayoutGrid,
  ChevronDown,
  Volume2,
  VolumeX,
  Moon,
  Sun,
  Bluetooth,
  Maximize2,
  LogOut,
  Cpu,
  Radio,
  Mic,
  Shield
} from 'lucide-react';
import { sounds } from '../../services/soundService';

import { useSocket } from '../../hooks/useSocket';
import { useVoiceCall } from '../../hooks/useVoiceCall';
import { useApp } from '../../contexts/AppContext';

interface MobilePlatformProps {
  t: any;
  user: any;
  lang: 'en' | 'zh';
  setLang: (lang: 'en' | 'zh') => void;
  onLogin: () => void;
  onExit?: () => void;
  renderTabContent: (tab: string) => React.ReactNode;
}

export function MobilePlatform({ t, user, lang, setLang, onLogin, onExit, renderTabContent }: MobilePlatformProps) {
  const [activeScreen, setActiveScreen] = useState<'home' | 'core' | 'factory' | 'agents' | 'profile'>('home');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isControlCenterOpen, setIsControlCenterOpen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);

  const socket = useSocket();
  const { callState, startCall, endCall } = useVoiceCall({
    socket,
    onResponse: (text) => {
      // Logic to show response in mobile UI if needed
    }
  });

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const triggerHaptic = (pattern: number | number[] = 10) => {
    if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  };

  const handleNavClick = (screen: any) => {
    if (activeScreen === screen) return;
    triggerHaptic(5);
    if (!isMuted) sounds.playClick();
    setActiveScreen(screen);
  };

  const toggleControlCenter = () => {
    triggerHaptic(15);
    if (!isMuted) sounds.playClick();
    setIsControlCenterOpen(!isControlCenterOpen);
  };

  const navItems = [
    { id: 'home', icon: LayoutGrid, label: t.navHome || 'Home' },
    { id: 'factory', icon: Cpu, label: t.navFactory || 'Factory' },
    { id: 'core', icon: Orbit, label: t.navCore || 'Core' },
    { id: 'agents', icon: MessageSquare, label: t.navAgents || 'Agents' },
    { id: 'profile', icon: User, label: t.navProfile || 'Profile' },
  ];

  const renderScreen = () => {
    switch (activeScreen) {
      case 'home':
        return (
          <motion.div 
            key="home"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6 pt-4"
          >
            <div className="flex justify-between items-end">
              <div className="space-y-1">
                <h2 className="text-3xl font-black italic tracking-tighter uppercase">{t.deviceStatus || <>Device <span className="text-celestial-saturn text-glow-sm">Status</span></>}</h2>
                <p className="text-xs text-white/40 font-mono uppercase tracking-widest">{t.activeNodeMonitoring || 'Active Node Monitoring'}</p>
              </div>
            </div>

            {/* Device Monitoring Grid */}
            <div className="grid gap-4">
              <div className="glass-dark p-6 rounded-[2.5rem] border border-white/5 space-y-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center text-celestial-saturn">
                      <Smartphone size={20} />
                    </div>
                    <div>
                      <div className="text-xs font-black uppercase">{t.localHost || 'Local Host'}</div>
                      <div className="text-xs text-white/40 uppercase font-mono">NODE_IP: 192.168.1.44</div>
                    </div>
                  </div>
                  <div className="px-3 py-1 bg-celestial-saturn/10 border border-celestial-saturn/20 rounded-full text-xs font-black text-celestial-saturn uppercase">{t.linked || 'Linked'}</div>
                </div>
                <div className="space-y-1.5">
                   <div className="flex justify-between text-xs font-bold text-white/20 uppercase tracking-widest">
                     <span>{t.shardingSync || 'Sharding Sync'}</span>
                     <span>98.2%</span>
                   </div>
                   <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: '98.2%' }} className="h-full bg-celestial-saturn" />
                   </div>
                </div>
              </div>

              <div className="glass-dark p-6 rounded-[2.5rem] border border-white/5 space-y-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center text-purple-400">
                      <Radio size={20} />
                    </div>
                    <div>
                      <div className="text-xs font-black uppercase">{t.meshBridge || 'Mesh Bridge'}</div>
                      <div className="text-xs text-white/40 uppercase font-mono">LATENCY: 12ms</div>
                    </div>
                  </div>
                  <div className="px-3 py-1 bg-purple-500/10 border border-purple-500/20 rounded-full text-xs font-black text-purple-500 uppercase">{t.activeStatus || 'Active'}</div>
                </div>
                <div className="space-y-1.5">
                   <div className="flex justify-between text-xs font-bold text-white/20 uppercase tracking-widest">
                     <span>{t.globalTraffic || 'Global Traffic'}</span>
                     <span>4.2 PB/S</span>
                   </div>
                   <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: '42%' }} className="h-full bg-purple-500" />
                   </div>
                </div>
              </div>
            </div>

            {/* Hardware Quick Permissions */}
            <div className="grid grid-cols-2 gap-4">
              <div className="glass-dark p-5 rounded-[2rem] border border-white/5 flex items-center gap-3">
                 <div className="w-8 h-8 rounded-xl bg-celestial-saturn/20 flex items-center justify-center text-celestial-saturn">
                   <ShieldCheck size={14} />
                 </div>
                 <div className="text-xs font-black uppercase tracking-tight">{t.biometricsTile || 'Biometrics'}</div>
              </div>
              <div className="glass-dark p-5 rounded-[2rem] border border-white/5 flex items-center gap-3">
                 <div className="w-8 h-8 rounded-xl bg-orange-500/20 flex items-center justify-center text-orange-400">
                   <Activity size={14} />
                 </div>
                 <div className="text-xs font-black uppercase tracking-tight">{t.telemetryTile || 'Telemetry'}</div>
              </div>
            </div>
          </motion.div>
        );
      case 'core':
        return (
          <motion.div 
            key="core"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="h-full flex flex-col items-center justify-center space-y-12 pb-24"
          >
            <div className="text-center space-y-2">
               <h2 className="text-4xl font-black italic tracking-tighter uppercase text-white">{t.centralPersona || <>Central <span className="text-celestial-saturn text-glow">Persona</span></>}</h2>
               <p className="text-xs text-white/30 uppercase tracking-[0.4em] font-mono leading-none">{t.localShardIntegrityVerified || 'Local Shard Integrity Verified'}</p>
            </div>

            <motion.div 
              whileTap={{ scale: 0.9 }}
              onClick={() => {
                triggerHaptic(20);
                if (!isMuted) sounds.playPulse();
              }}
              className="relative"
            >
               <div className="absolute inset-0 bg-celestial-saturn/20 blur-[60px] rounded-full animate-pulse" />
               <div className="w-64 h-64 glass-dark rounded-full border-4 border-white/5 flex items-center justify-center relative overflow-hidden group active:border-celestial-saturn/40 transition-colors">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,200,80,0.1)_0%,transparent_75%)]" />
                  <div className="text-center z-10 pointer-events-none">
                     <Orbit size={100} className="text-celestial-saturn opacity-20 animate-spin-slow mb-4" />
                     <div className="text-xs font-black text-white/40 uppercase tracking-widest">Shard_K_001</div>
                  </div>
               </div>
            </motion.div>

            <div className="w-full space-y-4">
                <button 
                  onClick={() => {
                    triggerHaptic(10);
                    if (callState === 'idle') startCall(undefined, 'lumi', 'lumi');
                    else endCall();
                  }}
                  className={`w-full p-6 glass-dark rounded-[2.5rem] border transition-all flex items-center justify-between group active:bg-white/5 ${
                    callState !== 'idle' ? 'border-celestial-saturn/50 bg-celestial-saturn/5' : 'border-white/5'
                  }`}
                >
                  <div className="flex items-center gap-4">
                     <div className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-colors ${
                       callState !== 'idle' ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40'
                     }`}>
                       <Mic size={20} className={callState !== 'idle' ? 'animate-pulse' : ''} />
                     </div>
                     <span className={`text-xs font-black uppercase tracking-widest ${callState !== 'idle' ? 'text-celestial-saturn' : ''}`}>
                       {callState === 'idle' ? (t.initializeSync || 'Initialize Sync') : (t.sessionActive || 'Session Active')}
                     </span>
                  </div>
                  <ChevronDown className={`text-white/20 -rotate-90 transition-transform ${callState !== 'idle' ? 'rotate-0' : ''}`} size={16} />
               </button>
            </div>
          </motion.div>
        );
      case 'factory':
        return (
          <motion.div 
            key="factory"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="h-full pt-4"
          >
            {renderTabContent('generate')}
          </motion.div>
        );
      case 'agents':
        return (
          <motion.div 
            key="agents"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="h-full pt-4 space-y-8"
          >
            <div className="flex justify-between items-end px-2">
              <h2 className="text-3xl font-black italic tracking-tighter uppercase whitespace-pre-line leading-none">{t.neuralEntities || <>Neural <br/> <span className="text-purple-500">Entities</span></>}</h2>
              <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center text-white/40">
                 <Shield size={18} />
              </div>
            </div>
            {renderTabContent('ecosystem')}
          </motion.div>
        );
      case 'profile':
        return (
          <motion.div 
            key="profile"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="h-full pt-4 space-y-6"
          >
            {renderTabContent('profile')}

            <div className="px-2 space-y-4 pt-4">
              <div className="glass-dark p-6 rounded-[2.5rem] border border-white/5 space-y-4">
                <div className="flex items-center gap-3">
                  <Globe size={18} className="text-celestial-saturn" />
                  <span className="text-xs font-black uppercase tracking-widest">{t.language}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button 
                    onClick={() => setLang('en')}
                    className={`p-4 rounded-2xl border text-xs font-black uppercase tracking-widest transition-all ${lang === 'en' ? 'bg-celestial-saturn text-black border-celestial-saturn shadow-lg' : 'bg-white/5 border-white/5 text-white/40'}`}
                  >
                    {t.english || 'English'}
                  </button>
                  <button
                    onClick={() => setLang('zh')}
                    className={`p-4 rounded-2xl border text-xs font-black uppercase tracking-widest transition-all ${lang === 'zh' ? 'bg-celestial-saturn text-black border-celestial-saturn shadow-lg' : 'bg-white/5 border-white/5 text-white/40'}`}
                  >
                    {t.chinese || 'Chinese'}
                  </button>
                </div>
              </div>
            </div>
            
            {onExit && (
              <div className="px-2 pt-8">
                <button 
                  onClick={() => {
                    triggerHaptic(5);
                    if (!isMuted) sounds.playClick();
                    onExit();
                  }}
                  className="w-full p-6 glass-dark rounded-[2.5rem] border border-white/5 flex items-center justify-center gap-3 text-white/40 hover:text-white transition-colors"
                >
                  <LogOut size={20} />
                  <span className="text-xs font-black uppercase tracking-widest text-glow-sm">{t.exitMobileInterface || 'Exit Mobile Interface'}</span>
                </button>
              </div>
            )}
          </motion.div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-[#000] text-white flex flex-col font-sans overflow-hidden">
      {/* OS Background Layer */}
      <div className="absolute inset-0 z-0 bg-[#020205]">
        <div className="absolute top-[-15%] left-[-10%] w-[80%] h-[50%] bg-celestial-saturn/5 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[40%] bg-purple-900/10 blur-[100px] rounded-full" />
        <div className="absolute inset-0 bg-transparent opacity-[0.15] brightness-50" />
      </div>

      {/* Main Viewport Container */}
      <div className="flex-1 overflow-y-auto px-6 pb-36 pt-4 z-10 custom-scrollbar relative">
        <AnimatePresence mode="wait">
          {renderScreen()}
        </AnimatePresence>
      </div>

      {/* Floating Dynamic Dock */}
      <div className="fixed bottom-8 left-0 right-0 z-50 px-6 pointer-events-none">
        <div className="max-w-md mx-auto pointer-events-auto">
          <div className="relative bg-black/40 backdrop-blur-3xl border border-white/10 rounded-[2.5rem] p-1.5 flex items-center justify-between shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            {/* Sliding Active Indicator */}
            <motion.div 
              className="absolute bg-white rounded-[2rem] z-0 shadow-[0_10px_20px_rgba(255,255,255,0.2)]"
              initial={false}
              animate={{ 
                x: `${navItems.findIndex(i => i.id === activeScreen) * 100}%`,
              }}
              transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              style={{
                width: `calc((100% - 12px) / ${navItems.length})`,
                height: 'calc(100% - 12px)',
                top: '6px',
                left: '6px',
              }}
            />

            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeScreen === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item.id)}
                  className={`relative z-10 flex-1 flex flex-col items-center justify-center h-14 transition-all duration-500`}
                >
                  <Icon 
                    size={20} 
                    strokeWidth={isActive ? 3 : 2} 
                    className={`transition-colors duration-300 ${isActive ? 'text-black' : 'text-white/40 group-hover:text-white/60'}`}
                  />
                  {isActive && (
                    <motion.span 
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-xs font-black uppercase text-black mt-0.5"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* CRT Post-processing Overlay */}
      <div className="fixed inset-0 pointer-events-none z-[1000] opacity-[0.04] bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] overflow-hidden" />
    </div>
  );
}

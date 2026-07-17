import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, ShoppingCart, Shield, Zap, Cpu, MessageSquare, Radio, Power, Settings, Info, Monitor, Lamp as LampIcon, Database, Glasses, Circle, Car, Home, Gem, Watch, Headphones, Rabbit, Smile, Gamepad2 } from 'lucide-react';
import { Button } from './ui/button';
import { GlassCard, IconBox, FeatureItem } from './SharedUI';
import { socketService } from '@/services/socketService';
import { useApp } from '@/contexts/AppContext';
import {
  shouldDisplayAgentResponse,
  type AgentResponseDelivery,
} from '@/lib/agentResponseDelivery';

const iconMap: { [key: string]: React.ReactNode } = {
  Hologram: <Monitor size={100} />,
  Lamp: <LampIcon size={100} />,
  Base: <Database size={100} />,
  Glasses: <Glasses size={100} />,
  Ring: <Circle size={100} />,
  Car: <Car size={100} />,
  Home: <Home size={100} />,
  Cpu: <Cpu size={100} />,
  Watch: <Watch size={100} />,
  Headphones: <Headphones size={100} />,
  Gem: <Gem size={100} />,
  Rabbit: <Rabbit size={100} />,
  Smile: <Smile size={100} />,
  Gamepad: <Gamepad2 size={100} />
};

interface ProductDetailPageProps {
  t: any;
  product: any;
  onBack: () => void;
}

export function ProductDetailPage({ t, product, onBack }: ProductDetailPageProps) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const socket = React.useRef<any>(null);

  useEffect(() => {
    socket.current = socketService.connect();

    const onResponse = (data: AgentResponseDelivery) => {
      if (shouldDisplayAgentResponse(data)) {
        setMessages(prev => [...prev, { role: 'agent', text: data.text! }]);
      }
      setIsTyping(false);
    };

    socket.current.on("agent:response", onResponse);

    return () => {
      socket.current?.off("agent:response", onResponse);
    };
  }, []);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim()) return;

    const userMsg = { role: 'user', text: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    socket.current.emit("agent:chat", {
      text: input,
      history: messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text
      })),
      personalityId: 'lumi'
    });
  };

  return (
    <div className="max-w-7xl mx-auto space-y-12 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Button 
          variant="ghost" 
          onClick={onBack}
          className="flex items-center gap-2 text-white/60 hover:text-white"
        >
          <ArrowLeft size={20} />
          {t.back}
        </Button>
        <div className="flex items-center gap-4">
          <div className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest border ${isActive ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-white/5 border-white/10 text-white/40'}`}>
            {isActive ? (t.deviceOnline || 'Device Online') : (t.standbyMode || 'Standby Mode')}
          </div>
          <Button 
            onClick={() => setIsActive(!isActive)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isActive ? 'bg-celestial-saturn text-black shadow-[0_0_20px_rgba(255,204,0,0.3)]' : 'bg-white/5 text-white/40'}`}
          >
            <Power size={18} />
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-12">
        {/* Left: Product Visuals & Specs */}
        <div className="space-y-8">
          <div className="relative aspect-square glass rounded-[3rem] flex items-center justify-center overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-celestial-saturn/5 to-transparent opacity-50" />
            
            {/* Animated Background Rings */}
            <AnimatePresence>
              {isActive && (
                <>
                  <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1.2, opacity: 0.1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="absolute w-64 h-64 rounded-full border border-celestial-saturn"
                  />
                  <motion.div 
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1.5, opacity: 0.05 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    transition={{ duration: 3, repeat: Infinity, delay: 0.5 }}
                    className="absolute w-80 h-80 rounded-full border border-celestial-mars"
                  />
                </>
              )}
            </AnimatePresence>

            <motion.div 
              animate={isActive ? { 
                y: [0, -20, 0],
                rotateY: [0, 10, 0]
              } : {}}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              className="relative z-10"
            >
              {/* This would be the product icon/image */}
              <div className="w-48 h-48 rounded-full bg-gradient-to-br from-white/10 to-black/40 border border-white/10 flex items-center justify-center shadow-2xl">
                <div className={isActive ? "text-celestial-saturn" : "text-white/45"}>
                  {React.isValidElement(iconMap[product.icon]) 
                    ? React.cloneElement(iconMap[product.icon] as React.ReactElement<any>, {
                        className: isActive ? "animate-pulse" : ""
                      })
                    : <Cpu size={100} className={isActive ? "animate-pulse" : ""} />
                  }
                </div>
              </div>
            </motion.div>

            <div className="absolute bottom-8 left-8 right-8 flex justify-between items-end">
              <div className="space-y-1">
                <div className="px-2 py-0.5 rounded bg-celestial-saturn/20 border border-celestial-saturn/30 inline-block">
                  <span className="text-xs font-bold uppercase tracking-widest text-celestial-saturn">{product.category}</span>
                </div>
                <h1 className="text-4xl font-bold tracking-tighter">{product.name}</h1>
                <p className="text-celestial-saturn font-mono text-lg">{product.price}</p>
              </div>
              <Button className="bg-celestial-saturn text-black rounded-2xl px-6 py-6 font-bold hover:scale-105 transition-transform flex items-center gap-2">
                <ShoppingCart size={18} />
                {t.buyNow}
              </Button>
            </div>
          </div>

          <GlassCard className="p-8 rounded-[2.5rem] space-y-4" hoverEffect={false}>
            <h3 className="text-lg font-bold tracking-tight flex items-center gap-2">
              <Info size={20} className="text-celestial-saturn" />
              {t.productOverview || 'Product Overview'}
            </h3>
            <p className="text-white/80 leading-relaxed text-lg">
              {product.description}
            </p>
          </GlassCard>

          <div className="grid grid-cols-2 gap-6">
            <GlassCard className="p-6 rounded-3xl space-y-4" hoverEffect={false}>
              <div className="flex items-center gap-2 text-celestial-saturn">
                <Shield size={18} />
                <span className="text-xs font-bold uppercase tracking-widest">{t.security || 'Security'}</span>
              </div>
              <p className="text-sm text-white/60">{t.securityDesc || 'End-to-end encrypted local processing. Your data never leaves the device.'}</p>
            </GlassCard>
            <GlassCard className="p-6 rounded-3xl space-y-4" hoverEffect={false}>
              <div className="flex items-center gap-2 text-celestial-mars">
                <Zap size={18} />
                <span className="text-xs font-bold uppercase tracking-widest">{t.performance || 'Performance'}</span>
              </div>
              <p className="text-sm text-white/60">{t.performanceDesc || 'Ultra-low latency neural engine optimized for real-time interaction.'}</p>
            </GlassCard>
          </div>
        </div>

        {/* Right: Interaction & Details */}
        <div className="space-y-8">
          <GlassCard className="h-[600px] rounded-[3rem] flex flex-col overflow-hidden" hoverEffect={false}>
            <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-celestial-saturn animate-pulse' : 'bg-white/20'}`} />
                <span className="text-xs font-bold uppercase tracking-widest text-white/60">{t.digitalTwinInteraction || 'Digital Twin Interaction'}</span>
              </div>
              <div className="flex gap-2">
                <button className="p-2 rounded-lg bg-white/5 text-white/40 hover:text-white transition-colors">
                  <Settings size={16} />
                </button>
                <button className="p-2 rounded-lg bg-white/5 text-white/40 hover:text-white transition-colors">
                  <Info size={16} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide">
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-20">
                  <Radio size={48} />
                  <p className="text-sm">{t.deviceInterfaceReady || 'Device interface ready.'}<br/>{t.askAboutFeatures || 'Ask about features, setup, or technical specs.'}</p>
                </div>
              )}
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${msg.role === 'agent' ? 'justify-start' : 'justify-end'}`}
                >
                  <div className={`max-w-[80%] p-4 rounded-2xl text-sm ${
                    msg.role === 'agent' 
                      ? 'bg-celestial-saturn/10 text-celestial-saturn border border-celestial-saturn/20 rounded-tl-none' 
                      : 'bg-white/5 text-white/80 border border-white/10 rounded-tr-none'
                  }`}>
                    {msg.text}
                  </div>
                </motion.div>
              ))}
              {isTyping && (
                <div className="flex gap-1 items-center text-celestial-saturn/40 text-xs">
                  <div className="w-1 h-1 bg-current rounded-full animate-bounce" />
                  <div className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:0.2s]" />
                  <div className="w-1 h-1 bg-current rounded-full animate-bounce [animation-delay:0.4s]" />
                </div>
              )}
            </div>

            <div className="p-6 bg-white/5 border-t border-white/5">
              <form onSubmit={handleSend} className="relative flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={isActive ? (t.typeToInteract || "Type to interact...") : (t.activateDevice || "Activate device to start interaction")}
                  disabled={!isActive}
                  className="flex-1 bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-celestial-saturn/50 disabled:opacity-50"
                />
                <Button 
                  type="submit" 
                  disabled={!isActive || !input.trim() || isTyping}
                  className="bg-celestial-saturn text-black rounded-xl px-4"
                >
                  <MessageSquare size={18} />
                </Button>
              </form>
            </div>
          </GlassCard>

          <div className="space-y-4">
            <h3 className="text-lg font-bold tracking-tight px-2">{t.technicalSpecifications || 'Technical Specifications'}</h3>
            <div className="grid grid-cols-2 gap-4">
              {product.specs?.map((spec: string, i: number) => (
                <div key={i} className="p-4 bg-white/5 border border-white/10 rounded-2xl flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-celestial-saturn" />
                  <span className="text-xs text-white/60">{spec}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

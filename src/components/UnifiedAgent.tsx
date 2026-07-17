import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, MessageSquare, Cpu, Globe, Zap, Loader2, User as UserIcon, Settings, Eye, Camera, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { LocalAgentSphere } from './LocalAgentSphere';
import { socketService } from '@/services/socketService';
import { useTTS } from '@/hooks/useTTS';
import { useModuleData } from '@/hooks/useModuleData';
import { GlassCard } from './SharedUI';
import { useApp } from '../contexts/AppContext';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import { useSocket } from '@/hooks/useSocket';
import { toast } from 'sonner';
import { formatUiMessage, uiMessage } from '../i18n/uiMessages';
import {
  isTerminalAgentStatus,
  shouldDisplayAgentResponse,
  shouldSpeakAgentResponse,
  type AgentResponseDelivery,
} from '@/lib/agentResponseDelivery';

export function UnifiedAgent({ t, user, onEnterSanctuary }: { t: any; user: any; onEnterSanctuary?: () => void }) {
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const { user: appUser } = useApp();
  const [isVisionActive, setIsVisionActive] = useState(false);
  const [visionData, setVisionData] = useState<string[]>([]);
  const [founderVision, setFounderVision] = useState('');
  const [isFounderEditing, setIsFounderEditing] = useState(false);
  
  const socket = useSocket();
  const { callState, audioLevel, startCall, endCall, transcript } = useVoiceCall({
    socket,
    onTranscript: (text, isFinal) => {
      if (isFinal) {
        const userMsg = {
          id: Date.now().toString(),
          text,
          userName: user?.displayName || uiMessage('unified-agent.user.d25ece72d0'),
          timestamp: new Date().toISOString(),
          type: 'user'
        };
        setMessages(prev => [...prev, userMsg]);
      }
    },
    onResponse: (text) => {
      const agentMsg = {
        id: Date.now().toString(),
        text,
        userName: 'Lumi',
        timestamp: new Date().toISOString(),
        type: 'agent'
      };
      setMessages(prev => [...prev, agentMsg]);
    }
  });

  const { speak, stop, isSpeaking } = useTTS();
  const { data: agents, error: agentsError } = useModuleData<any[]>('/api/agents');
  const agentConfig = agents?.[0];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isVoiceMode, setIsVoiceMode] = useState(false);

  const [isPrivateMode, setIsPrivateMode] = useState(false);

  useEffect(() => {
    if (!socket) return;

    const handleAgentResponse = (data: AgentResponseDelivery & { agentName?: string }) => {
      if (shouldDisplayAgentResponse(data)) {
        const agentMsg = {
          id: Date.now().toString(),
          text: data.text,
          userName: data.agentName || 'Lumi',
          timestamp: new Date().toISOString(),
          type: 'agent'
        };
        setMessages(prev => [...prev, agentMsg]);
      }
      
      // Only speak if we are in voice mode or it was a voice trigger
      if (isVoiceMode && shouldSpeakAgentResponse(data)) {
        speak(data.text!);
      }
    };

    const handleStatus = (data: { status: string }) => {
      if (data.status === 'thinking' || data.status === 'responding') {
        setIsTyping(true);
      } else if (isTerminalAgentStatus(data.status)) {
        setIsTyping(false);
      }
    };

    const handleError = (data: { message: string }) => {
      console.error("Socket Agent Error:", data.message);
      setIsTyping(false);
    };

    const handleProactive = (data: {
      type: string;
      message: string;
      agentName?: string;
      timestamp: string;
      finalized?: boolean;
      blocked?: boolean;
      reason?: string;
    }) => {
      if (data.type === 'greeting') {
        const delivery: AgentResponseDelivery = { ...data, text: data.message };
        if (!shouldDisplayAgentResponse(delivery)) return;
        const greetingMsg = {
          id: `greeting-${data.timestamp}`,
          text: data.message,
          userName: data.agentName || 'Lumi',
          timestamp: data.timestamp,
          type: 'agent'
        };
        setMessages(prev => [...prev, greetingMsg]);
        if (isVoiceMode && shouldSpeakAgentResponse(delivery)) speak(data.message);
      }
    };

    socket.on("agent:response", handleAgentResponse);
    socket.on("agent:status", handleStatus);
    socket.on("agent:error", handleError);
    socket.on("agent:proactive", handleProactive);

    return () => {
      socket.off("agent:response", handleAgentResponse);
      socket.off("agent:status", handleStatus);
      socket.off("agent:error", handleError);
      socket.off("agent:proactive", handleProactive);
    };
  }, [socket, speak, isVoiceMode]);

  const fetchInteractions = async () => {
    try {
      const res = await fetch('/api/interactions');
      if (res.ok) {
        const data = await res.json();
        setMessages(data.map((i: any) => ({
          id: i.id,
          text: i.content,
          userName: i.role === 'user' ? (user?.displayName || uiMessage('unified-agent.user.d25ece72d0')) : (agentConfig?.name || 'Lumi'),
          timestamp: i.timestamp,
          type: i.role === 'user' ? 'user' : 'agent'
        })));
      }
    } catch (error) {
      console.error('Error fetching interactions:', error);
    }
  };

  useEffect(() => {
    if (user) {
      fetchInteractions();
      fetchFounderVision();
    } else {
      setMessages([]);
    }
  }, [user]);

  useEffect(() => {
    if (agentsError) toast.error(t.failedToLoadAgentConfig || 'Failed to load agent configuration');
  }, [agentsError]);

  const fetchFounderVision = async () => {
    try {
      const res = await fetch('/api/founder/vision');
      if (res.ok) {
        const data = await res.json();
        setFounderVision(data.vision);
      }
    } catch (err) {
      console.error('Error fetching founder vision:', err);
    }
  };

  const updateFounderVision = async () => {
    try {
      const res = await fetch('/api/founder/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vision: founderVision })
      });
      if (res.ok) {
        setIsFounderEditing(false);
      }
    } catch (err) {
      console.error('Error updating founder vision:', err);
    }
  };

  const toggleVision = () => {
    setIsVisionActive(!isVisionActive);
    if (!isVisionActive) {
      // Query active device capabilities from the mesh
      fetch('/api/devices')
        .then(res => res.json())
        .then(data => {
          const ctx = data.sensoryContext;
          if (ctx && ctx.deviceCount > 0) {
            const caps: string[] = [];
            if (ctx.hasAudio) caps.push(uiMessage('unified-agent.audio-input.6576a47986'));
            if (ctx.hasVideo) caps.push(uiMessage('unified-agent.camera.b084bb3f31'));
            if (ctx.hasSpatial) caps.push(uiMessage('unified-agent.spatial-tracking.00b02e47a0'));
            if (ctx.hasHaptic) caps.push(uiMessage('unified-agent.haptic-feedback.1f62c7f820'));
            if (ctx.hasHolographic) caps.push(uiMessage('unified-agent.holographic-output.b41d04feea'));
            setVisionData(caps.length > 0 ? caps : [uiMessage('unified-agent.no-active-sensors.6be33346bb')]);
          } else {
            setVisionData([uiMessage('unified-agent.no-devices-connected.a663f62582')]);
          }
        })
        .catch(() => setVisionData([uiMessage('unified-agent.sensor-api-unavailable.e1cde145cc')]));
    } else {
      setVisionData([]);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async (e?: React.FormEvent, text?: string, isVoice: boolean = false) => {
    if (e) e.preventDefault();
    const messageText = text || newMessage;
    if (!messageText.trim() || !user) return;

    setIsVoiceMode(isVoice);
    
    // If typing, stop any ongoing speech
    if (!isVoice) {
      stop();
    }

    const userMsg = {
      id: Date.now().toString(),
      text: messageText,
      userName: user.displayName || user.username || uiMessage('unified-agent.anonymous.39c1bd4767'),
      timestamp: new Date().toISOString(),
      type: 'user'
    };

    setMessages(prev => [...prev, userMsg]);
    setNewMessage('');
    
    if (socket) {
      socket.emit("agent:chat", {
        text: messageText,
        history: messages.map(m => ({
          role: m.type === 'user' ? 'user' : 'assistant',
          content: m.text
        })),
        personalityId: 'lumi'
      });
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-12">
      {/* Top Row: Holographic Module & Founder Vision */}
      <div className="grid md:grid-cols-2 gap-8">
        {/* Left: Holographic Module (Carrier Dock & Sensing) */}
        <GlassCard className="p-8 rounded-[2.5rem] space-y-6" hoverEffect={false}>
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold tracking-tighter flex items-center gap-2">
              <Cpu size={20} className={isPrivateMode ? "text-celestial-saturn" : "text-celestial-glow animate-pulse"} />
              {isPrivateMode ? uiMessage('unified-agent.physical-isolation.9d64f9ccf2') : uiMessage('unified-agent.neural-carrier.ff8509e4a3')}
            </h3>
            <div className="flex gap-2">
              <Button 
                onClick={toggleVision}
                className={`rounded-full px-3 h-7 text-[12px] font-bold uppercase tracking-widest ${
                  isVisionActive ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40'
                }`}
              >
                {uiMessage('unified-agent.sensors.5d0ff4c71e')}
              </Button>
              <Button 
                onClick={() => setIsPrivateMode(!isPrivateMode)}
                className={`rounded-full px-3 h-7 text-[12px] font-bold uppercase tracking-widest ${
                  isPrivateMode ? 'bg-celestial-saturn text-black' : 'bg-white/5 text-white/40'
                }`}
              >
                {isPrivateMode ? uiMessage('unified-agent.online.ab9849070c') : uiMessage('unified-agent.kill-switch.02bd0841f8')}
              </Button>
            </div>
          </div>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-white/5 rounded-2xl border border-white/5">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full status-pulse ${isPrivateMode ? 'bg-celestial-saturn' : 'bg-celestial-glow'}`} />
                <span className="text-xs font-bold uppercase tracking-widest text-white/60">
                  {isPrivateMode ? uiMessage('unified-agent.local-npu-active.a60727058f') : uiMessage('unified-agent.mesh-synced.7075001361')}
                </span>
              </div>
              <span className="text-[12px] font-mono text-white/45">v2.0-Alpha</span>
            </div>

            <div className="flex flex-wrap gap-2 min-h-[32px]">
              {isVisionActive ? (
                visionData.map((obj, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-xs font-medium flex items-center gap-2"
                  >
                    <div className="w-1 h-1 rounded-full bg-celestial-saturn" />
                    {obj}
                  </motion.div>
                ))
              ) : (
                <p className="text-xs text-white/45 italic">{uiMessage('unified-agent.edge-sensors-on-standby.59037c03d6')}</p>
              )}
            </div>
          </div>
        </GlassCard>

        {/* Right: Founder's Vision */}
        <GlassCard className="p-8 rounded-[2.5rem] space-y-6" hoverEffect={false}>
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold tracking-tighter flex items-center gap-2">
              <Zap size={20} className="text-celestial-mars" />
              {t.founderVision || uiMessage('unified-agent.founder-s-vision.c0fa614a0e')}
            </h3>
            {user?.role === 'admin' && (
              <Button 
                onClick={() => isFounderEditing ? updateFounderVision() : setIsFounderEditing(true)}
                className="rounded-full px-4 h-8 text-xs font-bold uppercase tracking-widest bg-white/5 text-white/40 hover:bg-white/10"
              >
                {isFounderEditing ? (t.updateVision || uiMessage('unified-agent.update-vision.04bb4e41be')) : uiMessage('unified-agent.edit-vision.f704aaa37a')}
              </Button>
            )}
          </div>
          
          {isFounderEditing ? (
            <textarea
              value={founderVision}
              onChange={(e) => setFounderVision(e.target.value)}
              className="w-full h-24 bg-black/20 border border-white/10 rounded-2xl p-4 text-sm text-white/80 focus:outline-none focus:border-celestial-saturn/50 resize-none font-mono"
            />
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-white/60 leading-relaxed italic">
                "{founderVision || uiMessage('unified-agent.lumiai-aims-to-build-a.ef32f8bf6c')}"
              </p>
              <Button 
                onClick={onEnterSanctuary}
                className="w-full py-6 rounded-2xl bg-celestial-saturn/10 border border-celestial-saturn/30 text-celestial-saturn font-bold hover:bg-celestial-saturn hover:text-black transition-all flex items-center justify-center gap-2 group"
              >
                <Sparkles size={18} className="group-hover:animate-spin" />
                {t.enterSanctuary || uiMessage('unified-agent.enter-founder-sanctuary.503e7ea673')}
              </Button>
            </div>
          )}
        </GlassCard>
      </div>

      {/* Top Section: Voice & Visual Agent */}
      <section className="relative">
        <div className="text-center space-y-4 mb-8">
          <h2 className="text-4xl font-bold tracking-tighter glow-text">
            {uiMessage('unified-agent.lumi-core-agent.f03abbcc53')}
          </h2>
          <p className="text-white/40 max-w-xl mx-auto italic">
            "{t.holographicEntranceDesc}"
          </p>
        </div>
        
        <div className="flex flex-col lg:flex-row items-center justify-center gap-12">
          <div className="w-full lg:w-1/2">
            <LocalAgentSphere 
              t={t} 
              callState={callState}
              audioLevel={audioLevel}
              onStartCall={() => startCall(undefined, 'lumi', 'lumi')}
              onEndCall={endCall}
            />
          </div>

          {/* Message Board (Simplified Chat) */}
          <div className="w-full lg:w-1/2 flex flex-col h-[500px] glass rounded-[2.5rem] border-white/10 overflow-hidden relative">
            {/* Real-time Overlay for Transcript */}
            <AnimatePresence>
              {callState !== 'idle' && transcript && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-x-0 top-20 z-50 flex justify-center px-4 pointer-events-none"
                >
                  <div className="inline-flex max-w-full items-start justify-center gap-3 rounded-2xl bg-celestial-saturn px-5 py-3 text-center text-sm font-bold text-black shadow-2xl">
                    <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-black animate-pulse" />
                    <span className="min-w-0 whitespace-normal break-words leading-relaxed">{transcript}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isSpeaking ? 'bg-celestial-mars animate-ping' : 'bg-celestial-saturn animate-pulse'}`} />
                <span className="text-xs font-bold uppercase tracking-widest text-white/60">{t.realTimeNode || uiMessage('unified-agent.real-time-node.b5eb7f62d7')}</span>
                {isSpeaking && (
                  <Button 
                    onClick={stop}
                    className="h-6 px-2 text-xs bg-red-500/20 text-red-500 hover:bg-red-500/40 rounded-full border border-red-500/20"
                  >
                    {t.stopSpeaking || uiMessage('unified-agent.stop.6864db7885')}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs text-white/40 font-mono uppercase">
                  {t.founderMode || uiMessage('unified-agent.founder-mode.354f37c16b')}
                </div>
              </div>
            </div>

            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide"
            >
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-20">
                  <MessageSquare size={48} />
                  <p className="text-sm">{uiMessage('unified-agent.no-interactions-yet.536ca35cec')}<br />{uiMessage('unified-agent.start-talking-with-your-local.83ee0df1d3')}</p>
                </div>
              )}
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex flex-col ${msg.type === 'agent' ? 'items-start' : 'items-end'}`}
                  >
                    <div className={`max-w-[85%] p-4 rounded-2xl text-sm ${
                      msg.type === 'agent' 
                        ? 'bg-celestial-saturn/10 text-celestial-saturn border border-celestial-saturn/20 rounded-tl-none' 
                        : 'bg-white/5 text-white/80 border border-white/10 rounded-tr-none'
                    }`}>
                      {msg.text}
                    </div>
                    <span className="text-[12px] uppercase tracking-tighter opacity-30 mt-1 px-2">
                      {msg.userName} • {new Date(msg.timestamp).toLocaleTimeString(isZh ? 'zh-CN' : undefined, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {isTyping && (
                <div className="flex gap-1 items-center text-celestial-saturn/40 text-xs">
                  <Loader2 size={12} className="animate-spin" />
                  {uiMessage('unified-agent.agent-is-thinking.5f1dd108b4')}
                </div>
              )}
            </div>

            <div className="p-4 bg-white/5 border-t border-white/5">
              <form onSubmit={handleSendMessage} className="relative flex gap-2">
                <Input
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder={uiMessage('unified-agent.type-a-command-or-message.ba53e37dab')}
                  className="bg-black/20 border-white/10 rounded-xl focus-visible:ring-celestial-saturn/50"
                />
                <Button 
                  type="submit" 
                  disabled={isTyping}
                  className="bg-celestial-saturn text-black rounded-xl px-4 hover:scale-105 transition-transform"
                >
                  <Send size={18} />
                </Button>
              </form>
            </div>
          </div>
        </div>
      </section>

      {/* Stats / Info Row */}
      <StatsRow socket={socket} t={t} />
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <GlassCard className="p-6 rounded-3xl flex items-center gap-4" hoverEffect={false}>
      <div className={`p-3 rounded-2xl bg-white/5 ${color}`}>
        {icon}
      </div>
      <div>
        <div className="text-xs font-bold uppercase tracking-widest text-white/55">{label}</div>
        <div className="text-lg font-bold">{value}</div>
      </div>
    </GlassCard>
  );
}

function StatsRow({ socket, t }: { socket: any; t: any }) {
  const [latency, setLatency] = useState<number | null>(null);
  const isZh = t?.langCode !== 'en';
  const ui = (zh: string, en: string) => (isZh ? zh : en);

  useEffect(() => {
    if (!socket) return;
    let done = false;
    const measure = async () => {
      const start = performance.now();
      socket.emit('ping');
      socket.once('pong', () => {
        if (!done) { setLatency(Math.round(performance.now() - start)); done = true; }
      });
    };
    measure();
    const iv = setInterval(measure, 5000);
    return () => { clearInterval(iv); done = true; };
  }, [socket]);

  const cpuCores = (navigator as any).hardwareConcurrency || '?';
  const connected = socket?.connected ?? false;

  return (
    <div className="grid md:grid-cols-3 gap-6">
      <StatCard
        icon={<Cpu size={24} />}
        label={t.computePower || uiMessage('unified-agent.compute-power.820b0308d9')}
        value={formatUiMessage('unified-agent.value0-cores.ab9c5a4a13', { value0: cpuCores })}
        color="text-celestial-saturn"
      />
      <StatCard
        icon={<Globe size={24} />}
        label={t.nodeSync || uiMessage('unified-agent.node-sync.2761bbdeec')}
        value={connected ? (t.meshActiveLabel || uiMessage('unified-agent.mesh-connected.b5eb8c66fb')) : (t.disconnected || uiMessage('unified-agent.disconnected.0065488a05'))}
        color={connected ? 'text-celestial-mars' : 'text-white/40'}
      />
      <StatCard
        icon={<Zap size={24} />}
        label={t.responseLatency || uiMessage('unified-agent.response-latency.6bd0d2579c')}
        value={latency ? `${latency}ms` : '--'}
        color="text-celestial-glow"
      />
    </div>
  );
}

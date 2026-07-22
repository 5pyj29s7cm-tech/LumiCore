import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquare, X, Send, Sparkles, Loader2, Bot, Settings, Mic, MicOff, HelpCircle, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { GlassCard } from './SharedUI';
import { useSocket } from '@/hooks/useSocket';
import { useApp } from '@/contexts/AppContext';
import { requestMicrophoneStream } from '@/services/sensorPermissionService';
import {
  isTerminalAgentStatus,
  shouldDisplayAgentResponse,
  type AgentResponseDelivery,
} from '@/lib/agentResponseDelivery';
import Markdown from 'react-markdown';

export function FloatingAgent({ t }: { t: any }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([
    { role: 'assistant', content: t.manualIntro || 'I am your Lumi user-manual assistant. What would you like to learn about the platform?' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const socket = useSocket();

  const quickSuggestions = [
    { id: 'create', label: t.howToCreateAgent },
    { id: 'legacy', label: t.whatIsLegacyProtocol },
    { id: 'credits', label: t.howToEarnCredits },
    { id: 'privacy', label: t.privacyPolicy },
  ];

  useEffect(() => {
    if (!socket || !isOpen) return;

    const onResponse = (data: AgentResponseDelivery) => {
      if (shouldDisplayAgentResponse(data)) {
        setMessages(prev => [...prev, { role: 'assistant', content: data.text! }]);
      }
      setIsLoading(false);
    };

    const onStatus = (data: { status: string }) => {
      if (data.status === 'thinking' || data.status === 'responding') {
        setIsLoading(true);
      } else if (isTerminalAgentStatus(data.status)) {
        setIsLoading(false);
      }
    };

    socket.on("agent:response", onResponse);
    socket.on("agent:status", onStatus);

    return () => {
      socket.off("agent:response", onResponse);
      socket.off("agent:status", onStatus);
    };
  }, [isOpen, socket]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSend = async (text?: string) => {
    const messageToSend = text || input.trim();
    if (!messageToSend || isLoading) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: messageToSend }]);
    setIsLoading(true);

    if (socket) {
      socket.emit("agent:chat", {
        text: messageToSend,
        history: messages.map(m => ({
          role: m.role,
          content: m.content
        })),
        personalityId: 'lumi'
      });
    }
  };

  const toggleListen = async () => {
    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const stream = await requestMicrophoneStream(true);
      stream.getTracks().forEach(track => track.stop());
    } catch (err) {
      console.error('Microphone access denied:', err);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    
    recognition.onstart = () => setIsListening(true);
    
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
      setIsListening(false);
    };

    recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.error('Speech recognition error:', event.error);
      }
      setIsListening(false);
    };

    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  return (
    <div className="fixed bottom-6 right-6 z-[60]">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            className="mb-4 w-[350px] sm:w-[420px]"
          >
            <GlassCard className="flex flex-col h-[600px] overflow-hidden border-celestial-saturn/30 shadow-[0_20px_50px_rgba(0,0,0,0.5),0_0_30px_rgba(255,204,0,0.1)]">
              {/* Header */}
              <div className="p-5 border-b border-white/10 flex items-center justify-between bg-white/5 backdrop-blur-md">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-celestial-saturn flex items-center justify-center text-black shadow-[0_0_15px_rgba(255,204,0,0.4)]">
                    <Bot size={22} />
                  </div>
                  <div>
                    <div className="text-base font-bold tracking-tight">{t.userManual || 'User Manual'}</div>
                    <div className="text-xs text-celestial-saturn flex items-center gap-1 font-bold uppercase tracking-widest">
                      <span className="w-1.5 h-1.5 rounded-full bg-celestial-saturn animate-pulse" />
                      {t.manualAssistant || 'Manual Assistant'}
                    </div>
                  </div>
                </div>
                <button 
                  onClick={() => setIsOpen(false)} 
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-all"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Messages Area */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-6 scrollbar-hide bg-black/20">
                {messages.map((msg, i) => (
                  <motion.div 
                    key={i} 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-celestial-saturn text-black font-medium rounded-tr-none shadow-lg' 
                        : 'bg-white/5 border border-white/10 text-white/90 rounded-tl-none backdrop-blur-sm'
                    }`}>
                      <div className="markdown-body">
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    </div>
                  </motion.div>
                ))}
                
                {/* Quick Suggestions - Only show after the first message or when not loading */}
                {!isLoading && messages.length === 1 && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-3 pt-2"
                  >
                    <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-white/55 font-bold px-1">
                      <HelpCircle size={12} />
                      {t.quickGuide}
                    </div>
                    <div className="grid gap-2">
                      {quickSuggestions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => handleSend(s.label)}
                          className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white/60 hover:text-celestial-saturn hover:border-celestial-saturn/30 hover:bg-celestial-saturn/5 transition-all text-left group"
                        >
                          {s.label}
                          <ChevronRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}

                {isLoading && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex justify-start"
                  >
                    <div className="bg-white/5 border border-white/10 p-4 rounded-2xl rounded-tl-none">
                      <div className="flex gap-1">
                        <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity }} className="w-1.5 h-1.5 bg-celestial-saturn rounded-full" />
                        <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0.2 }} className="w-1.5 h-1.5 bg-celestial-saturn rounded-full" />
                        <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: 0.4 }} className="w-1.5 h-1.5 bg-celestial-saturn rounded-full" />
                      </div>
                    </div>
                  </motion.div>
                )}
              </div>

              {/* Input Area */}
              <div className="p-5 border-t border-white/10 bg-white/5 backdrop-blur-md">
                <form 
                  onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                  className="flex gap-3"
                >
                  <Button
                    type="button"
                    onClick={toggleListen}
                    className={`shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${
                      isListening ? 'bg-red-500 text-white animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.4)]' : 'bg-white/5 text-white/40 hover:bg-white/10 border border-white/10'
                    }`}
                  >
                    {isListening ? <Mic size={20} /> : <MicOff size={20} />}
                  </Button>
                  <div className="relative flex-1">
                    <Input 
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={isListening ? (t.listening || "Listening...") : (t.askAboutLumiAI || "Ask about LumiAI...")}
                      className="h-12 bg-black/40 border-white/10 focus:border-celestial-saturn/50 rounded-2xl pr-12"
                    />
                    <button 
                      type="submit" 
                      disabled={isLoading || !input.trim()}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-celestial-saturn disabled:text-white/45 transition-colors"
                    >
                      <Send size={18} />
                    </button>
                  </div>
                </form>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => setIsOpen(!isOpen)}
        className="w-16 h-16 rounded-full bg-celestial-saturn text-black shadow-[0_10px_30px_rgba(255,204,0,0.3)] flex items-center justify-center relative group overflow-hidden"
      >
        <div className="absolute inset-0 bg-gradient-to-tr from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        {isOpen ? <X size={28} /> : <HelpCircle size={28} />}
        {!isOpen && (
          <div className="absolute -top-1 -right-1 w-5 h-5 bg-celestial-mars rounded-full border-2 border-celestial-deep animate-bounce flex items-center justify-center text-xs font-bold text-white">
            1
          </div>
        )}
        <div className="absolute right-full mr-4 px-4 py-2 bg-celestial-deep/90 backdrop-blur-xl border border-white/10 rounded-2xl text-xs font-bold text-white opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0 whitespace-nowrap pointer-events-none shadow-2xl">
          {t.userManual || 'User Manual'}
        </div>
      </motion.button>
    </div>
  );
}

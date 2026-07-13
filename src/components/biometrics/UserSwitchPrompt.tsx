import { motion, AnimatePresence } from 'motion/react';
import { useState, useEffect, useCallback } from 'react';
import { useT } from '../../lib/useT';
import { uiMessage } from '../../i18n/uiMessages';

interface DetectedUser {
  uid: string;
  username: string;
  confidence: number;
}

interface UserSwitchPromptProps {
  socket?: any;
}

export function UserSwitchPrompt({ socket }: UserSwitchPromptProps) {
  const t = useT();
  const isZh = t.langCode !== 'en';
  const [detected, setDetected] = useState<DetectedUser | null>(null);
  const [switching, setSwitching] = useState(false);

  const handleSwitchUser = useCallback((uid: string, username: string) => {
    if (switching) return;
    setSwitching(true);
    // Switch by calling the org switch endpoint with the detected user
    // (in single-user mode, this becomes a JWT re-issue for the target user)
    fetch('/api/auth/switch-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ targetUid: uid }),
    }).then(res => {
      if (res.ok) {
        window.location.reload();
      } else {
        setSwitching(false);
        setDetected(null);
      }
    }).catch(() => {
      setSwitching(false);
      setDetected(null);
    });
  }, [switching]);

  const handleDismiss = useCallback(() => {
    setDetected(null);
  }, []);

  // Listen for detected users from the socket
  useEffect(() => {
    if (!socket) return;
    const handler = (data: DetectedUser) => {
      setDetected(data);
    };
    socket.on('presence:detected_user', handler);
    return () => { socket.off('presence:detected_user', handler); };
  }, [socket]);

  return (
    <AnimatePresence>
      {detected && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000]"
        >
          <div
            className="flex items-center gap-4 px-5 py-3 rounded-2xl shadow-2xl"
            style={{ background: 'rgba(20,20,20,0.92)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
                <span className="text-amber-400 text-sm font-bold">
                  {detected.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <div>
                <p className="text-sm text-white/90 font-medium">{uiMessage('user-switch-prompt.detected.7548e82813', (isZh) ? 'zh' : 'en')} {detected.username}</p>
                <p className="text-[10px] text-white/40">{uiMessage('user-switch-prompt.confidence.dc2fc3df56', (isZh) ? 'zh' : 'en')} {Math.round(detected.confidence * 100)}%</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleSwitchUser(detected.uid, detected.username)}
                disabled={switching}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/80 text-black hover:bg-amber-400 transition-colors"
              >
                {switching ? (uiMessage('user-switch-prompt.switching.c197a0b742', (isZh) ? 'zh' : 'en')) : (uiMessage('user-switch-prompt.switch.5a77f0584c', (isZh) ? 'zh' : 'en'))}
              </button>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-xs text-white/50 hover:text-white/80 transition-colors"
              >
                {uiMessage('user-switch-prompt.ignore.9330c23b1e', (isZh) ? 'zh' : 'en')}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

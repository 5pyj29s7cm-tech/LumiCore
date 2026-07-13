import React from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { getLocale, getMessages } from '@/i18n/runtime';

function getT() {
  try {
    return getMessages(getLocale());
  } catch {
    return getMessages('en');
  }
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error.message, errorInfo.componentStack?.slice(0, 300));
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const t = getT();

      return (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-center justify-center min-h-[60vh]"
        >
          <div className="glass-dark rounded-[2.5rem] p-8 border border-white/10 max-w-sm text-center space-y-5">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
              <AlertTriangle size={28} className="text-red-400" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-black uppercase tracking-widest text-white/60">{t.errorSignalInterrupted || 'Signal Interrupted'}</h3>
              <p className="text-xs text-white/45 font-mono uppercase tracking-widest">{t.errorRenderFailure || 'Component render failure'}</p>
            </div>
            <p className="text-xs text-white/40 font-mono bg-white/5 rounded-xl p-3 max-h-20 overflow-auto">
              {this.state.error?.message?.slice(0, 120) || t.errorUnknown || 'Unknown error'}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleRetry}
                className="px-5 py-2.5 rounded-xl bg-white/5 border border-white/10 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              >
                <RefreshCw size={12} />
                {t.errorRetry || 'Retry'}
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-5 py-2.5 rounded-xl bg-celestial-saturn/10 border border-celestial-saturn/20 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-celestial-saturn hover:bg-celestial-saturn/20 transition-colors"
              >
                <Home size={12} />
                {t.errorReload || 'Reload'}
              </button>
            </div>
          </div>
        </motion.div>
      );
    }

    return this.props.children;
  }
}

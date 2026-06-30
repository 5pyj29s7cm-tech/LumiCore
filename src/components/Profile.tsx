import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { User, Shield, Cpu, Rocket, Ghost, Activity, Wallet, Zap, Key, CheckCircle, AlertCircle, Crown, TrendingUp, BarChart3 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useApp } from '../contexts/AppContext';
import { GlassCard } from './SharedUI';

export function Profile({ t }: { t: any }) {
  const { user, agents } = useApp();
  const [health, setHealth] = useState<any>(null);
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [status, setStatus] = useState<{ type: 'success' | 'error' | null, message: string }>({ type: null, message: '' });
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then(res => res.json())
      .then(data => setHealth(data))
      .catch(err => console.error('Health fetch failed:', err));
  }, []);

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdating(true);
    setStatus({ type: null, message: '' });

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.next })
      });

      const data = await res.json();
      if (res.ok) {
        setStatus({ type: 'success', message: t.passwordChanged });
        setPasswords({ current: '', next: '' });
      } else {
        setStatus({ type: 'error', message: data.error || t.passwordError });
      }
    } catch (err) {
      setStatus({ type: 'error', message: t.passwordError });
    } finally {
      setIsUpdating(false);
    }
  };

  if (!user) return null;

  return (
    <div className="max-w-4xl mx-auto space-y-12">
      <div className="flex flex-col md:flex-row items-center gap-8">
        <div className="relative w-32 h-32 md:w-48 md:h-48 rounded-full overflow-hidden border-4 border-celestial-saturn/20 shadow-[0_0_50px_rgba(255,204,0,0.1)]">
          {user.photoURL ? (
            <img src={user.photoURL} alt={user.displayName} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-full h-full bg-white/5 flex items-center justify-center text-white/40">
              <User size={64} />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        </div>
        
        <div className="text-center md:text-left space-y-4">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tighter glow-text">{user.displayName || user.username}</h1>
            <p className="text-white/40 font-mono text-sm">{t.nodeId || 'Node ID'}: {user.uid.slice(0, 6)}...{user.uid.slice(-4)}</p>
          </div>
          <div className="flex flex-wrap justify-center md:justify-start gap-3">
            <Badge icon={<Shield size={12} />} label={t.verifiedNode || 'Verified Node'} color="text-green-500 bg-green-500/10" />
            <Badge icon={<Cpu size={12} />} label={t.levelArchitect || 'Level 12 Architect'} color="text-celestial-saturn bg-celestial-saturn/10" />
            <Badge icon={<Rocket size={12} />} label={t.earlyExplorer || 'Early Explorer'} color="text-celestial-mars bg-celestial-mars/10" />
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        <GlassCard className="p-8 rounded-[3rem] space-y-6" hoverEffect={false}>
          <h3 className="text-xl font-bold tracking-tighter flex items-center gap-2">
            <Wallet size={20} className="text-celestial-saturn" />
            {t.wallet || 'Neural Wallet'}
          </h3>
          <div className="space-y-4">
            <div className="p-6 bg-gradient-to-br from-celestial-saturn/20 to-transparent rounded-3xl border border-celestial-saturn/20 text-center space-y-2">
              <div className="text-xs text-white/40 uppercase tracking-widest font-bold">{t.credits || 'Lumi Credits'}</div>
              <div className="text-4xl font-bold text-celestial-saturn flex items-center justify-center gap-2">
                <Zap size={32} fill="currentColor" />
                {user.balance || 0}
              </div>
              <div className="text-xs text-white/45">{t.earnCredits || 'Earn by Contributing Node Power'}</div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Button className="rounded-xl bg-white/5 border border-white/10 text-xs h-10">{t.withdraw || 'Withdraw'}</Button>
              <Button className="rounded-xl bg-celestial-saturn text-black font-bold text-xs h-10">{t.topUp || 'Top Up'}</Button>
            </div>
          </div>
        </GlassCard>

        <GlassCard className="p-8 rounded-[3rem] space-y-6" hoverEffect={false}>
          <h3 className="text-xl font-bold tracking-tighter">{t.nodeStats || 'Node Stats'}</h3>
          <div className="grid grid-cols-2 gap-4">
            <StatBox label={t.totalData || 'Total Data'} value="1.2 TB" />
            <StatBox label={t.uptime || 'Uptime'} value={health?.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : "99.9%"} />
            <StatBox label={t.nodePower || 'Node Power'} value="850 GFLOPS" />
            <StatBox label={t.interactions || 'Interactions'} value={health?.database?.interactions || "1,240"} />
          </div>
        </GlassCard>

        <GlassCard className="p-8 rounded-[3rem] space-y-6" hoverEffect={false}>
          <h3 className="text-xl font-bold tracking-tighter flex items-center gap-2">
            <Crown size={20} className="text-amber-400" />
            {t.subscription || 'Subscription'}
          </h3>
          <SubscriptionSection t={t} />
        </GlassCard>

        <GlassCard className="p-8 rounded-[3rem] space-y-6" hoverEffect={false}>
          <h3 className="text-xl font-bold tracking-tighter flex items-center gap-2">
            <Key size={20} className="text-celestial-mars" />
            {t.changePassword || 'Change Password'}
          </h3>
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest font-bold text-white/40">{t.currentPassword}</label>
              <Input 
                type="password" 
                value={passwords.current}
                onChange={(e) => setPasswords(prev => ({ ...prev, current: e.target.value }))}
                className="bg-white/5 border-white/10 rounded-xl"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-widest font-bold text-white/40">{t.newPassword}</label>
              <Input 
                type="password" 
                value={passwords.next}
                onChange={(e) => setPasswords(prev => ({ ...prev, next: e.target.value }))}
                className="bg-white/5 border-white/10 rounded-xl"
                required
              />
            </div>
            
            {status.type && (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                  status.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
                }`}
              >
                {status.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                {status.message}
              </motion.div>
            )}

            <Button 
              type="submit" 
              disabled={isUpdating}
              className="w-full rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 font-bold"
            >
              {isUpdating ? '...' : t.updatePassword}
            </Button>
          </form>
        </GlassCard>

        {health && (
          <GlassCard className="p-8 rounded-[3rem] space-y-6 md:col-span-2" hoverEffect={false}>
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold tracking-tighter flex items-center gap-2">
                <Activity size={20} className="text-green-500" />
                {t.healthStatus || 'System Health'}
              </h3>
              <div className="text-xs font-mono text-white/40">{health.timestamp}</div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-xs text-white/40 uppercase font-bold mb-1">{t.status || 'Status'}</div>
                <div className="text-green-500 font-bold uppercase tracking-widest text-xs">{t.operational || 'Operational'}</div>
              </div>
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-xs text-white/40 uppercase font-bold mb-1">{t.users || 'Users'}</div>
                <div className="text-white font-bold text-xs">{health.database?.users}</div>
              </div>
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-xs text-white/40 uppercase font-bold mb-1">{t.agents || 'Agents'}</div>
                <div className="text-white font-bold text-xs">{health.database?.agents}</div>
              </div>
              <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                <div className="text-xs text-white/40 uppercase font-bold mb-1">{t.latency || 'Latency'}</div>
                <div className="text-celestial-saturn font-bold text-xs">12ms</div>
              </div>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}

function SubscriptionSection({ t }: { t: any }) {
  const [sub, setSub] = useState<any>(null);
  const [tokens, setTokens] = useState<any>(null);

  useEffect(() => {
    fetch('/api/subscription/status', { credentials: 'include' })
      .then(r => r.json()).then(d => setSub(d.subscription)).catch(() => {});
    fetch('/api/llm/usage?days=1', { credentials: 'include' })
      .then(r => r.json()).then(d => setTokens(d)).catch(() => {});
  }, []);

  const cap = sub?.monthlyTokenCap ?? 500000;
  const used = sub?.tokensUsedThisMonth ?? 0;
  const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
  const todayTotal = tokens?.grandTotal ?? 0;

  const planLabels: Record<string, string> = { free: 'Free', light: 'Light', pro: 'Pro', org: 'Org' };
  const planColors: Record<string, string> = {
    free: 'text-white/40',
    light: 'text-blue-400',
    pro: 'text-purple-400',
    org: 'text-amber-400',
  };
  const planId = sub?.planId || 'free';
  const planLabel = planLabels[planId] || planId;
  const planColor = planColors[planId] || 'text-white/40';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
        <div>
          <span className="text-xs font-black uppercase tracking-widest text-white/40">{t.currentPlan || 'Current Plan'}</span>
          <div className={`text-lg font-bold ${planColor}`}>{planLabel}</div>
        </div>
        <Crown size={28} className="text-amber-400/40" />
      </div>
      <div className="space-y-2">
        <div className="text-xs font-black uppercase tracking-widest text-white/55">{t.monthlyUsage || 'Monthly Token Usage'}</div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-3 bg-white/5 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(pct, 100)}%` }}
              className={`h-full rounded-full ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-gradient-to-r from-cyan-400 to-blue-500'}`}
            />
          </div>
          <span className="text-sm font-mono font-bold text-white/60">{pct}%</span>
        </div>
        <div className="flex justify-between text-xs text-white/40">
          <span>{used.toLocaleString()} / {cap.toLocaleString()} tokens</span>
          <span>{t.today || 'Today'}: {todayTotal.toLocaleString()}</span>
        </div>
      </div>
      {sub?.planId === 'free' && (
        <div className="p-4 bg-amber-500/5 border border-amber-500/10 rounded-2xl text-xs text-amber-300/60 flex items-center gap-2">
          <TrendingUp size={14} />
          {t.upgradeHint || 'Upgrade to unlock higher token caps and premium features.'}
        </div>
      )}
    </div>
  );
}

function Badge({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest ${color}`}>
      {icon}
      {label}
    </div>
  );
}

function AgentItem({ name, type, status }: { name: string; type: string; status: string }) {
  return (
    <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-celestial-saturn">
          <Ghost size={20} />
        </div>
        <div className="space-y-0.5">
          <div className="font-bold text-sm">{name}</div>
          <div className="text-xs text-white/40 uppercase tracking-widest">{type}</div>
        </div>
      </div>
      <div className={`text-xs font-bold uppercase tracking-widest ${status === 'Online' ? 'text-green-500' : status === 'Standby' ? 'text-celestial-saturn' : 'text-white/45'}`}>
        {status}
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4 bg-white/5 rounded-2xl border border-white/5 text-center space-y-1">
      <div className="text-xs text-white/40 uppercase tracking-widest font-bold">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}

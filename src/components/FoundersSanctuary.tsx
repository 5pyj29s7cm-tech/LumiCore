import { useState } from 'react';
import { motion } from 'motion/react';
import { Shield, Cpu, Network, ArrowLeft } from 'lucide-react';
import { foundersSanctuaryCopy } from '../i18n/locales/foundersSanctuary';

export function FoundersSanctuary({ t, onBack }: { t: any; onBack: () => void }) {
  const copy = foundersSanctuaryCopy(t?.langCode === 'zh' ? 'zh' : 'en');
  const [expanded, setExpanded] = useState<string | null>(null);
  const icons = [Network, Shield, Cpu];

  return (
    <div className="space-y-16 py-12">
      <motion.button initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
        type="button" onClick={onBack}
        className="flex items-center gap-2 text-white/40 hover:text-white transition-colors group">
        <ArrowLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
        <span className="text-xs font-black uppercase tracking-widest">{t.returnToHub || copy.back}</span>
      </motion.button>

      <section className="text-center space-y-6">
        <p className="text-xs font-bold uppercase tracking-widest text-celestial-saturn">{copy.category}</p>
        <h1 className="text-5xl font-black tracking-tight text-white/90">{copy.title}</h1>
        <p className="text-lg text-white/55 max-w-2xl mx-auto leading-relaxed">{t.sanctuaryHeroDesc || copy.introduction}</p>
      </section>

      <section className="grid lg:grid-cols-3 gap-8 items-start">
        {copy.concepts.map((item, index) => {
          const Icon = icons[index];
          const open = expanded === item.id;
          const detailId = `founder-concept-${item.id}`;
          return (
            <motion.div key={item.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.15 }} className="p-8 glass-dark rounded-[2rem] border border-white/10 space-y-6">
              <Icon size={24} className="text-celestial-saturn" />
              <p className="text-xs font-mono text-white/40">{copy.idLabel}: {item.id}</p>
              <h2 id={`${detailId}-title`} className="text-2xl font-black tracking-tight text-white/90">{item.title}</h2>
              <p className="text-sm text-white/50 leading-relaxed">{item.description}</p>
              <div className="pt-4 flex justify-between items-center gap-3 border-t border-white/10">
                <span className="text-xs font-bold text-white/50">{copy.status}</span>
                <button type="button" aria-expanded={open} aria-controls={detailId}
                  onClick={() => setExpanded(open ? null : item.id)}
                  className="text-xs font-bold text-white/70 hover:text-white border border-white/15 px-4 py-2 rounded-full">
                  {open ? copy.close : copy.open}
                </button>
              </div>
              {open && <div id={detailId} role="region" aria-labelledby={`${detailId}-title`} className="space-y-4 border-t border-white/10 pt-5 text-sm leading-relaxed">
                <div><h3 className="font-bold text-white/80">{copy.goal}</h3><p className="mt-1 text-white/55">{item.goal}</p></div>
                <div><h3 className="font-bold text-white/80">{copy.current}</h3><p className="mt-1 text-white/55">{item.current}</p></div>
                <div><h3 className="font-bold text-white/80">{copy.next}</h3><p className="mt-1 text-white/55">{item.next}</p></div>
              </div>}
            </motion.div>
          );
        })}
      </section>

      <section className="glass p-8 rounded-[2rem] border border-white/10 space-y-5">
        <h2 className="text-2xl font-bold text-white/85">{copy.principlesTitle}</h2>
        <ul className="space-y-3 text-sm leading-relaxed text-white/55">
          {copy.principles.map(principle => <li key={principle} className="border-l-2 border-celestial-saturn/30 pl-4">{principle}</li>)}
        </ul>
      </section>
    </div>
  );
}

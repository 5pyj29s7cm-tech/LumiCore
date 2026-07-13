import React from 'react';
import { motion } from 'motion/react';
import { Watch, Headphones, Cpu, Zap, Shield, Globe, ShoppingCart, Eye, Mic, Code, Monitor, Lamp as LampIcon, Database, Glasses, Circle, Car, Home, Gem, Rabbit, Smile, Gamepad2 } from 'lucide-react';
import { Button } from './ui/button';
import { useModuleData } from '@/hooks/useModuleData';
import { LoadingSpinner, GlassCard, IconBox, FeatureItem } from './SharedUI';
import { CN_PRODUCT_CATEGORY_ALIASES } from '../i18n/regions/cn/recognition';

const iconMap: { [key: string]: React.ReactNode } = {
  Hologram: <Monitor size={40} className="text-celestial-saturn" />,
  Lamp: <LampIcon size={40} className="text-celestial-mars" />,
  Base: <Database size={40} className="text-celestial-glow" />,
  Glasses: <Glasses size={40} className="text-celestial-saturn" />,
  Ring: <Circle size={40} className="text-celestial-mars" />,
  Car: <Car size={40} className="text-celestial-glow" />,
  Home: <Home size={40} className="text-celestial-saturn" />,
  Eye: <Eye size={40} className="text-celestial-saturn" />,
  Mic: <Mic size={40} className="text-celestial-mars" />,
  Code: <Code size={40} className="text-celestial-glow" />,
  Cpu: <Cpu size={40} className="text-celestial-saturn" />,
  Watch: <Watch size={40} className="text-celestial-mars" />,
  Headphones: <Headphones size={40} className="text-celestial-glow" />,
  Gem: <Gem size={40} className="text-celestial-saturn" />,
  Rabbit: <Rabbit size={40} className="text-celestial-mars" />,
  Smile: <Smile size={40} className="text-celestial-glow" />,
  Gamepad: <Gamepad2 size={40} className="text-celestial-saturn" />
};

export function MultimodalProducts({ t, onSelectProduct }: { t: any; onSelectProduct: (product: any) => void }) {
  const { data: products, loading } = useModuleData<any[]>('/api/modules/products', []);
  const sectionRefs = React.useRef<{ [key: string]: HTMLElement | null }>({});

  React.useEffect(() => {
    const handleScroll = (e: any) => {
      const category = e.detail;
      const element = sectionRefs.current[category];
      if (element) {
        const offset = 100; // Account for fixed navbar
        const elementPosition = element.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - offset;
        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      }
    };

    window.addEventListener('scroll-to-category', handleScroll);
    return () => window.removeEventListener('scroll-to-category', handleScroll);
  }, []);

  if (loading) return <LoadingSpinner />;

  const categories = [t.coreDevices, t.smartWearables, t.aiCompanionToys, t.partnershipZone];

  return (
    <div className="max-w-7xl mx-auto space-y-24">
      <div className="text-center space-y-6">
        <h1 className="text-6xl font-bold tracking-tighter glow-text">{t.multimodalProducts}</h1>
        <p className="text-xl text-white/60 max-w-2xl mx-auto">{t.multimodalHeroDesc || 'Hardware designed to bridge the gap between digital intelligence and physical reality.'}</p>
      </div>

      {categories.map((category) => (
        <section 
          key={category} 
          className="space-y-12"
          ref={el => { sectionRefs.current[category] = el; }}
        >
          <div className="flex items-center gap-4">
            <h2 className="text-3xl font-bold tracking-tight text-celestial-saturn">{category}</h2>
            <div className="flex-1 h-px bg-white/10" />
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {products
              ?.filter((p) => {
                // Map database categories to translated categories
                const dbCatMap: { [key: string]: string } = {
                  [CN_PRODUCT_CATEGORY_ALIASES.coreDevices]: t.coreDevices,
                  [CN_PRODUCT_CATEGORY_ALIASES.smartWearables]: t.smartWearables,
                  [CN_PRODUCT_CATEGORY_ALIASES.aiCompanionToys]: t.aiCompanionToys,
                  [CN_PRODUCT_CATEGORY_ALIASES.partnershipZone]: t.partnershipZone,
                };
                return dbCatMap[p.category] === category || p.category === category;
              })
              .map((product) => (
                <ProductCard 
                  key={product.id}
                  icon={iconMap[product.icon] || <Cpu size={40} className="text-celestial-saturn" />}
                  title={product.name}
                  price={product.price || "$299"}
                  desc={product.description}
                  specs={product.specs || [t.localProcessing || 'Local Processing', t.neuralEngine || 'Neural Engine', t.privacyFirst || 'Privacy First']}
                  t={t}
                  onClick={() => onSelectProduct(product)}
                />
              ))}
          </div>
        </section>
      ))}

      {(!products || products.length === 0) && (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          <ProductCard 
            icon={<Cpu size={40} className="text-celestial-saturn" />}
            title="Lumi Core Node"
            price="$499"
            desc="The ultimate local processing unit. 128GB Unified Memory, 20-core Neural Engine."
            specs={['Local LLM Hosting', 'Encrypted Storage', 'Multi-Agent Sync']}
            t={t}
            onClick={() => onSelectProduct({ name: "Lumi Core Node", price: "$499", description: "The ultimate local processing unit.", specs: ['Local LLM Hosting', 'Encrypted Storage', 'Multi-Agent Sync'] })}
          />
          <ProductCard 
            icon={<Watch size={40} className="text-celestial-mars" />}
            title="Neural Link Watch"
            price="$299"
            desc="Real-time Agent synchronization on your wrist. Biometric feedback loop."
            specs={['Haptic Feedback', 'Voice Interface', 'Health Monitoring']}
            t={t}
            onClick={() => onSelectProduct({ name: "Neural Link Watch", price: "$299", description: "Real-time Agent synchronization on your wrist.", specs: ['Haptic Feedback', 'Voice Interface', 'Health Monitoring'] })}
          />
          <ProductCard 
            icon={<Headphones size={40} className="text-celestial-glow" />}
            title="Aural Essence Pro"
            price="$199"
            desc="High-fidelity voice synthesis and spatial audio for immersive Agent interaction."
            specs={['Active Noise Cancellation', 'Voice Cloning Support', '40h Battery']}
            t={t}
            onClick={() => onSelectProduct({ name: "Aural Essence Pro", price: "$199", description: "High-fidelity voice synthesis and spatial audio.", specs: ['Active Noise Cancellation', 'Voice Cloning Support', '40h Battery'] })}
          />
        </div>
      )}

      <GlassCard className="p-12 rounded-[4rem] overflow-hidden relative group" hoverEffect={false}>
        <div className="absolute inset-0 bg-gradient-to-br from-celestial-saturn/10 via-transparent to-celestial-mars/10 opacity-50 group-hover:opacity-100 transition-opacity" />
        <div className="relative z-10 grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
            <div className="space-y-4">
              <h2 className="text-4xl font-bold tracking-tighter">{t.ecosystemAdvantage || 'The Ecosystem Advantage'}</h2>
              <p className="text-white/60 leading-relaxed">{t.ecosystemAdvantageDesc || 'LumiAI hardware is built with a privacy-first philosophy. Unlike traditional smart devices, all data processing happens locally on your Core Node. Your voice, your biometric data, and your Agent\'s memory never leave your physical possession.'}</p>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <FeatureItem icon={<Shield size={20} />} title={t.zeroCloud || 'Zero Cloud'} desc={t.zeroCloudDesc || 'No data upload.'} />
              <FeatureItem icon={<Zap size={20} />} title={t.instantSync || 'Instant Sync'} desc={t.instantSyncDesc || 'Low latency.'} />
            </div>
            <Button className="bg-celestial-saturn text-black rounded-full px-10 py-6 font-bold text-lg hover:scale-105 transition-transform">{t.exploreTechnology || 'Explore Technology'}</Button>
          </div>
          <div className="relative aspect-square flex items-center justify-center">
            <motion.div 
              animate={{ rotate: 360 }}
              transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
              className="absolute inset-0 rounded-full border border-white/5 border-dashed"
            />
            <div className="w-64 h-64 rounded-full bg-gradient-to-br from-white/10 to-black/40 border border-white/10 flex items-center justify-center shadow-[0_0_50px_rgba(255,204,0,0.1)]">
              <Cpu size={80} className="text-celestial-saturn animate-pulse" />
            </div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}

function ProductCard({ icon, title, price, desc, specs, t, onClick }: { icon: React.ReactNode; title: string; price: string; desc: string; specs: string[]; t: any; onClick?: () => void }) {
  return (
    <GlassCard 
      className="p-8 rounded-[3rem] flex flex-col justify-between group cursor-pointer hover:border-celestial-saturn/30 transition-all overflow-hidden relative"
      onClick={onClick}
    >
      {/* Holographic Background Effect */}
      <div className="absolute inset-0 bg-gradient-to-b from-celestial-saturn/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
      <div className="absolute -top-24 -right-24 w-48 h-48 bg-celestial-saturn/10 blur-[60px] rounded-full group-hover:scale-150 transition-transform duration-1000" />
      
      <div className="relative z-10 space-y-6">
        {/* Holographic Projection Stage */}
        <div className="relative h-32 flex items-center justify-center">
          <motion.div 
            animate={{ 
              y: [0, -10, 0],
              rotateY: [0, 10, 0]
            }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            className="relative z-10"
          >
            <IconBox icon={icon} size="lg" className="shadow-[0_0_30px_rgba(255,204,0,0.2)]" />
          </motion.div>
          
          {/* Projection Base */}
          <div className="absolute bottom-0 w-24 h-1 bg-celestial-saturn/20 blur-sm rounded-full" />
          <div className="absolute bottom-0 w-16 h-4 bg-gradient-to-t from-celestial-saturn/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          
          {/* Scanning Line */}
          <motion.div 
            animate={{ top: ['0%', '100%', '0%'] }}
            transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
            className="absolute left-0 right-0 h-px bg-celestial-saturn/20 z-20 opacity-0 group-hover:opacity-100"
          />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-end">
            <h3 className="text-2xl font-bold tracking-tight">{title}</h3>
            <span className="text-celestial-saturn font-bold">{price}</span>
          </div>
          <p className="text-sm text-white/40 leading-relaxed">{desc}</p>
        </div>
        <div className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-widest text-white/45">{t.specifications}</p>
          <ul className="space-y-2">
            {specs.map((spec, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-white/60">
                <div className="w-1 h-1 rounded-full bg-celestial-saturn" />
                {spec}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Button className="w-full mt-8 rounded-2xl bg-white/5 border border-white/10 hover:bg-celestial-saturn hover:text-black transition-all flex items-center gap-2 py-6 relative z-10">
        <ShoppingCart size={18} />
        {t.buyNow}
      </Button>
    </GlassCard>
  );
}

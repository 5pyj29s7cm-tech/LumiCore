import React, { useState } from 'react';
import { Rocket, MessageSquare, Globe, Users, User as UserIcon, BookOpen, Zap, ChevronDown, Database, ShoppingBag, Cloud, Network, Smartphone, Laptop, Handshake, Building2, Smile, Settings as SettingsIcon, Briefcase } from 'lucide-react';
import { Button } from './ui/button';
import { motion, AnimatePresence } from 'motion/react';

interface NavbarProps {
  user: any;
  onLogin: () => void;
  onLogout: () => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  lang: 'en' | 'zh';
  setLang: (lang: 'en' | 'zh') => void;
  t: any;
}

export function Navbar({ user, onLogin, onLogout, activeTab, setActiveTab, lang, setLang, t }: NavbarProps) {
  const [isProductsOpen, setIsProductsOpen] = useState(false);
  const [isEcoOpen, setIsEcoOpen] = useState(false);

  const productCategories = [
    { id: 'core', label: t.coreDevices, desc: t.coreDevicesDesc, icon: <Laptop size={16} /> },
    { id: 'wearables', label: t.smartWearables, desc: t.smartWearablesDesc, icon: <Smartphone size={16} /> },
    { id: 'companions', label: t.aiCompanionToys, desc: t.aiCompanionToysDesc, icon: <Smile size={16} /> },
    { id: 'partnership', label: t.partnershipZone, desc: t.partnershipZoneDesc, icon: <Handshake size={16} /> }
  ];

  const ecoCategories = [
    { id: 'mesh', label: t.neuralMesh, desc: t.neuralMeshDesc, icon: <Network size={16} /> },
    { id: 'cloud', label: t.memoryCloud, desc: t.memoryCloudNavDesc, icon: <Cloud size={16} /> },
    { id: 'market', label: t.marketplace, desc: t.marketplaceNavDesc, icon: <ShoppingBag size={16} /> }
  ];

  const dispatchAfterTabChange = (eventName: string, detail: string) => {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }, 120);
  };

  const Dropdown = ({ items, isOpen, onSelect, active }: { items: any[], isOpen: boolean, onSelect: (id: string, label: string) => void, active: boolean }) => (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.95 }}
          className="absolute top-full left-0 mt-4 w-72 bg-celestial-deep/95 backdrop-blur-2xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-50 p-2"
        >
          <div className="grid gap-1">
            {items.map((item, idx) => (
              <motion.button
                key={item.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                onClick={() => onSelect(item.id, item.label)}
                className="group flex items-start gap-4 p-3 rounded-2xl hover:bg-white/5 transition-all text-left"
              >
                <div className="mt-1 w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center text-white/40 group-hover:text-celestial-saturn group-hover:bg-celestial-saturn/10 transition-colors">
                  {item.icon}
                </div>
                <div className="space-y-0.5">
                  <div className="text-sm font-bold text-white/80 group-hover:text-white transition-colors">{item.label}</div>
                  <div className="text-xs text-white/55 group-hover:text-white/50 transition-colors leading-tight">{item.desc}</div>
                </div>
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <nav className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[95%] max-w-7xl px-6 py-2 glass rounded-2xl flex items-center justify-between border border-white/10 shadow-[0_20px_40px_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveTab('home')}>
        <div className="w-8 h-8 rounded-lg mars-gradient flex items-center justify-center shadow-lg">
          <Rocket className="text-white" size={16} />
        </div>
        <div className="flex flex-col -space-y-1">
          <span className="text-sm font-black tracking-tight glow-text uppercase">{t.lumiKernel || 'Lumi Kernel'}</span>
          <span className="text-xs font-bold text-white/40 tracking-widest">{t.stableVersion || 'STABLE v3.0.1'}</span>
        </div>
      </div>

        <div className="hidden lg:flex items-center gap-8">
          <NavItem active={activeTab === 'home'} onClick={() => setActiveTab('home')} icon={<Rocket size={18} />} label={t.interact} />
          
          {/* Ecosystem Dropdown */}
          <div 
            className="relative group"
            onMouseEnter={() => setIsEcoOpen(true)}
            onMouseLeave={() => setIsEcoOpen(false)}
          >
            <NavItem 
              active={activeTab === 'ecosystem'} 
              onClick={() => setActiveTab('ecosystem')} 
              icon={<Globe size={18} />} 
              label={t.ecosystem} 
              hasDropdown
            />
            <Dropdown 
              items={ecoCategories} 
              isOpen={isEcoOpen} 
              active={activeTab === 'ecosystem'}
              onSelect={(id, label) => {
                setActiveTab('ecosystem');
                dispatchAfterTabChange('scroll-to-eco', label);
                setIsEcoOpen(false);
              }}
            />
          </div>
          
          {/* Multimodal Dropdown */}
          <div 
            className="relative group"
            onMouseEnter={() => setIsProductsOpen(true)}
            onMouseLeave={() => setIsProductsOpen(false)}
          >
            <NavItem 
              active={activeTab === 'multimodal'} 
              onClick={() => setActiveTab('multimodal')} 
              icon={<Zap size={18} />} 
              label={t.multimodalProducts} 
              hasDropdown
            />
            <Dropdown 
              items={productCategories} 
              isOpen={isProductsOpen} 
              active={activeTab === 'multimodal'}
              onSelect={(id, label) => {
                setActiveTab('multimodal');
                dispatchAfterTabChange('scroll-to-category', label);
                setIsProductsOpen(false);
              }}
            />
          </div>

          <NavItem active={activeTab === 'docs'} onClick={() => setActiveTab('docs')} icon={<BookOpen size={18} />} label={t.docs} />
          <NavItem active={activeTab === 'solutions'} onClick={() => setActiveTab('solutions')} icon={<Building2 size={18} />} label={t.coreVision || "Core Vision"} />
          <NavItem active={activeTab === 'org'} onClick={() => setActiveTab('org')} icon={<Briefcase size={18} />} label={t.orgWorkbench || 'Workbench'} />
          <NavItem active={activeTab === 'join'} onClick={() => setActiveTab('join')} icon={<Users size={18} />} label={t.join} />
        </div>

      <div className="flex items-center gap-4">
        <div className="lg:hidden">
          <select 
            value={activeTab} 
            onChange={(e) => {
              const val = e.target.value;
              if (val.startsWith('multimodal:')) {
                const catLabel = val.split(':')[1];
                setActiveTab('multimodal');
                dispatchAfterTabChange('scroll-to-category', catLabel);
              } else if (val.startsWith('ecosystem:')) {
                const catLabel = val.split(':')[1];
                setActiveTab('ecosystem');
                dispatchAfterTabChange('scroll-to-eco', catLabel);
              } else {
                setActiveTab(val);
              }
            }}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-sm text-white/80 focus:outline-none"
          >
            <option value="home" className="bg-celestial-deep">{t.interact}</option>
            
            <optgroup label={t.ecosystem} className="bg-celestial-deep">
              <option value="ecosystem" className="bg-celestial-deep">{t.ecosystem}</option>
              {ecoCategories.map(cat => (
                <option key={cat.id} value={`ecosystem:${cat.label}`} className="bg-celestial-deep pl-4">
                  -- {cat.label}
                </option>
              ))}
            </optgroup>

            <optgroup label={t.multimodalProducts} className="bg-celestial-deep">
              <option value="multimodal" className="bg-celestial-deep">{t.multimodalProducts}</option>
              {productCategories.map(cat => (
                <option key={cat.id} value={`multimodal:${cat.label}`} className="bg-celestial-deep pl-4">
                  -- {cat.label}
                </option>
              ))}
            </optgroup>
            
            <option value="docs" className="bg-celestial-deep">{t.docs}</option>
            <option value="join" className="bg-celestial-deep">{t.join}</option>
            <option value="settings" className="bg-celestial-deep">{t.settings}</option>
          </select>
        </div>

        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
          className="text-white/60 hover:text-white border border-white/10 rounded-full px-3"
        >
          {lang === 'en' ? t.chinese : 'EN'}
        </Button>

        {user ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setActiveTab('settings')}
              className={`p-2 rounded-full transition-all ${activeTab === 'settings' ? 'text-celestial-saturn bg-celestial-saturn/10' : 'text-white/40 hover:text-white/60 hover:bg-white/5'}`}
              title={t.settings}
            >
              <SettingsIcon size={20} />
            </button>
            <button 
              onClick={() => setActiveTab('profile')}
              className={`w-10 h-10 rounded-full overflow-hidden border-2 transition-all ${activeTab === 'profile' ? 'border-celestial-saturn scale-110' : 'border-white/10 hover:border-white/30'}`}
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt={t.profile || "Profile"} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-full h-full bg-white/5 flex items-center justify-center text-white/40">
                  <UserIcon size={20} />
                </div>
              )}
            </button>
            <Button variant="ghost" size="sm" onClick={onLogout} className="text-white/60 hover:text-white hidden sm:block">{t.logout}</Button>
          </div>
        ) : (
          <Button onClick={onLogin} className="bg-celestial-saturn text-black hover:scale-105 transition-transform">
            {t.connect}
          </Button>
        )}
      </div>
    </nav>
  );
}

function NavItem({ active, onClick, icon, label, hasDropdown }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; hasDropdown?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 text-sm font-medium transition-colors ${active ? 'text-celestial-saturn' : 'text-white/60 hover:text-white'}`}
    >
      {icon}
      {label}
      {hasDropdown && <ChevronDown size={14} className={`transition-transform duration-300 ${active ? 'rotate-180' : ''}`} />}
    </button>
  );
}

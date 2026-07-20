import React from 'react';
import { Rocket, Github, Twitter, Mail, ExternalLink } from 'lucide-react';

interface FooterProps {
  t: any;
}

export function Footer({ t }: FooterProps) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative mt-32 border-t border-white/10 bg-black/20 backdrop-blur-xl">
      <div className="container mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
          {/* Brand Section */}
          <div className="space-y-6 col-span-1 md:col-span-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full mars-gradient flex items-center justify-center">
                <Rocket className="text-white" size={16} />
              </div>
              <span className="text-xl font-bold tracking-tighter glow-text">LumiAI</span>
            </div>
            <p className="text-sm text-white/40 leading-relaxed">
              {t.footerDesc || 'Building the future of holographic spatial computing and independent AI personalities.'}
            </p>
            <div className="flex gap-4">
              <SocialLink icon={<Twitter size={18} />} href="#" />
              <SocialLink icon={<Github size={18} />} href="#" />
              <SocialLink icon={<Mail size={18} />} href="#" />
            </div>
          </div>

          {/* Quick Links */}
          <div className="space-y-6">
            <h4 className="font-bold text-sm uppercase tracking-widest text-white/60">{t.links || 'Links'}</h4>
            <ul className="space-y-3">
              <FooterLink label={t.docs || 'Documentation'} href="#" />
              <FooterLink label={t.ecosystem || 'Ecosystem'} href="#" />
              <FooterLink label={t.marketplace || 'Marketplace'} href="#" />
            </ul>
          </div>

          {/* Resources */}
          <div className="space-y-6">
            <h4 className="font-bold text-sm uppercase tracking-widest text-white/60">{t.resources || 'Resources'}</h4>
            <ul className="space-y-3">
              <FooterLink label={t.privacy || 'Privacy Policy'} href="#" />
              <FooterLink label={t.terms || 'Terms of Service'} href="#" />
              <FooterLink label={t.security || 'Security'} href="#" />
            </ul>
          </div>

          {/* Newsletter */}
          <div className="space-y-6">
            <h4 className="font-bold text-sm uppercase tracking-widest text-white/60">{t.newsletter || 'Newsletter'}</h4>
            <p className="text-xs text-white/40">{t.newsletterDesc || 'Stay updated with the latest neural synthesis breakthroughs.'}</p>
            <div className="flex gap-2">
              <input 
                type="email" 
                placeholder={t.emailPlaceholder || 'Email address'} 
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-celestial-saturn"
              />
              <button className="p-2 bg-celestial-saturn text-black rounded-xl hover:scale-105 transition-transform">
                <ExternalLink size={18} />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-16 pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="space-y-1">
            <p className="text-xs text-white/45">
              © {currentYear} LumiAI Neural Systems. {t.allRightsReserved}
            </p>
            <p className="text-[12px] text-white/35 uppercase tracking-[0.2em] font-mono">
              {t.ethicalProtocol}
            </p>
          </div>
          <div className="flex gap-6 text-xs text-white/45">
            <span>v3.0.2-stable</span>
            <span className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {t.systemsOnline}
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ label, href }: { label: string; href: string }) {
  return (
    <li>
      <a href={href} className="text-sm text-white/40 hover:text-celestial-saturn transition-colors">
        {label}
      </a>
    </li>
  );
}

function SocialLink({ icon, href }: { icon: React.ReactNode; href: string }) {
  return (
    <a 
      href={href} 
      className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/40 hover:bg-celestial-saturn/10 hover:text-celestial-saturn transition-all"
    >
      {icon}
    </a>
  );
}

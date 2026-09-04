import React, { useMemo, useState } from 'react';
import {
  Building2,
  CheckCircle,
  FileText,
  Home,
  Layout,
  Lightbulb,
  Loader2,
  Map,
  Palette,
  PenTool,
  Ruler,
  Send,
  Sparkles,
} from 'lucide-react';
import { useT } from '../../lib/useT';
import { uiMessage } from '../../i18n/uiMessages';

type DesignView =
  | 'space'
  | 'interior'
  | 'architecture'
  | 'brand'
  | 'logo'
  | 'ux-review'
  | 'creative'
  | 'spec-check'
  | 'inspiration';

export type DesignWorkspace = 'spatial' | 'brand';

interface NavItem {
  id: DesignView;
  label: string;
  desc: string;
  icon: React.ReactNode;
}

interface ToolConfig {
  title: string;
  desc: string;
  placeholder: string;
  button: string;
  role: string;
  output: string[];
  chips: string[];
  icon: React.ReactNode;
}

const localText = (t: any, zh: string, en: string) => (t.langCode === 'en' ? en : zh);

export function DesignHub({ workspace = 'spatial' }: { workspace?: DesignWorkspace }) {
  const [view, setView] = useState<DesignView>(() => workspace === 'spatial' ? 'space' : 'brand');
  const t = useT();
  const ui = (zh: string, en: string) => localText(t, zh, en);

  React.useEffect(() => {
    setView(workspace === 'spatial' ? 'space' : 'brand');
  }, [workspace]);

  const tools = useMemo<Record<DesignView, ToolConfig>>(() => ({
    space: {
      title: uiMessage('design-hub.space-planning.45b68a19b1'),
      desc: uiMessage('design-hub.plan-area-zoning-circulation-adjacency.e9c0ef36f1'),
      placeholder: uiMessage('design-hub.enter-project-type-area-users.06d5f41332'),
      button: uiMessage('design-hub.generate-space-strategy.0941499d62'),
      role: uiMessage('design-hub.you-are-a-space-planning.ac8e88b8ac'),
      output: [uiMessage('design-hub.zoning.95986a777d'), uiMessage('design-hub.circulation.869865913c'), uiMessage('design-hub.area-schedule.f1603d728b'), uiMessage('design-hub.material-list.9d43638192')],
      chips: [uiMessage('design-hub.office.186755a5a3'), uiMessage('design-hub.retail.93abaf25a8'), uiMessage('design-hub.showroom.89a4f1ca54'), uiMessage('design-hub.hospitality.b84e7cfed1')],
      icon: <Map size={18} />,
    },
    interior: {
      title: uiMessage('design-hub.interior-design.2e2c60dfaa'),
      desc: uiMessage('design-hub.turn-layout-style-budget-materials.d4c8719cc8'),
      placeholder: uiMessage('design-hub.enter-room-home-type-area.cbeb881cec'),
      button: uiMessage('design-hub.generate-interior-scheme.bcf9efc129'),
      role: uiMessage('design-hub.you-are-a-lead-interior.fd7458ced0'),
      output: [uiMessage('design-hub.concept.05051517f3'), uiMessage('design-hub.materials-lighting.daf58644eb'), uiMessage('design-hub.ff-e.f301d6607b'), uiMessage('design-hub.construction-notes.bc32a6aa3a')],
      chips: [uiMessage('design-hub.modern.4d26372ed4'), uiMessage('design-hub.natural-wood.13001750de'), uiMessage('design-hub.soft-neutral.a95aa63937'), uiMessage('design-hub.commercial.0f281c94ac')],
      icon: <Home size={18} />,
    },
    architecture: {
      title: uiMessage('design-hub.architecture-design.e6a97526c9'),
      desc: uiMessage('design-hub.early-stage-building-design-for.78f8dba57d'),
      placeholder: uiMessage('design-hub.enter-site-location-area-building.781850b43c'),
      button: uiMessage('design-hub.generate-architecture-strategy.d90bba37fb'),
      role: uiMessage('design-hub.you-are-an-architectural-concept.24bfb85994'),
      output: [uiMessage('design-hub.site.e6021f1ab9'), uiMessage('design-hub.massing.a625c7444e'), uiMessage('design-hub.code-risks.eed8e9fb5f'), uiMessage('design-hub.cad-bim-next-steps.6c46b6a248')],
      chips: [uiMessage('design-hub.residential.e0ee88bbfd'), uiMessage('design-hub.office-building.3220ddef0c'), uiMessage('design-hub.factory.9df28452e4'), uiMessage('design-hub.community-retail.f2204cbb18')],
      icon: <Building2 size={18} />,
    },
    brand: {
      title: uiMessage('design-hub.brand-design.4883ca5345'),
      desc: uiMessage('design-hub.generate-brand-strategy-visual-direction.b49bf20970'),
      placeholder: uiMessage('design-hub.describe-brand-product-service-audience.230eddc253'),
      button: uiMessage('design-hub.generate-brand-proposal.74a8c80a61'),
      role: uiMessage('design-hub.you-are-a-brand-designer.f52e7eb5d2'),
      output: [uiMessage('design-hub.positioning.9e67873b41'), uiMessage('design-hub.identity.e74bc890c9'), uiMessage('design-hub.color-type.fdb57b9abe'), uiMessage('design-hub.applications.1ace93bd70')],
      chips: [uiMessage('design-hub.tech-brand.1c06c7857d'), uiMessage('design-hub.lifestyle.8c20b106d2'), uiMessage('design-hub.premium-service.aa20ba4c25'), uiMessage('design-hub.youthful.4ef7b46a78')],
      icon: <Palette size={18} />,
    },
    logo: {
      title: uiMessage('design-hub.logo-generation.1b4f937bab'),
      desc: uiMessage('design-hub.create-logo-concepts-style-routes.95d896434c'),
      placeholder: uiMessage('design-hub.enter-brand-name-industry-keywords.9fdf607471'),
      button: uiMessage('design-hub.generate-logo-direction.286c83c389'),
      role: uiMessage('design-hub.you-are-a-logo-designer.2c098094a6'),
      output: [uiMessage('design-hub.concepts.6914e2cf22'), uiMessage('design-hub.graphic-language.01cf673d21'), uiMessage('design-hub.colors-type.ea0304b970'), uiMessage('design-hub.prompts.7da273709b')],
      chips: [uiMessage('design-hub.minimal-geometry.32f12e84e9'), uiMessage('design-hub.handmade.89c104922b'), uiMessage('design-hub.eastern.337bd89d97'), uiMessage('design-hub.tech.c623bdf4c0')],
      icon: <PenTool size={18} />,
    },
    'ux-review': {
      title: uiMessage('design-hub.ui-ux-review.0d0368eb5c'),
      desc: uiMessage('design-hub.review-hierarchy-interaction-states-responsive.e1124d71bb'),
      placeholder: uiMessage('design-hub.describe-the-interface-or-paste.d1590c5634'),
      button: uiMessage('design-hub.start-review.94abbdec33'),
      role: uiMessage('design-hub.you-are-a-ui-ux.8f40fc2abb'),
      output: [uiMessage('design-hub.priorities.7f55e50f52'), uiMessage('design-hub.states.d8cc24b126'), uiMessage('design-hub.hierarchy.3abe8ed832'), uiMessage('design-hub.acceptance.02a3c33f82')],
      chips: [uiMessage('design-hub.mobile.8f523cf970'), uiMessage('design-hub.desktop.1b34e52031'), uiMessage('design-hub.dashboard.ecd57c41e8'), uiMessage('design-hub.accessibility.83b544c235')],
      icon: <Layout size={18} />,
    },
    creative: {
      title: uiMessage('design-hub.creative-generation.2d56c6b4f8'),
      desc: uiMessage('design-hub.generate-creative-directions-for-renders.e2d0e8e897'),
      placeholder: uiMessage('design-hub.describe-subject-style-lighting-composition.3061159c97'),
      button: uiMessage('design-hub.generate-creative-direction.af03f90325'),
      role: uiMessage('design-hub.you-are-an-ai-visual.a2ead2fc7a'),
      output: [uiMessage('design-hub.direction.c852f73091'), uiMessage('design-hub.prompts.a9d3661684'), uiMessage('design-hub.composition.c7e5d517be'), uiMessage('design-hub.iteration.f1e1fa1b02')],
      chips: [uiMessage('design-hub.product-render.f5fd8d94c4'), uiMessage('design-hub.poster.0c1c349504'), uiMessage('design-hub.social.4b28c7306a'), uiMessage('design-hub.scene.dc4a24d79e')],
      icon: <Sparkles size={18} />,
    },
    'spec-check': {
      title: uiMessage('design-hub.design-spec-check.8190abf201'),
      desc: uiMessage('design-hub.check-design-systems-component-consistency.14240972cd'),
      placeholder: uiMessage('design-hub.paste-ui-code-design-tokens.13a0ec90c5'),
      button: uiMessage('design-hub.check-spec.176c04d1db'),
      role: uiMessage('design-hub.you-are-a-design-system.a7e9591487'),
      output: [uiMessage('design-hub.tokens.73c7c83006'), uiMessage('design-hub.components.deb6f8f5ce'), uiMessage('design-hub.responsive.26acef0454'), uiMessage('design-hub.fix-list.a6969b4af6')],
      chips: ['Material Design 3', 'Human Interface', 'Ant Design', uiMessage('design-hub.custom-spec.4ca6ec8d64')],
      icon: <CheckCircle size={18} />,
    },
    inspiration: {
      title: uiMessage('design-hub.design-inspiration.8a47b5b464'),
      desc: uiMessage('design-hub.collect-trends-cases-references-and.cd05657671'),
      placeholder: uiMessage('design-hub.enter-a-trend-industry-style.8061018c65'),
      button: uiMessage('design-hub.search-inspiration.a56d83c030'),
      role: uiMessage('design-hub.you-are-a-design-researcher.f5758d2749'),
      output: [uiMessage('design-hub.trends.5acd40b13d'), uiMessage('design-hub.cases.9edada54b7'), uiMessage('design-hub.takeaways.9179c1fb45'), uiMessage('design-hub.advice.9cea9bb187')],
      chips: [uiMessage('design-hub.2026-trends.421bc0ea0e'), uiMessage('design-hub.space-cases.745104e4b3'), uiMessage('design-hub.brand-cases.74c37cfd67'), uiMessage('design-hub.ui-trends.77cf24ce53')],
      icon: <Lightbulb size={18} />,
    },
  }), [t.langCode]);

  const allNavItems: NavItem[] = [
    { id: 'space', label: tools.space.title, desc: tools.space.desc, icon: tools.space.icon },
    { id: 'interior', label: tools.interior.title, desc: tools.interior.desc, icon: tools.interior.icon },
    { id: 'architecture', label: tools.architecture.title, desc: tools.architecture.desc, icon: tools.architecture.icon },
    { id: 'brand', label: tools.brand.title, desc: tools.brand.desc, icon: tools.brand.icon },
    { id: 'logo', label: tools.logo.title, desc: tools.logo.desc, icon: tools.logo.icon },
    { id: 'ux-review', label: tools['ux-review'].title, desc: tools['ux-review'].desc, icon: tools['ux-review'].icon },
    { id: 'creative', label: tools.creative.title, desc: tools.creative.desc, icon: tools.creative.icon },
    { id: 'spec-check', label: tools['spec-check'].title, desc: tools['spec-check'].desc, icon: tools['spec-check'].icon },
    { id: 'inspiration', label: tools.inspiration.title, desc: tools.inspiration.desc, icon: tools.inspiration.icon },
  ];
  const spatialViews = new Set<DesignView>(['space', 'interior', 'architecture']);
  const navItems = allNavItems.filter(item => workspace === 'spatial' ? spatialViews.has(item.id) : !spatialViews.has(item.id));
  const workspaceTitle = workspace === 'spatial'
    ? uiMessage('design-hub.spatial-architecture.ad5a608bfc')
    : uiMessage('design-hub.brand-creative.2ae19b7f69');
  const workspaceDescription = workspace === 'spatial'
    ? uiMessage('design-hub.a-focused-workspace-for-space.8acafc6c5f')
    : uiMessage('design-hub.a-focused-workspace-for-brand.945622f065');

  return (
    <div data-organization-wallpaper-module="design" className="lumi-org-module-shell lumi-design-hub flex h-full min-h-0">
      <aside data-wallpaper-tool="organization-module-tools" className="lumi-org-module-tools lumi-design-sidebar flex w-64 shrink-0 flex-col border-r border-white/[0.08] bg-black/20">
        <div className="lumi-org-module-tool-header border-b border-white/[0.08] p-4">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85">
            <span className={`flex h-8 w-8 items-center justify-center rounded-xl border ${workspace === 'spatial' ? 'border-cyan-300/15 bg-cyan-400/10 text-cyan-200' : 'border-pink-300/15 bg-pink-400/10 text-pink-200'}`}>
              {workspace === 'spatial' ? <Building2 size={16} /> : <Palette size={16} />}
            </span>
            <span className="lumi-org-module-tool-copy min-w-0 truncate">{workspaceTitle}</span>
          </h3>
          <p className="lumi-org-module-tool-copy mt-2 text-xs leading-relaxed text-white/40">
            {workspaceDescription}
          </p>
        </div>
        <nav className="lumi-org-module-tool-nav custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              title={item.label}
              aria-label={item.label}
              className={`lumi-org-module-tool-button flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                view === item.id
                  ? workspace === 'spatial'
                    ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                    : 'border-pink-400/20 bg-pink-500/10 text-pink-100'
                  : 'border-transparent text-white/50 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
              }`}
            >
              <span className="lumi-org-module-tool-icon mt-0.5 shrink-0">{item.icon}</span>
              <span className="lumi-org-module-tool-copy min-w-0">
                <span className="block truncate text-sm font-bold">{item.label}</span>
                <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-white/35">{item.desc}</span>
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <main data-wallpaper-tool="organization-module-workspace" className="lumi-org-module-workspace lumi-design-workspace custom-scrollbar min-w-0 flex-1 overflow-y-auto bg-black/10">
        <DesignToolView config={tools[view]} workspace={workspace} />
      </main>
    </div>
  );
}

function useDesignChat() {
  const t = useT();
  const ui = (zh: string, en: string) => localText(t, zh, en);
  const [input, setInput] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);

  const send = async (prompt: string) => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setResult('');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || uiMessage('design-hub.design-request-failed.d46a4ea64c'));
      setResult(data.text || data.response || data.reply || data.message || JSON.stringify(data, null, 2));
    } catch (err: any) {
      setResult(`${uiMessage('design-hub.error.ae49a17998')}${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return { input, setInput, result, loading, send };
}

function DesignToolView({ config, workspace }: { config: ToolConfig; workspace: DesignWorkspace }) {
  const t = useT();
  const ui = (zh: string, en: string) => localText(t, zh, en);
  const { input, setInput, result, loading, send } = useDesignChat();

  const run = () => {
    const outputGuide = config.output.map(item => `- ${item}`).join('\n');
    send(`${config.role}

请按以下模块输出：
${outputGuide}

用户需求：
${input}`);
  };

  return (
    <div className="lumi-design-tool mx-auto flex max-w-5xl flex-col gap-5 p-6">
      <section className="border-b border-white/[0.08] pb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className={`mb-2 flex items-center gap-2 ${workspace === 'spatial' ? 'text-cyan-200' : 'text-pink-200'}`}>
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl border ${workspace === 'spatial' ? 'border-cyan-300/15 bg-cyan-400/10 text-cyan-200' : 'border-pink-300/15 bg-pink-400/10 text-pink-200'}`}>
                {config.icon}
              </span>
              <h2 className="text-xl font-black tracking-tight text-white">{config.title}</h2>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-white/55">{config.desc}</p>
          </div>
          <div className="hidden shrink-0 gap-2 lg:flex">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[12px] font-bold uppercase tracking-[0.12em] text-white/45">
              {uiMessage('design-hub.scheme.22e0b3b6ef')}
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[12px] font-bold uppercase tracking-[0.12em] text-white/45">
              {uiMessage('design-hub.deliverable.9556d9d045')}
            </span>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-4">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={config.placeholder}
            rows={8}
            className={`lumi-field min-h-56 w-full resize-none ${workspace === 'spatial' ? 'focus:border-cyan-500/50' : 'focus:border-pink-500/50'}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            {config.chips.map(chip => (
              <button
                key={chip}
                type="button"
                onClick={() => setInput(prev => prev ? `${prev}\n${chip}` : chip)}
                className={`rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-bold text-white/55 transition-colors ${workspace === 'spatial' ? 'hover:border-cyan-400/25 hover:bg-cyan-500/10 hover:text-cyan-100' : 'hover:border-pink-400/25 hover:bg-pink-500/10 hover:text-pink-100'}`}
              >
                {chip}
              </button>
            ))}
          </div>
          <button
            onClick={run}
            disabled={loading || !input.trim()}
            className={`lumi-button-primary px-6 py-3 disabled:cursor-not-allowed disabled:opacity-40 ${workspace === 'spatial' ? 'border-cyan-400/25 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25' : 'border-pink-400/25 bg-pink-500/15 text-pink-100 hover:bg-pink-500/25'}`}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {loading ? uiMessage('design-hub.working.9ac20f67c1') : config.button}
          </button>
        </div>

        <aside className="space-y-3">
          <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-white/45">
            <Ruler size={14} />
            {uiMessage('design-hub.output-structure.1f914a8f2b')}
          </h4>
          <div className="grid gap-2">
            {config.output.map(item => (
              <div key={item} className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.035] px-3 py-2 text-sm text-white/65">
                <FileText size={14} className={`shrink-0 ${workspace === 'spatial' ? 'text-cyan-300/70' : 'text-pink-300/70'}`} />
                <span className="min-w-0 truncate">{item}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>

      {result && (
        <section className="lumi-design-result lumi-panel custom-scrollbar max-h-[560px] overflow-y-auto p-5 text-sm leading-relaxed whitespace-pre-wrap text-white/80">
          {result}
        </section>
      )}
    </div>
  );
}

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
      title: ui('空间规划', 'Space Planning'),
      desc: ui('梳理面积、功能分区、动线、邻接关系和空间效率。', 'Plan area, zoning, circulation, adjacency, and spatial efficiency.'),
      placeholder: ui('输入项目类型、面积、使用人群、功能需求、现状限制。例如：300 平办公空间，20 人团队，需要接待、会议、开放工位和储物。', 'Enter project type, area, users, functional needs, and constraints. Example: 300 sqm office for a 20-person team with reception, meeting rooms, open desks, and storage.'),
      button: ui('生成空间策略', 'Generate Space Strategy'),
      role: ui('你是空间规划顾问，请按真实设计流程输出空间定位、功能分区、动线组织、面积分配、邻接关系、风险与下一步资料清单。', 'You are a space planning consultant. Output positioning, zoning, circulation, area allocation, adjacency, risks, and next required materials.'),
      output: [ui('功能分区', 'Zoning'), ui('动线组织', 'Circulation'), ui('面积表', 'Area Schedule'), ui('资料清单', 'Material List')],
      chips: [ui('办公空间', 'Office'), ui('商业空间', 'Retail'), ui('展厅', 'Showroom'), ui('民宿/酒店', 'Hospitality')],
      icon: <Map size={18} />,
    },
    interior: {
      title: ui('室内设计', 'Interior Design'),
      desc: ui('把户型、风格、预算、材料和灯光收束成可执行方案。', 'Turn layout, style, budget, materials, and lighting into an executable scheme.'),
      placeholder: ui('输入户型/空间、面积、家庭成员或使用场景、喜欢的风格、预算、保留家具、材料偏好。', 'Enter room/home type, area, users, preferred style, budget, existing furniture, and material preferences.'),
      button: ui('生成室内方案', 'Generate Interior Scheme'),
      role: ui('你是室内设计主案，请输出概念定位、平面优化、色彩材料、家具软装、灯光、施工注意、预算分层和可视化提示词。', 'You are a lead interior designer. Output concept, layout improvements, color/materials, furniture, lighting, construction notes, budget tiers, and visualization prompts.'),
      output: [ui('概念定位', 'Concept'), ui('材料灯光', 'Materials & Lighting'), ui('家具软装', 'FF&E'), ui('施工注意', 'Construction Notes')],
      chips: [ui('现代简约', 'Modern'), ui('原木自然', 'Natural Wood'), ui('奶油风', 'Soft Neutral'), ui('商业展示', 'Commercial')],
      icon: <Home size={18} />,
    },
    architecture: {
      title: ui('建筑设计', 'Architecture Design'),
      desc: ui('面向建筑方案、地块条件、体量、功能和规范风险的前期推演。', 'Early-stage building design for site, massing, program, and code risks.'),
      placeholder: ui('输入地块位置/面积、建筑类型、层数或容积率、功能需求、朝向、限制条件、当地规范线索。', 'Enter site location/area, building type, floors/FAR, program, orientation, constraints, and code clues.'),
      button: ui('生成建筑策略', 'Generate Architecture Strategy'),
      role: ui('你是建筑方案顾问，请输出场地分析、体量策略、功能分区、立面方向、结构/机电协同点、规范风险和后续 CAD/BIM 工作建议。', 'You are an architectural concept consultant. Output site analysis, massing strategy, program zoning, facade direction, structure/MEP coordination, code risks, and CAD/BIM next steps.'),
      output: [ui('场地分析', 'Site'), ui('体量策略', 'Massing'), ui('规范风险', 'Code Risks'), ui('CAD/BIM 下一步', 'CAD/BIM Next Steps')],
      chips: [ui('住宅', 'Residential'), ui('办公楼', 'Office Building'), ui('厂房', 'Factory'), ui('社区商业', 'Community Retail')],
      icon: <Building2 size={18} />,
    },
    brand: {
      title: ui('品牌设计', 'Brand Design'),
      desc: ui('生成品牌策略、视觉方向、色彩字体和应用场景。', 'Generate brand strategy, visual direction, colors, typography, and applications.'),
      placeholder: ui('描述品牌：产品/服务、目标受众、调性、竞品、色彩偏好。', 'Describe brand: product/service, audience, tone, competitors, and color preference.'),
      button: ui('生成品牌方案', 'Generate Brand Proposal'),
      role: ui('你是品牌设计师，请输出品牌定位、关键词、视觉识别方向、色彩字体、Logo 方向和应用场景。', 'You are a brand designer. Output positioning, keywords, identity direction, colors, typography, logo direction, and applications.'),
      output: [ui('品牌定位', 'Positioning'), ui('视觉识别', 'Identity'), ui('色彩字体', 'Color & Type'), ui('应用场景', 'Applications')],
      chips: [ui('科技品牌', 'Tech Brand'), ui('生活方式', 'Lifestyle'), ui('高端服务', 'Premium Service'), ui('年轻化', 'Youthful')],
      icon: <Palette size={18} />,
    },
    logo: {
      title: ui('Logo 生成', 'Logo Generation'),
      desc: ui('输出 Logo 概念、风格路径和可交付提示词。', 'Create logo concepts, style routes, and production prompts.'),
      placeholder: ui('输入品牌名、行业、关键词、风格偏好和禁忌。', 'Enter brand name, industry, keywords, style preference, and constraints.'),
      button: ui('生成 Logo 方向', 'Generate Logo Direction'),
      role: ui('你是 Logo 设计师，请给出 3 个不同方向，每个方向包含概念、图形语言、字体建议、颜色和图像生成提示词。', 'You are a logo designer. Provide 3 directions with concept, graphic language, typography, colors, and image-generation prompts.'),
      output: [ui('概念方向', 'Concepts'), ui('图形语言', 'Graphic Language'), ui('颜色字体', 'Colors & Type'), ui('生成提示词', 'Prompts')],
      chips: [ui('极简几何', 'Minimal Geometry'), ui('手写感', 'Handmade'), ui('东方气质', 'Eastern'), ui('科技感', 'Tech')],
      icon: <PenTool size={18} />,
    },
    'ux-review': {
      title: ui('UI/UX 审查', 'UI/UX Review'),
      desc: ui('审查界面层级、交互状态、响应式、可访问性和改版优先级。', 'Review hierarchy, interaction states, responsive behavior, accessibility, and priorities.'),
      placeholder: ui('描述界面或粘贴截图说明，标注你关心的问题。', 'Describe the interface or paste screenshot notes, and mention what you care about.'),
      button: ui('开始审查', 'Start Review'),
      role: ui('你是 UI/UX 审查专家，请按 P0-P3 输出问题、原因、修改建议和可验证标准。', 'You are a UI/UX reviewer. Output P0-P3 issues, rationale, fixes, and verification criteria.'),
      output: [ui('问题分级', 'Priorities'), ui('交互状态', 'States'), ui('视觉层级', 'Hierarchy'), ui('验收标准', 'Acceptance')],
      chips: [ui('移动端', 'Mobile'), ui('桌面端', 'Desktop'), ui('后台系统', 'Dashboard'), ui('可访问性', 'Accessibility')],
      icon: <Layout size={18} />,
    },
    creative: {
      title: ui('创意生成', 'Creative Generation'),
      desc: ui('生成产品渲染、海报、场景图和营销视觉的创意方向。', 'Generate creative directions for renders, posters, scenes, and marketing visuals.'),
      placeholder: ui('描述画面主体、风格、光线、构图、颜色、用途。', 'Describe subject, style, lighting, composition, color, and use case.'),
      button: ui('生成创意方案', 'Generate Creative Direction'),
      role: ui('你是 AI 视觉创意总监，请输出创意方向、英文图像提示词、构图建议和迭代策略。', 'You are an AI visual creative director. Output direction, English image prompts, composition advice, and iteration strategy.'),
      output: [ui('创意方向', 'Direction'), ui('图像提示词', 'Prompts'), ui('构图建议', 'Composition'), ui('迭代策略', 'Iteration')],
      chips: [ui('产品渲染', 'Product Render'), ui('海报', 'Poster'), ui('社媒图', 'Social'), ui('场景图', 'Scene')],
      icon: <Sparkles size={18} />,
    },
    'spec-check': {
      title: ui('设计规范检查', 'Design Spec Check'),
      desc: ui('检查设计系统、组件一致性、Token、响应式和暗色模式。', 'Check design systems, component consistency, tokens, responsive behavior, and dark mode.'),
      placeholder: ui('粘贴界面代码、设计 Token 或规范描述。', 'Paste UI code, design tokens, or spec notes.'),
      button: ui('检查规范', 'Check Spec'),
      role: ui('你是设计系统专家，请检查 Token、组件一致性、命名、暗色模式、响应式和跨平台一致性，并输出修复清单。', 'You are a design-system expert. Check tokens, consistency, naming, dark mode, responsive behavior, and cross-platform consistency.'),
      output: [ui('Token', 'Tokens'), ui('组件一致性', 'Components'), ui('响应式', 'Responsive'), ui('修复清单', 'Fix List')],
      chips: ['Material Design 3', 'Human Interface', 'Ant Design', ui('自定义规范', 'Custom Spec')],
      icon: <CheckCircle size={18} />,
    },
    inspiration: {
      title: ui('设计灵感', 'Design Inspiration'),
      desc: ui('整理趋势、案例、风格参考和可应用建议。', 'Collect trends, cases, references, and actionable advice.'),
      placeholder: ui('输入趋势、行业、风格或案例方向。', 'Enter a trend, industry, style, or case direction.'),
      button: ui('搜索灵感', 'Search Inspiration'),
      role: ui('你是设计研究员，请输出趋势摘要、案例参考、可借鉴点、风险和落地建议。', 'You are a design researcher. Output trends, case references, takeaways, risks, and practical advice.'),
      output: [ui('趋势', 'Trends'), ui('案例', 'Cases'), ui('可借鉴点', 'Takeaways'), ui('落地建议', 'Advice')],
      chips: [ui('2026 趋势', '2026 Trends'), ui('空间案例', 'Space Cases'), ui('品牌案例', 'Brand Cases'), ui('界面趋势', 'UI Trends')],
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
    ? ui('空间建筑设计', 'Spatial & Architecture')
    : ui('品牌创意设计', 'Brand & Creative');
  const workspaceDescription = workspace === 'spatial'
    ? ui('面向空间规划、室内方案与建筑前期设计的专业工作区。', 'A focused workspace for space planning, interior schemes, and architectural concept design.')
    : ui('面向品牌识别、Logo、数字体验与营销视觉的创意工作区。', 'A focused workspace for brand identity, logos, digital experience, and campaign visuals.');

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/[0.08] bg-black/20">
        <div className="border-b border-white/[0.08] p-4">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-white/85">
            <span className={`flex h-8 w-8 items-center justify-center rounded-xl border ${workspace === 'spatial' ? 'border-cyan-300/15 bg-cyan-400/10 text-cyan-200' : 'border-pink-300/15 bg-pink-400/10 text-pink-200'}`}>
              {workspace === 'spatial' ? <Building2 size={16} /> : <Palette size={16} />}
            </span>
            <span className="min-w-0 truncate">{workspaceTitle}</span>
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-white/40">
            {workspaceDescription}
          </p>
        </div>
        <nav className="custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                view === item.id
                  ? workspace === 'spatial'
                    ? 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100'
                    : 'border-pink-400/20 bg-pink-500/10 text-pink-100'
                  : 'border-transparent text-white/50 hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-white/80'
              }`}
            >
              <span className="mt-0.5 shrink-0">{item.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">{item.label}</span>
                <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-white/35">{item.desc}</span>
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="custom-scrollbar min-w-0 flex-1 overflow-y-auto bg-black/10">
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
      if (!res.ok) throw new Error(data.error || ui('设计请求失败', 'Design request failed'));
      setResult(data.text || data.response || data.reply || data.message || JSON.stringify(data, null, 2));
    } catch (err: any) {
      setResult(`${ui('错误：', 'Error: ')}${err.message || err}`);
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
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
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
              {ui('方案', 'Scheme')}
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[12px] font-bold uppercase tracking-[0.12em] text-white/45">
              {ui('交付', 'Deliverable')}
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
            {loading ? ui('处理中...', 'Working...') : config.button}
          </button>
        </div>

        <aside className="space-y-3">
          <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-white/45">
            <Ruler size={14} />
            {ui('输出结构', 'Output Structure')}
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
        <section className="lumi-panel custom-scrollbar max-h-[560px] overflow-y-auto p-5 text-sm leading-relaxed whitespace-pre-wrap text-white/80">
          {result}
        </section>
      )}
    </div>
  );
}

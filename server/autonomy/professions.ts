import { readDB, writeDB } from "../../db_layer";

export interface ProfessionProfile {
  profession: string;
  confidence: number; // 0–1
  evidence: string[]; // which installed apps suggest this
  knowledgeDomains: string[];
  personaHints: string[];
  installedRelevantTools: string[];
}

const PROFESSION_SIGNATURES: Record<string, { apps: string[]; domains: string[]; persona: string[] }> = {
  designer: {
    apps: ['Photoshop', 'Illustrator', 'Figma', 'Sketch', 'Adobe XD', 'Adobe', 'Canva', 'CorelDRAW', 'InDesign',
      'After Effects', 'Premiere Pro', 'Blender', 'Cinema 4D', 'Maya', 'ZBrush', 'Procreate', 'Affinity',
      'SketchUp', 'AutoCAD', 'Revit', 'Rhino', '3ds Max', 'DaVinci Resolve', 'Final Cut', 'Lightroom',
      'Affinity Designer', 'Affinity Photo', 'Affinity Publisher', 'GIMP', 'Inkscape', 'Krita',
      'Capture One', 'Pixelmator', 'Zeplin', 'InVision', 'Framer', 'Principle', 'ProtoPie',
      'Axure', 'Balsamiq', 'Marvel', 'Abstract', 'Notion', 'Miro', 'Dribbble'],
    domains: ['UI/UX设计', '平面设计', '品牌设计', '工业设计', '3D建模', '视频剪辑', '设计系统', '色彩理论', '排版', '用户体验'],
    persona: ['视觉思维', '注重细节', '审美敏锐', '创造性解决问题'],
  },
  doctor: {
    apps: ['Epic', 'Cerner', 'Medscape', 'UpToDate', 'PubMed', 'SPSS', 'GraphPad', 'Prism', 'MATLAB',
      '3D Slicer', 'OsiriX', 'RStudio', 'ImageJ', 'EndNote', 'Mendeley', 'Zotero', 'GraphPad Prism',
      'SAS', 'Stata', 'RevMan', 'REDCap', 'OpenClinica', 'LabVIEW', 'PyMOL', 'Chimera', 'VMD',
      'DICOM', 'PACS', 'emr', 'ehr', 'MedCalc', 'BioRender', 'SnapGene', 'Geneious', 'CLC',
      '医脉通', '用药助手', '丁香园', '临床指南', 'UpToDate'],
    domains: ['临床医学', '诊断学', '药理学', '循证医学', '医学影像', '病理学', '流行病学', '生物统计', '医学伦理', '病历书写'],
    persona: ['严谨', '逻辑缜密', '循证思维', '共情能力'],
  },
  lawyer: {
    apps: ['Westlaw', 'LexisNexis', 'Practical Law', 'Clio', 'MyCase', 'iManage', 'NetDocuments',
      'Relativity', 'Everlaw', 'CaseMap', 'TrialDirector', 'TimeMap', 'Concordance', 'Summation',
      'PDF Expert', 'Adobe Acrobat', 'DocuSign', 'HelloSign', 'CaseText', 'Fastcase',
      '北大法宝', '威科先行', '中国裁判文书网', '无讼', '法天使', '天眼查', '企查查',
      '法律家', '聚法案例', '理脉', '律商', '华律', '中国法律', '法律之星', '北大法意'],
    domains: ['民法', '刑法', '商法', '合同法', '知识产权法', '劳动法', '行政法', '诉讼法', '法律检索', '法律写作'],
    persona: ['逻辑严密', '语言精准', '风险意识', '辩证思维'],
  },
  engineer: {
    apps: ['Visual Studio', 'VS Code', 'IntelliJ IDEA', 'WebStorm', 'PyCharm', 'GoLand', 'CLion',
      'Eclipse', 'NetBeans', 'Android Studio', 'Xcode', 'Docker', 'Kubernetes', 'Git', 'GitHub Desktop',
      'Postman', 'Insomnia', 'Wireshark', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'RabbitMQ',
      'Node.js', 'Python', 'Rust', 'Go', 'Java', 'AWS CLI', 'Azure CLI', 'gcloud', 'Terraform',
      'Ansible', 'Jenkins', 'GitLab', 'Bitbucket', 'Jira', 'Confluence', 'Slack', 'Tmux', 'Vim',
      'Neovim', 'Sublime Text', 'Fleet', 'Cursor', 'Windsurf', 'Zed', 'Alacritty', 'Windows Terminal',
      'PowerShell', 'WSL', 'Cmder', 'Termius', 'MobaXterm', 'PuTTY', 'WinSCP', 'FileZilla',
      'Unity', 'Unreal Engine', 'Godot', 'OpenCV', 'TensorFlow', 'PyTorch', 'Jupyter',
      'CMake', 'Make', 'Ninja', 'Bazel', 'Gradle', 'Maven', 'npm', 'yarn', 'pnpm', 'pip',
      'Homebrew', 'Chocolatey', 'Scoop', 'winget', 'Nginx', 'Apache', 'Traefik', 'Caddy'],
    domains: ['软件工程', '系统设计', '数据结构', '算法', '网络协议', '数据库', '云计算', 'DevOps', '安全', '代码审查'],
    persona: ['系统思维', '抽象能力', '解决问题', '持续学习'],
  },
  teacher: {
    apps: ['PowerPoint', 'Word', 'Excel', 'OneNote', 'Zoom', 'Teams', 'Google Classroom', 'Moodle',
      'Canvas', 'Blackboard', 'Kahoot', 'Quizlet', 'Turnitin', 'Camtasia', 'OBS Studio', 'Screencast',
      'ClassIn', '雨课堂', '超星', '钉钉', '腾讯课堂', '学堂在线', '智慧树', '学而思',
      'Anki', 'Notion', 'Mendeley', 'EndNote', 'SPSS', 'NVivo', 'MAXQDA', 'Atlas.ti',
      'GeoGebra', 'MATLAB', 'Maple', 'Mathematica', 'Desmos', 'Wolfram Alpha'],
    domains: ['教育学', '课程设计', '教学评估', '认知心理学', '教育技术', '课堂管理', '学科知识', '学术写作'],
    persona: ['耐心', '善于表达', '结构化思维', '激发思考'],
  },
};

export function detectProfession(installedApps: string[]): ProfessionProfile[] {
  const results: ProfessionProfile[] = [];

  const matchesSignature = (app: string, signature: string): boolean => {
    const normalizedApp = app.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim();
    const normalizedSignature = signature.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim();
    if (!normalizedSignature) return false;
    if (normalizedSignature.length <= 3 && /^[a-z0-9]+$/.test(normalizedSignature)) {
      return normalizedApp.split(/\s+/).includes(normalizedSignature);
    }
    return normalizedApp === normalizedSignature || normalizedApp.includes(normalizedSignature);
  };

  for (const [profession, sig] of Object.entries(PROFESSION_SIGNATURES)) {
    const matched = [...new Set(installedApps.filter(app => sig.apps.some(sigApp => matchesSignature(app, sigApp))))];
    if (matched.length === 0) continue;

    const confidence = Math.min(1, matched.length / Math.max(3, Math.sqrt(sig.apps.length)));
    results.push({
      profession,
      confidence,
      evidence: matched.slice(0, 10),
      knowledgeDomains: sig.domains,
      personaHints: sig.persona,
      installedRelevantTools: matched.slice(0, 15),
    });
  }

  // Sort by confidence desc
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}

export function saveProfessionProfile(profiles: ProfessionProfile[]): void {
  const db = readDB();
  (db as any).professionProfiles = profiles;
  writeDB(db);
}

export function getProfessionProfile(): ProfessionProfile[] {
  const db = readDB();
  return (db as any).professionProfiles || [];
}

/** Generate a knowledge-domain-aware system prompt augmentation */
export function buildProfessionOverlay(): string | null {
  const profiles = getProfessionProfile();
  if (profiles.length === 0) return null;

  const top = profiles[0];
  if (top.confidence < 0.3) return null;

  const lines: string[] = [];
  lines.push('\n## User Profession Context');
  lines.push(`The user appears to be a **${top.profession}** (confidence: ${Math.round(top.confidence * 100)}%).`);
  lines.push(`Evidence: ${top.evidence.slice(0, 5).join(', ')}`);
  if (top.knowledgeDomains.length > 0) {
    lines.push(`Relevant knowledge domains: ${top.knowledgeDomains.slice(0, 8).join(', ')}`);
  }
  lines.push('Adapt your vocabulary, examples, and assistance to this professional context.');

  return lines.join('\n');
}

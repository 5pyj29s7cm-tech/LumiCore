export type ArchitectureLayer =
  | 'experience'
  | 'desktop-shell'
  | 'runtime'
  | 'transport'
  | 'data'
  | 'capability'
  | 'cognition'
  | 'voice'
  | 'native-automation';

export interface TechnicalArchitectureComponent {
  id: string;
  layer: ArchitectureLayer;
  label: string;
  technologies: string[];
  responsibility: string;
  sourcePaths: string[];
  platforms: Array<'shared' | 'windows' | 'macos'>;
}

export interface LumiTechnicalArchitecture {
  schemaVersion: number;
  product: string;
  topology: 'local-first-desktop-agent';
  invariants: string[];
  components: TechnicalArchitectureComponent[];
}

/**
 * The authoritative product architecture shared by diagnostics, self-awareness,
 * documentation checks, and client health reporting. Runtime state and
 * capabilities live in their own manifests; this describes how those systems
 * fit together.
 */
export const LUMI_TECHNICAL_ARCHITECTURE: LumiTechnicalArchitecture = {
  schemaVersion: 1,
  product: 'LumiCore',
  topology: 'local-first-desktop-agent',
  invariants: [
    'CapabilityManifest is the single runtime source for tool identity, routing, permission, risk, evidence, verification, fallback, and provenance.',
    'Windows and macOS expose the same capability IDs and behavior contracts; only native adapters differ.',
    'client_surfaces is the single registry for Lumi client surfaces and client actions.',
    'Task completion is derived from TaskLedger execution evidence and verification, never from model prose alone.',
    'User memory, runtime configuration, generated drafts, logs, and migration backups live in the dedicated user-data directory, not the source tree.',
  ],
  components: [
    {
      id: 'experience.react',
      layer: 'experience',
      label: 'Client experience',
      technologies: ['React 19', 'TypeScript', 'Vite', 'Tailwind CSS'],
      responsibility: 'Renders desktop, web, mobile, voice, task, organization, and settings surfaces from canonical registries and live state.',
      sourcePaths: ['src/', 'shared/client_surfaces.ts'],
      platforms: ['shared'],
    },
    {
      id: 'desktop.tauri',
      layer: 'desktop-shell',
      label: 'Native desktop shell',
      technologies: ['Tauri 2', 'Rust'],
      responsibility: 'Owns native windows, lifecycle, permissions, platform commands, packaging, and the local runtime boundary.',
      sourcePaths: ['src-tauri/'],
      platforms: ['windows', 'macos'],
    },
    {
      id: 'runtime.node',
      layer: 'runtime',
      label: 'Local LumiCore runtime',
      technologies: ['Node.js', 'TypeScript', 'Express'],
      responsibility: 'Hosts cognition, tools, skills, memory, task execution, adapters, model routing, and local APIs.',
      sourcePaths: ['server.ts', 'server/'],
      platforms: ['shared'],
    },
    {
      id: 'transport.realtime',
      layer: 'transport',
      label: 'Realtime transport',
      technologies: ['Socket.IO', 'WebSocket', 'HTTP'],
      responsibility: 'Carries chat, voice, task progress, desktop relay, client state, and interruption events.',
      sourcePaths: ['server/socket/', 'server/routes/'],
      platforms: ['shared'],
    },
    {
      id: 'data.sqlite',
      layer: 'data',
      label: 'Private local data',
      technologies: ['SQLite', 'Filesystem user-data directory'],
      responsibility: 'Stores memory, tasks, workflows, knowledge metadata, preferences, runtime configuration, and audited migration state.',
      sourcePaths: ['server/db/', 'server/memory/', 'server/config/'],
      platforms: ['shared'],
    },
    {
      id: 'capability.manifest',
      layer: 'capability',
      label: 'Capability system',
      technologies: ['CapabilityManifest', 'MCP', 'maintained Skills', 'built-in tools'],
      responsibility: 'Defines what Lumi can do and supplies the same metadata to discovery, routing, policy, execution, verification, and diagnostics.',
      sourcePaths: ['server/tools/', 'server/mcp/', 'server/skills/'],
      platforms: ['shared'],
    },
    {
      id: 'cognition.execution',
      layer: 'cognition',
      label: 'Cognition and execution',
      technologies: ['model-role router', 'CapabilityPlan', 'TaskLedger', 'verification finalizer'],
      responsibility: 'Turns user intent into a bounded plan, executes real capabilities, resumes confirmations, verifies outcomes, and reports ledger facts.',
      sourcePaths: ['server/cognition/', 'server/agents/', 'server/llm/'],
      platforms: ['shared'],
    },
    {
      id: 'voice.realtime',
      layer: 'voice',
      label: 'Realtime voice',
      technologies: ['streaming STT', 'TTS', 'voiceprint', 'barge-in'],
      responsibility: 'Supports voice-first conversation, interruption, speaker verification, meeting capture, and task continuation.',
      sourcePaths: ['server/socket/voice.ts', 'src/hooks/useVoiceCall.ts', 'src/hooks/useVoiceprint.ts'],
      platforms: ['shared'],
    },
    {
      id: 'native.automation',
      layer: 'native-automation',
      label: 'Native desktop automation',
      technologies: ['Windows UI Automation', 'macOS Accessibility', 'screen capture', 'native input'],
      responsibility: 'Implements one shared desktop automation contract through platform-specific adapters and permission checks.',
      sourcePaths: ['server/external_control/', 'server/adapters/'],
      platforms: ['windows', 'macos'],
    },
  ],
};

export function getLumiTechnicalArchitecture(): LumiTechnicalArchitecture {
  return LUMI_TECHNICAL_ARCHITECTURE;
}

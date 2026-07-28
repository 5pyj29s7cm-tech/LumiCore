import { getExternalControlCandidate, listExternalControlCandidates } from '../../external_control/candidates';
import { captureNativeUiSnapshot, runNativeUiAction } from '../../external_control/native_ui';
import {
  createVisibleWpsDocumentWithText,
  WPS_CREATE_DOCUMENT_TOOL,
} from '../../external_control/wps_automation';
import { mcpManager, recoverServerTools } from '../../mcp';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

const UI_TARGET_PROPERTIES = {
  root: { type: 'string', enum: ['active', 'focused', 'desktop'], description: 'Search root. Defaults active foreground window.' },
  name: { type: 'string', description: 'Exact accessible name to match, case-insensitive.' },
  nameContains: { type: 'string', description: 'Substring of accessible name to match, case-insensitive.' },
  automationId: { type: 'string', description: 'Exact AutomationId to match.' },
  controlType: { type: 'string', description: 'Control type to match, e.g. Button, Edit, Document, MenuItem, Window.' },
  className: { type: 'string', description: 'Exact UI class name to match.' },
  processId: { type: 'number', description: 'Process id from a fresh desktop_ui_snapshot. Either this or nativeWindowHandle is required for every action.' },
  nativeWindowHandle: { type: 'number', description: 'Native window handle from a fresh desktop_ui_snapshot. Either this or processId is required for every action.' },
  index: { type: 'number', description: 'Zero-based index when multiple controls match. Defaults 0.' },
  maxDepth: { type: 'number', description: 'Maximum UI tree depth to search, default 5, max 8.' },
  maxNodes: { type: 'number', description: 'Maximum controls to inspect, default 160, max 500.' },
  includeOffscreen: { type: 'boolean', description: 'Include offscreen controls. Defaults false.' },
  timeoutMs: { type: 'number', description: 'Timeout in milliseconds, default 8000, max 20000.' },
  verify: { type: 'boolean', description: 'Return selected control state after action. Defaults true.' },
  delayAfterMs: { type: 'number', description: 'Delay before verification, default 250ms.' },
};

export function registerExternalControlTools(registry: ToolRegistry): void {
  registry.register({
    name: WPS_CREATE_DOCUMENT_TOOL,
    description: 'Create exactly one real blank WPS Writer document in a visible WPS instance and optionally type requested text through the registered KWPS COM automation interface. Use for a recovered current-WPS create request. The receipt verifies attachedExisting versus newVisibleInstance, Visible=true, a real wps.exe PID/window/document, and exact body-text readback including an empty blank document. This tool does not save the document.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Optional exact text to write. Omit or pass an empty string for a real blank document.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify(
      await createVisibleWpsDocumentWithText(String(args.text || '')),
      null,
      2,
    ),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'office.wps.document.create-visible',
      family: 'wps',
      lane: 'office',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'desktop_control', scope: 'visible WPS Writer document', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'automation', 'processId', 'documentCreated', 'exactTextMatch'],
        requiredValues: {
          ok: true,
          status: 'verified',
          automation: 'KWPS.Application',
          visible: true,
          documentCreated: true,
          exactTextMatch: true,
        },
        successStatuses: ['verified'],
        successSignals: ['visible WPS document exists and exact body text readback matches'],
        limitations: ['The document remains unsaved.'],
      },
    },
    evidence: {
      capability: 'office.wps.document.create-visible',
      operation: 'create',
      assurance: 'verified',
      subjectArgument: 'text',
      limitations: ['Creates and verifies an unsaved visible WPS document.'],
    },
  });

  registry.register({
    name: 'external_control_candidates',
    description: 'List curated general-purpose external-control upgrades for Lumi, such as Playwright MCP for browser DOM control and the platform-native semantic accessibility adapter for desktop apps.',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Optional layer filter: browser, desktop_ui, desktop_vision, or safety.' },
        industry: { type: 'string', description: 'Optional industry hint, e.g. ecommerce, short_video, account_management, legal, design_delivery, or general_work.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify({
      candidates: listExternalControlCandidates({
        layer: args.layer,
        industry: args.industry,
      }),
      note: 'Prefer browser DOM/Playwright for web platforms, the Windows UIA or macOS Accessibility adapter for native apps, and vision computer_use only as a fallback.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'external_control_configure_candidate',
    description: 'Configure a curated external-control candidate in Lumi. Currently used for MCP-backed candidates such as Playwright MCP; writes MCP config and can optionally enable/restart the server.',
    parameters: {
      type: 'object',
      properties: {
        candidateId: { type: 'string', description: 'Candidate id, e.g. playwright-mcp.' },
        serverName: { type: 'string', description: 'Optional MCP server name override. Defaults to the candidate serverName.' },
        enabled: { type: 'boolean', description: 'Whether to enable the MCP server immediately. Defaults false.' },
        restart: { type: 'boolean', description: 'Whether to restart/connect the server after writing config. Defaults false.' },
      },
      required: ['candidateId'],
    },
    handler: async (args, context?: ToolContext) => {
      if (context?.domain === 'work' || context?.orgId) {
        throw new Error('An organization workspace cannot change this computer\'s MCP configuration. Configure host capabilities from the member\'s local personal workspace or desktop settings.');
      }
      const candidate = getExternalControlCandidate(String(args.candidateId || ''));
      if (!candidate) throw new Error(`Unknown external control candidate: ${args.candidateId}`);
      if (!candidate.mcp) {
        return JSON.stringify({
          ok: true,
          status: 'not_applicable',
          configured: false,
          persisted: false,
          candidate,
          note: 'This candidate is native or policy-only and does not require MCP configuration.',
        }, null, 2);
      }

      const serverName = String(args.serverName || candidate.mcp.serverName).trim();
      if (!serverName) throw new Error('serverName is required.');
      const config = mcpManager.getConfig();
      const nextServer = {
        ...candidate.mcp.config,
        enabled: args.enabled === true,
      };
      config[serverName] = nextServer;
      mcpManager.saveConfig(config);
      const persistedConfig = mcpManager.getConfig()[serverName];
      if (!persistedConfig || JSON.stringify(persistedConfig) !== JSON.stringify(nextServer)) {
        throw new Error(`External control candidate configuration was not persisted for ${serverName}.`);
      }

      let restarted = false;
      let tools: unknown[] = [];
      if (args.restart === true && nextServer.enabled) {
        tools = await mcpManager.restartServer(serverName);
        await recoverServerTools(serverName, tools as any);
        restarted = true;
        if (!Array.isArray(tools) || tools.length === 0) {
          throw new Error(`External control candidate ${serverName} restarted without exposing any tools.`);
        }
      } else if (args.restart === true && !nextServer.enabled) {
        await mcpManager.disconnectServer(serverName);
      }

      const status = nextServer.enabled
        ? restarted ? 'connected' : 'restart_required'
        : args.restart === true ? 'disconnected' : 'configured_disabled';
      return JSON.stringify({
        ok: true,
        status,
        configured: true,
        persisted: true,
        candidate,
        serverName,
        enabled: nextServer.enabled,
        restarted,
        toolCount: Array.isArray(tools) ? tools.length : 0,
        config: nextServer,
        note: nextServer.enabled
          ? 'Candidate is enabled. If restart=false, restart the MCP server or Lumi runtime before using its tools.'
          : 'Candidate is configured but disabled. Enable it after reviewing safety and setup.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'external-control.candidate.configure',
      family: 'external-control',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'host MCP server configuration', reversible: true },
        { type: 'process_execution', scope: 'optional MCP server restart or disconnect', reversible: true },
        { type: 'installation', scope: 'candidate package resolved by configured MCP command', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'configured', 'persisted', 'candidate.id'],
        requiredValues: { ok: true },
        successStatuses: ['not_applicable', 'connected', 'restart_required', 'disconnected', 'configured_disabled'],
        failureStatuses: ['failed', 'unverified'],
        successSignals: ['MCP configuration reread matches the requested candidate configuration', 'enabled restart exposes at least one tool'],
        limitations: ['Native and policy-only candidates require no MCP write and return not_applicable.', 'A restart_required receipt means configuration is durable but the tools are not yet available.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'external-control.candidate.configure',
      operation: 'mutate',
      subjectArgument: 'candidateId',
      limitations: ['Configuration alone does not prove a target website or desktop application can be controlled.'],
    }),
  });

  registry.register({
    name: 'desktop_ui_snapshot',
    description: 'Capture a read-only platform-native semantic accessibility tree for the active/focused/desktop window, including control names, types, identifiers, enabled/focused state, and bounding boxes. Windows uses UI Automation and macOS uses Accessibility. Use this before clicking native apps so Lumi can reason about real controls instead of only screen pixels.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', enum: ['active', 'focused', 'desktop'], description: 'Snapshot root. Defaults active foreground window.' },
        name: { type: 'string', description: 'Optional exact accessible root-window name when root=desktop.' },
        nameContains: { type: 'string', description: 'Optional partial accessible root-window name when root=desktop.' },
        automationId: { type: 'string', description: 'Optional root-window AutomationId selector.' },
        controlType: { type: 'string', description: 'Optional root control type selector, such as Window.' },
        className: { type: 'string', description: 'Optional root-window class selector.' },
        processId: { type: 'number', description: 'Optional root process id selector.' },
        nativeWindowHandle: { type: 'number', description: 'Optional native window handle selector.' },
        allMatches: { type: 'boolean', description: 'Return up to six matching native-window trees instead of only the first.' },
        maxDepth: { type: 'number', description: 'Maximum UI tree depth, default 3, max 6.' },
        maxNodes: { type: 'number', description: 'Maximum controls to return, default 80, max 300.' },
        includeOffscreen: { type: 'boolean', description: 'Include offscreen controls. Defaults false.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds, default 5000, max 15000.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify(await captureNativeUiSnapshot({
      root: args.root,
      name: args.name,
      nameContains: args.nameContains,
      automationId: args.automationId,
      controlType: args.controlType,
      className: args.className,
      processId: args.processId,
      nativeWindowHandle: args.nativeWindowHandle,
      allMatches: args.allMatches === true,
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      includeOffscreen: args.includeOffscreen === true,
      timeoutMs: args.timeoutMs,
    }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.native_ui.snapshot',
      family: 'desktop-native-ui',
      lane: 'desktop',
      source: 'adapter',
      provider: 'desktop.native',
      operation: 'observe',
      domains: ['desktop'],
      intents: ['inspect native controls', 'read application accessibility tree'],
      modes: ['assistant', 'autonomous'],
      risk: 'low',
      adapter: {
        id: 'desktop.native',
        operations: ['snapshot'],
        implementations: {
          windows: 'windows-uia',
          macos: 'macos-accessibility',
        },
      },
    },
    evidence: {
      capability: 'desktop.native_ui.snapshot',
      operation: 'observe',
      assurance: 'observed',
      limitations: ['Only controls exposed by the target application accessibility framework are visible.'],
    },
  });

  registry.register({
    name: 'desktop_ui_focus',
    description: 'Focus a platform-native accessible control selected by name, identifier, control type, class/role, and a process id or handle from a fresh desktop_ui_snapshot. Windows uses UI Automation and macOS uses Accessibility. The action fails closed without a stable target binding.',
    parameters: {
      type: 'object',
      properties: UI_TARGET_PROPERTIES,
      required: [],
    },
    handler: async (args) => JSON.stringify(await runNativeUiAction({ ...args, action: 'focus' }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.native_ui.focus',
      family: 'desktop-native-ui',
      lane: 'desktop',
      source: 'adapter',
      provider: 'desktop.native',
      operation: 'mutate',
      modes: ['assistant', 'autonomous'],
      risk: 'low',
      sideEffects: [{ type: 'desktop_control', scope: 'focus', reversible: true }],
      adapter: {
        id: 'desktop.native',
        operations: ['focus'],
        implementations: { windows: 'windows-uia', macos: 'macos-accessibility' },
      },
    },
    evidence: {
      capability: 'desktop.native_ui.focus',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['Focus verification does not prove a later application action succeeded.'],
    },
  });

  registry.register({
    name: 'desktop_ui_click',
    description: 'Activate a platform-native accessible control selected by semantic properties and a process id or handle from a fresh desktop_ui_snapshot. Prefer this over raw coordinates for office, messaging, CAD/BIM dialogs, installers, and normal desktop apps. The action fails closed if the target binding is missing or changed.',
    parameters: {
      type: 'object',
      properties: UI_TARGET_PROPERTIES,
      required: [],
    },
    handler: async (args) => JSON.stringify(await runNativeUiAction({ ...args, action: 'click' }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.native_ui.click',
      family: 'desktop-native-ui',
      lane: 'desktop',
      source: 'adapter',
      provider: 'desktop.native',
      operation: 'mutate',
      modes: ['assistant', 'autonomous'],
      risk: 'medium',
      sideEffects: [{ type: 'desktop_control', scope: 'selected accessible control', reversible: true }],
      adapter: {
        id: 'desktop.native',
        operations: ['click'],
        implementations: { windows: 'windows-uia', macos: 'macos-accessibility' },
      },
    },
    evidence: {
      capability: 'desktop.native_ui.click',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['The accessibility action must be followed by target-state verification.'],
    },
  });

  registry.register({
    name: 'desktop_ui_invoke',
    description: 'Invoke a platform-native accessible button or menu item through UIA Invoke/Press on Windows or AXPress on macOS, bound to a process id or handle from a fresh desktop_ui_snapshot.',
    parameters: {
      type: 'object',
      properties: {
        ...UI_TARGET_PROPERTIES,
        fallbackClick: { type: 'boolean', description: 'Use a mouse click if InvokePattern is unavailable. Defaults true.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify(await runNativeUiAction({ ...args, action: 'invoke' }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.native_ui.invoke',
      family: 'desktop-native-ui',
      lane: 'desktop',
      source: 'adapter',
      provider: 'desktop.native',
      operation: 'mutate',
      modes: ['assistant', 'autonomous'],
      risk: 'medium',
      sideEffects: [{ type: 'desktop_control', scope: 'selected accessible action', reversible: true }],
      adapter: {
        id: 'desktop.native',
        operations: ['invoke'],
        implementations: { windows: 'windows-uia', macos: 'macos-accessibility' },
      },
    },
    evidence: {
      capability: 'desktop.native_ui.invoke',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['The accessibility action must be followed by target-state verification.'],
    },
  });

  registry.register({
    name: 'desktop_ui_type',
    description: 'Type or set text in a platform-native accessible text control. Uses UIA ValuePattern on Windows or AXValue on macOS, with focused keyboard input only as an adapter fallback. Use desktop_ui_snapshot first; high-consequence external submits still require confirmation.',
    parameters: {
      type: 'object',
      properties: {
        ...UI_TARGET_PROPERTIES,
        text: { type: 'string', description: 'Text to type or set.' },
        append: { type: 'boolean', description: 'Append to existing ValuePattern text instead of replacing. Defaults false.' },
      },
      required: ['text'],
    },
    handler: async (args) => JSON.stringify(await runNativeUiAction({ ...args, action: 'type', text: String(args.text || '') }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.native_ui.type',
      family: 'desktop-native-ui',
      lane: 'desktop',
      source: 'adapter',
      provider: 'desktop.native',
      operation: 'mutate',
      modes: ['assistant', 'autonomous'],
      risk: 'medium',
      sideEffects: [{ type: 'desktop_control', scope: 'selected accessible text control', reversible: true }],
      adapter: {
        id: 'desktop.native',
        operations: ['type'],
        implementations: { windows: 'windows-uia', macos: 'macos-accessibility' },
      },
    },
    evidence: {
      capability: 'desktop.native_ui.type',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['Typed text must be read back or otherwise verified before reporting success.'],
    },
  });
}

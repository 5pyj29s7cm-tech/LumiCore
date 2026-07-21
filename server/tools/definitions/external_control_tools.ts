import { getExternalControlCandidate, listExternalControlCandidates } from '../../external_control/candidates';
import { captureWindowsUiSnapshot, runWindowsUiAction } from '../../external_control/windows_uia';
import {
  createVisibleWpsDocumentWithText,
  WPS_CREATE_DOCUMENT_TOOL,
} from '../../external_control/wps_automation';
import { mcpManager, recoverServerTools } from '../../mcp';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';

const UI_TARGET_PROPERTIES = {
  root: { type: 'string', enum: ['active', 'focused', 'desktop'], description: 'Search root. Defaults active foreground window.' },
  name: { type: 'string', description: 'Exact accessible name to match, case-insensitive.' },
  nameContains: { type: 'string', description: 'Substring of accessible name to match, case-insensitive.' },
  automationId: { type: 'string', description: 'Exact AutomationId to match.' },
  controlType: { type: 'string', description: 'Control type to match, e.g. Button, Edit, Document, MenuItem, Window.' },
  className: { type: 'string', description: 'Exact UI class name to match.' },
  processId: { type: 'number', description: 'Optional process id to restrict matches.' },
  nativeWindowHandle: { type: 'number', description: 'Optional native window handle to restrict matches.' },
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
    evidence: {
      capability: 'wps_document',
      operation: 'create',
      assurance: 'verified',
    },
  });

  registry.register({
    name: 'external_control_candidates',
    description: 'List curated general-purpose external-control upgrades for Lumi, such as Playwright MCP for browser DOM control and Windows UI Automation for native desktop apps.',
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
      note: 'Prefer browser DOM/Playwright for web platforms, Windows UIA for native apps, and vision computer_use only as a fallback.',
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
          configured: false,
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

      let restarted = false;
      let tools: unknown[] = [];
      if (args.restart === true && nextServer.enabled) {
        tools = await mcpManager.restartServer(serverName);
        await recoverServerTools(serverName, tools as any);
        restarted = true;
      } else if (args.restart === true && !nextServer.enabled) {
        await mcpManager.disconnectServer(serverName);
      }

      return JSON.stringify({
        configured: true,
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
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ui_snapshot',
    description: 'Capture a read-only Windows UI Automation tree for the active/focused/desktop window, including control names, types, automation ids, enabled/offscreen state, and bounding boxes. A desktop-root snapshot can target a specific native window by accessible identity without foregrounding it. Use this before clicking native apps so Lumi can reason about real controls instead of only screen pixels.',
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
    handler: async (args) => JSON.stringify(await captureWindowsUiSnapshot({
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
  });

  registry.register({
    name: 'desktop_ui_focus',
    description: 'Focus a native Windows UI Automation control selected by name, AutomationId, control type, class name, process id, or handle. Use desktop_ui_snapshot first to choose a precise target.',
    parameters: {
      type: 'object',
      properties: UI_TARGET_PROPERTIES,
      required: [],
    },
    handler: async (args) => JSON.stringify(await runWindowsUiAction({ ...args, action: 'focus' }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ui_click',
    description: 'Click the center of a native Windows UI Automation control selected by accessible properties. Prefer this over raw coordinates for WPS, WeChat, CAD/Revit dialogs, installers, and normal Windows apps. Use desktop_ui_snapshot first.',
    parameters: {
      type: 'object',
      properties: UI_TARGET_PROPERTIES,
      required: [],
    },
    handler: async (args) => JSON.stringify(await runWindowsUiAction({ ...args, action: 'click' }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ui_invoke',
    description: 'Invoke a native Windows UI Automation control through InvokePattern, falling back to a center click by default. Use for buttons/menu items when the target supports accessibility invocation.',
    parameters: {
      type: 'object',
      properties: {
        ...UI_TARGET_PROPERTIES,
        fallbackClick: { type: 'boolean', description: 'Use a mouse click if InvokePattern is unavailable. Defaults true.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify(await runWindowsUiAction({ ...args, action: 'invoke' }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'desktop_ui_type',
    description: 'Type or set text into a native Windows UI Automation text control. Uses ValuePattern when available and falls back to focused keyboard input. Use desktop_ui_snapshot first; foreground user-requested ordinary messages/comments can proceed, while payments, account-security transitions, legal/contractual submits, and ambiguous external submits still require confirmation.',
    parameters: {
      type: 'object',
      properties: {
        ...UI_TARGET_PROPERTIES,
        text: { type: 'string', description: 'Text to type or set.' },
        append: { type: 'boolean', description: 'Append to existing ValuePattern text instead of replacing. Defaults false.' },
      },
      required: ['text'],
    },
    handler: async (args) => JSON.stringify(await runWindowsUiAction({ ...args, action: 'type', text: String(args.text || '') }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });
}

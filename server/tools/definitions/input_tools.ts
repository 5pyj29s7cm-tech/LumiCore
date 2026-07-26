import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

function inputCapability(id: string, scope: string) {
  return capabilityContract({
    id,
    family: 'desktop_input',
    lane: 'desktop',
    operation: 'mutate',
    risk: 'medium',
    sideEffects: [{ type: 'desktop_control', scope, reversible: true }],
    verification: {
      strategy: 'state_diff',
      required: true,
      requiredFields: [],
      successSignals: ['a verified post-action desktop state matches the requested outcome'],
      limitations: ['Native input dispatch alone is not proof that the target application reached the intended state.'],
    },
  });
}

function inputEvidence(id: string, subjectArgument?: string) {
  return capabilityEvidence({
    id,
    operation: 'mutate',
    assurance: 'observed',
    subjectArgument,
    limitations: ['The receipt proves input dispatch; task completion requires post-state verification.'],
  });
}

async function mouseMove(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Mouse control requires the Tauri desktop app');
  return context.desktopRelay('desktop_mouse_move', { x: args.x, y: args.y });
}

async function mouseClick(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Mouse control requires the Tauri desktop app');
  return context.desktopRelay('desktop_mouse_click', { button: args.button || 'left' });
}

async function mouseDrag(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Mouse control requires the Tauri desktop app');
  return context.desktopRelay('desktop_mouse_drag', {
    from_x: args.from_x,
    from_y: args.from_y,
    to_x: args.to_x,
    to_y: args.to_y,
    button: args.button || 'left',
  });
}

async function keyType(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Keyboard control requires the Tauri desktop app');
  return context.desktopRelay('desktop_keyboard_type', { text: args.text });
}

async function keyPress(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Keyboard control requires the Tauri desktop app');
  return context.desktopRelay('desktop_keyboard_press', { key: args.key });
}

async function relayDesktopInput(
  toolName: string,
  args: Record<string, any>,
  context?: any,
): Promise<string> {
  if (!context?.desktopRelay) throw new Error('Desktop input requires the Tauri desktop app');
  return context.desktopRelay(toolName, args);
}

export function registerInputTools(registry: ToolRegistry): void {
  // These names are the canonical foreground-workflow operations used by the
  // router, action contracts, executor and Tauri relay. Register them as real
  // tools so the model-visible capability set and the executable policy are
  // derived from the same source of truth.
  registry.register({
    name: 'desktop_mouse_click_at',
    description: 'Click a specific absolute screen coordinate in the visible desktop app. Inspect the target first and use this only when an accessible UI control is unavailable.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute horizontal screen coordinate.' },
        y: { type: 'number', description: 'Absolute vertical screen coordinate.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
      },
      required: ['x', 'y'],
    },
    handler: (args, context) => relayDesktopInput('desktop_mouse_click_at', {
      x: args.x,
      y: args.y,
      button: args.button || 'left',
    }, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.pointer.click',
      family: 'desktop',
      lane: 'desktop',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'desktop_control', scope: 'visible foreground application', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['verification.status'],
        successSignals: ['post-click target state matches the requested outcome'],
        limitations: ['Input dispatch is not proof that the target application accepted the click.'],
      },
    },
    evidence: {
      capability: 'desktop.pointer.click',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['A click receipt proves input was issued, not that the intended UI outcome occurred.'],
    },
  });

  registry.register({
    name: 'desktop_keyboard_press',
    description: 'Press a key or keyboard shortcut in the visible foreground desktop app.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or combination such as enter, escape, ctrl+v, or meta+n.' },
      },
      required: ['key'],
    },
    handler: (args, context) => relayDesktopInput('desktop_keyboard_press', { key: args.key }, context),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'desktop.keyboard.press',
      family: 'desktop',
      lane: 'desktop',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'desktop_control', scope: 'visible foreground application', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['verification.status'],
        successSignals: ['post-key target state matches the requested outcome'],
        limitations: ['Input dispatch is not proof that the target application accepted the key.'],
      },
    },
    evidence: {
      capability: 'desktop.keyboard.press',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['A key receipt proves input was issued, not that the intended UI outcome occurred.'],
    },
  });

  for (const definition of [
    {
      name: 'desktop_cursor_glow_show',
      description: 'Show Lumi\'s visible desktop cursor indicator before a foreground pointer action.',
      properties: {
        timeoutMs: { type: 'number', description: 'Optional automatic hide timeout in milliseconds.' },
        source: { type: 'string', description: 'Optional workflow source label.' },
      },
    },
    {
      name: 'desktop_cursor_glow_update',
      description: 'Move Lumi\'s visible desktop cursor indicator to an absolute screen coordinate.',
      properties: {
        x: { type: 'number', description: 'Absolute horizontal screen coordinate.' },
        y: { type: 'number', description: 'Absolute vertical screen coordinate.' },
      },
      required: ['x', 'y'],
    },
    {
      name: 'desktop_cursor_glow_click',
      description: 'Animate Lumi\'s visible desktop cursor indicator at a click coordinate.',
      properties: {
        x: { type: 'number', description: 'Absolute horizontal screen coordinate.' },
        y: { type: 'number', description: 'Absolute vertical screen coordinate.' },
      },
      required: ['x', 'y'],
    },
    {
      name: 'desktop_cursor_glow_hide',
      description: 'Hide Lumi\'s visible desktop cursor indicator after foreground work finishes.',
      properties: {
        source: { type: 'string', description: 'Optional workflow source label.' },
      },
    },
  ] as const) {
    registry.register({
      name: definition.name,
      description: definition.description,
      parameters: {
        type: 'object',
        properties: definition.properties,
        required: 'required' in definition ? [...definition.required] : [],
      },
      handler: (args, context) => relayDesktopInput(definition.name, args, context),
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: `desktop.pointer.visibility.${definition.name.replace('desktop_cursor_glow_', '')}`,
        family: 'desktop',
        lane: 'desktop',
        operation: 'mutate',
        risk: 'low',
        sideEffects: [{ type: 'desktop_control', scope: 'Lumi cursor visualization only', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: [],
          successSignals: ['native cursor-visualization adapter receipt'],
          limitations: ['Cursor visualization does not verify any external application result.'],
        },
      },
      evidence: {
        capability: `desktop.pointer.visibility.${definition.name.replace('desktop_cursor_glow_', '')}`,
        operation: 'mutate',
        assurance: 'observed',
        limitations: ['Cursor visualization is execution feedback, not proof of the target application result.'],
      },
    });
  }

  registry.register({
    name: 'mouse_move',
    description:
      'Move the mouse cursor to absolute screen coordinates (x, y). Use this to position the cursor before clicking or to hover over UI elements. Coordinates are pixels from the top-left corner of the primary monitor.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal pixel coordinate from the left edge of the primary monitor.' },
        y: { type: 'number', description: 'Vertical pixel coordinate from the top edge of the primary monitor.' },
      },
      required: ['x', 'y'],
    },
    handler: mouseMove,
    permission: 'user',
    securityLevel: 'safe',
    capability: inputCapability('desktop.pointer.move', 'visible pointer position'),
    evidence: inputEvidence('desktop.pointer.move', 'x'),
  });

  registry.register({
    name: 'mouse_click',
    description:
      'Click a mouse button at the current cursor position. Use after mouse_move to interact with buttons, links, or any UI element.',
    parameters: {
      type: 'object',
      properties: {
        button: { type: 'string', description: 'Mouse button: "left", "right", or "middle". Defaults to "left".' },
      },
      required: [],
    },
    handler: mouseClick,
    permission: 'user',
    securityLevel: 'safe',
    capability: inputCapability('desktop.pointer.click-current', 'visible foreground application at current pointer position'),
    evidence: inputEvidence('desktop.pointer.click-current', 'button'),
  });

  registry.register({
    name: 'mouse_drag',
    description:
      'Click and drag from one screen position to another. Useful for moving windows, selecting text, or drag-and-drop operations.',
    parameters: {
      type: 'object',
      properties: {
        from_x: { type: 'number', description: 'Starting x coordinate.' },
        from_y: { type: 'number', description: 'Starting y coordinate.' },
        to_x: { type: 'number', description: 'Ending x coordinate.' },
        to_y: { type: 'number', description: 'Ending y coordinate.' },
        button: { type: 'string', description: 'Mouse button: "left", "right", or "middle". Defaults to "left".' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
    handler: mouseDrag,
    permission: 'user',
    securityLevel: 'safe',
    capability: inputCapability('desktop.pointer.drag', 'visible foreground application drag path'),
    evidence: inputEvidence('desktop.pointer.drag', 'from_x'),
  });

  registry.register({
    name: 'keyboard_type',
    description:
      'Type a text string at the current keyboard focus. Use to fill in text fields, compose messages, or input content.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type.' },
      },
      required: ['text'],
    },
    handler: keyType,
    permission: 'user',
    securityLevel: 'safe',
    capability: inputCapability('desktop.keyboard.type', 'currently focused desktop control'),
    evidence: inputEvidence('desktop.keyboard.type', 'text'),
  });

  registry.register({
    name: 'keyboard_press',
    description:
      'Press a keyboard key or key combination. For single keys use names like "enter", "escape", "tab", "space", "backspace", "delete", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "f1".."f12", or a single character. For combos use "ctrl+c", "ctrl+shift+t", "alt+tab", "ctrl+v" etc. Supported modifiers: ctrl, shift, alt, meta (Windows key / Cmd).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or combination. E.g., "enter", "ctrl+c", "alt+tab", "ctrl+shift+t".' },
      },
      required: ['key'],
    },
    handler: keyPress,
    permission: 'user',
    securityLevel: 'safe',
    capability: inputCapability('desktop.keyboard.press-legacy', 'currently focused desktop control'),
    evidence: inputEvidence('desktop.keyboard.press-legacy', 'key'),
  });
}

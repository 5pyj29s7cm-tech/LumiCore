import { execFile } from 'child_process';
import type {
  DesktopUiActionOptions,
  DesktopUiSnapshotOptions,
} from './native_ui_contract';

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

const MACOS_ACCESSIBILITY_JXA = String.raw`
ObjC.import('stdlib');

function envValue(name) {
  const pointer = $.getenv(name);
  return pointer ? ObjC.unwrap(pointer) : '';
}

function safe(read, fallbackValue) {
  try {
    const value = read();
    return value === undefined || value === null ? fallbackValue : value;
  } catch (_) {
    return fallbackValue;
  }
}

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function normalizeControlType(role) {
  return text(role).replace(/^AX/, '').replace(/\s+/g, '');
}

function attributeValue(element, name) {
  return safe(function () {
    const attribute = element.attributes.byName(name);
    return attribute.value();
  }, '');
}

function elementInfo(element, processInfo, depth, childCount) {
  const role = text(safe(function () { return element.role(); }, ''));
  const position = safe(function () { return element.position(); }, []);
  const size = safe(function () { return element.size(); }, []);
  const name = text(safe(function () { return element.name(); }, attributeValue(element, 'AXTitle')));
  const x = Number(position[0] || 0);
  const y = Number(position[1] || 0);
  const width = Number(size[0] || 0);
  const height = Number(size[1] || 0);
  return {
    name: name,
    automationId: text(attributeValue(element, 'AXIdentifier')),
    className: text(safe(function () { return element.subrole(); }, role)),
    controlType: normalizeControlType(role),
    localizedControlType: text(safe(function () { return element.description(); }, normalizeControlType(role))),
    processId: processInfo.pid,
    nativeWindowHandle: 0,
    isEnabled: Boolean(safe(function () { return element.enabled(); }, true)),
    isOffscreen: false,
    boundingRectangle: {
      x: x,
      y: y,
      width: width,
      height: height,
      right: x + width,
      bottom: y + height,
      centerX: x + (width / 2),
      centerY: y + (height / 2)
    },
    depth: depth,
    childCount: childCount
  };
}

function processInfo(process) {
  return {
    name: text(safe(function () { return process.name(); }, '')),
    pid: Number(safe(function () { return process.unixId(); }, 0))
  };
}

function rootWindows(systemEvents, input) {
  const allProcesses = safe(function () { return systemEvents.applicationProcesses(); }, []);
  const roots = [];
  for (let processIndex = 0; processIndex < allProcesses.length; processIndex += 1) {
    const process = allProcesses[processIndex];
    const info = processInfo(process);
    if (input.root !== 'desktop' && !Boolean(safe(function () { return process.frontmost(); }, false))) continue;
    if (input.processId && info.pid !== Number(input.processId)) continue;
    const windows = safe(function () { return process.windows(); }, []);
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const windowElement = windows[windowIndex];
      const title = text(safe(function () { return windowElement.name(); }, ''));
      if (input.name && title.toLowerCase() !== text(input.name).toLowerCase()) continue;
      if (input.nameContains && title.toLowerCase().indexOf(text(input.nameContains).toLowerCase()) < 0) continue;
      roots.push({ element: windowElement, process: process, processInfo: info });
      if (input.root !== 'desktop' && !input.allMatches) return roots;
      if (!input.allMatches && roots.length >= 1) return roots;
      if (roots.length >= 6) return roots;
    }
  }
  return roots;
}

function matchesSelector(info, input) {
  if (input.name && info.name.toLowerCase() !== text(input.name).toLowerCase()) return false;
  if (input.nameContains && info.name.toLowerCase().indexOf(text(input.nameContains).toLowerCase()) < 0) return false;
  if (input.automationId && info.automationId.toLowerCase() !== text(input.automationId).toLowerCase()) return false;
  if (input.controlType && info.controlType.toLowerCase() !== normalizeControlType(input.controlType).toLowerCase()) return false;
  if (input.className) {
    const expected = text(input.className).toLowerCase();
    if (info.className.toLowerCase() !== expected) return false;
  }
  if (input.processId && info.processId !== Number(input.processId)) return false;
  return true;
}

function walk(root, input, collectTree) {
  const maxDepth = Number(input.maxDepth || 3);
  const maxNodes = Number(input.maxNodes || 80);
  let visited = 0;
  const matches = [];

  function visit(element, process, info, depth) {
    if (visited >= maxNodes || depth > maxDepth) return null;
    visited += 1;
    const children = safe(function () { return element.uiElements(); }, []);
    const node = elementInfo(element, info, depth, children.length);
    if (matchesSelector(node, input)) matches.push({ element: element, process: process, info: node });
    if (collectTree) node.children = [];
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const childNode = visit(children[childIndex], process, info, depth + 1);
      if (collectTree && childNode) node.children.push(childNode);
      if (visited >= maxNodes) break;
    }
    return node;
  }

  const tree = visit(root.element, root.process, root.processInfo, 0);
  return { tree: tree, matches: matches, visited: visited };
}

function performPress(element) {
  const actions = safe(function () { return element.actions(); }, []);
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const name = text(safe(function () { return action.name(); }, ''));
    if (name === 'AXPress' || name === 'AXConfirm' || name === 'AXPick') {
      action.perform();
      return name;
    }
  }
  throw new Error('Selected accessibility element has no press/invoke action.');
}

function setFocused(element, process) {
  process.frontmost = true;
  const attribute = element.attributes.byName('AXFocused');
  attribute.value = true;
}

function setValue(element, process, value, append, systemEvents) {
  process.frontmost = true;
  const current = text(attributeValue(element, 'AXValue'));
  const next = append ? current + value : value;
  try {
    const attribute = element.attributes.byName('AXValue');
    attribute.value = next;
    return 'AXValue';
  } catch (_) {
    setFocused(element, process);
    systemEvents.keystroke(value);
    return 'keystroke';
  }
}

function executePayload() {
  const input = JSON.parse(envValue('LUMI_NATIVE_UI_PAYLOAD') || '{}');
  const systemEvents = Application('System Events');
  const roots = rootWindows(systemEvents, input);
  if (!roots.length) {
    return JSON.stringify({
      status: 'not_found',
      platform: 'darwin',
      adapter: 'macos-accessibility',
      note: 'No matching accessible native window was found.'
    });
  }

  if (input.kind === 'snapshot') {
    const trees = [];
    let visited = 0;
    for (let index = 0; index < roots.length; index += 1) {
      const walked = walk(roots[index], input, true);
      trees.push(walked.tree);
      visited += walked.visited;
      if (!input.allMatches) break;
    }
    return JSON.stringify({
      status: 'ok',
      platform: 'darwin',
      adapter: 'macos-accessibility',
      root: input.root || 'active',
      maxDepth: Number(input.maxDepth || 3),
      maxNodes: Number(input.maxNodes || 80),
      capturedNodes: visited,
      truncated: visited >= Number(input.maxNodes || 80),
      tree: trees.length ? trees[0] : null,
      trees: trees,
      targetMatched: null,
      note: 'Read-only macOS Accessibility snapshot. Verify task-level state before claiming work is done.'
    });
  }

  const matches = [];
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const walked = walk(roots[rootIndex], input, false);
    for (let matchIndex = 0; matchIndex < walked.matches.length; matchIndex += 1) {
      matches.push(walked.matches[matchIndex]);
    }
  }
  const selected = matches[Number(input.index || 0)];
  if (!selected) {
    return JSON.stringify({
      status: 'not_found',
      platform: 'darwin',
      adapter: 'macos-accessibility',
      matchCount: matches.length,
      note: 'No accessible control matched the supplied selector.'
    });
  }

  let mechanism = '';
  if (input.action === 'focus') {
    setFocused(selected.element, selected.process);
    mechanism = 'AXFocused';
  } else if (input.action === 'click' || input.action === 'invoke') {
    selected.process.frontmost = true;
    mechanism = performPress(selected.element);
  } else if (input.action === 'type') {
    mechanism = setValue(
      selected.element,
      selected.process,
      text(input.text),
      Boolean(input.append),
      systemEvents
    );
  } else {
    throw new Error('Unsupported native UI action: ' + text(input.action));
  }

  delay(Number(input.delayAfterMs || 250) / 1000);
  const verified = elementInfo(
    selected.element,
    selected.processInfo,
    selected.info.depth,
    selected.info.childCount
  );
  return JSON.stringify({
    status: 'ok',
    platform: 'darwin',
    adapter: 'macos-accessibility',
    action: input.action,
    method: mechanism,
    root: input.root || 'active',
    matchedCount: matches.length,
    selectedIndex: Number(input.index || 0),
    visitedNodes: matches.length,
    truncated: false,
    selectedBefore: selected.info,
    selectedAfter: input.verify === false ? null : verified,
    clickPoint: null,
    typedLength: input.action === 'type' ? text(input.text).length : 0,
    note: 'macOS Accessibility action completed. Verify task-level result before claiming work is done.'
  });
}

try {
  executePayload();
} catch (error) {
  const message = text(error && error.message ? error.message : error);
  JSON.stringify({
    status: /not authorized|assistive access|accessibility/i.test(message) ? 'permission_required' : 'error',
    platform: 'darwin',
    adapter: 'macos-accessibility',
    error: message,
    note: 'Grant LumiCore Accessibility permission in System Settings > Privacy & Security > Accessibility.'
  });
}
`;

async function runJxa(
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', MACOS_ACCESSIBILITY_JXA],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        signal,
        env: {
          ...process.env,
          LUMI_NATIVE_UI_PAYLOAD: JSON.stringify(payload),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || 'macOS Accessibility execution failed').trim()));
          return;
        }
        const output = String(stdout || '').trim();
        try {
          resolve(JSON.parse(output));
        } catch {
          resolve({
            status: 'parse_error',
            platform: 'darwin',
            adapter: 'macos-accessibility',
            raw: output.slice(0, 4000),
          });
        }
      },
    );
  });
}

export async function captureMacosAccessibilitySnapshot(
  options: DesktopUiSnapshotOptions = {},
): Promise<unknown> {
  if (process.platform !== 'darwin') {
    return {
      status: 'not_supported',
      platform: process.platform,
      adapter: 'macos-accessibility',
      note: 'The macOS Accessibility adapter is available only on macOS desktop hosts.',
    };
  }
  const timeoutMs = clampInt(options.timeoutMs, 5000, 1000, 15000);
  return runJxa({
    ...options,
    kind: 'snapshot',
    root: options.root === 'desktop' || options.root === 'focused' ? options.root : 'active',
    maxDepth: clampInt(options.maxDepth, 3, 0, 6),
    maxNodes: clampInt(options.maxNodes, 80, 1, 300),
  }, timeoutMs, options.signal);
}

export async function runMacosAccessibilityAction(
  options: DesktopUiActionOptions,
): Promise<unknown> {
  if (process.platform !== 'darwin') {
    return {
      status: 'not_supported',
      platform: process.platform,
      adapter: 'macos-accessibility',
      note: 'The macOS Accessibility adapter is available only on macOS desktop hosts.',
    };
  }
  const timeoutMs = clampInt(options.timeoutMs, 8000, 1000, 20000);
  return runJxa({
    ...options,
    kind: 'action',
    root: options.root === 'desktop' || options.root === 'focused' ? options.root : 'active',
    maxDepth: clampInt(options.maxDepth, 5, 0, 8),
    maxNodes: clampInt(options.maxNodes, 160, 1, 500),
    index: clampInt(options.index, 0, 0, 1000),
    delayAfterMs: clampInt(options.delayAfterMs, 250, 0, 3000),
  }, timeoutMs, options.signal);
}

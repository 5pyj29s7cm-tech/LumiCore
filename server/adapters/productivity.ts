import type { ProductivityAdapter } from './productivity_contract';
import { macosProductivityAdapter } from './macos_productivity';
import { windowsProductivityAdapter } from './windows_productivity';

export function getProductivityAdapter(platform = process.platform): ProductivityAdapter {
  if (platform === 'win32') return windowsProductivityAdapter;
  if (platform === 'darwin') return macosProductivityAdapter;
  throw new Error(`Calendar and mail automation are not available on platform "${platform}".`);
}

export type {
  CalendarCreateInput,
  CalendarModifyInput,
  ProductivityAdapter,
} from './productivity_contract';

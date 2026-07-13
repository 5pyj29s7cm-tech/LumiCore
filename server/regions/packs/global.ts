import type { RegionalCapabilityPack } from '../types';

export const GLOBAL_CAPABILITY_PACK: RegionalCapabilityPack = {
  id: 'global',
  aliases: ['global', 'international', 'world'],
  locales: ['en'],
  capabilities: ['desktop', 'browser', 'knowledge', 'messaging', 'meeting'],
};

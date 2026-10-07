export interface ModelSelection<P extends string> {
  provider: P;
  model: string;
  models: Record<string, string>;
}

export interface ModelSelectionDefinition<P extends string> {
  defaults: Readonly<Record<string, string>>;
  defaultProvider: P;
  specialProvider?: P;
  specialModel?: 'optional' | 'empty';
  includeDefaults?: boolean;
  maxLength?: number;
}

export function cleanModelName(value: unknown, maxLength = Infinity): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeModelMap(value: unknown, maxLength = Infinity): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, model]) => cleanModelName(model, maxLength))
    .map(([provider, model]) => [provider, cleanModelName(model, maxLength)]));
}

export function isSelectionProvider<P extends string>(
  value: unknown,
  definition: ModelSelectionDefinition<P>,
): value is P {
  return typeof value === 'string'
    && (value === definition.specialProvider || Object.hasOwn(definition.defaults, value));
}

/** The selected model and its provider map always describe the same selection. */
export function normalizeModelSelection<P extends string>(
  raw: unknown,
  definition: ModelSelectionDefinition<P>,
): ModelSelection<P> {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const provider = isSelectionProvider(value.provider, definition) ? value.provider : definition.defaultProvider;
  const saved = normalizeModelMap(value.models, definition.maxLength);
  const requested = cleanModelName(value.model, definition.maxLength);
  const special = provider === definition.specialProvider;
  const model = special
    ? definition.specialModel === 'empty' ? '' : requested
    : saved[provider] || requested || definition.defaults[provider] || '';
  const models: Record<string, string> = { ...(definition.includeDefaults ? definition.defaults : {}), ...saved };
  if (!special && model) models[provider] = model;
  return { provider, model, models };
}

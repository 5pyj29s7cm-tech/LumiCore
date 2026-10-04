export interface ProviderGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
  isOllamaAvailable?: () => boolean;
  isLmStudioAvailable?: () => boolean;
}

type Getter = () => any;
export type ProviderArguments = readonly [Getter, Getter, Getter?, Getter?, Getter?, Getter?, Getter?, Getter?, Getter?, Getter?, Getter?, Getter?];

/** Preserve the public provider call order without evaluating clients; callers retain their existing missing-client behavior. */
export function providerGetterArguments(getters: ProviderGetters, fallback?: 'optional'): ProviderArguments;
export function providerGetterArguments(getters: Partial<ProviderGetters>, fallback: 'primary'): ProviderArguments;
export function providerGetterArguments(getters: Partial<ProviderGetters>): Readonly<Partial<ProviderArguments>>;
export function providerGetterArguments(getters: Partial<ProviderGetters>, fallback?: 'primary' | 'optional'): ReadonlyArray<Getter | undefined> {
  const unavailable = () => null;
  return [
    getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic,
    getters.getQwen, getters.getOllama, getters.getLmStudio, getters.getArk,
    getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay,
  ].map((getter, index) => (fallback === 'primary' && index < 2 || fallback === 'optional' && index >= 2)
    ? getter || unavailable : getter);
}

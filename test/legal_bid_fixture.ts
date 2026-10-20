export function bidPromptSources(prompt: string): any[] {
  return JSON.parse(prompt.split('\n原始材料：')[1].split(/\n(?:本次只输出|待核对JSON草稿：)/)[0])
    .flatMap((source: any) => Array.isArray(source.paragraphs) ? source.paragraphs.map((paragraph: any) => ({ ...paragraph, materialId: source.materialId, title: source.title })) : [source]);
}

export function bidStructuredReply(prompt: string, response: string, missing = '资格、原始证明和计算仍待责任人核验'): string {
  if (prompt.includes('待核对JSON草稿：')) return JSON.stringify({ ...JSON.parse(prompt.split('待核对JSON草稿：')[1]), complete: true, unresolved: [] });
  const sources = bidPromptSources(prompt);
  const sections = JSON.parse(prompt.split('\n指定子节：')[1]);
  return JSON.stringify({ entries: sections.map((section: any) => ({
    sectionId: section.id,
    sourceIds: sources.some((source: any) => source.id === section.id) ? [section.id] : sources.slice(0, 30).map((source: any) => source.id),
    response,
    missing,
  })) });
}

/** SDK fixture follows the request transport; long generation emits empty heartbeat frames. */
export function sdkCompletion(params: any, completion: any, delayMs = 0, signal?: AbortSignal): any {
  if (!params.stream) return completion;
  return (async function* () {
    yield { choices: [{ delta: {} }] };
    for (let elapsed = 0; elapsed < delayMs;) {
      const step = Math.min(10000, delayMs - elapsed);
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, step);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new Error('cancelled')); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
      });
      elapsed += step;
      if (elapsed < delayMs) yield { choices: [{ delta: {} }] };
    }
    yield { choices: completion.choices.map((choice:any,index:number)=>({index,delta:choice.message,finish_reason:choice.finish_reason})), ...(completion.usage?{usage:completion.usage}:{}) };
  })();
}

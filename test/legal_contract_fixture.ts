export function contractPromptSources(prompt: string): Array<{ id:string; quote:string }> { return JSON.parse(prompt.match(/^原始材料：(.+)$/m)![1]); }
export function contractStructuredReply(prompt: string, body: string): string {
  const match = prompt.match(/^指定栏目：(.+)$/m);
  if (!match) return body;
  const sections = JSON.parse(match[1]) as Array<{id:string}>;
  return JSON.stringify({complete:true,entries:sections.map(section=>({sectionId:section.id,sourceIds:[contractPromptSources(prompt)[0].id],response:body,missing:'原件真实性、未知条件与法律适用仍待核对。'}))});
}
export function sdkCompletionFixture(content: string, finishReason = 'stop', stream = false): any {
  return stream ? (async function*(){yield {choices:[{delta:{content},finish_reason:finishReason}]};})()
    : {choices:[{message:{content},finish_reason:finishReason}]};
}

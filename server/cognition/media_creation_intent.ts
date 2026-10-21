import { affirmativeActionClauses, negatedActionInstructions } from './action_instruction_clauses';
import { withoutLocationLiterals } from './location_literals';

type MediaGenerator = 'generate_video' | 'generate_image' | 'ai_edit_image';
function mediaGenerator(instruction: string): MediaGenerator {
  const head=instruction.split(/[：:，,。；;\n]/u)[0];
  // i18n-allow: media kind and the existing generative-edit operation vocabulary.
  return /视频|短片|成片|\b(?:video|clip|movie)\b/iu.test(head)?'generate_video':/^(?:please\s+)?(?:edit|modify|redraw)\b/iu.test(head)?'ai_edit_image':'generate_image';
}

/** Same polarity owner, narrowed to the object of this actual media action. */
function mediaActionProhibited(text: string, instruction: string, tool: string, selection = false): boolean {
  const target=(selection?affirmativeActionClauses(text).join(' '):instruction).toLowerCase();
  for(const negative of negatedActionInstructions(text)) {
    const command=withoutLocationLiterals(negative.instruction).trim();
    // A prohibition on repeating an operation does not revoke the first requested operation.
    // i18n-allow: operation repetition modifiers remain attached to their own action.
    if(/^(?:再(?:次)?|重新|重复|第二次)|^(?:again|another|retry|repeat)\b/iu.test(command))continue;
    // i18n-allow: an exact prohibited tool call is never an authorizing mention.
    const called=command.match(/^(?:调用|使用|执行|call|use|invoke)\s*(?:一次)?\s*([a-z][a-z0-9_]*)/iu)?.[1];
    if(called===tool)return true;
    // i18n-allow: existing media-generation and song-selection action predicates.
    const action=command.match(selection?/^(?:select-song|选入|选择|绑定|select|bind)\s*(.*)$/iu:/^(?:生成|创建|制作|产出|绘制|画|合成|generate|create|make|produce|render)\s*(.*)$/iu);
    if(!action)continue;
    // Objects, rather than a word elsewhere in the turn, determine the fence.
    // i18n-allow: generic determiners and clause punctuation are grammatical boundaries.
    const objects=action[1].replace(/^(?:[这该本任所新原]+(?:次|轮|个|份|张|条|段|有|何|的)*\s*|(?:any|all|the|this|a|an|new)\s+)/iu,'').replace(/[.。！？!?；;，,\s]+$/u,'').split(/以及|和|或|、|\band\b|\bor\b/iu).map(value=>value.trim().toLowerCase()).filter(Boolean);
    if(!objects.length||objects.some(object=>/^(?:内容|东西|content|anything|it)$/iu.test(object)
      // i18n-allow: Existing media artifact-kind input grammar.
      || (tool==='generate_video'&&/^(?:视频|短视频|短片|成片|videos?|clips?|movies?)$/iu.test(object))
      // i18n-allow: Existing song object-kind input grammar.
      || (selection&&/^(?:歌曲|原声|音轨|songs?|tracks?)$/iu.test(object))
      || target.includes(object)))return true;
  }
  return false;
}

/** Inspect authoritative action clauses, never creative data or a separate preservation fence. */
export function mediaCreationInstruction(text: string): string | null {
  for (const part of affirmativeActionClauses(text)) {
    const clause = withoutLocationLiterals(part);
    // i18n-allow: explanatory questions and planning text do not authorize paid media generation.
    if (/^(?:为什么|怎么|如何|是否|能否|介绍|说明|解释)|\b(?:why|how|explain|describe)\b/iu.test(clause.trim())) continue;
    // i18n-allow: media generation input recognition, kept on the existing media owner.
    const action = '(?:生成|创建|制作|产出|绘制|画|做(?:成)?|合成|转成|转换为|变成)';
    // i18n-allow: media artifact kinds, not a new tool or routing category.
    const media = '(?:图片|图像|插画|海报|封面|壁纸|人像|形象素材|视频|短视频|动画|成片)';
    const match = clause.match(new RegExp('(?<![刚已曾])'+action+'(?!的|过|完|好|了)(?:一?[张个段条]|一些|几[张个段条])?[^。！？!?；;\\n]{0,100}'+media,'u'));
    // i18n-allow: writing a prompt, script or other planning text is not provider generation.
    if (match && !/(?:提示词|文案|脚本|大纲|方案|字幕|标题)/u.test(match[0])) {
      const instruction=clause.slice(match.index).trim();
      if(!mediaActionProhibited(text,instruction,mediaGenerator(instruction)))return instruction;
    }
    // The media object may precede the action: use a configured video capability
    // to generate an audio carrier. Normalize only this action clause; raw text
    // and creative arguments remain unchanged in the accepted task contract.
    // i18n-allow: imperative object-before-action grammar shared by configured media services.
    const objectFirst = clause.match(/^(?:(?:请|帮我|现在|直接)\s*)*(?:使用|用|通过|调用)[^。！？!?；;\n]{0,80}?(图片|图像|视频|短视频)(?:生成)?(?:能力|模型|服务|接口)[^。！？!?；;\n]{0,24}?(生成|创建|制作|产出|合成)[^。！？!?；;\n]{1,100}$/u);
    // i18n-allow: the requested deliverable must remain a media artifact.
    if (objectFirst && !/(?:提示词|文案|脚本|大纲|方案|字幕|标题|组件|网页|代码)/u.test(objectFirst[0])) {
      const instruction=objectFirst[2]+objectFirst[1]+'：'+clause;
      if(!mediaActionProhibited(text,instruction,mediaGenerator(instruction)))return instruction;
    }
    // i18n-allow: English affirmative media instructions use the same projection and boundary.
    const english=clause.match(/^(?:please\s+)?(?:generate|create|make|draw|render|edit|modify|redraw)\b[^.!?;\n]{0,100}\b(?:image|images|picture|photo|poster|video|clip)\b/iu);
    if(english&&!/\b(?:prompt|script|copy|plan|outline|caption|code|component|webpage)\b/iu.test(english[0])&&!mediaActionProhibited(text,clause,mediaGenerator(clause))) return clause;
  }
  return null;
}

/** The exact media action survives unrelated preservation fences. This is a
 * scope projection only: ordinary role, owner, policy and adapter checks still apply. */
export function mediaAuthoringMutationScope(text: string): { instruction: string; generator: MediaGenerator; projectSelectionRequested: boolean; projectSelection?: { projectId: string; revision: number } } | null {
  const instruction=mediaCreationInstruction(text);
  if(!instruction)return null;
  const generator=mediaGenerator(instruction);
  const clauses=affirmativeActionClauses(text);
  const projectSelectionRequested=generator==='generate_video'&&clauses.some(clause=>/\b(?:chat_song_project)\s+(?:action\s*[=:]\s*)select-song\b/u.test(clause));
  const explicitSelection=projectSelectionRequested&&!mediaActionProhibited(text,instruction,'chat_song_project',true);
  const bindingText=clauses.join('\n');
  const bindings=[...bindingText.matchAll(/\bprojectId\s*=\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})[^。；;\n]{0,40}?\brevision\s*=\s*([1-9]\d*)/giu)].map(match=>({projectId:match[1].toLowerCase(),revision:Number(match[2])}));
  const uniqueBindings=[...new Map(bindings.map(binding=>[binding.projectId+':'+binding.revision,binding])).values()];
  const exact=uniqueBindings.length===1&&Number.isSafeInteger(uniqueBindings[0].revision)?uniqueBindings[0]:undefined;
  return{instruction,generator,projectSelectionRequested,...(explicitSelection&&exact?{projectSelection:exact}:{})};
}
export function isAvatarAuthoringRequest(text: string): boolean {
  // i18n-allow: memory-person authoring, not merely opening or chatting with a person.
  return /记忆领地|记忆化身|数字人|虚拟人物|人物形象|memory\s*(?:avatar|territory)|avatar/iu.test(text)
    && /创建|新建|设计|导入|配置|设置|create|design|import|configure/iu.test(text)
    // i18n-allow: explanatory question detection.
    && !/^(?:解释|介绍|什么是|explain|what is)/iu.test(text.trim());
}

/** Remove only fences on existing people and implementation files. The caller
 * must still restrict mutations to the requested person-authoring tools. */
export function avatarAuthoringMutationInstruction(text: string): string | null {
  if (!isAvatarAuthoringRequest(text)) return null;
  // i18n-allow: scoped prohibitions on existing people and implementation files.
  return text.replace(/(?:不要|不|别|禁止)\s*(?:修改|改动|覆盖)\s*(?:(?:程序)?(?:源代码|代码|源码|数据库)(?:文件)?(?:和|或|、)?)+(?=[，。；;！!、\n]|$)/gu, ' ')
    // i18n-allow: preserve existing people while creating a separate person.
    .replace(/(?:不要|不|别|禁止)\s*(?:修改|改动|覆盖)\s*(?:现有|已有)(?:的)?[^，。；;！!\n]{1,30}(?=[，。；;！!\n]|$)/gu, ' ');
}

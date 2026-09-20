/** Inspect instruction clauses, not descriptive words such as hair/发 in a brief. */
export function mediaCreationInstruction(text: string): string | null {
  // i18n-allow: multilingual imperative/media intent recognition.
  for (const clause of String(text || '').split(/[。！？!?；;：:\n]/u)) {
    if (/(?:不要|别|无需|不用|不需要|禁止|不是要|并非要|不再生图)|\b(?:don't|do not|never|without)\b/iu.test(clause)) continue;
    // i18n-allow: explanatory questions do not order image generation.
    if (/^(?:为什么|怎么|如何|是否|能否|介绍|说明|解释)|\b(?:why|explain|describe how)\b/iu.test(clause.trim())) continue;
    // i18n-allow: media generation intent recognition.
    const match = clause.match(/(?<![刚已曾])(?:生成|创建|制作|产出|绘制|画)(?!的|过|完|好|了)(?:一张|一个|一些|几张)?[^。！？!?；;\n]{0,100}(?:图片|图像|插画|海报|封面|壁纸|人像|形象素材|视频|短视频|动画|成片)/u);
    // i18n-allow: exclude requests to write planning text.
    if (!match || /(?:提示词|文案|脚本|大纲|方案|字幕|标题)/u.test(match[0])) continue;
    return clause.slice(match.index).trim();
  }
  return null;
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

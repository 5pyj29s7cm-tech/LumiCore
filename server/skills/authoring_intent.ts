/** User-authored skill/workflow work, distinct from automatic capability-gap repair. */
export type SkillAuthoringIntent = 'generate' | 'save' | 'publish' | 'install' | 'use' | 'none';

export function classifySkillAuthoringIntent(value: string): SkillAuthoringIntent {
  const text = String(value || '').split(/\r?\n\s*##\s+(?:Current Turn Attachments|Recent action continuation context)/i)[0].trim();
  // Conditional gap repair keeps the reuse-first discovery boundary.
  // i18n-allow: multilingual conditional capability-generation recognition.
  if (/\b(?:generate|create)\b.{0,60}\bonly\s+if\b|(?:找不到|没有合适|现有.*不支持|缺少能力).{0,35}(?:再|才)(?:生成|创建)技能/iu.test(text)) return 'none';
  // i18n-allow: multilingual user-intent recognition, not user-visible copy.
  const clauses = text.split(/[。！？!?；;\n]/u)
    // i18n-allow: remove whole negated clauses, including intervening objects.
    .map(clause => clause.replace(/(?:^|[，,])\s*(?:请)?(?:先|暂时)?(?:不要|别|禁止|无需|不用)[^，,]*(?=[，,]|$)/gu, ' '))
    // i18n-allow: multilingual explanation-only input recognition.
    .filter(clause => !/^\s*(?:请\s*)?(?:只|仅|先|暂时只)(?:需|要)?(?:解释|讲解|说明|介绍|告诉我)|^\s*(?:please\s+)?(?:only|just)\s+(?:explain|describe|tell\s+me)/iu.test(clause))
    // i18n-allow: multilingual negated authoring input recognition.
    .map(clause => clause.replace(/(?:不要|别|禁止|无需|不用|不必|暂时不|暂不|不|do\s+not|don't|never)\s*(?:再|重新|actually\s+)?(?:生成|创建|保存|存下(?:来)?|安装|发布|登记|复用|运行|执行|使用|再跑|create|generate|save|install|publish|run|use)/giu, ' '));
  // A later explicit draft request names the next action even when the first
  // clause describes saving a previously observed workflow. Draft generation
  // does not authorize the separate installation or execution steps.
  // i18n-allow: multilingual explicit skill draft authoring input recognition.
  if (clauses.some(clause => /(?:技能|工作流)|\b(?:skill|workflow)\b/iu.test(clause))
    && clauses.some(clause => /(?:实际|先|只|仅)?(?:生成|创建|新建).{0,12}草稿|\b(?:generate|create|build)\b.{0,35}\bdraft\b/iu.test(clause)
      // i18n-allow: multilingual retrospective-question input recognition.
      && !/(?:了吗|过吗|了没有|是否|有没有)|\b(?:did|have)\s+you\b/iu.test(clause))) return 'generate';
  for (const clause of clauses) {
    // A question about a prior save does not authorize a new authoring action.
    // i18n-allow: multilingual past-action question recognition.
    if (/(?:保存|创建|生成|登记|发布|安装).{0,16}(?:了吗|过吗|了没有)|(?:是否|有没有).{0,16}(?:保存|创建|生成|登记|发布|安装)|\b(?:did|have)\s+you\b|\b(?:already|previously)\s+(?:saved|created|generated|installed|published)\b/iu.test(clause)) continue;
    // i18n-allow: multilingual explicit authoring input recognition.
    const target = /(?:技能|工作流|流程)|\b(?:skill|workflow)\b/iu;
    if (!target.test(clause)) continue;
    // Saving a process *as a Skill* requests a package draft. Saving a workflow
    // requests a recipe; it must not silently enter package generation/install.
    // i18n-allow: explicit requested artifact type recognition.
    if (/(?:保存|沉淀).{0,25}(?:为|成).{0,12}技能|\b(?:save|capture)\b.{0,60}\bas\s+(?:a\s+)?(?:reusable\s+)?skill\b/iu.test(clause)) return 'generate';
    // The requested verb owns the operation; an already registered skill is
    // the object, not permission to publish it again. "可复用" describes a
    // future artifact and must not match the affirmative verb "复用".
    // i18n-allow: multilingual reuse and colloquial workflow capture recognition.
    if (/(?:按|照|用).{0,35}(?:技能|工作流|流程).{0,20}(?:再跑|运行|执行|处理|(?<!可)复用)|(?:技能|工作流|流程).{0,20}(?:再跑一遍|再执行一次)|\b(?:reuse|rerun)\b.{0,50}\b(?:skill|workflow)\b/iu.test(clause)) return 'use';
    // i18n-allow: colloquial workflow capture recognition.
    if (/(?:技能|工作流|流程).{0,20}存下来|存下来.{0,20}(?:技能|工作流|流程)/u.test(clause)) return 'save';
    // i18n-allow: explicit continuation of a named workflow, not a new draft.
    if (/^\s*(?:请\s*)?继续(?:当前|这个|刚才的|已有的)?(?:工作流|流程)/u.test(clause)) return 'use';
    // The leading requested operation owns the turn: "run the published
    // workflow" is execution, not another publication or installation.
    // i18n-allow: multilingual named capability reuse recognition.
    if (/^\s*(?:(?:请|现在|帮我|然后|继续)\s*)?(?:使用|运行|调用|执行|用)|^\s*(?:please\s+)?(?:use|run|invoke)\b/iu.test(clause)) return 'use';
    // i18n-allow: multilingual explicit authoring input recognition.
    if (/(?:生成|创建|新建|开发).{0,35}技能|\b(?:generate|create|build)\b.{0,50}\bskill\b/iu.test(clause)) return 'generate';
    // i18n-allow: multilingual explicit authoring input recognition.
    if (/(?:保存|记住|记下|沉淀).{0,40}(?:技能|工作流|流程)|(?:技能|工作流|流程).{0,45}(?:保存|记住|记下|沉淀)|(?:创建|新建).{0,35}工作流|\b(?:save|remember|capture)\b.{0,65}\b(?:skill|workflow|process)\b|\b(?:create|build)\b.{0,50}\bworkflow\b/iu.test(clause)) return 'save';
    // i18n-allow: multilingual explicit installation input recognition.
    if (/(?:安装).{0,40}技能|\binstall\b.{0,50}\bskill\b/iu.test(clause)) return 'install';
    // i18n-allow: multilingual explicit authoring input recognition.
    if (/(?:发布|登记).{0,40}(?:技能|工作流)|(?:技能|工作流).{0,40}(?:发布|登记)|\b(?:publish|register)\b.{0,50}\b(?:skill|workflow)\b/iu.test(clause)) return 'publish';
  }
  return 'none';
}

export function skillAuthoringTools(intent: SkillAuthoringIntent): string[] {
  if (intent === 'generate') return ['generate_skill', 'install_skill', 'list_skills', 'client_capability_manifest'];
  if (intent === 'save') return ['capture_recent_workflow', 'save_workflow', 'get_workflow', 'list_workflows'];
  if (intent === 'publish') return ['get_workflow', 'publish_workflow', 'install_skill', 'list_skills', 'client_capability_manifest'];
  if (intent === 'install') return ['install_skill', 'list_skills', 'client_capability_manifest'];
  if (intent === 'use') return ['client_capability_manifest', 'list_skills', 'get_workflow', 'list_workflows', 'run_workflow', 'get_workflow_run', 'decide_workflow_confirmation'];
  return [];
}

/** A current action followed by saving the process is a compound request.
 * Retrospective capture and a Skill's example/description do not authorize it.
 */
export function executionBeforeWorkflowSave(value: string): string {
  if (classifySkillAuthoringIntent(value) !== 'save') return '';
  // i18n-allow: multilingual sequence and explicit action recognition.
  const sequence = /然后|完成后|并把|并将|接着|\b(?:and\s+then|then)\b/giu;
  for (const match of value.matchAll(sequence)) {
    const before = value.slice(0, match.index).trim();
    const after = value.slice(match.index! + match[0].length);
    if (classifySkillAuthoringIntent(before) !== 'none' || classifySkillAuthoringIntent(after) !== 'save') continue;
    // i18n-allow: an explicit present action is required before authoring.
    if (/(?:不要|别|不必|无需|不用)[^。！？!?；;\n，,]{0,8}(?:执行|运行|读取|计算|生成)|\b(?:do not|don't|never)\b[^.!?;\n,]{0,40}\b(?:execute|run|read|calculate|generate)\b/iu.test(before)) return ''; // i18n-allow: clause-bounded negation of execution.
    // i18n-allow: descriptions of examples and completed tasks are not commands.
    if (/(?:功能|示例|例如|刚才|上次|以后|下次)[:：]?|\b(?:example|previously|last\s+time|next\s+time)\b/iu.test(before)) continue;
    // i18n-allow: multilingual imperative operation recognition.
    if (/(?:^|[。！？!?；;\n])\s*(?:(?:请|先|帮我|现在|立即)\s*)*(?:读取|打开|执行|运行|计算|处理|生成|写入|转换|检查|查询)|\b(?:please\s+)?(?:read|open|execute|run|calculate|process|write|convert|inspect)\b/iu.test(before)) return before;
  }
  return '';
}

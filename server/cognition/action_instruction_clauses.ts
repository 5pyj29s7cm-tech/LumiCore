export interface ActionInstructionClause { text: string; probe: string; start: number }
export interface NegatedActionInstruction { text: string; instruction: string }
interface ProjectedClause extends ActionInstructionClause { syntax: string }

/** Quote-aware instruction projection. Literal paths remain targets; other quoted text is data. */
function projectInstructionClauses(input: string): ProjectedClause[] {
  const parts: ProjectedClause[] = [];
  let start = 0, probe = '', syntax = '', quote = '', quoteStart = 0;
  // i18n-allow: User-supplied quote and sentence delimiters, not visible copy.
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'", '`': '`' };
  const escaped = (index: number) => {
    let backslashes = 0;
    for (let previous = index - 1; previous >= 0 && input[previous] === '\\'; previous--) backslashes++;
    return backslashes % 2 === 1;
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (input.startsWith(quote, index) && !escaped(index)) {
        const literal = input.slice(quoteStart, index + quote.length);
        const value = input.slice(quoteStart + quote.length, index).trim();
        // The former artifact projection protected exact quoted filesystem paths.
        const exactPath = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/(?!\/))[^\r\n<>|*?"'，,；;。！？!]+$/u.test(value)
          && !/\.(?:xlsx?|xlsm|docx?|pptx?|pdf|rtf|txt|md|csv|tsv|json|html?|wps|et|dps|png|jpe?g|webp|bmp|gif|tiff?|mp4|wav|mp3)\s+\S/iu.test(value);
        probe += exactPath ? literal : ' ';
        syntax += exactPath ? ' '.repeat(literal.length) : ' ';
        index += quote.length - 1;
        quote = '';
      }
      continue;
    }
    if (pairs[char] && !escaped(index) && !(char === "'" && /[a-z]/iu.test(input[index - 1] || '') && /[a-z]/iu.test(input[index + 1] || ''))) {
      quoteStart = index;
      quote = input.startsWith('```', index) ? '```' : pairs[char];
      if (quote.length > 1) index += quote.length - 1;
      continue;
    }
    probe += char;
    syntax += char;
    if (/[，,；;。！？!?\n]/u.test(char) || char === '.' && /\s|^$/u.test(input[index + 1] || '')) {
      parts.push({ text: input.slice(start, index + 1), probe, syntax, start });
      start = index + 1; probe = ''; syntax = '';
    }
  }
  if (quote) { probe += ' '; syntax += ' '; }
  parts.push({ text: input.slice(start), probe, syntax, start });
  return parts;
}

export function actionInstructionClauses(input: string): ActionInstructionClause[] {
  return projectInstructionClauses(input).map(({ syntax, ...clause }) => clause);
}

/** Pure affirmative-clause projection; it never calls an intent, contract, or artifact owner. */
function projectActionInstructionPolarity(input: string): { affirmative: ActionInstructionClause[]; negative: NegatedActionInstruction[] } {
  const result: ActionInstructionClause[] = [];
  const negativeClauses: NegatedActionInstruction[] = [];
  let hypotheticalSentence = false;
  for (const { syntax, ...clause } of projectInstructionClauses(String(input || ''))) {
    // i18n-allow: Existing hypothetical/quotation boundaries shared by action owners.
    hypotheticalSentence ||= /(?:如果|假如|假设|例如|举例)|\b(?:if|suppose|assuming|for\s+example)\b/iu.test(syntax);
    if (!hypotheticalSentence) {
      // Contrast starts a fresh affirmative obligation, unlike a coordinated prohibition.
      // i18n-allow: Multilingual contrast and predicate-negation grammar.
      const contrasts = /但是|不过|而是|但|\b(?:but|instead)\b/giu;
      let offset = 0;
      for (const boundary of [...syntax.matchAll(contrasts), { index: syntax.length, 0: '' }]) {
        const part = clause.probe.slice(offset, boundary.index);
        const grammar = syntax.slice(offset, boundary.index);
        // A bare Chinese 不 is a negator only before a predicate, not a character
        // inside its object. Relative clauses qualify that object, not the later command.
        // i18n-allow: Existing operation vocabulary scopes predicate negation.
        const negativePredicate = /(?:不要|别|无需|不需要|不用|不必|不能|不得|不准|禁止|请勿|勿|不(?=\s*(?:(?:再(?:次)?|重新|继续|对外|[一二三四五六七八九十\d]+次)\s*)*(?:创建|新建|生成|写入|保存|另存|导出|起草|撰写|制作|编辑|修改|修订|调整|更新|追加|替换|删除|重命名|移动|复制|覆盖|改成|改为|换成|读取|查看|打开|运行|执行|调用|选入|发送|提交|发布|上传|支付|付款|付费|转账|签署|归档|入案)))|\b(?:do\s+not|don't|never|without|cannot|can't|no\s+need\s+to|must\s+not|should\s+not|not)\b/iu;
        let positive = part, predicateText = grammar;
        for (let count = 0; count < 20; count++) {
          const negative = negativePredicate.exec(predicateText);
          if (!negative) break;
          const before = positive.slice(0, negative.index);
          // i18n-allow: Chinese relative-clause input grammar, not user-visible text.
          const relative = /^[^的，,。；;\n]{0,80}的/u.exec(predicateText.slice(negative.index));
          // i18n-allow: Chinese object-marker input grammar, not user-visible text.
          if (relative && /(?:把|将|对)/u.test(predicateText.slice(0, negative.index))) {
            const end = negative.index + relative[0].length;
            positive = before + positive.slice(end);
            predicateText = predicateText.slice(0, negative.index) + predicateText.slice(end);
          } else {
            negativeClauses.push({ text: positive.slice(negative.index).trim(), instruction: positive.slice(negative.index + negative[0].length).trim() });
            positive = before; break;
          }
        }
        positive = positive.trim();
        if (positive) result.push({ ...clause, probe: positive });
        offset = boundary.index! + boundary[0].length;
      }
    }
    if (/[。！？!?；;\n]\s*$|\.\s*$/u.test(clause.probe)) hypotheticalSentence = false;
  }
  return { affirmative: result, negative: negativeClauses };
}

export function affirmativeActionInstructionClauses(input: string): ActionInstructionClause[] {
  return projectActionInstructionPolarity(input).affirmative;
}

export function affirmativeActionClauses(input: string): string[] {
  return affirmativeActionInstructionClauses(input).map(clause => clause.probe);
}

export function negatedActionClauses(input: string): string[] {
  return negatedActionInstructions(input).map(clause => clause.text);
}

export function negatedActionInstructions(input: string): NegatedActionInstruction[] {
  return projectActionInstructionPolarity(input).negative;
}

export { negatedActionInstructions as negatedActionInstructionClauses };

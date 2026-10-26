import { describe, expect, it } from 'vitest';
import * as instructions from '../server/cognition/no_tool_instruction';
const cases: [string, boolean][] = [
 ['不要查询任何来源或读取本地文件。', true], ['不要查询官方来源或打开 a.docx。', true],
 ['不要进行任何查询。', true], ['不要联网查资料。', true], ['不要浏览网页。', true], ['只用当前聊天已有材料，不要补查。', true], ['不要查询本地文件，但请查询官方原文。', false], ['Do not query local files, but retrieve the official provisions.', false],
 ['不要查询资料。', true], ['不要再检索官方来源。', true], ['请勿继续搜索。', true], ['不查询外部来源。', true],
 ['Do not search official sources.', true], ['Do not query the database.', true], ['Never retrieve new source text.', true], ['No tools.', true],
 ['引用示例：“不要查询资料。”这里只解释这句话。', false], ['如果不要查询外部来源，结果会怎样？请讨论这个假设。', false],
 ['“Do not search.” is a quoted instruction. Explain its grammar.', false], ['If I said do not query, what would that mean?', false],
 ['请核对官方法条，不生成文件。', false], ['Do not create files, but check the official provisions.', false],
 ['不要读取本地文件，但请核对官方原文。', false], ['引用示例：“不要使用工具。”只说明这句话。', false],
];
describe('canonical no-lookup scope for supplemental source reads', () => {
 it.each(cases)('%s => %s', (text, expected) => {
  const veto = (instructions as typeof instructions & {hasExplicitNoLookupInstruction?: (value:string)=>boolean}).hasExplicitNoLookupInstruction;
  expect(veto?.(text)).toBe(expected);
 });
});

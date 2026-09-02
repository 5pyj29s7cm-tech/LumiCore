import { describe, expect, it } from 'vitest';
import {
  buildTextReplyStyleOverlay,
  formatUserVisibleReplyForReadability,
  formatVerifiedTaskResultForReadability,
} from '../server/cognition/reply_style';

describe('shared text reply style', () => {
  it('keeps task updates readable without exposing internal execution plumbing', () => {
    const overlay = buildTextReplyStyleOverlay('task');

    expect(overlay).toContain('blank line between paragraphs');
    expect(overlay).toContain('verified outcome');
    expect(overlay).toContain('exact blocker');
    expect(overlay).toContain('Do not dump tool names, task ids, receipt schemas');
    expect(overlay).toContain('Do not produce a single dense wall of text');
    expect(overlay).toContain('list marker must start on its own line');
  });

  it('places unmistakable adjacent Markdown task-result bullets on their own lines', () => {
    expect(formatVerifiedTaskResultForReadability(
      '根据读取内容：- 项目 name：lumi-core  - 项目 version：3.1.0',
    )).toBe('根据读取内容：\n\n- 项目 name：lumi-core\n- 项目 version：3.1.0');
  });

  it('does not rewrite code, JSON, paths, URLs, or prose without an inline list', () => {
    const code = '```text\n说明：- 原样保留  - 第二项\n```';
    const json = '{"note":"说明：- 原样保留  - 第二项"}';
    const pathAndUrl = '路径 D:\\work\\a-b.txt，地址 https://example.com/a-b；正常聊天保持原样。';
    expect(formatVerifiedTaskResultForReadability(code)).toBe(code);
    expect(formatVerifiedTaskResultForReadability(json)).toBe(json);
    expect(formatVerifiedTaskResultForReadability(pathAndUrl)).toBe(pathAndUrl);
  });

  it('repairs every unmistakable bullet in the compact live conceptual-answer shape', () => {
    const compact = '判断成功需要事实证据：- **视觉证据**：看到目标状态。- **文件证据**：读取目标文件。- **反馈证据**：收到应用确认。⚠️ 注意：  - success=true 不能单独证明成功；  - 没报错也不等于成功。需要我给出示例吗？';
    expect(formatUserVisibleReplyForReadability(compact)).toBe([
      '判断成功需要事实证据：',
      '',
      '- **视觉证据**：看到目标状态。',
      '- **文件证据**：读取目标文件。',
      '- **反馈证据**：收到应用确认。',
      '',
      '⚠️ 注意：',
      '',
      '- success=true 不能单独证明成功；',
      '- 没报错也不等于成功。',
      '',
      '需要我给出示例吗？',
    ].join('\n'));
  });

  it('splits adjacent named fields and honors an explicit three-line path request', () => {
    expect(formatUserVisibleReplyForReadability(
      '项目名称（`name`）是：`lumi-core`  版本号（`version`）是：`3.1.0`',
    )).toBe('项目名称（`name`）是：`lumi-core`\n版本号（`version`）是：`3.1.0`');

    expect(formatUserVisibleReplyForReadability(
      'D:\\lumiOS\\package.json  lumi-core  3.1.0',
      { task: '把路径、name 和 version 分三行告诉我。' },
    )).toBe('D:\\lumiOS\\package.json\nlumi-core\n3.1.0');
  });

  it('splits the exact live read shape when the first field label follows introductory text', () => {
    expect(formatUserVisibleReplyForReadability(
      '`package.json` 中的项目名称（`name`）是：**lumi-core**  版本号（`version`）是：**3.1.0**',
    )).toBe('`package.json` 中的项目名称（`name`）是：**lumi-core**\n版本号（`version`）是：**3.1.0**');
  });

  it('keeps ordinary spacing, complete JSON, code, URLs, and Windows paths intact', () => {
    const prose = '你好  今天我们继续聊，不需要机械换行。';
    const json = '{"path":"D:\\\\work\\\\a-b.txt","url":"https://example.com/a-b"}';
    const code = '说明：`value  - literal`  ```text\n标题：- 原样\n```';
    const pathAndUrl = 'D:\\work\\a-b.txt 连接 https://example.com/a-b';
    expect(formatUserVisibleReplyForReadability(prose)).toBe(prose);
    expect(formatUserVisibleReplyForReadability(json)).toBe(json);
    expect(formatUserVisibleReplyForReadability(code)).toBe(code);
    expect(formatUserVisibleReplyForReadability(pathAndUrl)).toBe(pathAndUrl);
  });
});

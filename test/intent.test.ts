import { describe, it, expect } from 'vitest';
import { classifyIntent, IntentResult } from '../server/cognition/intent';

function c(input: string): IntentResult {
  return classifyIntent(input);
}

describe('Intent Classifier', () => {
  // ── Greetings ──
  describe('greetings → conversation', () => {
    const cases = ['hi', 'hey', 'hello', '你好', '嗨', '您好', '在吗', '早上好', 'good morning', 'good evening'];
    cases.forEach(input => {
      it(`"${input}" → conversation (high confidence)`, () => {
        const r = c(input);
        expect(r.category).toBe('conversation');
        expect(r.confidence).toBeGreaterThanOrEqual(0.85);
      });
    });
  });

  // ── Small talk ──
  describe('small talk → conversation', () => {
    it('谢谢 → conversation', () => {
      const r = c('谢谢');
      expect(r.category).toBe('conversation');
      expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('thank you → conversation', () => {
      const r = c('thank you!');
      expect(r.category).toBe('conversation');
    });

    it('再见 / bye → conversation', () => {
      expect(c('再见').category).toBe('conversation');
      expect(c('bye').category).toBe('conversation');
    });

    it('嗯 / 好的 → conversation', () => {
      expect(c('嗯').category).toBe('conversation');
      expect(c('好的').category).toBe('conversation');
    });
  });

  // ── Commands ──
  describe('commands', () => {
    it('打开 + app → command:open', () => {
      const r = c('打开 Chrome');
      expect(r.category).toBe('command');
      expect(r.subIntent).toBe('open');
      expect(r.entities.target).toBe('Chrome');
    });

    it('foreground WeChat sends are not classified as generic app opens', () => {
      const r = c('\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89');
      expect(r.category).toBe('command');
      expect(r.subIntent).toBe('messaging_send');
      expect(r.directToolCall).toBeUndefined();
    });

    it('打开 + URL → command:open with directToolCall (URL pattern)', () => {
      const r = c('打开网页 https://example.com');
      expect(r.category).toBe('command');
      // First COMMAND_PATTERN (generic open) matches before the URL-specific one
      expect(r.subIntent).toBe('open');
      expect(r.directToolCall).toBeDefined();
    });

    it('创建/新建 → command:create', () => {
      expect(c('创建文件 test.ts').subIntent).toBe('create');
      expect(c('新建文件夹 components').subIntent).toBe('create');
    });

    it('删除/移除 → command:delete', () => {
      expect(c('删除文件 old.txt').subIntent).toBe('delete');
    });

    it('列出/显示 文件 → command:list_files', () => {
      const r = c('列出桌面文件');
      expect(r.subIntent).toBe('list_files');
      expect(r.needsLLM).toBe(false);
    });

    it('截屏/screenshot → command:screenshot', () => {
      expect(c('截屏').subIntent).toBe('screenshot');
      expect(c('screenshot').category).toBe('command');
    });

    it('关闭 + target → command:close', () => {
      expect(c('关闭 VS Code').subIntent).toBe('close');
    });
    it('foreground WeChat chat reading is not classified as generic app open or sending', () => {
      const r = c('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9');
      expect(r.category).toBe('command');
      expect(r.subIntent).toBe('messaging_read');
      expect(r.directToolCall).toBeUndefined();
    });

    it('does not turn a negated desktop constraint into a direct open command', () => {
      const r = c('\u8fd9\u662f\u684c\u9762 relay \u538b\u6d4b\u3002\u8bf7\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u7684\u6807\u9898\u548c\u5f53\u524d\u684c\u9762\u8fd0\u884c\u72b6\u6001\uff0c\u7ed9\u51fa\u4f60\u5b9e\u9645\u8bfb\u53d6\u5230\u7684\u7ed3\u679c\u3002\u7981\u6b62\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u4efb\u4f55\u5185\u5bb9');
      expect(r.directToolCall).toBeUndefined();
      expect(r.subIntent).not.toBe('open');
    });
  });

  // ── Web ──
  describe('web search / fetch', () => {
    it('搜索/查找 → web:web_search', () => {
      const r = c('搜索 TypeScript 教程');
      expect(r.category).toBe('web');
      expect(r.subIntent).toBe('web_search');
      expect(r.entities.query).toBe('TypeScript 教程');
    });

    it('获取网页 → web:url_fetch', () => {
      const r = c('获取网页 https://example.com');
      expect(r.category).toBe('web');
      expect(r.subIntent).toBe('url_fetch');
    });
  });

  // ── Code ──
  describe('code operations', () => {
    it('修复/fix → code:fix', () => {
      expect(c('修复这个 bug').subIntent).toBe('fix');
    });

    it('重构/refactor → code:refactor', () => {
      expect(c('重构这段代码').subIntent).toBe('refactor');
    });

    it('实现/implement → code:implement', () => {
      expect(c('实现一个登录功能').subIntent).toBe('implement');
    });

    it('解释/explain → code:explain', () => {
      expect(c('解释这段代码').subIntent).toBe('explain');
    });

    it('测试/test → code:test', () => {
      expect(c('写测试').category).toBe('code');
      expect(c('写测试').subIntent).toBe('test');
    });

    it('does not classify a conversation continuity test as code work', () => {
      expect(c('我们开始一个连续对话测试，请记住代号青穹-17').category).not.toBe('code');
    });
  });

  // ── File ──
  describe('file operations', () => {
    it('读取文件 → file:read_file with path', () => {
      const r = c('读取文件 config.json');
      expect(r.category).toBe('file');
      expect(r.subIntent).toBe('read_file');
      expect(r.entities.filePath).toBe('config.json');
    });

    it('写文件 → file:write_file', () => {
      expect(c('写文件到 output.txt').subIntent).toBe('write_file');
    });
  });

  // ── System ──
  describe('system queries', () => {
    it('系统信息 → system with directToolCall', () => {
      const r = c('系统状态');
      expect(r.category).toBe('system');
      expect(r.needsLLM).toBe(false);
      expect(r.directToolCall!.name).toBe('get_system_info');
    });

    it('CPU/内存 → system', () => {
      expect(c('CPU 内存').category).toBe('system');
    });

    it('版本 → system', () => {
      expect(c('version').category).toBe('system');
    });
  });

  // ── Questions ──
  describe('questions', () => {
    it('怎么 / 如何 / why → question', () => {
      expect(c('怎么用 React').category).toBe('question');
      expect(c('what is TypeScript').category).toBe('question');
    });

    it('ends with ? / ？→ question', () => {
      expect(c('Is this correct?').category).toBe('question');
      expect(c('这个对吗？').category).toBe('question');
    });

    it('treats questions about prior Lumi behavior as questions, not commands', () => {
      for (const text of [
        '你怎么运行了这么久才回我？',
        '你打开画图做什么？',
        '刚才为什么又打开了画图？',
        '能不能听见我说话？',
      ]) {
        const result = c(text);
        expect(result.category, text).toBe('question');
        expect(result.directToolCall, text).toBeUndefined();
      }
    });
  });

  // ── Agent ──
  describe('agent management', () => {
    it('"create/make/new" matches command before agent patterns', () => {
      // COMMAND_PATTERNS are checked before AGENT_PATTERNS in classifyIntent.
      // "new agent" has "new" which matches the command regex first.
      const r = c('create a new agent');
      expect(r.category).toBe('command');
      expect(r.subIntent).toBe('create');
    });

    it('agent management phrases → agent', () => {
      expect(c('代理列表').category).toBe('agent');
      expect(c('助手切换').category).toBe('agent');
    });
  });

  // ── Edge cases ──
  describe('edge cases', () => {
    it('empty input → unknown', () => {
      const r = c('');
      expect(r.category).toBe('unknown');
      expect(r.confidence).toBe(0);
    });

    it('whitespace only → unknown', () => {
      const r = c('   ');
      expect(r.category).toBe('unknown');
    });

    it('short OK-ish phrase → conversation via small talk', () => {
      // "ok let me think" starts with "ok" which matches SMALL_TALK pattern
      const r = c('ok let me think');
      expect(r.category).toBe('conversation');
      expect(r.confidence).toBe(0.85);
    });

    it('long unknown → unknown', () => {
      const r = c('this is a very long message that does not clearly match any known pattern whatsoever');
      expect(r.category).toBe('unknown');
    });
  });
});

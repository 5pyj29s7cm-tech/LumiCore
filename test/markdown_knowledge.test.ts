import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import {
  enrichMarkdownKnowledgeContent,
  normalizeKnowledgeLinkTarget,
  type MarkdownKnowledgeMetadata,
} from '../server/knowledge/markdown';

let cleanup = () => {};
let testUrl = '';

describe('Markdown knowledge metadata', () => {
  it('extracts Obsidian-style properties, tags, wikilinks, and markdown links', () => {
    const source = `---
title: Project Lumi
aliases: [Lumi KB, Knowledge Base]
tags:
  - ai
  - workspace/notes
owner: team
---
# Project Lumi

Links to [[Source Note|source]] and [[Roadmap#Q3]].
See [Spec](docs/spec.md) and #rag.

\`#notatag [[Nope]]\`

\`\`\`
#code
[[Nope]]
\`\`\`
`;

    const enriched = enrichMarkdownKnowledgeContent(source, 'Project Lumi.md');

    expect(enriched.metadata).toMatchObject({
      title: 'Project Lumi',
      aliases: ['Lumi KB', 'Knowledge Base'],
      tags: ['ai', 'workspace/notes', 'rag'],
      wikiLinks: ['Source Note', 'Roadmap'],
      markdownLinks: ['docs/spec.md'],
    });
    expect(enriched.metadata.frontmatter.owner).toBe('team');
    expect(enriched.content).toContain('[Markdown Source]');
    expect(enriched.content).toContain('Tags: #ai, #workspace/notes, #rag');
    expect(enriched.metadata.wikiLinks).not.toContain('Nope');
    expect(enriched.metadata.tags).not.toContain('code');
  });

  it('normalizes link targets for backlink matching', () => {
    expect(normalizeKnowledgeLinkTarget('Folder/Source Note.md#Heading')).toBe('source note');
    expect(normalizeKnowledgeLinkTarget('[[Roadmap|display]]')).toBe('roadmap');
    expect(normalizeKnowledgeLinkTarget('https://example.com/Roadmap.md')).toBe('');
  });
});

describe('RAG markdown source metadata', () => {
  beforeAll(async () => {
    const app = await makeApp();
    const { default: fileRoutes } = await import('../routes/files');
    app.apiRouter.use('/', fileRoutes);
    testUrl = app.url;
    cleanup = app.cleanup;
  });

  afterAll(() => {
    cleanup();
  });

  it('does not expose the personal knowledge list without the local identity token', async () => {
    const response = await fetch(`${testUrl}/api/files/list?domain=personal`);
    expect(response.status).toBe(401);
  });

  it('stores tags, aliases, and links as retrievable memory keywords', async () => {
    const { ingestDocument } = await import('../server/agents/rag');
    const { readDB } = await import('../db_layer');
    const sourceMetadata: MarkdownKnowledgeMetadata = {
      kind: 'markdown',
      title: 'Project Lumi',
      aliases: ['Lumi KB'],
      tags: ['rag', 'workspace/notes'],
      wikiLinks: ['Source Note'],
      markdownLinks: ['docs/spec.md'],
      links: ['Source Note', 'docs/spec.md'],
      frontmatter: { title: 'Project Lumi' },
    };

    const result = await ingestDocument(
      'user-md',
      'lumi',
      'Project Lumi.md',
      'Project Lumi keeps source metadata attached to every chunk.',
      {
        filePath: 'Project Lumi.md',
        sourceMetadata,
      },
    );

    const db = readDB();
    const stored = db.memories.find((memory: any) => memory.id === result.memoryIds[0]);
    expect(stored?.keywords).toEqual(expect.arrayContaining([
      'title:Project Lumi',
      'alias:Lumi KB',
      'tag:rag',
      'tag:workspace/notes',
      'wikilink:Source Note',
      'link:docs/spec.md',
    ]));
  });

  it('connects and syncs an Obsidian vault into Lumi knowledge', async () => {
    const { readDB } = await import('../db_layer');
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi_obsidian_vault_'));
    const cookie = `token=${jwt.sign({ uid: 'obsidian-user', username: 'obsidian-user' }, JWT_SECRET)}`;

    try {
      fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
      fs.mkdirSync(path.join(vaultDir, 'cases'), { recursive: true });
      fs.writeFileSync(path.join(vaultDir, 'Source Note.md'), [
        '# Source Note',
        '',
        'This source note should be available as a wikilink target.',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(path.join(vaultDir, 'cases', 'Matter.md'), [
        '---',
        'title: Obsidian Matter',
        'aliases: [Matter Alias]',
        'tags:',
        '  - law',
        '  - client',
        '---',
        '# Obsidian Matter',
        '',
        'Links to [[Source Note]] and keeps inline #rag context.',
      ].join('\n'), 'utf-8');

      const connectRes = await fetch(`${testUrl}/api/files/obsidian/connect?domain=personal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ vaultPath: vaultDir, maxFiles: 20 }),
      });
      expect(connectRes.ok).toBe(true);
      const connected = await connectRes.json();
      expect(connected.noteCount).toBe(2);
      expect(connected.vault.isObsidianVault).toBe(true);

      const syncRes = await fetch(`${testUrl}/api/files/obsidian/sync?domain=personal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ vaultId: connected.vault.id, maxFiles: 20 }),
      });
      expect(syncRes.ok).toBe(true);
      const synced = await syncRes.json();
      expect(synced.synced).toBe(2);
      expect(synced.failed).toBe(0);

      const listRes = await fetch(`${testUrl}/api/files/list?domain=personal`, {
        headers: { Cookie: cookie },
      });
      expect(listRes.ok).toBe(true);
      const listed = await listRes.json();
      const matter = listed.files.find((file: any) => file.obsidianRelativePath === 'cases/Matter.md');
      expect(matter).toMatchObject({
        source: 'obsidian',
        obsidianVaultName: path.basename(vaultDir),
        sourceTitle: 'Obsidian Matter',
      });
      expect(matter.sourceTags).toEqual(expect.arrayContaining(['law', 'client', 'rag']));
      expect(matter.sourceLinks).toEqual(expect.arrayContaining(['Source Note']));

      const db = readDB();
      const memories = db.memories.filter((memory: any) => (
        memory.userId === 'obsidian-user'
        && memory.agentId === 'lumi'
        && memory.type === 'knowledge'
        && String(memory.sourceInteractionId || '').includes('obsidian-')
      ));
      expect(memories.length).toBeGreaterThan(0);
      expect(memories.flatMap((memory: any) => memory.keywords || [])).toEqual(expect.arrayContaining([
        'title:Obsidian Matter',
        'alias:Matter Alias',
        'tag:law',
        'tag:client',
        'tag:rag',
        'wikilink:Source Note',
      ]));
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});

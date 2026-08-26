#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import sqlite3Package from 'sqlite3';
import iconv from 'iconv-lite';

const sqlite3 = sqlite3Package.verbose();
const apply = process.argv.includes('--apply');

function dataRoot() {
  return process.env.LUMI_DATA_DIR || path.join(os.homedir(), 'LumiCore');
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '_',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

const MOJIBAKE_TOKENS = [
  '\u00c3',
  '\u00c2',
  '\ufffd',
  '\u00e6',
  '\u00e9',
  '\u00e8',
  '\u00e7',
  '\u00e5',
  '\u00e4',
  '\u951f',
  '\u93c2',
  '\u6d93',
  '\u7f01',
  '\u7015',
  '\u6fc2',
  '\u5a34',
  '\u6d7c',
  '\u5fe1',
  '\u9439',
  '\u9359',
];

function looksMojibake(value) {
  return /[\u0080-\u009f]/.test(value)
    || /[\u00c0-\u00ff][\u0080-\u00bf]/.test(value)
    || MOJIBAKE_TOKENS.some((token) => value.includes(token));
}

function textScore(value) {
  const replacement = (value.match(/\ufffd/g) || []).length;
  const controls = (value.match(/[\u0080-\u009f]/g) || []).length;
  const mojibake = MOJIBAKE_TOKENS.reduce((sum, token) => sum + (value.includes(token) ? 1 : 0), 0);
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (value.match(/[A-Za-z0-9._ -]/g) || []).length;
  return cjk * 2 + ascii * 0.15 - replacement * 8 - controls * 6 - mojibake * 2;
}

function repairFilename(value) {
  const original = String(value || '').normalize('NFC');
  if (!original || !looksMojibake(original)) return original;
  const candidates = new Set([original]);
  try { candidates.add(Buffer.from(original, 'latin1').toString('utf8').normalize('NFC')); } catch {}
  try { candidates.add(iconv.decode(iconv.encode(original, 'gbk'), 'utf8').normalize('NFC')); } catch {}
  try { candidates.add(iconv.decode(iconv.encode(original, 'gb18030'), 'utf8').normalize('NFC')); } catch {}
  return [...candidates].sort((a, b) => textScore(b) - textScore(a))[0] || original;
}

function sanitizeFileName(value, fallback = 'untitled') {
  const safe = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
  const base = path.basename(safe || fallback);
  return base && base !== '.' && base !== '..' ? base : fallback;
}

function discoverKnowledgeDirs(root) {
  const dataDir = path.join(root, 'data');
  const dirs = [];
  const personal = path.join(dataDir, 'knowledge');
  if (fs.existsSync(personal)) dirs.push({ domain: 'personal', orgId: '', dir: personal });

  const orgRoot = path.join(dataDir, 'org');
  if (fs.existsSync(orgRoot)) {
    for (const entry of fs.readdirSync(orgRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(orgRoot, entry.name, 'knowledge');
      if (fs.existsSync(dir)) dirs.push({ domain: 'work', orgId: entry.name, dir });
    }
  }
  return dirs;
}

function uniqueTargetPath(dir, oldPath, desiredName, reservedTargets) {
  const ext = path.extname(desiredName);
  const base = path.basename(desiredName, ext);
  let candidate = desiredName;
  let i = 1;
  while (true) {
    const target = path.join(dir, candidate);
    const targetKey = path.resolve(target).toLowerCase();
    const oldKey = path.resolve(oldPath).toLowerCase();
    const exists = fs.existsSync(target) && targetKey !== oldKey;
    if (!exists && !reservedTargets.has(targetKey)) return target;
    candidate = `${base} (${i})${ext}`;
    i += 1;
  }
}

function buildPlan(root) {
  const reservedTargets = new Set();
  const plan = [];
  for (const scope of discoverKnowledgeDirs(root)) {
    for (const entry of fs.readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const repaired = sanitizeFileName(repairFilename(entry.name), entry.name);
      if (!repaired || repaired === entry.name) continue;
      const oldPath = path.join(scope.dir, entry.name);
      const newPath = uniqueTargetPath(scope.dir, oldPath, repaired, reservedTargets);
      reservedTargets.add(path.resolve(newPath).toLowerCase());
      plan.push({
        domain: scope.domain,
        orgId: scope.orgId,
        oldName: entry.name,
        newName: path.basename(newPath),
        oldPath,
        newPath,
      });
    }
  }
  return plan;
}

function openDb(dbPath) {
  return new sqlite3.Database(dbPath);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function escapedJsonString(value) {
  return JSON.stringify(value).slice(1, -1);
}

function addReplacement(replacements, from, to) {
  if (!from || from === to) return;
  replacements.push({ from, to });
}

function buildReplacements(plan) {
  const replacements = [];
  for (const item of plan) {
    addReplacement(replacements, item.oldPath, item.newPath);
    addReplacement(replacements, item.oldPath.replace(/\\/g, '/'), item.newPath.replace(/\\/g, '/'));
    addReplacement(replacements, escapedJsonString(item.oldPath), escapedJsonString(item.newPath));
    addReplacement(replacements, escapedJsonString(item.oldPath.replace(/\\/g, '/')), escapedJsonString(item.newPath.replace(/\\/g, '/')));
    addReplacement(replacements, item.oldName, item.newName);
    addReplacement(replacements, escapedJsonString(item.oldName), escapedJsonString(item.newName));
  }
  return replacements.sort((a, b) => b.from.length - a.from.length);
}

function replaceEverywhere(value, replacements) {
  let next = value;
  for (const { from, to } of replacements) {
    if (next.includes(from)) next = next.split(from).join(to);
  }
  return next;
}

async function updateDatabaseText(dbPath, plan) {
  if (!fs.existsSync(dbPath) || plan.length === 0) return { updatedCells: 0, updatedRows: 0 };
  const replacements = buildReplacements(plan);
  const db = openDb(dbPath);
  let updatedCells = 0;
  let updatedRows = 0;
  try {
    await run(db, 'BEGIN TRANSACTION');
    const tables = await all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    for (const { name: table } of tables) {
      const info = await all(db, `PRAGMA table_info(${quoteIdent(table)})`);
      const textCols = info
        .filter((col) => /TEXT|CHAR|CLOB|VARCHAR/i.test(col.type || ''))
        .map((col) => col.name);
      if (textCols.length === 0) continue;

      const selectSql = `SELECT rowid AS __rowid, ${textCols.map(quoteIdent).join(', ')} FROM ${quoteIdent(table)}`;
      const rows = await all(db, selectSql);
      for (const row of rows) {
        const changed = [];
        for (const col of textCols) {
          const value = row[col];
          if (typeof value !== 'string' || value.length === 0) continue;
          const next = replaceEverywhere(value, replacements);
          if (next !== value) changed.push([col, next]);
        }
        if (changed.length === 0) continue;
        const setSql = changed.map(([col]) => `${quoteIdent(col)} = ?`).join(', ');
        await run(
          db,
          `UPDATE ${quoteIdent(table)} SET ${setSql} WHERE rowid = ?`,
          [...changed.map(([, value]) => value), row.__rowid],
        );
        updatedCells += changed.length;
        updatedRows += 1;
      }
    }
    await run(db, 'COMMIT');
  } catch (err) {
    try { await run(db, 'ROLLBACK'); } catch {}
    throw err;
  } finally {
    await closeDb(db);
  }
  return { updatedCells, updatedRows };
}

function writeReport(reportPath, data) {
  fs.writeFileSync(reportPath, JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const root = dataRoot();
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(dataDir, 'lumi.db');
  const id = stamp();
  const plan = buildPlan(root);
  const reportPath = path.join(dataDir, `knowledge-filename-repair-${id}.json`);
  const dbBackupPath = `${dbPath}.bak.knowledge-filenames.${id}`;

  const initialReport = {
    applied: false,
    dataRoot: root,
    dbPath,
    dbBackupPath: fs.existsSync(dbPath) ? dbBackupPath : null,
    planned: plan,
    renamed: [],
    database: { updatedCells: 0, updatedRows: 0 },
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(dataDir, { recursive: true });
  writeReport(reportPath, initialReport);

  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', reportPath, planned: plan.length, plan }, null, 2));
    return;
  }

  if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, dbBackupPath);

  const renamed = [];
  try {
    for (const item of plan) {
      fs.renameSync(item.oldPath, item.newPath);
      renamed.push(item);
    }
    const database = await updateDatabaseText(dbPath, plan);
    const finalReport = {
      ...initialReport,
      applied: true,
      renamed,
      database,
      completedAt: new Date().toISOString(),
    };
    writeReport(reportPath, finalReport);
    console.log(JSON.stringify({
      applied: true,
      renamed: renamed.length,
      database,
      reportPath,
      dbBackupPath: fs.existsSync(dbPath) ? dbBackupPath : null,
    }, null, 2));
  } catch (err) {
    for (const item of renamed.slice().reverse()) {
      try {
        if (fs.existsSync(item.newPath) && !fs.existsSync(item.oldPath)) {
          fs.renameSync(item.newPath, item.oldPath);
        }
      } catch {}
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

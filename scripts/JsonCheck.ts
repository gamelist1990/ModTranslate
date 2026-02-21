import * as path from "node:path";
import * as fs from "node:fs/promises";
import { loadJarZip, readZipText, removeZipFile, saveJarZip } from "../src/modtranslate/jar";

type CheckIssue = {
  level: "error" | "warn" | "info";
  jarPath: string;
  entryPath: string;
  message: string;
  location?: { line: number; column: number };
};

type Options = {
  langs: string[];
  inputs: string[];
  fix: boolean;
  backup: boolean;
};

function usage(): string {
  return [
    "JsonCheck.ts - jar内の lang/*.json 破損チェック（必要なら削除も）",
    "",
    "使い方:",
    "  bun scripts/JsonCheck.ts [<jar|dir> ...] [--lang ja_jp] [--langs ja_jp,en_us] [--fix] [--no-backup]",
    "",
    "引数なしの場合:",
    "  カレントディレクトリを再帰スキャンして jar/zip を探し、ja_jp 等の JSON 破損があれば jar から削除します（= --fix 相当）",
    "",
    "例:",
    "  bun scripts/JsonCheck.ts C:/mods --lang ja_jp",
    "  bun scripts/JsonCheck.ts some-mod.jar --langs ja_jp,en_us",
    "  bun scripts/JsonCheck.ts C:/mods --lang ja_jp --fix",
  ].join("\n");
}

function parseArgs(args: string[]): Options {
  const langs: string[] = [];
  const inputs: string[] = [];
  let fix = false;
  let backup = true;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === "--lang") {
      const v = args[i + 1];
      if (!v) throw new Error("--lang の値がありません");
      langs.push(v);
      i++;
      continue;
    }
    if (a === "--langs") {
      const v = args[i + 1];
      if (!v) throw new Error("--langs の値がありません");
      langs.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
      i++;
      continue;
    }
    if (a === "--fix") {
      fix = true;
      continue;
    }
    if (a === "--no-fix") {
      fix = false;
      continue;
    }
    if (a === "--no-backup") {
      backup = false;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`不明なオプション: ${a}`);
    }
    inputs.push(a);
  }

  if (langs.length === 0) langs.push("ja_jp");

  // 引数なしならカレントを対象にして、要求通り "そのまま実行" で修復(削除)まで行う
  if (inputs.length === 0) {
    inputs.push(process.cwd());
    fix = true;
  }

  return { langs: [...new Set(langs)], inputs, fix, backup };
}

async function statSafe(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function collectJarPaths(inputPath: string): Promise<string[]> {
  const st = await statSafe(inputPath);
  if (!st) return [];
  if (st.isFile()) {
    const lower = inputPath.toLowerCase();
    if (lower.endsWith(".jar") || lower.endsWith(".zip")) return [inputPath];
    return [];
  }

  if (!st.isDirectory()) return [];

  const out: string[] = [];
  const queue: string[] = [inputPath];

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith(".jar") || lower.endsWith(".zip")) out.push(full);
    }
  }

  return out;
}

function removeUtf8Bom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function posToLineCol(text: string, pos: number): { line: number; column: number } {
  // 1-based
  let line = 1;
  let lastNL = -1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNL = i;
    }
  }
  return { line, column: pos - lastNL };
}

function parseJsonWithLocation(textRaw: string):
  | { ok: true; value: unknown; warns: string[] }
  | { ok: false; message: string; location?: { line: number; column: number } } {
  const warns: string[] = [];
  const text = removeUtf8Bom(textRaw);

  if (text.includes("\u0000")) warns.push("NUL(\\u0000) を含みます");

  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      warns.push("JSONのトップレベルが object ではありません");
    } else {
      // lang json は基本的に { "key": "value" } なので軽く検査
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof k !== "string" || k.length === 0) {
          warns.push("空キーが存在する可能性があります");
          break;
        }
        if (typeof v !== "string") {
          warns.push(`値が string ではないキーがあります: ${k}`);
          break;
        }
      }
    }

    return { ok: true, value, warns };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // V8 の "... at position N" 形式を拾う
    const m = /position\s+(\d+)/i.exec(msg);
    if (m) {
      const pos = Number(m[1]);
      if (!Number.isNaN(pos)) {
        return { ok: false, message: msg, location: posToLineCol(text, pos) };
      }
    }
    return { ok: false, message: msg };
  }
}

async function ensureBackup(jarPath: string): Promise<string | null> {
  const bakPath = `${jarPath}.bak`;
  const st = await statSafe(bakPath);
  if (st && st.isFile()) return bakPath;
  try {
    await fs.copyFile(jarPath, bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

function isLangJsonEntry(entryPath: string, langs: string[]): boolean {
  const p = entryPath.replace(/\\/g, "/");
  if (!p.startsWith("assets/")) return false;
  const lower = p.toLowerCase();

  for (const lang of langs) {
    const langLower = lang.toLowerCase();

    // 一般的: assets/<ns>/lang/<lang>.json
    if (lower.endsWith(`/lang/${langLower}.json`)) return true;

    // たまに: assets/<ns>/<lang>.json
    if (lower.endsWith(`/${langLower}.json`)) return true;
  }

  return false;
}

async function checkJar(jarPath: string, langs: string[], fix: boolean, backup: boolean): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];
  let zip;
  try {
    zip = await loadJarZip(jarPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push({ level: "error", jarPath, entryPath: "(open)", message: `jarを開けません: ${msg}` });
    return issues;
  }

  const entries = Object.keys(zip.files)
    .filter((p) => !zip.files[p]?.dir)
    .filter((p) => isLangJsonEntry(p, langs))
    .sort();

  if (entries.length === 0) {
    issues.push({
      level: "warn",
      jarPath,
      entryPath: "(scan)",
      message: `対象のlang jsonが見つかりませんでした (${langs.join(",")})`,
    });
    return issues;
  }

  let brokenDeleted = 0;
  let brokenFound = 0;

  for (const entryPath of entries) {
    let text: string;
    try {
      text = await readZipText(zip, entryPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ level: "error", jarPath, entryPath, message: `読み込み失敗: ${msg}` });
      continue;
    }

    const parsed = parseJsonWithLocation(text);
    if (!parsed.ok) {
      brokenFound++;
      if (fix) {
        removeZipFile(zip, entryPath);
        brokenDeleted++;
        issues.push({
          level: "warn",
          jarPath,
          entryPath,
          message: `JSON破損のため削除: ${parsed.message}`,
          location: parsed.location,
        });
      } else {
        issues.push({
          level: "error",
          jarPath,
          entryPath,
          message: `JSON破損: ${parsed.message}`,
          location: parsed.location,
        });
      }
      continue;
    }

    for (const w of parsed.warns) {
      issues.push({ level: "warn", jarPath, entryPath, message: w });
    }
  }

  if (fix && brokenDeleted > 0) {
    if (backup) {
      const bak = await ensureBackup(jarPath);
      if (!bak) {
        issues.push({ level: "warn", jarPath, entryPath: "(backup)", message: "バックアップ作成に失敗しました（.bak を作れませんでした）" });
      } else {
        issues.push({ level: "info", jarPath, entryPath: "(backup)", message: `バックアップ作成: ${bak}` });
      }
    }
    try {
      await saveJarZip(zip, jarPath);
      issues.push({
        level: "info",
        jarPath,
        entryPath: "(save)",
        message: `破損JSONを ${brokenDeleted} 件削除して jar を保存しました`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ level: "error", jarPath, entryPath: "(save)", message: `jar保存に失敗しました: ${msg}` });
    }
  }

  if (brokenFound === 0) {
    issues.push({ level: "info", jarPath, entryPath: "(scan)", message: `対象JSON ${entries.length} 件: OK` });
  } else if (!fix) {
    issues.push({ level: "warn", jarPath, entryPath: "(scan)", message: `破損JSONを検出: ${brokenFound} 件（--fix で削除）` });
  }

  return issues;
}

function formatIssue(issue: CheckIssue): string {
  const loc = issue.location ? `:${issue.location.line}:${issue.location.column}` : "";
  const lvl = issue.level.toUpperCase();
  return `[${lvl}] ${issue.jarPath} :: ${issue.entryPath}${loc} - ${issue.message}`;
}

async function main(): Promise<number> {
  const { langs, inputs, fix, backup } = parseArgs(process.argv.slice(2));

  const jarPaths: string[] = [];
  for (const input of inputs) {
    const jars = await collectJarPaths(input);
    if (jars.length === 0) {
      console.warn(`[WARN] 入力から jar/zip が見つかりません: ${input}`);
      continue;
    }
    jarPaths.push(...jars);
  }

  const uniqueJars = [...new Set(jarPaths)].sort();
  if (uniqueJars.length === 0) {
    console.error("jar/zip が 0 件です。入力パスを確認してください。");
    return 2;
  }

  let errorCount = 0;
  let warnCount = 0;
  let infoCount = 0;

  for (const jarPath of uniqueJars) {
    const issues = await checkJar(jarPath, langs, fix, backup);
    for (const it of issues) {
      if (it.level === "error") errorCount++;
      else if (it.level === "warn") warnCount++;
      else infoCount++;
      console.log(formatIssue(it));
    }
  }

  const ok = errorCount === 0;
  console.log(
    `\n=== Summary ===\nJars: ${uniqueJars.length}\nLangs: ${langs.join(",")}\nMode: ${fix ? "FIX(delete broken)" : "CHECK only"}\nErrors: ${errorCount}\nWarnings: ${warnCount}\nInfo: ${infoCount}\nResult: ${ok ? "OK" : "NG"}`,
  );

  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    console.error(msg);
    process.exitCode = 2;
  });

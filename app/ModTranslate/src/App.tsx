import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import "./App.css";

type JarFile = { name: string; abs_path: string };

type PlanSummary = {
  total: number;
  skipped_in_jar: number;
  plan_errors: number;
  broken_target_found: number;
  repaired_target: number;
  backup_created: number;
  repair_errors: number;
};

type PlanResult = {
  summary: PlanSummary;
  tasks: Array<{
    jar_path: string;
    jar_name: string;
    namespace: string;
    src_path: string;
    dst_path: string;
  }>;
};

type ProgressEvent = {
  runId: string;
  doneMods: number;
  totalMods: number;
  translated: number;
  skipped: number;
  errors: number;
  current: string;
  keyTotal: number;
  keyDone: number;
  keyNote: string;
};

type LogEvent = { runId: string; line: string };

type DoneEvent = {
  runId: string;
  aborted: boolean;
  summary: PlanSummary;
  translated: number;
  skipped: number;
  errors: number;
  outDir: string;
  elapsedMs: number;
};

function clampInt(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function App() {
  const [commonLangs, setCommonLangs] = useState<string[]>([]);

  const [dir, setDir] = useState<string>("");
  const [outDir, setOutDir] = useState<string>("");
  const [source, setSource] = useState<string>("en_us");
  const [target, setTarget] = useState<string>("ja_jp");

  const [repairBrokenTargetInJar, setRepairBrokenTargetInJar] = useState(false);
  const [backupJars, setBackupJars] = useState(true);

  const [provider, setProvider] = useState<"auto" | "free" | "google-cloud">("auto");
  const [googleApiKey, setGoogleApiKey] = useState<string>("");
  const [gasUrl, setGasUrl] = useState<string>("");
  const [concurrency, setConcurrency] = useState<number>(0);

  const [jarFiles, setJarFiles] = useState<JarFile[]>([]);
  const [selectedJars, setSelectedJars] = useState<string[]>([]);
  const [manualJarPaths, setManualJarPaths] = useState<string>("");

  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  const logsRef = useRef<HTMLDivElement | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const isRunning = runId !== null;

  const request = useMemo(
    () => ({
      dir: dir || "",
      outDir: outDir || "",
      source,
      target,
      jars: selectedJars,
      repairBrokenTargetInJar,
      backupJars,
      translate: {
        provider: provider === "auto" ? null : provider,
        googleApiKey: googleApiKey || null,
        gasUrl: gasUrl || null,
        concurrency: concurrency > 0 ? clampInt(concurrency, 1, 32) : null,
      },
    }),
    [
      dir,
      outDir,
      source,
      target,
      selectedJars,
      repairBrokenTargetInJar,
      backupJars,
      provider,
      googleApiKey,
      gasUrl,
      concurrency,
    ],
  );

  useEffect(() => {
    (async () => {
      try {
        const langs = await invoke<string[]>("get_common_langs");
        setCommonLangs(langs);
      } catch {
        setCommonLangs(["en_us", "ja_jp"]);
      }
    })();
  }, []);

  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenLog: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;

    (async () => {
      unlistenProgress = await listen<ProgressEvent>("modtranslate:progress", (e) => {
        if (!runId || e.payload.runId !== runId) return;
        setProgress(e.payload);
      });
      unlistenLog = await listen<LogEvent>("modtranslate:log", (e) => {
        if (!runId || e.payload.runId !== runId) return;
        setLogs((prev) => {
          const next = [...prev, e.payload.line];
          return next.length > 2000 ? next.slice(next.length - 2000) : next;
        });
      });
      unlistenDone = await listen<DoneEvent>("modtranslate:done", (e) => {
        if (!runId || e.payload.runId !== runId) return;
        setDone(e.payload);
        setRunId(null);
        setBusy(false);
      });
    })();

    return () => {
      unlistenProgress?.();
      unlistenLog?.();
      unlistenDone?.();
    };
  }, [runId]);

  useEffect(() => {
    const el = logsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

  async function pickDir() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setDir(selected);
      if (!outDir) setOutDir(`${selected}\\ModTranslateResourcePack`);
    }
  }

  async function pickOutDir() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setOutDir(selected);
    }
  }

  async function refreshJars() {
    setErrorMsg("");
    if (!dir.trim()) {
      setErrorMsg("対象ディレクトリを指定してください");
      return;
    }
    setBusy(true);
    try {
      const jars = await invoke<JarFile[]>("list_jars", { dir });
      setJarFiles(jars);
      const abs = new Set(jars.map((j) => j.abs_path));
      setSelectedJars((prev) => prev.filter((p) => abs.has(p)));
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  function basename(p: string) {
    const s = p.split("/").join("\\");
    const parts = s.split("\\");
    return parts[parts.length - 1] || p;
  }

  function addManual() {
    const parts = manualJarPaths
      .split(/(?:;|\r?\n)+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;

    setJarFiles((prev) => {
      const map = new Map(prev.map((j) => [j.abs_path, j] as const));
      for (const p of parts) {
        if (!map.has(p)) {
          map.set(p, { name: basename(p), abs_path: p });
        }
      }
      return [...map.values()];
    });
    setSelectedJars((prev) => {
      const set = new Set(prev);
      for (const p of parts) set.add(p);
      return [...set.values()];
    });
    setManualJarPaths("");
  }

  function selectAll() {
    setSelectedJars(jarFiles.map((j) => j.abs_path));
  }

  function clearSelection() {
    setSelectedJars([]);
  }

  async function scan() {
    setErrorMsg("");
    setPlan(null);
    setDone(null);
    if (!outDir.trim()) {
      setErrorMsg("出力先を指定してください");
      return;
    }
    if (selectedJars.length === 0) {
      setErrorMsg("jarを1つ以上選択してください");
      return;
    }
    setBusy(true);
    try {
      const p = await invoke<PlanResult>("scan_plan", { req: request });
      setPlan(p);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setErrorMsg("");
    setDone(null);
    setProgress(null);
    setLogs([]);

    if (!dir.trim()) {
      setErrorMsg("対象ディレクトリを指定してください");
      return;
    }
    if (!outDir.trim()) {
      setErrorMsg("出力先を指定してください");
      return;
    }
    if (!source.trim() || !target.trim()) {
      setErrorMsg("翻訳元/翻訳先を指定してください");
      return;
    }
    if (selectedJars.length === 0) {
      setErrorMsg("jarを1つ以上選択してください");
      return;
    }

    setBusy(true);
    try {
      const id = await invoke<string>("start_run", { req: request });
      setRunId(id);
      setPlan(null);
    } catch (e) {
      setErrorMsg(String(e));
      setBusy(false);
    }
  }

  async function cancel() {
    if (!runId) return;
    await invoke<boolean>("cancel_run", { run_id: runId });
  }

  async function openOutDir() {
    if (!outDir.trim()) return;
    try {
      await openPath(outDir);
    } catch {
      // ignore
    }
  }

  const modPct = progress && progress.totalMods > 0 ? (progress.doneMods / progress.totalMods) * 100 : 0;
  const keyPct = progress && progress.keyTotal > 0 ? (progress.keyDone / progress.keyTotal) * 100 : 0;

  return (
    <main className="app">
      <header className="topbar">
        <div className="title">
          <div className="appname">ModTranslate</div>
          <div className="subtitle">Minecraft Mod 翻訳ツール (Tauri)</div>
        </div>
        <div className={`pill ${isRunning ? "running" : "idle"}`}>{isRunning ? "実行中" : "待機中"}</div>
      </header>

      <div className="grid">
        <section className="card">
          <h2>入力</h2>

          <div className="field">
            <label>対象ディレクトリ（jarが置いてある場所）</label>
            <div className="row">
              <input value={dir} onChange={(e) => setDir(e.currentTarget.value)} placeholder="C:\\path\\to\\mods" />
              <button type="button" onClick={pickDir} disabled={busy || isRunning}>
                選択
              </button>
            </div>
          </div>

          <div className="field">
            <label>出力先（resourcepackフォルダ）</label>
            <div className="row">
              <input value={outDir} onChange={(e) => setOutDir(e.currentTarget.value)} placeholder="...\\ModTranslateResourcePack" />
              <button type="button" onClick={pickOutDir} disabled={busy || isRunning}>
                選択
              </button>
            </div>
          </div>

          <div className="two">
            <div className="field">
              <label>翻訳元（Minecraft言語）</label>
              <input list="langs" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>翻訳先（Minecraft言語）</label>
              <input list="langs" value={target} onChange={(e) => setTarget(e.currentTarget.value)} />
            </div>
            <datalist id="langs">
              {commonLangs.map((l) => (
                <option value={l} key={l} />
              ))}
            </datalist>
          </div>
        </section>

        <section className="card">
          <h2>jar選択</h2>
          <div className="toolbar">
            <button type="button" onClick={refreshJars} disabled={busy || isRunning}>
              読み込み
            </button>
            <button type="button" onClick={selectAll} disabled={busy || isRunning || jarFiles.length === 0}>
              全選択
            </button>
            <button type="button" onClick={clearSelection} disabled={busy || isRunning || selectedJars.length === 0}>
              全解除
            </button>
            <div className="spacer" />
            <div className="muted">選択: {selectedJars.length}</div>
          </div>

          <div className="field">
            <label>jarパスを手動追加（複数は改行 or ; 区切り）</label>
            <div className="row">
              <input
                value={manualJarPaths}
                onChange={(e) => setManualJarPaths(e.currentTarget.value)}
                placeholder="C:\\path\\to\\mod.jar; D:\\mods\\another.jar"
                disabled={busy || isRunning}
              />
              <button type="button" onClick={addManual} disabled={busy || isRunning || !manualJarPaths.trim()}>
                追加
              </button>
            </div>
          </div>

          <div className="list">
            {jarFiles.length === 0 ? (
              <div className="empty">読み込みを押して jar 一覧を取得します</div>
            ) : (
              jarFiles.map((j) => {
                const checked = selectedJars.includes(j.abs_path);
                return (
                  <label className="item" key={j.abs_path}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setSelectedJars((prev) => {
                          if (on) return prev.includes(j.abs_path) ? prev : [...prev, j.abs_path];
                          return prev.filter((p) => p !== j.abs_path);
                        });
                      }}
                      disabled={busy || isRunning}
                    />
                    <span className="name">{j.name}</span>
                  </label>
                );
              })
            )}
          </div>
        </section>

        <section className="card">
          <h2>オプション</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={repairBrokenTargetInJar}
              onChange={(e) => setRepairBrokenTargetInJar(e.currentTarget.checked)}
              disabled={busy || isRunning}
            />
            jar内に既に翻訳先(lang)がある場合、JSONが破損していたら削除して翻訳し直す（Modファイルを書き換え）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={backupJars}
              onChange={(e) => setBackupJars(e.currentTarget.checked)}
              disabled={busy || isRunning || !repairBrokenTargetInJar}
            />
            書き換え前に .modtranslate.bak を作成
          </label>
        </section>

        <section className="card">
          <h2>翻訳設定</h2>
          <div className="two">
            <div className="field">
              <label>優先プロバイダ</label>
              <select value={provider} onChange={(e) => setProvider(e.currentTarget.value as any)} disabled={busy || isRunning}>
                <option value="auto">自動（APIキーがあればCloud優先）</option>
                <option value="free">Google Free 優先</option>
                <option value="google-cloud">Google Cloud 優先</option>
              </select>
              <div className="hint">実行中は「Google → GAS → もう片方のGoogle」の順で自動フォールバックします</div>
            </div>
            <div className="field">
              <label>並列数（任意 1〜32）</label>
              <input
                type="number"
                value={concurrency || ""}
                min={1}
                max={32}
                onChange={(e) => setConcurrency(Number(e.currentTarget.value || 0))}
                disabled={busy || isRunning}
                placeholder="(default)"
              />
              <div className="hint">高すぎるとレート制限になりやすいです</div>
            </div>
          </div>

          <div className="field">
            <label>Google Translate API Key（任意）</label>
            <input value={googleApiKey} onChange={(e) => setGoogleApiKey(e.currentTarget.value)} disabled={busy || isRunning} />
          </div>
          <div className="field">
            <label>GAS URL（任意）</label>
            <input value={gasUrl} onChange={(e) => setGasUrl(e.currentTarget.value)} disabled={busy || isRunning} />
          </div>
        </section>

        <section className="card">
          <h2>実行</h2>
          {errorMsg ? <div className="error">{errorMsg}</div> : null}
          <div className="toolbar">
            <button type="button" onClick={scan} disabled={busy || isRunning}>
              事前スキャン
            </button>
            <button type="button" className="primary" onClick={start} disabled={busy || isRunning}>
              開始
            </button>
            <button type="button" onClick={cancel} disabled={!isRunning}>
              中断
            </button>
            <div className="spacer" />
            <button type="button" onClick={() => setLogs([])} disabled={logs.length === 0}>
              ログクリア
            </button>
          </div>

          {plan ? (
            <div className="summary">
              <div className="sumrow">対象Mod: {plan.summary.total}</div>
              <div className="sumrow">jar内翻訳有り除外: {plan.summary.skipped_in_jar}</div>
              <div className="sumrow">破損{target}: {plan.summary.broken_target_found}</div>
              <div className="sumrow">修復: {plan.summary.repaired_target} / backup作成: {plan.summary.backup_created}</div>
              <div className="sumrow">事前スキャンエラー: {plan.summary.plan_errors} / 修復エラー: {plan.summary.repair_errors}</div>
            </div>
          ) : null}

          {progress ? (
            <div className="progress">
              <div className="kvs">
                <div>Mods: {progress.doneMods}/{progress.totalMods}</div>
                <div>T:{progress.translated} S:{progress.skipped} E:{progress.errors}</div>
              </div>
              <div className="bar">
                <div className="fill" style={{ width: `${modPct}%` }} />
              </div>
              <div className="muted">{progress.current}</div>

              <div className="kvs">
                <div>Keys: {progress.keyDone}/{progress.keyTotal}</div>
                <div className="muted">{progress.keyNote}</div>
              </div>
              <div className="bar">
                <div className="fill" style={{ width: `${keyPct}%` }} />
              </div>
            </div>
          ) : null}

          {done ? (
            <div className={`done ${done.aborted ? "aborted" : "ok"}`}>
              <div className="sumrow">
                {done.aborted ? "中断しました" : "完了しました"}（翻訳:{done.translated} / スキップ:{done.skipped} / エラー:{done.errors}）
              </div>
              <div className="sumrow">時間: {Math.round(done.elapsedMs / 1000)}s → {done.outDir}</div>
              <div className="toolbar">
                <button type="button" onClick={openOutDir}>
                  出力先を開く
                </button>
              </div>
            </div>
          ) : null}

          <div className="logs" ref={logsRef}>
            {logs.length === 0 ? <div className="empty">ログがここに表示されます</div> : null}
            {logs.map((l, i) => (
              <div key={i} className="logline">
                {l}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;

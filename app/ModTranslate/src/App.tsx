import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from '@tauri-apps/api/core';
import { listen } from "@tauri-apps/api/event";
import { message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import "./App.css";

import {
  JarFile,
  PlanResult,
  ProgressEvent,
  LogEvent,
  DoneEvent,
} from "./types";

import { Header } from "./components/Header";
import { InputSection } from "./components/InputSection";
import { JarSelectionSection } from "./components/JarSelectionSection";
import { OptionsSection } from "./components/OptionsSection";
import { TranslationSettingsSection } from "./components/TranslationSettingsSection";
import { ExecutionSection } from "./components/ExecutionSection";

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
        console.log("common langs:", langs);
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
    await invoke<boolean>("cancel_run", { runId: runId });
  }

  async function openOutDir() {
    const path = (done?.outDir ?? outDir).trim();
    if (!path) return;
    try {
      await openPath(path);
    } catch (e) {
      await message(`出力先を開けませんでした\n${String(e)}`, {
        title: "ModTranslate",
        kind: "error",
      });
    }
  }

  

  return (
    <main className="app">
      <Header isRunning={isRunning} />

      <div className="grid">
        <InputSection
          dir={dir}
          setDir={setDir}
          outDir={outDir}
          setOutDir={setOutDir}
          source={source}
          setSource={setSource}
          target={target}
          setTarget={setTarget}
          commonLangs={commonLangs}
          pickDir={pickDir}
          pickOutDir={pickOutDir}
          busy={busy}
          isRunning={isRunning}
        />

        <JarSelectionSection
          jarFiles={jarFiles}
          selectedJars={selectedJars}
          setSelectedJars={setSelectedJars}
          manualJarPaths={manualJarPaths}
          setManualJarPaths={setManualJarPaths}
          refreshJars={refreshJars}
          selectAll={selectAll}
          clearSelection={clearSelection}
          addManual={addManual}
          busy={busy}
          isRunning={isRunning}
        />

        <OptionsSection
          repairBrokenTargetInJar={repairBrokenTargetInJar}
          setRepairBrokenTargetInJar={setRepairBrokenTargetInJar}
          backupJars={backupJars}
          setBackupJars={setBackupJars}
          busy={busy}
          isRunning={isRunning}
        />

        <TranslationSettingsSection
          provider={provider}
          setProvider={setProvider}
          concurrency={concurrency}
          setConcurrency={setConcurrency}
          googleApiKey={googleApiKey}
          setGoogleApiKey={setGoogleApiKey}
          gasUrl={gasUrl}
          setGasUrl={setGasUrl}
          busy={busy}
          isRunning={isRunning}
        />

        <ExecutionSection
          errorMsg={errorMsg}
          scan={scan}
          start={start}
          cancel={cancel}
          setLogs={setLogs}
          logs={logs}
          plan={plan}
          progress={progress}
          done={done}
          target={target}
          openOutDir={openOutDir}
          logsRef={logsRef}
          busy={busy}
          isRunning={isRunning}
        />
      </div>
    </main>
  );
}

export default App;

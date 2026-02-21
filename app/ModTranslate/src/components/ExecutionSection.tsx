import React from "react";
import { PlanResult, ProgressEvent, DoneEvent } from "../types";

type ExecutionSectionProps = {
  errorMsg: string;
  scan: () => void;
  start: () => void;
  cancel: () => void;
  setLogs: (val: string[]) => void;
  logs: string[];
  plan: PlanResult | null;
  progress: ProgressEvent | null;
  done: DoneEvent | null;
  target: string;
  openOutDir: () => void;
  logsRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  isRunning: boolean;
};

export const ExecutionSection: React.FC<ExecutionSectionProps> = ({
  errorMsg,
  scan,
  start,
  cancel,
  setLogs,
  logs,
  plan,
  progress,
  done,
  target,
  openOutDir,
  logsRef,
  busy,
  isRunning,
}) => {
  const modPct =
    progress && progress.totalMods > 0
      ? (progress.doneMods / progress.totalMods) * 100
      : 0;
  const keyPct =
    progress && progress.keyTotal > 0
      ? (progress.keyDone / progress.keyTotal) * 100
      : 0;

  return (
    <section className="card">
      <h2>実行</h2>
      {errorMsg ? <div className="error">{errorMsg}</div> : null}
      <div className="toolbar">
        <button type="button" onClick={scan} disabled={busy || isRunning}>
          事前スキャン
        </button>
        <button
          type="button"
          className="primary"
          onClick={start}
          disabled={busy || isRunning}
        >
          開始
        </button>
        <button type="button" onClick={cancel} disabled={!isRunning}>
          中断
        </button>
        <div className="spacer" />
        <button
          type="button"
          onClick={() => setLogs([])}
          disabled={logs.length === 0}
        >
          ログクリア
        </button>
      </div>

      {plan ? (
        <div className="summary">
          <div className="sumrow">対象Mod: {plan.summary.total}</div>
          <div className="sumrow">
            jar内翻訳有り除外: {plan.summary.skipped_in_jar}
          </div>
          <div className="sumrow">
            破損{target}: {plan.summary.broken_target_found}
          </div>
          <div className="sumrow">
            修復: {plan.summary.repaired_target} / backup作成:{" "}
            {plan.summary.backup_created}
          </div>
          <div className="sumrow">
            事前スキャンエラー: {plan.summary.plan_errors} / 修復エラー:{" "}
            {plan.summary.repair_errors}
          </div>
        </div>
      ) : null}

      {progress ? (
        <div className="progress">
          <div className="kvs">
            <div>
              Mods: {progress.doneMods}/{progress.totalMods}
            </div>
            <div>
              T:{progress.translated} S:{progress.skipped} E:{progress.errors}
            </div>
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${modPct}%` }} />
          </div>
          <div className="muted">{progress.current}</div>

          <div className="kvs">
            <div>
              Keys: {progress.keyDone}/{progress.keyTotal}
            </div>
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
            {done.aborted ? "中断しました" : "完了しました"}（翻訳:
            {done.translated} / スキップ:{done.skipped} / エラー:{done.errors}）
          </div>
          <div className="sumrow">
            時間: {Math.round(done.elapsedMs / 1000)}s → {done.outDir}
          </div>
          <div className="toolbar">
            <button type="button" onClick={openOutDir}>
              出力先を開く
            </button>
          </div>
        </div>
      ) : null}

      <div className="logs" ref={logsRef}>
        {logs.length === 0 ? (
          <div className="empty">ログがここに表示されます</div>
        ) : null}
        {logs.map((l, i) => (
          <div key={i} className="logline">
            {l}
          </div>
        ))}
      </div>
    </section>
  );
};

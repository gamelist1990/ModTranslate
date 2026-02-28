import React from "react";
import { JarFile } from "../types";

type JarSelectionSectionProps = {
  jarFiles: JarFile[];
  selectedJars: string[];
  setSelectedJars: React.Dispatch<React.SetStateAction<string[]>>;
  manualJarPaths: string;
  setManualJarPaths: (val: string) => void;
  refreshJars: () => void;
  selectAll: () => void;
  clearSelection: () => void;
  addManual: () => void;
  busy: boolean;
  isRunning: boolean;
};

export const JarSelectionSection: React.FC<JarSelectionSectionProps> = ({
  jarFiles,
  selectedJars,
  setSelectedJars,
  manualJarPaths,
  setManualJarPaths,
  refreshJars,
  selectAll,
  clearSelection,
  addManual,
  busy,
  isRunning,
}) => {
  return (
    <section className="card">
      <h2>jar選択</h2>
      <div className="toolbar">
        <button type="button" onClick={refreshJars} disabled={busy || isRunning}>
          読み込み
        </button>
        <button
          type="button"
          onClick={selectAll}
          disabled={busy || isRunning || jarFiles.length === 0}
        >
          全選択
        </button>
        <button
          type="button"
          onClick={clearSelection}
          disabled={busy || isRunning || selectedJars.length === 0}
        >
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
          <button
            type="button"
            onClick={addManual}
            disabled={busy || isRunning || !manualJarPaths.trim()}
          >
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
  );
};

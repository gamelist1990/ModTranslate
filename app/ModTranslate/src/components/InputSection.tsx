import React from "react";

type InputSectionProps = {
  dir: string;
  setDir: (val: string) => void;
  outDir: string;
  setOutDir: (val: string) => void;
  source: string;
  setSource: (val: string) => void;
  target: string;
  setTarget: (val: string) => void;
  commonLangs: string[];
  pickDir: () => void;
  pickOutDir: () => void;
  busy: boolean;
  isRunning: boolean;
};

export const InputSection: React.FC<InputSectionProps> = ({
  dir,
  setDir,
  outDir,
  setOutDir,
  source,
  setSource,
  target,
  setTarget,
  commonLangs,
  pickDir,
  pickOutDir,
  busy,
  isRunning,
}) => {
  return (
    <section className="card">
      <h2>入力</h2>

      <div className="field">
        <label>対象ディレクトリ（jarが置いてある場所）</label>
        <div className="row">
          <input
            value={dir}
            onChange={(e) => setDir(e.currentTarget.value)}
            placeholder="C:\\path\\to\\mods"
            disabled={busy || isRunning}
          />
          <button type="button" onClick={pickDir} disabled={busy || isRunning}>
            選択
          </button>
        </div>
      </div>

      <div className="field">
        <label>出力先（resourcepackフォルダ）</label>
        <div className="row">
          <input
            value={outDir}
            onChange={(e) => setOutDir(e.currentTarget.value)}
            placeholder="...\\ModTranslateResourcePack"
            disabled={busy || isRunning}
          />
          <button type="button" onClick={pickOutDir} disabled={busy || isRunning}>
            選択
          </button>
        </div>
      </div>

      <div className="two">
        <div className="field">
          <label>翻訳元（Minecraft言語）</label>
          <input
            list="langs"
            value={source}
            onChange={(e) => setSource(e.currentTarget.value)}
            disabled={busy || isRunning}
          />
        </div>
        <div className="field">
          <label>翻訳先（Minecraft言語）</label>
          <input
            list="langs"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            disabled={busy || isRunning}
          />
        </div>
        <datalist id="langs">
          {commonLangs.map((l) => (
            <option value={l} key={l} />
          ))}
        </datalist>
      </div>
    </section>
  );
};

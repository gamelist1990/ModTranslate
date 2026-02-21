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
          {commonLangs && commonLangs.length > 0 ? (
            (() => {
              const isCustom = !commonLangs.includes(source);
              return (
                <>
                  <select
                    value={isCustom ? "__custom__" : source}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v === "__custom__") {
                        // keep current source (possibly custom) and show input
                        if (!commonLangs.includes(source)) return;
                        setSource("");
                      } else {
                        setSource(v);
                      }
                    }}
                    disabled={busy || isRunning}
                  >
                    <option value="" disabled>
                      -- 選択してください --
                    </option>
                    {commonLangs.map((l) => (
                      <option value={l} key={l}>
                        {l}
                      </option>
                    ))}
                    <option value="__custom__">その他（手動入力）</option>
                  </select>
                  {isCustom ? (
                    <input
                      value={source}
                      onChange={(e) => setSource(e.currentTarget.value)}
                      placeholder="例: en_us"
                      disabled={busy || isRunning}
                    />
                  ) : null}
                </>
              );
            })()
          ) : (
            <input
              list="langs"
              value={source}
              onChange={(e) => setSource(e.currentTarget.value)}
              disabled={busy || isRunning}
            />
          )}
        </div>
        <div className="field">
          <label>翻訳先（Minecraft言語）</label>
          {commonLangs && commonLangs.length > 0 ? (
            (() => {
              const isCustom = !commonLangs.includes(target);
              return (
                <>
                  <select
                    value={isCustom ? "__custom__" : target}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v === "__custom__") {
                        if (!commonLangs.includes(target)) return;
                        setTarget("");
                      } else {
                        setTarget(v);
                      }
                    }}
                    disabled={busy || isRunning}
                  >
                    <option value="" disabled>
                      -- 選択してください --
                    </option>
                    {commonLangs.map((l) => (
                      <option value={l} key={l}>
                        {l}
                      </option>
                    ))}
                    <option value="__custom__">その他（手動入力）</option>
                  </select>
                  {isCustom ? (
                    <input
                      value={target}
                      onChange={(e) => setTarget(e.currentTarget.value)}
                      placeholder="例: ja_jp"
                      disabled={busy || isRunning}
                    />
                  ) : null}
                </>
              );
            })()
          ) : (
            <input
              list="langs"
              value={target}
              onChange={(e) => setTarget(e.currentTarget.value)}
              disabled={busy || isRunning}
            />
          )}
        </div>
      </div>
    </section>
  );
};

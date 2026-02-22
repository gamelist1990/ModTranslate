import React from "react";

type TranslationSettingsSectionProps = {
  provider: "auto" | "free" | "google-cloud" | "gas" | "deepl" | "claude-ai";
  setProvider: (val: "auto" | "free" | "google-cloud" | "gas" | "deepl" | "claude-ai") => void;
  concurrency: number;
  setConcurrency: (val: number) => void;
  googleApiKey: string;
  setGoogleApiKey: (val: string) => void;
  deeplApiKey: string;
  setDeeplApiKey: (val: string) => void;
  busy: boolean;
  isRunning: boolean;
};

export const TranslationSettingsSection: React.FC<TranslationSettingsSectionProps> = ({
  provider,
  setProvider,
  concurrency,
  setConcurrency,
  googleApiKey,
  setGoogleApiKey,
  deeplApiKey,
  setDeeplApiKey,
  busy,
  isRunning,
}) => {
  const [showDeepl, setShowDeepl] = React.useState(false);
  const [showGoogle, setShowGoogle] = React.useState(false);
  return (
    <section className="card">
      <h2>翻訳設定</h2>
      <div className="two">
        <div className="field">
          <label>優先プロバイダ</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.currentTarget.value as any)}
            disabled={busy || isRunning}
          >
            <option value="auto">自動（APIキーがあればCloud優先）</option>
            <option value="free">Google Free 優先</option>
            <option value="google-cloud">Google Cloud 優先</option>
            <option value="gas">GAS（Google Apps Script）優先</option>
            <option value="deepl">DeepL 優先</option>
            <option value="claude-ai">Claude(AI) 優先</option>
          </select>
          <div className="hint">実行中は選択に応じて順次フォールバックします（例: GAS → Google → もう片方）</div>
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
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type={showGoogle ? "text" : "password"}
            value={googleApiKey}
            onChange={(e) => setGoogleApiKey(e.currentTarget.value)}
            disabled={busy || isRunning}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setShowGoogle((s) => !s)}
            disabled={busy || isRunning}
          >
            {showGoogle ? "非表示" : "表示"}
          </button>
        </div>
        <div className="hint">画面共有時に見えないよう、APIキーを非表示にできます</div>
      </div>
      <div className="field">
        <label>DeepL API Key（任意）</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type={showDeepl ? "text" : "password"}
            value={deeplApiKey}
            onChange={(e) => setDeeplApiKey(e.currentTarget.value)}
            disabled={busy || isRunning}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setShowDeepl((s) => !s)}
            disabled={busy || isRunning}
          >
            {showDeepl ? "非表示" : "表示"}
          </button>
        </div>
        <div className="hint">画面共有時に見えないよう、APIキーを非表示にできます</div>
      </div>
    </section>
  );
};

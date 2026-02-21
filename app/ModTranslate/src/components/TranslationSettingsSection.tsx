import React from "react";

type TranslationSettingsSectionProps = {
  provider: "auto" | "free" | "google-cloud";
  setProvider: (val: "auto" | "free" | "google-cloud") => void;
  concurrency: number;
  setConcurrency: (val: number) => void;
  googleApiKey: string;
  setGoogleApiKey: (val: string) => void;
  gasUrl: string;
  setGasUrl: (val: string) => void;
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
  gasUrl,
  setGasUrl,
  busy,
  isRunning,
}) => {
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
          </select>
          <div className="hint">
            実行中は「Google → GAS → もう片方のGoogle」の順で自動フォールバックします
          </div>
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
        <input
          value={googleApiKey}
          onChange={(e) => setGoogleApiKey(e.currentTarget.value)}
          disabled={busy || isRunning}
        />
      </div>
      <div className="field">
        <label>GAS URL（任意）</label>
        <input
          value={gasUrl}
          onChange={(e) => setGasUrl(e.currentTarget.value)}
          disabled={busy || isRunning}
        />
      </div>
    </section>
  );
};

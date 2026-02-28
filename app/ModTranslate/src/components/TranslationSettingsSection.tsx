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
  claudeBaseUrl: string;
  setClaudeBaseUrl: (val: string) => void;
  claudeModels: string;
  setClaudeModels: (val: string) => void;
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
  claudeBaseUrl,
  setClaudeBaseUrl,
  claudeModels,
  setClaudeModels,
  busy,
  isRunning,
}) => {
  const [showDeepl, setShowDeepl] = React.useState(false);
  const [showGoogle, setShowGoogle] = React.useState(false);
  const [showClaudeModal, setShowClaudeModal] = React.useState(false);

  const [draftClaudeBaseUrl, setDraftClaudeBaseUrl] = React.useState(claudeBaseUrl);
  const [draftClaudeModels, setDraftClaudeModels] = React.useState(claudeModels);

  React.useEffect(() => {
    if (!showClaudeModal) return;
    setDraftClaudeBaseUrl(claudeBaseUrl);
    setDraftClaudeModels(claudeModels);
  }, [showClaudeModal, claudeBaseUrl, claudeModels]);

  const claudeEnabled = provider === "claude-ai";
  const modalDisabled = busy || isRunning;

  const closeModal = () => setShowClaudeModal(false);
  const applyModal = () => {
    setClaudeBaseUrl(draftClaudeBaseUrl.trim());
    setClaudeModels(draftClaudeModels);
    setShowClaudeModal(false);
  };

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
        <label>Claude(AI) 設定</label>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setShowClaudeModal(true)}
            disabled={!claudeEnabled || modalDisabled}
          >
            設定を開く
          </button>
          <div className="hint" style={{ margin: 0 }}>
            {claudeEnabled ? "baseURL と model をカスタムできます" : "Claude(AI) を選択すると設定できます"}
          </div>
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

      {showClaudeModal && (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Claude(AI) 設定</div>
              <button type="button" onClick={closeModal} disabled={modalDisabled}>
                ×
              </button>
            </div>

            <div className="field">
              <label>Base URL（OpenAI互換）</label>
              <input
                value={draftClaudeBaseUrl}
                onChange={(e) => setDraftClaudeBaseUrl(e.currentTarget.value)}
                placeholder="(default) https://capi.voids.top/v2/"
                disabled={modalDisabled}
              />
              <div className="hint">空ならデフォルトを使います。末尾の / はあっても無くてもOKです</div>
            </div>

            <div className="field">
              <label>Models（優先順・改行 or カンマ区切り）</label>
              <textarea
                value={draftClaudeModels}
                onChange={(e) => setDraftClaudeModels(e.currentTarget.value)}
                placeholder={
                  "(default)\nclaude-opus-4-5\nclaude-haiku-4-5-20251001\nclaude-haiku-4.5\nclaude-sonnet-4.5"
                }
                disabled={modalDisabled}
                rows={6}
              />
              <div className="hint">空ならデフォルト順でフォールバックします</div>
            </div>

            <div className="modalActions">
              <button type="button" onClick={closeModal} disabled={modalDisabled}>
                キャンセル
              </button>
              <button type="button" className="primary" onClick={applyModal} disabled={modalDisabled}>
                適用
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

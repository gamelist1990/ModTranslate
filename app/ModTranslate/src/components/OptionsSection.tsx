import React from "react";

type OptionsSectionProps = {
  repairBrokenTargetInJar: boolean;
  setRepairBrokenTargetInJar: (val: boolean) => void;
  backupJars: boolean;
  setBackupJars: (val: boolean) => void;
  busy: boolean;
  isRunning: boolean;
};

export const OptionsSection: React.FC<OptionsSectionProps> = ({
  repairBrokenTargetInJar,
  setRepairBrokenTargetInJar,
  backupJars,
  setBackupJars,
  busy,
  isRunning,
}) => {
  return (
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
  );
};

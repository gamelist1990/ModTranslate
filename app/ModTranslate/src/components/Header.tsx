import React from "react";

type HeaderProps = {
  isRunning: boolean;
};

export const Header: React.FC<HeaderProps> = ({ isRunning }) => {
  return (
    <header className="topbar">
      <div className="title">
        <div className="appname">ModTranslate</div>
        <div className="subtitle">Minecraft Mod 翻訳ツール (Tauri)</div>
      </div>
      <div className={`pill ${isRunning ? "running" : "idle"}`}>
        {isRunning ? "実行中" : "待機中"}
      </div>
    </header>
  );
};

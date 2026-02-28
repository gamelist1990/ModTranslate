# ModTranslate

このリポジトリは、Mod（ゲーム等）の翻訳支援ツール `ModTranslate` のソースです。

---

## 概要

ローカルのリソースやアーカイブ（zip/jar 等）を解析して、翻訳用の抽出・適用を行うツールです。本リポジトリには GUI（Tauri + React）と CLI 版の両方の実装が含まれています。

---

## CLI版 — 使い方（簡潔）

コマンドはプロジェクトルートで実行してください。以下は主要なコマンドとオプションの説明です。

| コマンド | 説明 | 例 |
|---|---:|---|
| `modtranslate extract <input>` | 指定したファイル／フォルダから翻訳用のファイルを抽出して出力フォルダに保存します。 | `modtranslate extract ./mods/example.jar` |
| `modtranslate apply <input> <output>` | 翻訳ファイルを適用して、出力先に反映したアーカイブやフォルダを作成します。 | `modtranslate apply translations/ ./patched_mods/` |
| `modtranslate inspect <path>` | 指定パス内のリソースを解析して検出レポートを出力します。 | `modtranslate inspect ./resourcepack/` |
| `modtranslate --help` | 使い方のヘルプを表示します。 | `modtranslate --help` |

---

## オプションの例

- `--out, -o`: 出力ディレクトリを指定します。
- `--lang, -l`: 出力/適用する言語コードを指定します（例: `ja`, `en`）。
- `--format`: 抽出するフォーマット（例: `json`, `po`）。

---

## 具体的な使用例（PowerShell / コマンドプロンプト）

1) JAR から翻訳ファイルを抽出して `translations/` に出力

```powershell
modtranslate extract ./mods/example-mod.jar -o ./translations
```

2) 既存の翻訳を適用して修正版を `patched_mods/` に出す

```powershell
modtranslate apply ./translations ./patched_mods
```

3) リソースパック内容を解析してレポートを確認する

```powershell
modtranslate inspect ./resourcepack/ -o ./reports
```

---

## 出力とファイル配置について

- 抽出コマンドはデフォルトで `translations/`（実行ディレクトリ直下）にファイルを作成します。`-o` で変更できます。
- 適用コマンドは入力翻訳ファイルを読み取り、指定した出力先にパッチ済みファイルやアーカイブを作成します。

---

## 補足・貢献

- バグ報告や機能提案は Issue へお願いします。
- CLI の詳しいオプションは `modtranslate --help` で確認できます。GUI の使い方は `app/ModTranslate/README.md` を参照してください。

---

ライセンスや著作権情報はプロジェクトルートの記載に従ってください。


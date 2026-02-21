# Tauri 2.0

## ModTranslate のGUI版

Minecraft Mod（.jar）の `assets/<namespace>/lang/<source>.json` を読み取り、翻訳してリソースパック形式で出力します。

### 主な機能（CLI同等）
- 対象ディレクトリのjar一覧取得・複数選択
- jarパスの手動追加（改行 / `;` 区切り）
- 翻訳元/翻訳先（Minecraft言語: `en_us` → `ja_jp` など）
- 事前スキャン（対象数/スキップ数/破損検出/修復数などの確認）
- 進捗（Mods/Keys）とログ表示
- 中断（キャンセル）
- jar内の翻訳先JSONが破損している場合の修復（削除して再生成）
- 修復時のバックアップ作成（`.modtranslate.bak`）

### 起動
前提: Rust（cargo）と Tauri のビルド要件が必要です。

```bash
bun i
bun run tauri dev
```

ビルド:

```bash
bun run tauri build
```

### 翻訳プロバイダ
GUIの「翻訳設定」で以下を指定できます。

- **優先プロバイダ**: 自動 / Google Free / Google Cloud
- **Google Translate API Key**（任意）: 入れるとCloudが利用可能になります
- **GAS URL**（任意）: Googleが失敗した場合のフォールバック先
- **並列数**（任意）: 1〜32

※ 実行中は基本的に「Google（優先）→ GAS → もう片方のGoogle」の順でフォールバックします。

### 注意
- 「jar内の破損JSON修復」をONにすると、Modのjarファイルを書き換えます。
- バックアップONの場合、同じ場所に `.modtranslate.bak` を作成します（既にあれば作りません）。
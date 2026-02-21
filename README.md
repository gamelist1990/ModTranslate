# modtranslate

Minecraft Java Edition の Mod（`.jar`）内にある `assets/<modid>/lang/<lang>.json` を検出して、翻訳済みの Resource Pack 形式で出力するツールです。

- 既に `ja_jp.json` など翻訳先のファイルが jar 内に存在する場合は「翻訳済み」とみなしてスキップします
- ただし jar 内の翻訳先ファイルが **JSONとして破損**している場合は「日本語非対応」とみなして翻訳対象に戻します（必要なら jar から削除も可能）
- 出力は `pack.mcmeta` + `assets/<modid>/lang/<target>.json` のフォルダ構造（resourcepack）です
- 既に出力先resourcepackに `assets/<modid>/lang/<target>.json` がある場合、差分更新（不足/未翻訳っぽい行だけ翻訳）してAPIリクエストを節約します

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/loader.ts
```

## 処理中のGUI風画面

設定入力（対話）はそのままに、翻訳処理が始まったら自動で全画面の「GUIっぽい」進捗画面に切り替わります。

## 使い方

### 対話形式（おすすめ）

引数なしで起動すると、jarの選択などを対話形式で進めます。

```bash
bun run src/loader.ts
```

### 非対話（自動実行）

```bash
bun run src/loader.ts --yes --dir . --jar path/to/mod.jar --source en_us --target ja_jp --out ./ModTranslateResourcePack

# （任意）jar内の壊れた ja_jp.json を削除して翻訳し直す（Modファイルを書き換えます）
bun run src/loader.ts --yes --dir . --source en_us --target ja_jp --out ./ModTranslateResourcePack --repair-broken-target-in-jar

# （任意）バックアップを作らない（デフォルトは <jar>.modtranslate.bak を作成）
bun run src/loader.ts --yes --dir . --repair-broken-target-in-jar --no-jar-backup
```

## 翻訳APIについて

デフォルトは **無料のGoogle翻訳エンドポイント** を使います（安定性は保証されません）。

速度を上げたい場合は、並列翻訳（マルチタスク）を使えます：

- `.env` の `TRANSLATE_CONCURRENCY` で同時実行数を調整（例: 3）
- 数値を上げすぎると 429（Rate Limit）が増えるので、まずは 2〜4 を推奨

翻訳中は、コンソールに進捗バー（残り件数つき）が表示されます。

公式の Google Cloud Translation API を使いたい場合は、プロジェクト直下の `.env` にキーを設定してください：

- `GOOGLE_TRANSLATE_API_KEY=...`

（任意）プロバイダを固定したい場合：

- `TRANSLATE_PROVIDER=google-cloud` または `TRANSLATE_PROVIDER=free`

### エラー時のフォールバック（Google Apps Script）

Google側（無料エンドポイント / Google Cloud API）が 429 / 5xx などで失敗した場合、
自動で **Google Apps Script のWebアプリ** にフォールバックして翻訳します。

さらに、GAS側が失敗した場合は（可能なら）別のGoogle系（free ↔ google-cloud）へ戻して再試行します。

差し替えたい場合は `.env` で次を設定してください：

- `GOOGLE_APPS_SCRIPT_URL=...`


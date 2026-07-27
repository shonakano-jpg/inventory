# 引き継ぎメモ（開発者向け / Claude用）

このリポジトリは「**古着棚卸しPWA**」。別セッション（特にクラウドセッション）で作業を再開する際は、まず **このファイルと `README.md` と各ソースを読んで**状況を把握してから続けること。ユーザーは古着チェーン運営会社（avend）の担当者で、非エンジニア。**自律的に判断して進め、事後報告**を好む（許可待ちで止まらない）。

## これは何か
スマホのカメラで**値札のインハウスコード（バーコード）**を読み、複数店舗の在庫を棚卸しするPWA。ビルド不要のバニラJS。

- 公開URL: https://shonakano-jpg.github.io/inventory/ （GitHub Pages, リポジトリ shonakano-jpg/inventory, public）
- ※将来 `avend-sho.github.io` に変更したい意向あり（GitHub組織 avend-sho を作りリポジトリ移動で対応可能。未対応）

## ドメインの肝（重要）
- 商品マスタ＝**インハウスコード**。元は `【店舗用】インハウスコード.xlsx`（ユーザーのローカル）で「カテゴリ(行)×価格(列)」のマトリクス、各セルがJANバーコード。
- つまり**コード = カテゴリ + 価格**。一点物ではなく**数量カウント型**（同じコードを何点でも加算）。
- バーコードは**先頭2の店内用13桁コード**（先頭「230」）。※当初「EAN-13で統一」と記載していたが、**実機テストで実物の値札は Code128 エンコード**だった（例: 雑貨/小物¥1490 = `2300033015001`、下段の可読数字なし）。値は13桁でmaster.csvと一致。scannerは **EAN-13＋Code128＋QR** を許可（Code128は必須。消さないこと）。誤読低減のため対応形式はこの3種に限定。
- 抽出済みマスタ = `master.csv`（278コード / 18カテゴリ）。初回自動読込。

## データモデル
- **stores**（店舗マスタ）: name(PK), brand, area。公式30店舗を `stores.json` に収録、初回自動投入。SELFURUGI 18 + NOTIME 12。
- **sessions**（棚卸しセッション）: store（店舗名）+ name（棚卸日 YYYY-MM-DD）。画面表示は「店舗名 / 棚卸日」。
- **scans**: (session_id, location, sku) 単位で qty 加算。location大分類 = `店内在庫 / バックヤード在庫 / その他倉庫`。担当者名は device 列に保存。
  - **ラック**（店内のみ）は**スキーマ変更なし**で location 文字列に埋め込む＝`店内在庫｜<ラック名>`（区切りは全角縦棒 `｜`）。集計/レポートは先頭の大分類（`baseLocation()`）に丸めるので3分類表示は不変。CSVは「ロケーション」「ラック」列に分離出力。app.js の `RACK_SEP/baseLocation/rackOf/effectiveLocation` 参照。
- 読取加算はRPC `add_scan(p_session, p_sku, p_device, p_location, p_qty)`。

## 主な機能
- カメラ読取（**1回読むと2秒クールダウン**＝連続誤カウント防止。`scanner.js` の cooldownMs=2000）。手入力＋数量、外付けスキャナも可。
- バーコード無し在庫は「選んで数量入力」（カテゴリ×価格を選び +5/+10/+50 等でまとめて点数入力）。
- **店舗別レポート**: 店舗一覧（合計点数）→ タップで詳細（店内/BY/その他倉庫の内訳、カテゴリ比率、価格帯比率のCSS横棒）。CSV書出（全店/店舗別）。
- 店舗マスタ管理（設定画面で追加/削除、公式リスト再読込）。

## クラウド（Supabase）
- プロジェクト: ref=`qtzdfcqfgbrjqsofphzk`（URLは `config.js` 参照）。組織 avend-store-analytics、東京、無料。
- **接続情報は `config.js` の window.APP_CONFIG に埋め込み済み** → 各端末はURLを開くだけで自動接続（スタッフはキー入力不要）。anonキーは公開前提でRLS保護。
- スキーマは `supabase-schema.sql`。RLSは「anonキーを知る全員が読み書き可」の店舗内向け最小構成。
- 現状クラウド: 商品278 / 店舗30 投入済み・クリーン（セッション0・読取0）。
- **rack_checks テーブル追加（要SQL実行）**: 複数人での二重チェック防止のラック確認ステータス（仮登録→ダブルチェック完了）。`supabase-schema.sql` に定義済み・べき等なので**SQL Editorで再実行すれば追加**される。未実行だとアプリは「クラウド側の準備が必要」と表示（ローカルモードでは自動動作）。API: `DB.getRackChecks/setRackCheck/removeRackCheck`。リアルタイム購読済み。
- **データ変更のやり方**: 店舗やマスタの追加/削除は、config.jsのURL+anonキーでSupabase REST(PostgREST)に直接投げれば可能（例: `DELETE /rest/v1/stores?name=eq.〇〇`）。構造変更(列追加等)はSQL EditorでSQL実行が必要＝ユーザーに依頼。

## デプロイ（重要な運用ルール）
- 静的ファイルをGitHub Pagesが配信。**main への push/マージで自動再デプロイ**（1〜2分）。
- クラウドセッションからはブランチ→PR→ユーザーがマージ、で反映。ローカルからは手動アップロード。
- **ハマったバグ（再発注意）**:
  1. Service Workerを cache-first にすると古いJSが残る → `sw.js` は自ファイル network-first にしてある（現行 v4）。JS更新時は必要なら CACHE 名をbump。
  2. Supabase UMDの読込URLは `dist/umd/supabase.js`（`.min.js` は404）。`db.js` の loadSupabaseLib 参照。

## ファイル
`index.html`/`styles.css`/`app.js`(画面・CSV・レポート)/`db.js`(データ層: local⇔Supabase透過切替・リアルタイム)/`scanner.js`(**getUserMedia＋zxing-wasm** でカメラ制御・デコード)/`config.js`(接続情報埋込)/`sw.js`(オフライン)/`master.csv`/`stores.json`/`supabase-schema.sql`

### 読取エンジンの経緯（重要）
当初 html5-qrcode(内蔵ZXing-JS) を使用したが、**実物の値札(小さめのCode128)を実機で読めなかった**（強力なzxing-cppでは同映像を読めたのでエンジンの弱さが原因）。→ **scanner.js を getUserMedia＋zxing-wasm(=zxing-cppのWASM版) に置換**。ESMを`cdn.jsdelivr.net/npm/zxing-wasm@3.1.2`から動的import、wasmは同版を自動取得。約6fpsでフレームをcanvas取込→`readBarcodes`。ズーム/ライト/連続AFはMediaStreamTrackを直接制御。html5-qrcodeは廃止（index.htmlのscript削除済み）。

## 次にやること
- **実データ（実際の値札・業務フロー）で試用**し、読取精度・操作感を確認→必要なら調整。
- 出た要望に応じて機能調整。ユーザーは「変更を伝える→こちらが作成・検証→反映の最終操作だけ依頼」という分担を希望。
- 任意タイミングでURLを avend-sho.github.io へ。

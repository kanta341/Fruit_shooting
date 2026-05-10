# Draw App API 仕様

## 概要

`src/draw_app_api.py` は、入力場所と生成場所が同一の描画ウィジェットを提供するローカルHTTPサーバです。

用途:

- 外部アプリから `iframe` や `BrowserWindow` で埋め込む
- 単一ステージ上に直接線を描き、その同じ場所にフルーツ画像をリアルタイム生成する
- `AUTO` 判定、手動画像指定、判定モード切り替えを呼び出し側で制御する
- 表示サイズと内部処理サイズを分離して、表示を大きくしても速度低下を抑える

起動コマンド:

```bash
python -m src.draw_app_api
```

デフォルトURL:

```text
http://127.0.0.1:8010/widget
```


## 現在の設計ポイント

このAPIは「表示サイズ」と「内部処理サイズ」を分けています。

- 表示サイズ: 実際に画面に見えるウィジェットの大きさ
- 内部処理サイズ: 線画抽出、bbox算出、サーバ送信、生成処理に使うキャンバスサイズ

これにより、表示を大きくしても毎回巨大な画像を送らずに済みます。

また、長方形フレーム時は、内部処理サイズの既定値も表示アスペクト比に合わせて自動調整されます。


## エンドポイント

### `GET /widget`

描画ウィジェットのHTMLを返します。

このHTMLの特徴:

- 入力場所と生成場所が同一
- 線を描くと、その場に生成画像が表示される
- リアルタイム生成
- `Clear` ボタンあり
- 長方形表示対応
- 表示サイズに関わらず、黒線の見た目の太さが大きくなりすぎないよう補正あり

#### クエリパラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
| --- | --- | --- | --- | --- |
| `image_id` | string | いいえ | `AUTO` | `AUTO` または `Image_1` のようなID |
| `fruit_name` | string | いいえ | `banana` | `banana` / `apple` / `grape` |
| `judge_mode` | string | いいえ | `components` | `components` / `whole` / `grid` |
| `realtime_interval` | float | いいえ | `0.5` | リアルタイム生成間隔。秒。内部で `0.1` から `10.0` に丸め込み |
| `frame_size` | int | いいえ | `640` | 正方形指定用の互換パラメータ。`frame_width` / `frame_height` 未指定時だけ使う |
| `frame_width` | int | いいえ | `frame_size` または `640` | 表示フレームの横幅 px。`280` から `1400` に丸め込み |
| `frame_height` | int | いいえ | `frame_size` または `640` | 表示フレームの縦幅 px。`280` から `1400` に丸め込み |
| `processing_width` | int | いいえ | 自動計算 | 内部処理キャンバスの横幅 px |
| `processing_height` | int | いいえ | 自動計算 | 内部処理キャンバスの縦幅 px |

#### `processing_width` / `processing_height` の既定値

指定しなければ、表示フレームの縦横比を維持したまま、長辺が `280px` になるように自動計算されます。

例:

- `frame_width=800&frame_height=450` のとき `processing_width=280`, `processing_height=158`
- `frame_width=450&frame_height=800` のとき `processing_width=158`, `processing_height=280`

この設計により、長方形表示でも線画と生成画像の位置ズレを防ぎつつ、処理負荷を抑えています。

#### 例

正方形:

```text
http://127.0.0.1:8010/widget?image_id=AUTO&fruit_name=banana&judge_mode=components&realtime_interval=0.4&frame_width=720&frame_height=720
```

横長:

```text
http://127.0.0.1:8010/widget?image_id=AUTO&fruit_name=banana&judge_mode=components&realtime_interval=0.4&frame_width=800&frame_height=450
```

縦長:

```text
http://127.0.0.1:8010/widget?image_id=Image_15&fruit_name=apple&judge_mode=whole&realtime_interval=0.8&frame_width=450&frame_height=800
```

処理サイズも明示:

```text
http://127.0.0.1:8010/widget?image_id=AUTO&fruit_name=banana&judge_mode=components&frame_width=800&frame_height=450&processing_width=320&processing_height=180
```


### `POST /api/predict`

描画画像を送って生成結果を取得するAPIです。

`/widget` 内部でもこのAPIを使っています。

#### リクエストヘッダ

```text
Content-Type: application/json
```

#### リクエストボディ

| フィールド | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| `image` | string | はい | 白背景PNGの Data URL |
| `sketch_overlay` | string | はい | 線だけを透明背景にしたPNGの Data URL |
| `bbox` | object | はい | 入力線の外接矩形 |
| `image_id` | string | いいえ | `AUTO` または `Image_x` |
| `fruit_name` | string | いいえ | `banana` / `apple` / `grape` |
| `judge_mode` | string | いいえ | `components` / `whole` / `grid` |
| `canvas_width` | int | いいえ | 内部処理に使う入力キャンバス横幅 |
| `canvas_height` | int | いいえ | 内部処理に使う入力キャンバス縦幅 |

`bbox` の形式:

```json
{
  "left": 12,
  "top": 20,
  "right": 140,
  "bottom": 190,
  "width": 128,
  "height": 170
}
```

#### レスポンス

成功時は `200 OK` で JSON を返します。

主要フィールド:

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `lines` | string[] | 判定・フィット結果ログ |
| `image_id` | string | 採用された代表画像ID |
| `components` | object[] | 配置された画像情報 |
| `composite_image` | string | 線オーバーレイ込みのSVG Data URL |
| `stage_image` | string | 生成画像のみのSVG Data URL |

`stage_image` は、入力場所と生成場所が同一のUIで使うための画像です。

#### レスポンス例

```json
{
  "lines": [
    "judge mode: components",
    "selected fruit: banana",
    "component count: 1",
    "input bbox size: 120 x 180"
  ],
  "image_id": "Image_25",
  "components": [
    {
      "fruit_name": "banana",
      "image_id": "Image_25",
      "image_width": 280,
      "image_height": 280,
      "scale": 0.92,
      "translation_x": 14.2,
      "translation_y": 18.7
    }
  ],
  "composite_image": "data:image/svg+xml;base64,...",
  "stage_image": "data:image/svg+xml;base64,..."
}
```


### `GET /health`

疎通確認用です。

レスポンス:

```json
{
  "ok": true
}
```


## CORS

以下を許可しています。

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Content-Type`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`

そのため、ローカルの別アプリや別ポートのフロントエンドから呼びやすい構成です。


## 内部仕様

`src/draw_app_api.py` は、生成処理そのものは `src/draw_app.py` の `build_result(...)` を再利用しています。

共通化されている内容:

- 判定ロジック
- `AUTO` 時のバナナモデル利用
- `banana / apple / grape` の手動画像指定
- `components / whole / grid` の各判定モード
- `point_data` を使ったフィット処理
- 生成SVGの配置計算

つまり、API版と既存アプリ版で生成ロジックは揃っています。


## 長方形対応について

長方形フレームで線画と生成画像がズレないよう、現在は以下の設計にしています。

- 表示フレームは `frame_width / frame_height`
- 内部処理は `processing_width / processing_height`
- 既定では内部処理サイズも表示アスペクト比に合わせる
- 生成画像はステージ上で `object-fit: fill` で表示し、キャンバス座標系と一致させる

これにより:

- 横長では横方向にズレる
- 縦長では縦方向にズレる

という問題を避けています。


## パフォーマンスについて

表示を大きくすると、そのままでは処理コストも上がります。

このAPIではそれを避けるために、表示サイズと内部処理サイズを分離しています。

推奨:

- 表示だけ大きくしたい場合は `frame_width / frame_height` だけ変える
- 速度優先なら `processing_width / processing_height` は既定のまま使う
- 精度を少し上げたい場合だけ `processing_width / processing_height` を大きくする

例:

- 軽量寄り: `frame_width=900&frame_height=500`
- 精度寄り: `frame_width=900&frame_height=500&processing_width=420&processing_height=233`


## 線の見た目について

表示サイズだけ大きくした場合でも、黒線の見た目が太くなりすぎないように補正しています。

内部では、表示倍率に応じて描画時の `lineWidth` を調整しています。


## Electron で使えるか

使えます。ローカルで動く Electron アプリなら適用可能です。

主な使い方は2つです。

### 1. `BrowserWindow` や `iframe` で `/widget` をそのまま表示する

最も簡単です。

例:

```text
http://127.0.0.1:8010/widget?image_id=AUTO&fruit_name=banana&judge_mode=components&realtime_interval=0.4&frame_width=800&frame_height=450
```

向いているケース:

- UIをそのまま再利用したい
- 単一ステージ型ウィジェットをそのまま使いたい
- 実装工数を抑えたい


### 2. Electron側で独自UIを作り、`POST /api/predict` だけ呼ぶ

Electron側で独自CanvasやReact UIを持ちたい場合はこちらです。

流れ:

1. Electron側で描画Canvasを作る
2. 線画を `image` と `sketch_overlay` の Data URL に変換する
3. `bbox` を算出する
4. `canvas_width / canvas_height` を付けて `POST /api/predict` を叩く
5. 返ってきた `stage_image` を同じ場所へ重ねて表示する

向いているケース:

- Electronの既存デザインに合わせたい
- 設定UIを独自に持ちたい
- `/widget` の見た目をそのまま使いたくない


## Electron 利用時の注意

### ローカルサーバ起動が必要

このAPIはHTTPサーバです。Electron単体の静的HTMLだけでは動かず、`python -m src.draw_app_api` でサーバ起動が必要です。

一般的には次のいずれかです。

- Electron起動前に別プロセスでPythonサーバを起動しておく
- ElectronメインプロセスからPythonを子プロセス起動する


### Python実行環境が必要

Electronアプリを配布する場合、利用環境にPython実行環境と依存ライブラリが必要です。

配布を考えるなら:

- Python環境を同梱する
- サーバ部分を別パッケージ化する
- 将来的にHTTP API部分を別ランタイムへ置き換える

のいずれかを検討した方がよいです。


### `file://` ではなく `http://127.0.0.1:8010` を使う

`/widget` を使う場合は、Electron側で `file://...` に直接埋め込むのではなく、ローカルサーバURLを読み込む形にするのが素直です。


## 推奨

Electronでまず動かすだけなら、最初は `/widget` を `BrowserWindow` または `iframe` で読み込む構成が最も簡単です。

独自デザインや独自操作を詰めたくなったら、その時点で `POST /api/predict` ベースの独自UIへ移るのが現実的です。

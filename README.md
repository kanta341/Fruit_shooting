# MAKE2

手描きの線画からフルーツ弾を生成し、シューティングゲームへ送る展示用アプリです。

## 主な構成

- `shootGame/`: Electron / Vite / TypeScript のゲーム本体、`/draw2` お絵描き画面、`/gameControl` 設定画面、`/boss` 表示画面
- `shootGame/capacitor-www/`: iPadネイティブ風アプリ用の `/draw2` ランチャー
- `space_data/`: 背景、敵、サンプル、フルーツ画像などのアセット
- `voice/`: BGM、効果音、案内音声
- `src/`: フルーツ生成・判定モデル関連のPythonコード
- `scripts/`: 補助スクリプト

## 起動

```bash
cd shootGame
npm install
npm run dev
```

ゲーム本体のローカル制御サーバは `http://127.0.0.1:8030` で起動します。

よく使う画面:

- `http://127.0.0.1:8030/draw2`
- `http://127.0.0.1:8030/gameControl`
- `http://127.0.0.1:8030/boss`

## iPadアプリ

```bash
cd shootGame
npm run cap:sync:ios
npm run cap:open:ios
```

XcodeからiPadへインストールします。iPad側ではMacのIPアドレスを `192.168.x.x:8030` のように指定して `/draw2` をアプリ内WebViewで開きます。

## ビルド確認

```bash
cd shootGame
npm run build:web
```

## Git管理方針

`node_modules`、ビルド成果物、Python仮想環境、Xcodeのユーザー固有ファイル、Capacitorが再生成できるiOS web payloadはコミット対象外です。

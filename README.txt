# e.nue Dashboard（修正版 / ダウンロード版）

## 直ってる内容
- otherページ：タップ不能にならない（tileはaタグ全面クリック、被りレイヤー無し）
- カレンダー：枠だけ問題を潰す（iframe固定高さ + overflow）
- iPhoneの青文字：aタグの色をinheritに統一（iOS青リンク対策）
- 受注件数 ↔ 総資産：切替モーション復活（panel + transition）
- 総資産/受注件数：bundle + 当月patch の骨組み（/data + Firestore想定）
- 購入履歴：追加＝patch、週次/任意でbundle再生成する方針の導線

## 使い方（GitHub Pages）
1) このフォルダ中身をそのままリポジトリに置く（index.html がルート）
2) Pagesを有効化（Branch: main / root）
3) URLで開く

## Firebase（patch読取）を有効にする
- js/firebase-optional.js を参考に、Firebase SDKを読み込み、initDashboard({getPatchFn}) を呼び出してください。
- Firestoreのpatch例：
  collection: patches
  docId: summary-YYYY-MM
  fields: { month:"YYYY-MM", assets:..., orders:..., revenue:... }

## bundleの更新
- /data/summary-bundle.json を管理者が再生成して差し替え（過去分）
- 当月分はFirestore patchで上書き️

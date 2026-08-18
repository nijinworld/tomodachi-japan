# API 一覧 ｜ Ranius日本語

すべて JSON。ベースは `http://localhost:5173`。

**認証は署名つきクッキー（`ranius_session`）だけです。**
ヘッダやクエリで利用者を名乗ることはできません。ログインは `POST /api/session`。

エラーは `{ "error": "日本語のメッセージ", "code": "CODE" }`。

| コード | 意味 |
|---|---|
| `UNAUTHENTICATED` (401) | ログインしていない、またはセッションが切れた |
| `FORBIDDEN` (403) | ロールが足りない／見てよい範囲の外 |
| `BAD_CREDENTIALS` (401) | ユーザーIDか合言葉が違う |
| `HALTED` (423) | セーフガーディング事案が開いている。確認と記録以外は止まる |
| `RANKING_FORBIDDEN` (403) | 先生の順位づけを求めた |
| `PERSONALITY_TERM` (422) | 所見・宣言に人格に触れる語が入っている |
| `SURVEY_FULL` (429) | 子ども用アンケートが上限に達した（名簿の人数＋4件） |

> **身元は必ずセッションから決まります。** `raterId` / `userId` / `facilitatorId` を body に入れても、
> 自分以外にはなりません（403 か、本人に上書き）。
> 一覧を返すエンドポイントは、すべてサーバ側で見える範囲に絞ってから返します。

## ロール

| ロール | 主に触れるもの |
|---|---|
| `admin` | 全部 |
| `mentor` | 担当チームの授業・所見・記録・集計 |
| `facilitator` | 自分の授業・所見・アンケートだけ |
| `rater` | `/api/blind/*` だけ |
| `staff` | 費用・設定・書き出し |

---

## ログイン

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/session` | 誰としてログインしているか。未ログインでも200（`user: null`） |
| POST | `/api/session` | `{userId, passcode}`。userId は ID でも名前でも可。HttpOnly クッキーを返す |
| DELETE | `/api/session` | ログアウト |
| POST | `/api/session/passcode` | `{current, next}` 本人が変更（8文字以上） |
| POST | `/api/users/:id/passcode` | admin が設定。CLI は `node scripts/set-passcode.js` |

---

## 盲検の採点（rater / admin のみ）

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/blind/queue` | 採点待ちの一覧。**「もう1人ぶん待ち」が先に出る** |
| GET | `/api/blind/lessons/:id` | 書き起こしのみ。先生の名前・アーム・AIスコア・子どもの名前は返さない |
| POST | `/api/lessons/:id/ratings` | `{raterId, dims}`。rater は自分以外のIDでは保存できない |

---

## 書き起こしの取り込み

| メソッド | パス | 備考 |
|---|---|---|
| POST | `/api/import/parse` | `{text, format?}` → 形式判定・話者一覧・警告・冒頭40発話 |
| POST | `/api/import/lesson` | `{classId, date, text, mapping}` → 授業作成＋採点＋所見。**対応づけはサーバで再実行する** |

対応形式：`webvtt` / `srt` / `zoom` / `plain` / `csv` / `tsv`（自動判定、`format` で明示指定も可）

---

## 書き出し（admin / staff）

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/export` | データセット一覧と列 |
| GET | `/api/export/:id` | CSV（BOM付きUTF-8／CRLF）。**子どもの識別子は入らない** |

`scores_long` / `scores_wide` / `mentor_logs` / `ratings` / `irr_pairs` / `survey_responses` / `cost_items` / `lessons`

---

## アンケートの配布（子どもはログインしない）

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/surveys/cycles` | 配布リンクの一覧と回答数 |
| POST | `/api/surveys/cycles` | `{classId, cycle}` → トークン発行。同じ組み合わせなら既存を返す |
| POST | `/api/surveys/cycles/:id/close` | 締め切る |
| GET | `/api/survey/:token` | **公開**。設問と尺度 |
| POST | `/api/survey/:token` | **公開**。`{answers}`。`studentId` は常に `null` で保存される |

---

## メタ・状態

| メソッド | パス | 何を返すか |
|---|---|---|
| GET | `/api/health` | 生存確認 |
| GET | `/api/meta` | ルーブリック／アンケート仕様／エビデンス表／撤退基準／現行モデル版／設定。**画面はまずこれを読む** |
| GET | `/api/kill-status` | 撤退基準の判定と、判定に使った指標 |
| PUT | `/api/settings` | 賃金など。知らないキーは400 |

`/api/health` `/api/meta` `/api/kill-status` `/api/incidents*` は停止中でも応答します。

---

## 人・組織

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/users?role=&arm=` | 見える範囲はロール依存。**合言葉のハッシュは返さない** |
| POST | `/api/users` | `{name, role, arm, licensed, region, startedAt, readyAt}`（admin） |
| PATCH | `/api/users/:id` | 名前・ロール・アーム・チーム等の変更（admin） |
| POST | `/api/classes` | `{name, facilitatorId, capacity}`（admin / mentor） |
| POST | `/api/classes/:id/students` | `{name}`。**定員を超えると400**（子どもを押し出さない） |
| GET | `/api/teams` | 4〜8名かどうかを `size_ok` で返す |
| GET | `/api/classes` | 定員8。超過は `over_capacity` |
| GET | `/api/students?arm=` | |

---

## 授業と採点

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/lessons?arm=&facilitatorId=&from=&to=&limit=` | **`sort` を付けると403**。順位は作らない |
| GET | `/api/lessons/:id` | 授業＋書き起こし＋スコア＋盲検採点＋所見 |
| POST | `/api/lessons` | `{classId, date, facilitatorId?, arm?, utterances:[{t,speaker,text}]}` |
| POST | `/api/lessons/:id/score` | 現行の凍結版で採点し、所見も作る |
| POST | `/api/lessons/:id/ratings` | `{raterId, dims:{CI:0..4,...}, blind}` 盲検の人間採点 |

`utterances` の `speaker` は `"T"`（先生）か、生徒ID。`t` は開始からの秒。

**スコアの構造**

```jsonc
{
  "lessonId": "ls_...", "modelVersionId": "mv_1", "frozen": true, "arm": "A",
  "overall": 3.0,
  "dims": { "CI": { "rater": "ai", "level": 3, "value": 0.599, "evidence": [ { "at": "00:21", "type": "long_utterance", "note": "..." } ] } },
  "signals": { "teacher_talk_ratio": 0.70, "uptake_rate": 0.43, "wait_time_median_sec": 3.0 }
}
```

---

## 先生（本人の過去とだけ比べる）

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/facilitators/:id/trend` | 時系列・最初の3回 vs 直近3回・所見履歴。**他人とは比べない** |
| GET | `/api/funnel` | 一人前到達率・中央値日数・90日継続率・採用率 |
| GET | `/api/feedbacks?facilitatorId=` | |
| POST | `/api/feedbacks` | 人格語を含むと422。`mentorMinutes` を入れるとメンター記録に自動計上 |
| POST | `/api/feedbacks/:id/ack` | 本人が読んだ |

---

## モデル版（凍結）

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/model-versions` | 一覧・現行・いまのファイルの指紋・**ドリフト警告** |
| POST | `/api/model-versions/freeze` | `{label, notes, llm}`。同内容なら既存を返す |
| POST | `/api/rescore` | `{modelVersionId?, lessonIds?}` 凍結版で再スコア |

指紋 = `sha256(scorer_version + llm + sha256(rubric.ja.json) + sha256(prompts/feedback.ja.md))`

---

## 測る

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/irr` | 人間×人間（判定に使う）と AI×人間（参考値）。QWK・完全一致・±1・ICC |
| GET | `/api/analysis/instrument` | 観点ごとの分布・天井床・観点間相関。因子分析の代わりの安い版 |
| GET | `/api/mentor-load` | 週次と要約。**記録がない週は 0 ではなく「未測定」** |
| POST | `/api/mentor-logs` | `{mentorId, facilitatorId, date, minutes, kind}`。minutes 必須 |
| GET | `/api/cost` | 3シナリオ（0円／最低賃金／同等職）× アーム別の1名あたり養成コスト |
| POST | `/api/cost-items` | `{label, category, actor, arm, hours, jpy, qty}` |
| DELETE | `/api/cost-items/:id` | |
| GET | `/api/analysis/ab` | アーム単位の集計のみ。個人は返さない |
| GET | `/api/analysis/archive-effect` | 教師固定効果で「見た週の次」を比べる。因果ではない |

---

## 子どものアンケート

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/surveys?facilitatorId=` | サイクルごとの集計＋前回差＋**返し方の遵守状況** |
| POST | `/api/surveys/responses` | `{facilitatorId, cycle, answers:{CI1:1..5,...}}` 頻度尺度のみ |
| POST | `/api/surveys/steps` | `{facilitatorId, cycle, step, action?}` step は `returned_at` / `action_declared_at` / `discussed_with_students_at` |

回答が4件未満のサイクルは、集計を返しません（個人が割れるため）。

---

## アーカイブ・チーム

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/clips` | |
| POST | `/api/clips` | **`prompt`（視聴の問い）は必須**。ないと400 |
| POST | `/api/clips/:id/view` | **`answer` は必須**。問いに答えない視聴は記録しない |
| GET | `/api/meetings` | 週次のチーム会 |
| POST | `/api/meetings` | `{teamId, date, attendeeIds, declarations:[{facilitatorId, action, dimension}]}` |

---

## セーフガーディング

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/incidents` | 停止中も応答 |
| POST | `/api/incidents` | `{summary}`。**記録した瞬間に全機能が停止する** |
| POST | `/api/incidents/:id/close` | `{publishedAt, resolution}`。**公表日なしにはクローズできない** |

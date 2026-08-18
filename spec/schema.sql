-- Ranius 日本語スクール版 — PostgreSQL スキーマ
-- 設計原則：スコアは必ず model_version_id を持つ。凍結版でしか採点しない。

CREATE TYPE role_t      AS ENUM ('trainee','facilitator','mentor','admin','external_rater');
CREATE TYPE arm_t       AS ENUM ('A_licensed_human_mentor','B_unlicensed_ai_mentor','none');
CREATE TYPE stage_t     AS ENUM ('applied','screening','training','supervised','certified','inactive');
CREATE TYPE dim_t       AS ENUM ('safety','learner_talk','negotiation','input','output');
CREATE TYPE cost_cat_t  AS ENUM ('personnel','materials_equipment','facilities','other');
CREATE TYPE cost_beh_t  AS ENUM ('fixed','variable','lumpy');
CREATE TYPE payer_t     AS ENUM ('company_cash','participant_opportunity','in_kind');

-- 凍結されたモデル版 ------------------------------------------------------
CREATE TABLE model_versions (
  id              text PRIMARY KEY,
  frozen_at       timestamptz NOT NULL,
  llm             text NOT NULL,
  prompt_sha256   char(64) NOT NULL,
  rubric_version  text NOT NULL,
  is_active       boolean NOT NULL DEFAULT false,
  notes           text
);
-- 有効な版は常に1つだけ
CREATE UNIQUE INDEX one_active_model ON model_versions (is_active) WHERE is_active;

CREATE TABLE people (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name          text NOT NULL,
  role                  role_t NOT NULL,
  has_teaching_license  boolean NOT NULL,
  prior_teaching_years  numeric(4,1) NOT NULL DEFAULT 0,
  residence_country     text,
  arm                   arm_t NOT NULL DEFAULT 'none',
  team_id               uuid,
  stage                 stage_t NOT NULL DEFAULT 'applied',
  certified_at          timestamptz,
  first_placement_at    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  mentor_id          uuid NOT NULL REFERENCES people(id),
  weekly_meeting_day smallint NOT NULL CHECK (weekly_meeting_day BETWEEN 0 AND 6),
  -- 4〜8名。人数自体にエビデンスはないが、心理的安全性の器として設計値
  CONSTRAINT team_size_hint CHECK (true)
);
ALTER TABLE people ADD CONSTRAINT fk_team FOREIGN KEY (team_id) REFERENCES teams(id);

CREATE TABLE lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitator_id   uuid NOT NULL REFERENCES people(id),
  class_id         uuid NOT NULL,
  started_at       timestamptz NOT NULL,
  duration_sec     integer NOT NULL,
  recording_uri    text,
  head15_clip_uri  text,          -- 冒頭15分。MET準拠で人間評定の省力化に使う
  consent_learners boolean NOT NULL DEFAULT false,
  consent_guardian boolean NOT NULL DEFAULT false,
  consent_at       timestamptz
);
CREATE INDEX ON lessons (facilitator_id, started_at);

-- AI採点 -----------------------------------------------------------------
CREATE TABLE ai_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id         uuid NOT NULL REFERENCES lessons(id),
  model_version_id  text NOT NULL REFERENCES model_versions(id),   -- ★必須
  scored_at         timestamptz NOT NULL DEFAULT now(),
  scores            jsonb NOT NULL,       -- {dim: 0-100}
  raw_metrics       jsonb NOT NULL,       -- SDだけでなく raw を必ず保存
  next_experiment   text,
  -- 同じ授業を同じ版で二重採点しない
  UNIQUE (lesson_id, model_version_id)
);
CREATE TABLE ai_score_evidence (
  id           bigserial PRIMARY KEY,
  ai_score_id  uuid NOT NULL REFERENCES ai_scores(id) ON DELETE CASCADE,
  dim          dim_t NOT NULL,
  t_sec        integer NOT NULL,
  quote        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('observation','counter_example'))
);

-- 人間評定（盲検） --------------------------------------------------------
CREATE TABLE human_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id   uuid NOT NULL REFERENCES lessons(id),
  rater_id    uuid NOT NULL REFERENCES people(id),
  blinded     boolean NOT NULL,           -- false は IRR 計算から除外
  head15_only boolean NOT NULL DEFAULT true,
  rated_at    timestamptz NOT NULL DEFAULT now(),
  scores      jsonb NOT NULL,
  UNIQUE (lesson_id, rater_id)
);

-- 生徒アンケート ----------------------------------------------------------
CREATE TABLE survey_responses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id        uuid REFERENCES lessons(id),
  class_id         uuid NOT NULL,
  learner_id_hash  text NOT NULL,          -- 生の学習者IDは保存しない
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  answers          jsonb NOT NULL,         -- {item_id: 1..5} 頻度尺度
  open_answers     jsonb
);

-- 「示唆＋伴走」。ここが効果を10倍にする層
CREATE TABLE survey_insights (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitator_id            uuid NOT NULL REFERENCES people(id),
  period_from               date NOT NULL,
  period_to                 date NOT NULL,
  model_version_id          text NOT NULL REFERENCES model_versions(id),
  focus_dimension           text NOT NULL,   -- dim_t または 'belonging'
  summary                   text NOT NULL,
  discussion_prompt         text NOT NULL,   -- 週次チームで話す問い
  share_with_students_prompt text NOT NULL,  -- 生徒と話し合うことを促す
  acknowledged_at           timestamptz,
  discussed_in_team_at      timestamptz
);

-- 習熟度別の割り当て（"タイプ別"ではない） --------------------------------
CREATE TABLE coaching_assignments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facilitator_id       uuid NOT NULL REFERENCES people(id),
  assigned_at          timestamptz NOT NULL DEFAULT now(),
  baseline_band        text NOT NULL CHECK (baseline_band IN ('entry','developing','proficient')),
  target_dimension     dim_t NOT NULL,
  technique            text NOT NULL,
  modality             text NOT NULL CHECK (modality IN ('ai_only','ai_plus_human','human_only')),
  mentor_id            uuid REFERENCES people(id),
  rehearsal_scenario_id uuid
);

-- 場面リハーサル（エビデンス未確立） --------------------------------------
CREATE TABLE rehearsal_scenarios (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  dim              dim_t NOT NULL,
  situation        text NOT NULL,
  learner_persona  text NOT NULL,
  success_criteria jsonb NOT NULL,
  evidence_status  text NOT NULL DEFAULT 'no_published_evidence'
);
CREATE TABLE rehearsal_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id      uuid NOT NULL REFERENCES rehearsal_scenarios(id),
  person_id        uuid NOT NULL REFERENCES people(id),
  attempted_at     timestamptz NOT NULL DEFAULT now(),
  transcript       jsonb NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id),
  ai_feedback      text,
  criteria_met     jsonb
);

-- 事業の全論拠：メンター1人あたりの担当数 ---------------------------------
CREATE TABLE mentor_load_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_of                     date NOT NULL,
  mentor_id                   uuid NOT NULL REFERENCES people(id),
  arm                         arm_t NOT NULL,
  active_facilitators         integer NOT NULL,
  human_minutes_spent         integer NOT NULL,
  ai_assist_events            integer NOT NULL DEFAULT 0,
  facilitators_per_mentor_hour numeric(6,2)
    GENERATED ALWAYS AS (
      CASE WHEN human_minutes_spent > 0
        THEN active_facilitators::numeric / (human_minutes_spent::numeric/60)
        ELSE NULL END) STORED,
  UNIQUE (week_of, mentor_id)
);

-- Ingredients-method の費用 -----------------------------------------------
CREATE TABLE cost_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period             text NOT NULL,             -- 'YYYY-MM'
  category           cost_cat_t NOT NULL,
  behavior           cost_beh_t NOT NULL,
  stage              text NOT NULL CHECK (stage IN ('development','startup','ongoing')),
  payer              payer_t NOT NULL,
  arm                arm_t NOT NULL,
  item               text NOT NULL,
  quantity           numeric(12,2) NOT NULL,
  unit_price_jpy     numeric(12,2) NOT NULL,
  shadow_price_case  text CHECK (shadow_price_case IN ('zero','minimum_wage','comparable_occupation')),
  source_note        text NOT NULL              -- 推測禁止。出典を必ず書く
);

-- 90日継続率を出すためのビュー
CREATE VIEW v_day90_retention AS
SELECT p.arm,
       count(*) FILTER (WHERE p.first_placement_at <= now() - interval '90 days') AS eligible,
       count(*) FILTER (WHERE p.first_placement_at <= now() - interval '90 days'
                          AND p.stage = 'certified')                              AS still_active
FROM people p
WHERE p.role = 'facilitator'
GROUP BY p.arm;

-- IRR（評定者間一致）の材料。盲検のみ・同一授業に2名以上
CREATE VIEW v_irr_pairs AS
SELECT hr1.lesson_id, hr1.rater_id AS rater_a, hr2.rater_id AS rater_b,
       hr1.scores AS scores_a, hr2.scores AS scores_b
FROM human_ratings hr1
JOIN human_ratings hr2
  ON hr1.lesson_id = hr2.lesson_id AND hr1.rater_id < hr2.rater_id
WHERE hr1.blinded AND hr2.blinded;

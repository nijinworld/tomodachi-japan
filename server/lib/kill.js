'use strict';
// 撤退基準の判定。
// 基準は spec/kill-criteria.json にある。コードに数字を書かない（後から動かせてしまうため）。
// safeguarding だけは、触れた瞬間にシステム全体を停止する（halt_all）。
const fs = require('node:fs');
const path = require('node:path');

function loadCriteria() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'spec', 'kill-criteria.json'), 'utf8'));
}

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
};

// metrics: { open_incident_count, mentor_load_ratio_b_over_a, irr_qwk, ... }
function evaluate(metrics, criteria = loadCriteria()) {
  // enabled: false の基準は判定しない。消してはいない（消すと誰も気づけなくなる）。
  const off = criteria.criteria.filter((c) => c.enabled === false);
  const results = criteria.criteria.filter((c) => c.enabled !== false).map((c) => {
    const value = metrics[c.metric];
    const measured = value !== undefined && value !== null;
    const tripped = measured && OPS[c.operator](value, c.threshold);
    return {
      id: c.id,
      label: c.label,
      rule: c.rule,
      metric: c.metric,
      value: measured ? value : null,
      threshold: c.threshold,
      operator: c.operator,
      measured,
      tripped,
      action: c.action,
      priority: c.priority,
      deadline: c.deadline || null,
      rationale: c.rationale || null,
    };
  });
  results.sort((a, b) => a.priority - b.priority);
  const tripped = results.filter((r) => r.tripped);
  const halt = tripped.find((r) => r.action === 'halt_all');
  return {
    results,
    tripped,
    disabled: off.map((c) => ({ id: c.id, label: c.label, reason: c.disabled_reason || '' })),
    unmeasured: results.filter((r) => !r.measured).map((r) => r.id),
    halt_all: !!halt,
    halt_reason: halt ? halt.label : null,
    status: halt ? 'halt' : tripped.length ? 'warn' : 'ok',
  };
}

module.exports = { evaluate, loadCriteria };

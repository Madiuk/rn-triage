// Pure aggregation helpers for query_history rows. Used by kb.js's
// /history/cost and /history/quality endpoints. Pure — no fetch / no
// DOM / no env access — so they're trivially unit-testable.
//
// The shape of a `row` is whatever PostgREST returned from a `select=`
// clause; these helpers gracefully tolerate missing columns by treating
// them as null/0. That matters because older rows (created before
// migration 0005) won't have model / token / cost columns populated,
// and we never want a JS crash on a partially-populated row.

function round6(n)      { return Math.round(n * 1e6) / 1e6; }
function roundDay(d)    { return { day: d.day, cost_usd: round6(d.cost_usd), count: d.count }; }
function roundModel(m)  { return { model: m.model, cost_usd: round6(m.cost_usd), count: m.count }; }
function byDayAsc(a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; }

// Per-day spend series + per-model split + cache hit rate. Returns the
// shape directly served by /history/cost.
function aggregateCostRows(rows) {
  const byDay = new Map();
  const byModel = new Map();
  let totalCost = 0;
  let totalLatencyMs = 0;
  let latencyCount = 0;
  let freshIn = 0, cacheRead = 0, cacheWrite = 0, output = 0;

  for (const row of rows) {
    const day = (row.created_at || '').slice(0, 10);
    const cost = Number(row.cost_usd) || 0;
    totalCost += cost;
    if (row.latency_ms != null) { totalLatencyMs += Number(row.latency_ms); latencyCount++; }
    freshIn    += Number(row.input_tokens)          || 0;
    cacheRead  += Number(row.cache_read_tokens)     || 0;
    cacheWrite += Number(row.cache_creation_tokens) || 0;
    output     += Number(row.output_tokens)         || 0;

    if (!byDay.has(day)) byDay.set(day, { day, cost_usd: 0, count: 0 });
    const d = byDay.get(day); d.cost_usd += cost; d.count += 1;

    const model = row.model || 'unknown';
    if (!byModel.has(model)) byModel.set(model, { model, cost_usd: 0, count: 0 });
    const m = byModel.get(model); m.cost_usd += cost; m.count += 1;
  }

  const inputTotal = freshIn + cacheRead + cacheWrite;
  return {
    total_cost_usd: round6(totalCost),
    total_triages: rows.length,
    mean_cost_per_triage: rows.length ? round6(totalCost / rows.length) : 0,
    mean_latency_ms: latencyCount ? Math.round(totalLatencyMs / latencyCount) : null,
    cache_hit_rate: inputTotal ? Number((cacheRead / inputTotal).toFixed(4)) : 0,
    tokens: {
      fresh_input:    freshIn,
      cache_read:     cacheRead,
      cache_creation: cacheWrite,
      output:         output,
    },
    by_day:   Array.from(byDay.values())  .map(roundDay)  .sort(byDayAsc),
    by_model: Array.from(byModel.values()).map(roundModel).sort((a, b) => b.cost_usd - a.cost_usd),
  };
}

// Quality / correction signals. Returns the shape served by
// /history/quality. Includes a per-prompt-version breakdown so a
// regression after a prompt change is visible directly in the data —
// you don't need to manually join versions and correction rates.
function aggregateQualityRows(rows) {
  const total = rows.length;
  let urgencyOverrides = 0;
  let corrected = 0;
  let upvoted = 0, downvoted = 0;
  let editDistSum = 0, editDistN = 0;
  let durSum = 0, durN = 0;
  let confSum = 0, confN = 0;
  let escalations = 0;
  const byPromptVersion = new Map();

  for (const row of rows) {
    const overrode = !!(row.urgency_override && row.urgency_override !== row.urgency_original);
    const wasCorrected = !!(row.actual_response_sent || row.correction_note);
    if (overrode) urgencyOverrides++;
    if (wasCorrected) corrected++;
    if (row.upvoted)   upvoted++;
    if (row.downvoted) downvoted++;
    if (row.edit_distance != null)            { editDistSum += Number(row.edit_distance);             editDistN++; }
    if (row.session_duration_seconds != null) { durSum      += Number(row.session_duration_seconds);  durN++; }
    if (row.ai_confidence != null)            { confSum     += Number(row.ai_confidence);             confN++; }
    if (row.clinical_routing_level && row.clinical_routing_level !== 'none') escalations++;

    const pv = row.prompt_version || 'unstamped';
    if (!byPromptVersion.has(pv)) {
      byPromptVersion.set(pv, { prompt_version: pv, count: 0, urgency_overrides: 0, corrections: 0 });
    }
    const v = byPromptVersion.get(pv);
    v.count++;
    if (overrode) v.urgency_overrides++;
    if (wasCorrected) v.corrections++;
  }

  function rate(n) { return total ? Number((n / total).toFixed(4)) : 0; }

  return {
    total_triages: total,
    urgency_override_rate: rate(urgencyOverrides),
    correction_rate:       rate(corrected),
    upvote_rate:           rate(upvoted),
    downvote_rate:         rate(downvoted),
    escalation_rate:       rate(escalations),
    mean_edit_distance:    editDistN ? Math.round((editDistSum / editDistN) * 10) / 10 : null,
    mean_session_seconds:  durN      ? Math.round(durSum / durN)                       : null,
    mean_ai_confidence:    confN     ? Number((confSum / confN).toFixed(3))            : null,
    by_prompt_version: Array.from(byPromptVersion.values())
      .map(v => ({
        prompt_version: v.prompt_version,
        count: v.count,
        urgency_override_rate: v.count ? Number((v.urgency_overrides / v.count).toFixed(4)) : 0,
        correction_rate:       v.count ? Number((v.corrections        / v.count).toFixed(4)) : 0,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

module.exports = { aggregateCostRows, aggregateQualityRows };

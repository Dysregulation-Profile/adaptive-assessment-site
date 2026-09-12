import { estimateEap } from './eap.js';
import { DIMENSIONS, itemInformationAtTheta } from './grm.js';
import { expectedMaximumSeReduction } from './pser.js';

const RESPONSE_MIN = 1;
const RESPONSE_MAX = 5;
const STOP_REASONS = new Set(['precision_stability', 'pser_information_exhausted', 'max_items']);

function fail(message) {
  throw new TypeError(message);
}

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => names.includes(key));
}

function numericDimensionRecord(value, label, { nonnegative = false, integer = false } = {}) {
  if (!exactKeys(value, DIMENSIONS)) fail(`${label} must contain exactly ${DIMENSIONS.join(',')}`);
  const out = {};
  for (const dimension of DIMENSIONS) {
    const number = finiteNumber(value[dimension], `${label}.${dimension}`);
    if (nonnegative && number < 0) fail(`${label}.${dimension} must be nonnegative`);
    if (integer && !Number.isInteger(number)) fail(`${label}.${dimension} must be an integer`);
    out[dimension] = number;
  }
  return out;
}

function modelIndex(model) {
  if (!model || typeof model !== 'object' || model.schemaVersion !== 1 || !Array.isArray(model.items)) {
    fail('browser IRT model is required');
  }
  if (!sameArray(model.dimensions, DIMENSIONS)) fail('model dimension order mismatch');
  const byId = new Map();
  for (const item of model.items) {
    if (!item || typeof item.id !== 'string' || byId.has(item.id) || !DIMENSIONS.includes(item.dimension)) {
      fail('invalid browser model item');
    }
    byId.set(item.id, item);
  }
  return byId;
}

export function validateCatStrategy(strategy, model) {
  const byId = modelIndex(model);
  if (!strategy || typeof strategy !== 'object') fail('CAT strategy is required');
  if (strategy.strategyVersion !== 'dp27-mcat-pser-2026-09-11' || strategy.mode !== 'mcat_adaptive') {
    fail('unsupported CAT strategy');
  }
  if (strategy.questionVersion !== model.questionVersion || strategy.modelVersion !== model.modelVersion ||
      String(strategy.modelSha256).toLowerCase() !== String(model.sourceModelSha256).toLowerCase()) {
    fail('CAT strategy/model provenance mismatch');
  }
  if (!sameArray(strategy.dimensions, DIMENSIONS)) fail('CAT dimension order mismatch');
  if (!Array.isArray(strategy.itemIds) || strategy.itemIds.length !== model.items.length ||
      new Set(strategy.itemIds).size !== strategy.itemIds.length ||
      strategy.itemIds.some((id, index) => id !== model.items[index]?.id || !byId.has(id))) {
    fail('CAT canonical item order mismatch');
  }
  if (!strategy.dimensionItems || typeof strategy.dimensionItems !== 'object') fail('CAT dimension items are required');
  for (const dimension of DIMENSIONS) {
    const expected = model.items.filter((item) => item.dimension === dimension).map((item) => item.id);
    if (!sameArray(strategy.dimensionItems[dimension], expected)) fail(`CAT ${dimension} item order mismatch`);
  }
  const expectedInitial = ['anx_b_1', 'anx_b_5', 'agg_a_2', 'agg_a_1', 'att_a_3', 'att_a_4'];
  if (!sameArray(strategy.initialItems, expectedInitial)) fail('CAT initial item order mismatch');

  const estimator = strategy.estimator;
  if (!estimator || estimator.method !== 'EAP' || estimator.quadpts !== 31 ||
      !sameArray(estimator.theta_lim, [-6, 6])) fail('CAT estimator mismatch');

  const stopping = strategy.stopping;
  if (!stopping || stopping.minItems !== 6 || stopping.minPerDimension !== 2 ||
      stopping.earliestStop !== 8 || stopping.maxItems !== 27 ||
      stopping.thetaDeltaThreshold !== 0.1 || stopping.thetaDeltaComparator !== 'strictly_less_than' ||
      stopping.consecutiveStableUpdates !== 2 || stopping.seThreshold !== 0.5 ||
      stopping.pserMetric !== 'expected_maximum_standard_error_reduction' ||
      stopping.pserThreshold !== 0.005 || stopping.pserComparator !== 'strictly_less_than' ||
      stopping.consecutivePserUpdates !== 2) {
    fail('CAT stopping rule mismatch');
  }

  const selection = strategy.selection;
  if (!selection || selection.initial !== 'top_two_information_per_dimension_at_theta_zero' ||
      selection.afterMinimum !== 'maximum_standard_error_dimension_then_highest_information_remaining' ||
      selection.dimensionTieBreak !== 'EMO_BEH_ATT_order' ||
      selection.itemTieBreak !== 'final27_canonical_order' ||
      selection.exhaustedDimensionFallback !== 'all_remaining_final27_canonical_order') {
    fail('CAT selection rule mismatch');
  }
  return { byId };
}

function normalizeHistory(history, strategy) {
  if (!Array.isArray(history) || history.length > strategy.stopping.maxItems) fail('invalid CAT history');
  const known = new Set(strategy.itemIds);
  const seen = new Set();
  return history.map((entry, index) => {
    if (!exactKeys(entry, ['itemId', 'value']) || typeof entry.itemId !== 'string' || !known.has(entry.itemId) ||
        seen.has(entry.itemId) || !Number.isInteger(entry.value) || entry.value < RESPONSE_MIN || entry.value > RESPONSE_MAX) {
      fail(`invalid CAT history entry ${index}`);
    }
    seen.add(entry.itemId);
    return { itemId: entry.itemId, value: entry.value };
  });
}

export function dimensionCountsFromHistory(history, model, strategy) {
  const { byId } = validateCatStrategy(strategy, model);
  const normalized = normalizeHistory(history, strategy);
  const counts = { EMO: 0, BEH: 0, ATT: 0 };
  for (const entry of normalized) counts[byId.get(entry.itemId).dimension] += 1;
  return counts;
}

function informationRankedItem(candidates, theta, byId) {
  let bestId = null;
  let bestInformation = -Infinity;
  for (const itemId of candidates) {
    const information = itemInformationAtTheta(byId.get(itemId), theta);
    if (information > bestInformation) {
      bestInformation = information;
      bestId = itemId;
    }
  }
  if (bestId === null) fail('no CAT item candidate');
  return { itemId: bestId, information: bestInformation };
}

export function selectNextCatItem({ asked, theta, se, dimensionCounts }, model, strategy) {
  const { byId } = validateCatStrategy(strategy, model);
  if (!Array.isArray(asked) || new Set(asked).size !== asked.length || asked.some((id) => !byId.has(id))) {
    fail('asked item IDs are invalid');
  }
  const thetaRecord = numericDimensionRecord(theta, 'theta');
  const seRecord = numericDimensionRecord(se, 'se', { nonnegative: true });
  const counts = numericDimensionRecord(dimensionCounts, 'dimensionCounts', { nonnegative: true, integer: true });
  if (DIMENSIONS.reduce((sum, dimension) => sum + counts[dimension], 0) !== asked.length) {
    fail('dimension counts do not match asked items');
  }

  const askedSet = new Set(asked);
  const remaining = strategy.itemIds.filter((id) => !askedSet.has(id));
  if (remaining.length === 0) fail('no CAT items remain');

  const underMinimum = DIMENSIONS.filter((dimension) => counts[dimension] < strategy.stopping.minPerDimension);
  let targetDimension;
  if (underMinimum.length > 0) {
    targetDimension = underMinimum[0];
    for (const dimension of underMinimum.slice(1)) {
      if (counts[dimension] < counts[targetDimension]) targetDimension = dimension;
    }
  } else {
    targetDimension = DIMENSIONS[0];
    for (const dimension of DIMENSIONS.slice(1)) {
      if (seRecord[dimension] > seRecord[targetDimension]) targetDimension = dimension;
    }
  }

  let candidates = remaining.filter((id) => byId.get(id).dimension === targetDimension);
  const fallback = candidates.length === 0;
  if (fallback) candidates = remaining;
  const selected = informationRankedItem(candidates, thetaRecord, byId);
  return { ...selected, targetDimension, fallback };
}

function makeEstimate(theta, se, stableUpdates, thetaDelta, precisionMet, pser, pserBelowUpdates) {
  return {
    theta: numericDimensionRecord(theta, 'theta'),
    se: numericDimensionRecord(se, 'se', { nonnegative: true }),
    stableUpdates,
    thetaDelta,
    precisionMet,
    pser,
    pserBelowUpdates,
    informationExhausted: pserBelowUpdates >= 2,
  };
}

function stoppingFlags(count, estimate, stopping) {
  const eligible = count >= stopping.earliestStop &&
    estimate.stableUpdates >= stopping.consecutiveStableUpdates;
  return {
    precisionStop: eligible && estimate.precisionMet,
    informationStop: eligible && !estimate.precisionMet &&
      estimate.pserBelowUpdates >= stopping.consecutivePserUpdates,
  };
}

function makeState(history, dimensionCounts, estimate, complete, stopReason, nextItem) {
  return { history, dimensionCounts, estimate, complete, stopReason, nextItem };
}

function stateSelection(history, estimate, counts, model, strategy) {
  return selectNextCatItem({
    asked: history.map((entry) => entry.itemId),
    theta: estimate.theta,
    se: estimate.se,
    dimensionCounts: counts,
  }, model, strategy).itemId;
}

export function validateCatState(state, model, strategy) {
  validateCatStrategy(strategy, model);
  if (!exactKeys(state, ['history', 'dimensionCounts', 'estimate', 'complete', 'stopReason', 'nextItem'])) {
    fail('invalid CAT state shape');
  }
  const history = normalizeHistory(state.history, strategy);
  const count = history.length;
  const counts = dimensionCountsFromHistory(history, model, strategy);
  const suppliedCounts = numericDimensionRecord(state.dimensionCounts, 'dimensionCounts', { nonnegative: true, integer: true });
  if (DIMENSIONS.some((dimension) => suppliedCounts[dimension] !== counts[dimension])) fail('CAT dimension counts mismatch');
  if (typeof state.complete !== 'boolean') fail('CAT complete flag must be boolean');

  const initialPrefix = strategy.initialItems.slice(0, Math.min(count, strategy.initialItems.length));
  if (!sameArray(history.slice(0, initialPrefix.length).map((entry) => entry.itemId), initialPrefix)) {
    fail('CAT initial item prefix mismatch');
  }

  if (count < strategy.stopping.minItems) {
    if (state.estimate !== null || state.complete || state.stopReason !== null ||
        state.nextItem !== strategy.initialItems[count]) fail('invalid pre-minimum CAT state');
    return makeState(history, counts, null, false, null, strategy.initialItems[count]);
  }

  if (!state.estimate || typeof state.estimate !== 'object') fail('CAT estimate is required');
  const theta = numericDimensionRecord(state.estimate.theta, 'estimate.theta');
  const se = numericDimensionRecord(state.estimate.se, 'estimate.se', { nonnegative: true });
  if (!Number.isInteger(state.estimate.stableUpdates) || state.estimate.stableUpdates < 0) fail('invalid stable update count');
  const thetaDelta = state.estimate.thetaDelta;
  if (thetaDelta !== null && (!Number.isFinite(thetaDelta) || thetaDelta < 0)) fail('invalid theta delta');
  if ((count === strategy.stopping.minItems && thetaDelta !== null) ||
      (count > strategy.stopping.minItems && thetaDelta === null)) fail('invalid theta delta timing');
  const precisionMet = DIMENSIONS.every((dimension) => se[dimension] <= strategy.stopping.seThreshold);
  if (state.estimate.precisionMet !== precisionMet) fail('CAT precision flag mismatch');
  const pser = finiteNumber(state.estimate.pser, 'estimate.pser');
  if (pser < 0) fail('estimate.pser must be nonnegative');
  if (!Number.isInteger(state.estimate.pserBelowUpdates) || state.estimate.pserBelowUpdates < 0) {
    fail('invalid PSER update count');
  }
  const pserMet = pser < strategy.stopping.pserThreshold;
  if ((pserMet && state.estimate.pserBelowUpdates === 0) ||
      (!pserMet && state.estimate.pserBelowUpdates !== 0)) fail('CAT PSER streak mismatch');
  const informationExhausted = state.estimate.pserBelowUpdates >= strategy.stopping.consecutivePserUpdates;
  if (state.estimate.informationExhausted !== informationExhausted) fail('CAT information flag mismatch');
  const estimate = makeEstimate(
    theta, se, state.estimate.stableUpdates, thetaDelta, precisionMet, pser, state.estimate.pserBelowUpdates,
  );
  const flags = stoppingFlags(count, estimate, strategy.stopping);

  if (state.complete) {
    if (count < strategy.stopping.earliestStop || state.nextItem !== null || !STOP_REASONS.has(state.stopReason) ||
        (state.stopReason === 'precision_stability' && !flags.precisionStop) ||
        (state.stopReason === 'pser_information_exhausted' && !flags.informationStop) ||
        (state.stopReason === 'max_items' &&
          (count !== strategy.stopping.maxItems || flags.precisionStop || flags.informationStop))) {
      fail('invalid completed CAT state');
    }
    return makeState(history, counts, estimate, true, state.stopReason, null);
  }

  if (state.stopReason !== null || count >= strategy.stopping.maxItems || typeof state.nextItem !== 'string' ||
      flags.precisionStop || flags.informationStop ||
      history.some((entry) => entry.itemId === state.nextItem)) fail('invalid active CAT state');
  const selected = stateSelection(history, estimate, counts, model, strategy);
  if (state.nextItem !== selected) fail('CAT next item mismatch');
  return makeState(history, counts, estimate, false, null, selected);
}

export function startCat(model, strategy) {
  validateCatStrategy(strategy, model);
  return makeState([], { EMO: 0, BEH: 0, ATT: 0 }, null, false, null, strategy.initialItems[0]);
}

export function stepCat(state, itemId, value, model, grid, strategy) {
  const currentState = validateCatState(state, model, strategy);
  if (currentState.complete || typeof itemId !== 'string' || itemId !== currentState.nextItem ||
      !Number.isInteger(value) || value < RESPONSE_MIN || value > RESPONSE_MAX) fail('invalid CAT response');

  const history = [...currentState.history, { itemId, value }];
  const counts = dimensionCountsFromHistory(history, model, strategy);
  const count = history.length;
  const stopping = strategy.stopping;

  if (count < stopping.minItems) {
    return makeState(history, counts, null, false, null, strategy.initialItems[count]);
  }

  const current = estimateEap(history, model, grid);
  const precisionMet = DIMENSIONS.every((dimension) => current.se[dimension] <= stopping.seThreshold);
  const pser = expectedMaximumSeReduction({
    posterior: current.posterior,
    se: current.se,
    asked: history.map((entry) => entry.itemId),
  }, model, grid);
  const pserBelowUpdates = pser < stopping.pserThreshold
    ? (currentState.estimate?.pserBelowUpdates ?? 0) + 1
    : 0;

  if (count === stopping.minItems) {
    const estimate = makeEstimate(current.theta, current.se, 0, null, precisionMet, pser, pserBelowUpdates);
    return makeState(history, counts, estimate, false, null, stateSelection(history, estimate, counts, model, strategy));
  }

  const previousTheta = numericDimensionRecord(currentState.estimate.theta, 'previous theta');
  const thetaDelta = Math.max(...DIMENSIONS.map((dimension) => Math.abs(current.theta[dimension] - previousTheta[dimension])));
  const stableUpdates = thetaDelta < stopping.thetaDeltaThreshold ? currentState.estimate.stableUpdates + 1 : 0;
  const estimate = makeEstimate(
    current.theta, current.se, stableUpdates, thetaDelta, precisionMet, pser, pserBelowUpdates,
  );
  const { precisionStop, informationStop } = stoppingFlags(count, estimate, stopping);

  if (precisionStop) return makeState(history, counts, estimate, true, 'precision_stability', null);
  if (informationStop) return makeState(history, counts, estimate, true, 'pser_information_exhausted', null);
  if (count === stopping.maxItems) return makeState(history, counts, estimate, true, 'max_items', null);
  return makeState(history, counts, estimate, false, null, stateSelection(history, estimate, counts, model, strategy));
}

export function replayCat(history, model, grid, strategy) {
  const normalized = normalizeHistory(history, strategy);
  let state = startCat(model, strategy);
  for (const entry of normalized) {
    if (state.complete) fail('CAT history continues after completion');
    state = stepCat(state, entry.itemId, entry.value, model, grid, strategy);
  }
  return state;
}

export function catView(state, model, strategy) {
  const valid = validateCatState(state, model, strategy);
  return {
    mode: strategy.mode,
    strategyVersion: strategy.strategyVersion,
    questionVersion: strategy.questionVersion,
    administeredCount: valid.history.length,
    minItems: strategy.stopping.minItems,
    earliestStop: strategy.stopping.earliestStop,
    maxItems: strategy.stopping.maxItems,
    nextItem: valid.nextItem,
    complete: valid.complete,
    stopReason: valid.stopReason,
    dimensionCounts: valid.dimensionCounts,
    estimate: valid.estimate,
  };
}

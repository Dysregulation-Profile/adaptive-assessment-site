import { DIMENSIONS, grmCategoryProbabilitiesNative } from './grm.js';

const CATEGORY_COUNT = 5;
const runtimeCache = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function likelihoodCache(model, grid) {
  const cached = runtimeCache.get(model);
  if (cached?.grid === grid) return cached.likelihood;

  const pointCount = grid?.pointCount;
  if (!Number.isInteger(pointCount) || pointCount <= 0 || !Array.isArray(model?.items)) {
    fail('valid model and EAP grid are required for PSER');
  }
  const theta = DIMENSIONS.map((dimension) => grid.theta?.[dimension]);
  if (theta.some((values) => !Array.isArray(values) || values.length !== pointCount)) {
    fail('PSER grid dimension mismatch');
  }

  const likelihood = model.items.map((item) => {
    const categories = Array.from({ length: CATEGORY_COUNT }, () => new Float64Array(pointCount));
    for (let g = 0; g < pointCount; g += 1) {
      const probabilities = grmCategoryProbabilitiesNative(
        [theta[0][g], theta[1][g], theta[2][g]],
        item.native,
      );
      for (let category = 0; category < CATEGORY_COUNT; category += 1) {
        categories[category][g] = probabilities[category];
      }
    }
    return categories;
  });

  runtimeCache.set(model, { grid, likelihood });
  return likelihood;
}

export function expectedMaximumSeReduction({ posterior, se, asked }, model, grid) {
  const pointCount = grid?.pointCount;
  if (!(posterior instanceof Float64Array) || posterior.length !== pointCount) {
    fail('normalized EAP posterior is required for PSER');
  }
  if (!se || !Array.isArray(asked)) fail('current SE and asked items are required for PSER');

  const theta = DIMENSIONS.map((dimension) => grid.theta[dimension]);
  const currentLoss = Math.max(...DIMENSIONS.map((dimension) => se[dimension]));
  if (!Number.isFinite(currentLoss) || currentLoss < 0) fail('current SE is invalid for PSER');

  const askedSet = new Set(asked);
  const likelihood = likelihoodCache(model, grid);
  let bestReduction = 0;

  for (let itemIndex = 0; itemIndex < model.items.length; itemIndex += 1) {
    if (askedSet.has(model.items[itemIndex].id)) continue;
    let expectedLoss = 0;

    for (let category = 0; category < CATEGORY_COUNT; category += 1) {
      const itemLikelihood = likelihood[itemIndex][category];
      let responseProbability = 0;
      const first = [0, 0, 0];
      const second = [0, 0, 0];

      for (let g = 0; g < pointCount; g += 1) {
        const mass = posterior[g] * itemLikelihood[g];
        if (mass === 0) continue;
        responseProbability += mass;
        for (let dimension = 0; dimension < 3; dimension += 1) {
          const value = theta[dimension][g];
          first[dimension] += mass * value;
          second[dimension] += mass * value * value;
        }
      }

      if (!(responseProbability > 0)) continue;
      let conditionalMaximumSe = 0;
      for (let dimension = 0; dimension < 3; dimension += 1) {
        const mean = first[dimension] / responseProbability;
        const variance = Math.max(0, second[dimension] / responseProbability - mean * mean);
        conditionalMaximumSe = Math.max(conditionalMaximumSe, Math.sqrt(variance));
      }
      expectedLoss += responseProbability * conditionalMaximumSe;
    }

    bestReduction = Math.max(bestReduction, Math.max(0, currentLoss - expectedLoss));
  }

  return bestReduction;
}

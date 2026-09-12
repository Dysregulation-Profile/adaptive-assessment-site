import { DIMENSIONS, logistic } from './grm.js';

const CATEGORY_COUNT = 5;
const RESPONSE_MIN = 1;
const RESPONSE_MAX = 5;

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function validateGrid(grid) {
  if (!grid || typeof grid !== 'object') throw new TypeError('EAP grid is required');
  if (grid.schemaVersion !== 1) throw new TypeError('unsupported EAP grid schema');
  if (JSON.stringify(grid.dimensions) !== JSON.stringify(DIMENSIONS)) {
    throw new TypeError('EAP grid dimension order mismatch');
  }
  if (!grid.theta || typeof grid.theta !== 'object' || !Array.isArray(grid.weight)) {
    throw new TypeError('EAP grid theta/weight arrays are required');
  }

  const count = grid.pointCount;
  if (!Number.isInteger(count) || count <= 0 || grid.weight.length !== count) {
    throw new TypeError('invalid EAP grid point count');
  }

  for (const dimension of DIMENSIONS) {
    if (!Array.isArray(grid.theta[dimension]) || grid.theta[dimension].length !== count) {
      throw new TypeError(`invalid theta grid for ${dimension}`);
    }
  }
  return count;
}

function validateModel(model) {
  if (!model || typeof model !== 'object' || model.schemaVersion !== 1) {
    throw new TypeError('browser IRT model is required');
  }
  if (JSON.stringify(model.dimensions) !== JSON.stringify(DIMENSIONS)) {
    throw new TypeError('model dimension order mismatch');
  }
  if (!Array.isArray(model.items) || model.items.length === 0) {
    throw new TypeError('model items are required');
  }
}

function stableLogisticDifference(x, y) {
  finiteNumber(x, 'upper logit');
  finiteNumber(y, 'lower logit');
  if (x < y) throw new RangeError('GRM intercepts must preserve cumulative order');
  if (x === y) return 0;

  if (y >= 0) {
    const ex = Math.exp(-x);
    const ey = Math.exp(-y);
    return (ey - ex) / ((1 + ex) * (1 + ey));
  }
  if (x <= 0) {
    const ex = Math.exp(x);
    const ey = Math.exp(y);
    return (ex - ey) / ((1 + ex) * (1 + ey));
  }
  return logistic(x) - logistic(y);
}

export function grmCategoryProbabilityFromEta(eta, intercepts, category) {
  finiteNumber(eta, 'eta');
  if (!Array.isArray(intercepts) || intercepts.length !== 4) {
    throw new TypeError('four GRM intercepts are required');
  }
  if (!Number.isInteger(category) || category < 0 || category >= CATEGORY_COUNT) {
    throw new RangeError('GRM category index must be an integer from 0 to 4');
  }
  const d = intercepts.map((value, index) => finiteNumber(value, `d${index + 1}`));

  if (category === 0) return logistic(-(eta + d[0]));
  if (category === 4) return logistic(eta + d[3]);
  return stableLogisticDifference(eta + d[category - 1], eta + d[category]);
}

function prepareResponses(responses, model) {
  if (!Array.isArray(responses)) throw new TypeError('responses must be an array');
  const itemById = new Map(model.items.map((item) => [item.id, item]));
  const seen = new Set();

  return responses.map((response, index) => {
    if (!response || typeof response !== 'object' || typeof response.itemId !== 'string') {
      throw new TypeError(`response[${index}] is invalid`);
    }
    if (seen.has(response.itemId)) throw new TypeError(`duplicate response for ${response.itemId}`);
    seen.add(response.itemId);

    const item = itemById.get(response.itemId);
    if (!item || !item.native) throw new TypeError(`unknown item ${response.itemId}`);
    const value = response.value;
    if (!Number.isInteger(value) || value < RESPONSE_MIN || value > RESPONSE_MAX) {
      throw new RangeError(`response value for ${response.itemId} must be 1..5`);
    }

    const a = [item.native.a1, item.native.a2, item.native.a3].map((number, dim) =>
      finiteNumber(number, `${response.itemId}.a${dim + 1}`),
    );
    const d = [item.native.d1, item.native.d2, item.native.d3, item.native.d4].map((number, threshold) =>
      finiteNumber(number, `${response.itemId}.d${threshold + 1}`),
    );
    return { itemId: response.itemId, value, category: value - RESPONSE_MIN, a, d };
  });
}

export function estimateEap(responses, model, grid) {
  validateModel(model);
  const pointCount = validateGrid(grid);
  if (grid.sourceModelSha256 !== model.sourceModelSha256) {
    throw new TypeError('model/grid source SHA256 mismatch');
  }
  if (grid.modelVersion !== model.modelVersion || grid.questionVersion !== model.questionVersion) {
    throw new TypeError('model/grid version mismatch');
  }

  const prepared = prepareResponses(responses, model);
  const emo = grid.theta.EMO;
  const beh = grid.theta.BEH;
  const att = grid.theta.ATT;
  const logPosterior = new Float64Array(pointCount);
  let maxLogPosterior = -Infinity;

  for (let g = 0; g < pointCount; g += 1) {
    const priorWeight = finiteNumber(grid.weight[g], `weight[${g}]`);
    if (priorWeight < 0) throw new RangeError('EAP prior weights must be nonnegative');
    let logWeight = priorWeight > 0 ? Math.log(priorWeight) : -Infinity;

    if (Number.isFinite(logWeight)) {
      for (const response of prepared) {
        const eta = response.a[0] * emo[g] + response.a[1] * beh[g] + response.a[2] * att[g];
        const probability = grmCategoryProbabilityFromEta(eta, response.d, response.category);
        if (!(probability > 0) || !Number.isFinite(probability)) {
          logWeight = -Infinity;
          break;
        }
        logWeight += Math.log(probability);
      }
    }

    logPosterior[g] = logWeight;
    if (logWeight > maxLogPosterior) maxLogPosterior = logWeight;
  }

  if (!Number.isFinite(maxLogPosterior)) throw new RangeError('posterior has zero finite mass');

  let scaledMass = 0;
  const posterior = new Float64Array(pointCount);
  const means = [0, 0, 0];
  for (let g = 0; g < pointCount; g += 1) {
    const scaled = Math.exp(logPosterior[g] - maxLogPosterior);
    posterior[g] = scaled;
    scaledMass += scaled;
    means[0] += scaled * emo[g];
    means[1] += scaled * beh[g];
    means[2] += scaled * att[g];
  }
  if (!(scaledMass > 0) || !Number.isFinite(scaledMass)) throw new RangeError('invalid posterior normalization');
  for (let g = 0; g < pointCount; g += 1) posterior[g] /= scaledMass;
  for (let dimension = 0; dimension < 3; dimension += 1) means[dimension] /= scaledMass;

  const variances = [0, 0, 0];
  for (let g = 0; g < pointCount; g += 1) {
    const differences = [emo[g] - means[0], beh[g] - means[1], att[g] - means[2]];
    for (let dimension = 0; dimension < 3; dimension += 1) {
      variances[dimension] += posterior[g] * differences[dimension] * differences[dimension];
    }
  }

  const theta = {};
  const se = {};
  for (let dimension = 0; dimension < 3; dimension += 1) {
    const variance = Math.max(0, variances[dimension]);
    theta[DIMENSIONS[dimension]] = means[dimension];
    se[DIMENSIONS[dimension]] = Math.sqrt(variance);
  }

  return {
    theta,
    se,
    posterior,
    answeredItems: prepared.length,
    logNormalizer: maxLogPosterior + Math.log(scaledMass),
  };
}

export const DIMENSIONS = Object.freeze(['EMO', 'BEH', 'ATT']);
const PROBABILITY_FLOOR = 1e-10;

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function thresholdVector(thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length !== 4) {
    throw new TypeError('GRM requires exactly four thresholds');
  }
  return thresholds.map((value, index) => finiteNumber(value, `threshold[${index}]`));
}

function thetaVector(theta) {
  if (Array.isArray(theta)) {
    if (theta.length !== 3) throw new TypeError('theta array must have length 3');
    return theta.map((value, index) => finiteNumber(value, `theta[${index}]`));
  }
  if (theta && typeof theta === 'object') {
    return DIMENSIONS.map((dimension) => finiteNumber(theta[dimension], `theta.${dimension}`));
  }
  throw new TypeError('theta must be a 3-vector or dimension record');
}

export function logistic(x) {
  finiteNumber(x, 'x');
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function cumulativeProbabilities1D(theta, a, thresholds) {
  finiteNumber(theta, 'theta');
  finiteNumber(a, 'a');
  const bs = thresholdVector(thresholds);
  return [1, ...bs.map((b) => logistic(a * (theta - b))), 0];
}

function categoryProbabilitiesFromCumulative(pstar) {
  const probabilities = new Array(pstar.length - 1);
  for (let k = 0; k < probabilities.length; k += 1) {
    probabilities[k] = pstar[k] - pstar[k + 1];
  }
  return probabilities;
}

export function grmCategoryProbabilities1D(theta, a, thresholds) {
  return categoryProbabilitiesFromCumulative(cumulativeProbabilities1D(theta, a, thresholds));
}

export function grmItemInformation1D(theta, a, thresholds) {
  const pstar = cumulativeProbabilities1D(theta, a, thresholds);
  const pk = categoryProbabilitiesFromCumulative(pstar);
  const dstar = pstar.map((p) => a * p * (1 - p));

  let information = 0;
  for (let k = 0; k < pk.length; k += 1) {
    const derivative = dstar[k] - dstar[k + 1];
    information += (derivative * derivative) / Math.max(pk[k], PROBABILITY_FLOOR);
  }

  if (!Number.isFinite(information) || information < 0) {
    throw new RangeError('invalid GRM item information');
  }
  return information;
}

export function grmCategoryProbabilitiesNative(theta, native) {
  if (!native || typeof native !== 'object') throw new TypeError('native parameters are required');
  const thetaValues = thetaVector(theta);
  const a = [native.a1, native.a2, native.a3].map((value, index) => finiteNumber(value, `a${index + 1}`));
  const d = [native.d1, native.d2, native.d3, native.d4].map((value, index) => finiteNumber(value, `d${index + 1}`));

  let linearPredictor = 0;
  for (let i = 0; i < 3; i += 1) linearPredictor += a[i] * thetaValues[i];

  const pstar = [1, ...d.map((intercept) => logistic(linearPredictor + intercept)), 0];
  return categoryProbabilitiesFromCumulative(pstar);
}

export function itemInformationAtTheta(item, theta) {
  if (!item || typeof item !== 'object') throw new TypeError('item is required');
  if (!DIMENSIONS.includes(item.dimension)) throw new TypeError('item dimension is invalid');
  if (!item.irt || typeof item.irt !== 'object') throw new TypeError('item IRT parameters are required');

  const thetaValues = thetaVector(theta);
  const dimensionIndex = DIMENSIONS.indexOf(item.dimension);
  const a = finiteNumber(item.irt[`a${dimensionIndex + 1}`], 'on-dimension discrimination');
  const thresholds = [item.irt.b1, item.irt.b2, item.irt.b3, item.irt.b4];
  return grmItemInformation1D(thetaValues[dimensionIndex], a, thresholds);
}

export function probabilitySum(probabilities) {
  if (!Array.isArray(probabilities)) throw new TypeError('probabilities must be an array');
  return probabilities.reduce((sum, value, index) => sum + finiteNumber(value, `probability[${index}]`), 0);
}

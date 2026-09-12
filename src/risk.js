import { validateCatState } from './cat.js';
import { DIMENSIONS } from './grm.js';

export const RISK_LABELS = Object.freeze({
  none: '非高风险',
  emo: '高情绪问题型',
  beh: '高行为问题型',
  att: '高注意问题型',
  emo_beh: '情绪-行为混合型',
  emo_att: '情绪-注意混合型',
  beh_att: '行为-注意混合型',
  emo_beh_att: '三维共高型',
  general: '综合高风险型',
});

const CONFIG_KEYS = [
  'schemaVersion',
  'questionVersion',
  'modelVersion',
  'sourceModelSha256',
  'sourceMirtVersion',
  'mode',
  'dimensions',
  'coefficients',
  'riskThreshold',
  'thetaThresholds',
];

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

function numericDimensionRecord(value, label, { nonnegative = false } = {}) {
  if (!exactKeys(value, DIMENSIONS)) fail(`${label} must contain exactly ${DIMENSIONS.join(',')}`);
  const out = {};
  for (const dimension of DIMENSIONS) {
    const number = finiteNumber(value[dimension], `${label}.${dimension}`);
    if (nonnegative && number < 0) fail(`${label}.${dimension} must be nonnegative`);
    out[dimension] = number;
  }
  return out;
}

function booleanDimensionRecord(value, label) {
  if (!exactKeys(value, DIMENSIONS)) fail(`${label} must contain exactly ${DIMENSIONS.join(',')}`);
  const out = {};
  for (const dimension of DIMENSIONS) {
    if (typeof value[dimension] !== 'boolean') fail(`${label}.${dimension} must be boolean`);
    out[dimension] = value[dimension];
  }
  return out;
}

export function validateRiskConfig(config, model = null) {
  if (!exactKeys(config, CONFIG_KEYS) || config.schemaVersion !== 1) fail('invalid browser risk config');
  if (typeof config.questionVersion !== 'string' || config.questionVersion.length === 0 ||
      typeof config.modelVersion !== 'string' || config.modelVersion.length === 0 ||
      typeof config.sourceModelSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(config.sourceModelSha256) ||
      config.sourceMirtVersion !== '1.46.1' || config.mode !== 'fixed27_irt') {
    fail('unsupported browser risk config provenance');
  }
  if (!sameArray(config.dimensions, DIMENSIONS)) fail('risk dimension order mismatch');
  if (!exactKeys(config.coefficients, ['intercept', ...DIMENSIONS])) fail('risk coefficients are invalid');
  const coefficients = { intercept: finiteNumber(config.coefficients.intercept, 'coefficients.intercept') };
  for (const dimension of DIMENSIONS) {
    coefficients[dimension] = finiteNumber(config.coefficients[dimension], `coefficients.${dimension}`);
  }
  const riskThreshold = finiteNumber(config.riskThreshold, 'riskThreshold');
  const thetaThresholds = numericDimensionRecord(config.thetaThresholds, 'thetaThresholds');

  if (model !== null) {
    if (!model || typeof model !== 'object' || model.schemaVersion !== 1 ||
        model.questionVersion !== config.questionVersion || model.modelVersion !== config.modelVersion ||
        String(model.sourceModelSha256).toLowerCase() !== config.sourceModelSha256.toLowerCase() ||
        !sameArray(model.dimensions, DIMENSIONS)) {
      fail('risk config/model provenance mismatch');
    }
  }

  return {
    ...config,
    sourceModelSha256: config.sourceModelSha256.toLowerCase(),
    dimensions: [...DIMENSIONS],
    coefficients,
    riskThreshold,
    thetaThresholds,
  };
}

export function classifyRiskCode(isHigh, positive) {
  if (typeof isHigh !== 'boolean') fail('isHigh must be boolean');
  const checked = booleanDimensionRecord(positive, 'positive');
  if (!isHigh) return 'none';
  const selected = DIMENSIONS.filter((dimension) => checked[dimension]);
  if (selected.length === 0) return 'general';
  return selected.map((dimension) => dimension.toLowerCase()).join('_');
}

export function riskFromEstimate(theta, se, config, options = {}) {
  const checkedConfig = validateRiskConfig(config);
  const thetaRecord = numericDimensionRecord(theta, 'theta');
  const seRecord = numericDimensionRecord(se, 'se', { nonnegative: true });
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('risk options must be an object');
  const mode = options.mode ?? checkedConfig.mode;
  const strategyVersion = options.strategyVersion ?? null;
  if (mode !== checkedConfig.mode && mode !== 'mcat_adaptive') fail('unsupported risk scoring mode');
  if (mode === 'mcat_adaptive') {
    if (typeof strategyVersion !== 'string' || strategyVersion.length === 0) fail('adaptive risk strategy version is required');
  } else if (strategyVersion !== null) {
    fail('fixed risk scoring cannot include a CAT strategy version');
  }

  let score = checkedConfig.coefficients.intercept;
  for (const dimension of DIMENSIONS) score += thetaRecord[dimension] * checkedConfig.coefficients[dimension];
  finiteNumber(score, 'risk score');
  const isHigh = score >= checkedConfig.riskThreshold;
  const positive = Object.fromEntries(DIMENSIONS.map((dimension) => [
    dimension,
    thetaRecord[dimension] >= checkedConfig.thetaThresholds[dimension],
  ]));
  const typeCode = classifyRiskCode(isHigh, positive);

  const result = {
    status: 'ok',
    mode,
    modelVersion: checkedConfig.modelVersion,
    isHigh,
    typeCode,
    typeLabel: RISK_LABELS[typeCode],
    score,
    threshold: checkedConfig.riskThreshold,
    dimensions: DIMENSIONS.map((dimension) => ({
      id: dimension,
      theta: thetaRecord[dimension],
      se: seRecord[dimension],
      threshold: checkedConfig.thetaThresholds[dimension],
      positive: positive[dimension],
    })),
  };
  if (mode === 'mcat_adaptive') result.strategyVersion = strategyVersion;
  return result;
}

export function riskFromCompletedCatState(state, model, strategy, config) {
  const checkedConfig = validateRiskConfig(config, model);
  const validState = validateCatState(state, model, strategy);
  if (!validState.complete || validState.estimate === null) fail('completed CAT state with an estimate is required');
  if (strategy.questionVersion !== checkedConfig.questionVersion || strategy.modelVersion !== checkedConfig.modelVersion ||
      String(strategy.modelSha256).toLowerCase() !== checkedConfig.sourceModelSha256 || strategy.mode !== 'mcat_adaptive') {
    fail('CAT strategy/risk config provenance mismatch');
  }
  return riskFromEstimate(validState.estimate.theta, validState.estimate.se, checkedConfig, {
    mode: 'mcat_adaptive',
    strategyVersion: strategy.strategyVersion,
  });
}

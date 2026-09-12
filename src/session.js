import { replayCat, startCat, stepCat, validateCatState } from './cat.js';
import { questionnaireItemMap, validateQuestionnaire } from './questionnaire.js';
import { riskFromCompletedCatState, validateRiskConfig } from './risk.js';

const SESSION_SCHEMA_VERSION = 1;
const trustedSessions = new WeakSet();

function fail(message) {
  throw new TypeError(message);
}

function validateSessionShape(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session) ||
      Object.keys(session).length !== 2 || session.schemaVersion !== SESSION_SCHEMA_VERSION || !('cat' in session)) {
    fail('invalid assessment session');
  }
  return session;
}

function validateRuntime(questionnaire, model, strategy, riskConfig) {
  validateQuestionnaire(questionnaire, model, strategy);
  validateRiskConfig(riskConfig, model);
  return true;
}

function validateResponseValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 5) fail('response value must be an integer from 1 to 5');
  return value;
}

function sameCatState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function makeTrustedSession(cat) {
  const session = deepFreeze({ schemaVersion: SESSION_SCHEMA_VERSION, cat });
  trustedSessions.add(session);
  return session;
}

export function startAssessmentSession(questionnaire, model, strategy, riskConfig) {
  validateRuntime(questionnaire, model, strategy, riskConfig);
  return makeTrustedSession(startCat(model, strategy));
}

export function validateAssessmentSession(session, questionnaire, model, strategy, riskConfig, grid = undefined) {
  validateRuntime(questionnaire, model, strategy, riskConfig);
  validateSessionShape(session);
  const cat = validateCatState(session.cat, model, strategy);

  if (grid !== undefined && !trustedSessions.has(session)) {
    const replayed = replayCat(cat.history, model, grid, strategy);
    if (!sameCatState(cat, replayed)) fail('CAT state/history integrity mismatch');
    return makeTrustedSession(replayed);
  }

  return trustedSessions.has(session) ? session : { schemaVersion: SESSION_SCHEMA_VERSION, cat };
}

export function answerAssessmentSession(session, value, questionnaire, model, grid, strategy, riskConfig) {
  const valid = validateAssessmentSession(session, questionnaire, model, strategy, riskConfig, grid);
  if (valid.cat.complete) fail('assessment session is already complete');
  validateResponseValue(value);
  const cat = stepCat(valid.cat, valid.cat.nextItem, value, model, grid, strategy);
  return makeTrustedSession(cat);
}

export function assessmentHistoryItemView(session, index, questionnaire, model, strategy, riskConfig) {
  const valid = validateAssessmentSession(session, questionnaire, model, strategy, riskConfig);
  if (!Number.isInteger(index) || index < 0 || index >= valid.cat.history.length) fail('history index is out of range');
  const itemById = questionnaireItemMap(questionnaire, model, strategy);
  const entry = valid.cat.history[index];
  const question = itemById.get(entry.itemId);
  if (!question) fail('history item is absent from questionnaire');
  return {
    index,
    selectedValue: entry.value,
    laterAnswerCount: valid.cat.history.length - index - 1,
    question: { ...question },
    options: questionnaire.options.map((option) => ({ ...option })),
  };
}

export function rewindAssessmentSession(session, index, value, questionnaire, model, grid, strategy, riskConfig) {
  const valid = validateAssessmentSession(session, questionnaire, model, strategy, riskConfig, grid);
  if (!Number.isInteger(index) || index < 0 || index >= valid.cat.history.length) fail('history index is out of range');
  validateResponseValue(value);
  const prior = valid.cat.history[index];
  const history = [...valid.cat.history.slice(0, index), { itemId: prior.itemId, value }];
  const cat = replayCat(history, model, grid, strategy);
  return makeTrustedSession(cat);
}

export function assessmentSessionView(session, questionnaire, model, strategy, riskConfig) {
  const valid = validateAssessmentSession(session, questionnaire, model, strategy, riskConfig);
  const itemById = questionnaireItemMap(questionnaire, model, strategy);
  const administeredCount = valid.cat.history.length;
  const progress = {
    administeredCount,
    minItems: strategy.stopping.minItems,
    earliestStop: strategy.stopping.earliestStop,
    maxItems: strategy.stopping.maxItems,
  };

  if (valid.cat.complete) {
    return {
      status: 'complete',
      meta: { ...questionnaire.meta },
      progress,
      currentQuestion: null,
      options: [],
      result: riskFromCompletedCatState(valid.cat, model, strategy, riskConfig),
    };
  }

  const currentQuestion = itemById.get(valid.cat.nextItem);
  if (!currentQuestion) fail('current CAT item is absent from questionnaire');
  return {
    status: 'active',
    meta: { ...questionnaire.meta },
    progress,
    currentQuestion: { ...currentQuestion },
    options: questionnaire.options.map((option) => ({ ...option })),
    result: null,
  };
}

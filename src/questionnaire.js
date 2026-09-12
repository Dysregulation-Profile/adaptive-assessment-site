import { DIMENSIONS } from './grm.js';

export const QUESTIONNAIRE_SOURCE_SHA256 = '9dc269a45f8e142eee4948a33d513b1d6d5d1cf97a778bd1c6e53c2b3ddd1341';

function fail(message) {
  throw new TypeError(message);
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => names.includes(key));
}

export function validateQuestionnaire(questionnaire, model, strategy) {
  if (!questionnaire || typeof questionnaire !== 'object' || questionnaire.schemaVersion !== 1) {
    fail('browser questionnaire is required');
  }
  if (questionnaire.version !== strategy?.questionVersion || questionnaire.version !== model?.questionVersion) {
    fail('questionnaire version mismatch');
  }
  if (String(questionnaire.sourceQuestionnaireSha256).toLowerCase() !== QUESTIONNAIRE_SOURCE_SHA256) {
    fail('questionnaire source SHA256 mismatch');
  }
  if (!exactKeys(questionnaire.meta, ['title', 'recallPeriod', 'instruction']) ||
      !Object.values(questionnaire.meta).every(nonemptyString)) {
    fail('questionnaire metadata is invalid');
  }

  if (!Array.isArray(questionnaire.options) || questionnaire.options.length !== 5) fail('questionnaire options are invalid');
  for (let index = 0; index < questionnaire.options.length; index += 1) {
    const option = questionnaire.options[index];
    if (!exactKeys(option, ['value', 'label']) || option.value !== index + 1 || !nonemptyString(option.label)) {
      fail('questionnaire response scale mismatch');
    }
  }

  if (!Array.isArray(questionnaire.dimensions) || questionnaire.dimensions.length !== DIMENSIONS.length) {
    fail('questionnaire dimensions are invalid');
  }
  if (!sameArray(questionnaire.dimensions.map((dimension) => dimension.id), DIMENSIONS)) {
    fail('questionnaire dimension order mismatch');
  }
  for (const dimension of questionnaire.dimensions) {
    if (!exactKeys(dimension, ['id', 'label', 'shortLabel', 'description']) ||
        !nonemptyString(dimension.label) || !nonemptyString(dimension.shortLabel) || !nonemptyString(dimension.description)) {
      fail(`questionnaire dimension ${dimension.id} is invalid`);
    }
  }

  if (!Array.isArray(questionnaire.items) || questionnaire.items.length !== strategy.itemIds.length ||
      questionnaire.items.length !== model.items.length) {
    fail('questionnaire item count mismatch');
  }
  const ids = questionnaire.items.map((item) => item.id);
  if (!sameArray(ids, strategy.itemIds) || !sameArray(ids, model.items.map((item) => item.id)) || new Set(ids).size !== ids.length) {
    fail('questionnaire canonical item order mismatch');
  }
  for (let index = 0; index < questionnaire.items.length; index += 1) {
    const item = questionnaire.items[index];
    const modelItem = model.items[index];
    if (!exactKeys(item, ['id', 'text', 'dimension', 'attribute']) || !nonemptyString(item.text) ||
        !nonemptyString(item.attribute) || item.dimension !== modelItem.dimension || !DIMENSIONS.includes(item.dimension)) {
      fail(`questionnaire item ${item?.id ?? index} is invalid`);
    }
  }

  return questionnaire;
}

export function questionnaireItemMap(questionnaire, model, strategy) {
  validateQuestionnaire(questionnaire, model, strategy);
  return new Map(questionnaire.items.map((item) => [item.id, item]));
}

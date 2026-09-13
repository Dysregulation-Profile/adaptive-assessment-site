import {
  answerAssessmentSession,
  assessmentHistoryItemView,
  assessmentSessionView,
  rewindAssessmentSession,
  startAssessmentSession,
} from './src/session.js';
import { createEstimateRadar } from './src/chart.js';

const NAMES = { EMO: '情绪', BEH: '行为', ATT: '注意' };
const app = document.getElementById('app');

let runtime = null;
let session = null;
let cursor = 0;
let busy = false;
let generation = 0;
let phase = 'loading';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mount(card, page) {
  generation += 1;
  phase = page;
  busy = false;
  app.classList.toggle('is-result', page === 'result');
  app.replaceChildren(card);
  const title = card.querySelector('h1');
  if (title) {
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
  return generation;
}

async function loadJson(path) {
  const response = await fetch(new URL(path, import.meta.url), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`运行数据加载失败 (${response.status})`);
  return response.json();
}

async function loadRuntime() {
  const [questionnaire, model, grid, strategy, riskConfig] = await Promise.all([
    loadJson('./data/questionnaire.json'),
    loadJson('./data/irt-model.json'),
    loadJson('./data/eap-grid.json'),
    loadJson('./data/adaptive-strategy.json'),
    loadJson('./data/risk-model.json'),
  ]);
  // startAssessmentSession performs the cross-file provenance/contract checks.
  startAssessmentSession(questionnaire, model, strategy, riskConfig);
  return { questionnaire, model, grid, strategy, riskConfig };
}

function renderLoading() {
  const card = element('section', 'card intro-card loading-card');
  card.append(element('h1', 'intro-title', '正在加载测评'));
  const status = element('p', 'intro-description', '正在读取本地测评模型，请稍候。');
  status.setAttribute('role', 'status');
  card.append(status, element('p', 'fine-print', '模型加载完成后，作答与评分均在当前浏览器内完成。'));
  mount(card, 'loading');
}

function renderFatal(error) {
  const card = element('section', 'card intro-card');
  card.append(element('h1', 'intro-title', '测评暂时无法加载'));
  const message = element('p', 'error-message', error?.message || '测评运行数据校验失败，请刷新页面后重试。');
  message.setAttribute('role', 'alert');
  card.append(message);
  const retry = element('button', 'btn btn-primary', '重新加载');
  retry.type = 'button';
  retry.addEventListener('click', bootstrap);
  card.append(retry, element('p', 'fine-print', '页面不会上传作答数据。'));
  mount(card, 'fatal');
}

function renderIntro() {
  const { questionnaire } = runtime;
  const card = element('section', 'card intro-card');
  card.append(element('h1', 'intro-title', questionnaire.meta.title));

  const copy = element('div', 'intro-copy');
  const answerGuidance = element('p', '');
  answerGuidance.append(
    document.createTextNode('请根据'),
    element('strong', '', '过去 6 个月'),
    document.createTextNode('内的实际情况作答。回答没有对错之分，请选择最符合你真实情况的选项；如果不能确定，请选择最接近你实际感受的选项。'),
  );
  copy.append(
    element('p', '', '本测评用于了解成人在情绪调节、行为调控和注意控制三个方面的共同失调风险。本测评最多包含 27 道题，系统会根据你的作答动态选择后续题目，因此每个人实际完成的题目数量可能不同。'),
    answerGuidance,
    element('p', '', '本测评结果仅作为心理风险筛查和自我了解的参考，不能替代专业心理评估或临床诊断。若测评结果提示风险较高，可根据自身需要寻求专业心理咨询或医疗帮助。'),
    element('p', '', '我们将尊重并保护你的作答信息。你的作答将在当前浏览器中完成处理和计算，仅用于生成本次测评结果展示，不会上传至服务器，也不会被保存或用于与本次测评无关的用途。'),
  );
  card.append(copy);

  const start = element('button', 'btn btn-primary', '开始测评');
  start.type = 'button';
  start.addEventListener('click', begin);
  card.append(start);
  mount(card, 'intro');
}

function begin() {
  if (busy || !runtime) return;
  const { questionnaire, model, strategy, riskConfig } = runtime;
  session = startAssessmentSession(questionnaire, model, strategy, riskConfig);
  cursor = 0;
  renderQuestion();
}

function abandon() {
  session = null;
  cursor = 0;
  renderIntro();
}

function currentQuestionState() {
  const { questionnaire, model, strategy, riskConfig } = runtime;
  if (!session) throw new Error('测评会话尚未开始。');
  const history = session.cat.history;
  if (cursor < history.length) {
    const review = assessmentHistoryItemView(session, cursor, questionnaire, model, strategy, riskConfig);
    return {
      reviewing: true,
      question: review.question,
      options: review.options,
      selectedValue: review.selectedValue,
      laterAnswerCount: review.laterAnswerCount,
    };
  }
  const view = assessmentSessionView(session, questionnaire, model, strategy, riskConfig);
  if (view.status === 'complete') return { complete: true };
  return {
    reviewing: false,
    question: view.currentQuestion,
    options: view.options,
    selectedValue: undefined,
    laterAnswerCount: 0,
  };
}

function renderQuestion(message) {
  if (!session) return renderIntro();
  let state;
  try {
    state = currentQuestionState();
  } catch (error) {
    return renderFatal(error);
  }
  if (state.complete) return renderResult();

  const { strategy, questionnaire } = runtime;
  const history = session.cat.history;
  const card = element('section', 'card quiz-card');
  const progress = element('div', 'progress-track');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '已作答题数');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', String(strategy.stopping.maxItems));
  progress.setAttribute('aria-valuenow', String(history.length));
  const fill = element('div', 'progress-fill');
  fill.style.width = `${history.length / strategy.stopping.maxItems * 100}%`;
  progress.append(fill);

  const caption = element('div', 'progress-caption');
  caption.append(
    element('span', '', `第 ${cursor + 1} 题`),
    element('span', '', `已答 ${history.length} / 至多 ${strategy.stopping.maxItems} 题`),
  );
  card.append(progress, caption);

  if (state.reviewing) {
    card.append(element('p', 'review-kicker', '正在检查已作答题目。保持原答案会沿当前历史继续前进。'));
    if (state.laterAnswerCount > 0) {
      card.append(element('p', 'edit-warning', `修改本题会清除之后的 ${state.laterAnswerCount} 道作答，并按新路径重新选题。`));
    }
  }

  card.append(element('p', 'question-context', `请回想${questionnaire.meta.recallPeriod}的实际情况`));
  const title = element('h1', 'question-text', state.question.text);
  title.id = 'question-title';
  card.append(title);

  const options = element('div', 'options');
  options.setAttribute('role', 'group');
  options.setAttribute('aria-labelledby', title.id);
  let viewGeneration;
  state.options.forEach((option) => {
    const button = element('button', 'option', option.label);
    button.type = 'button';
    button.dataset.value = String(option.value);
    button.setAttribute('aria-pressed', String(option.value === state.selectedValue));
    button.addEventListener('click', () => choose(option.value, viewGeneration));
    options.append(button);
  });
  card.append(options);

  const nav = element('nav', 'question-nav');
  nav.setAttribute('aria-label', '题目导航');
  const previous = element('button', 'text-button', '上一题');
  previous.type = 'button';
  previous.disabled = cursor <= 0;
  previous.addEventListener('click', () => {
    if (busy || generation !== viewGeneration) return;
    cursor -= 1;
    renderQuestion();
  });
  nav.append(previous);

  if (state.reviewing) {
    const next = element('button', 'text-button next-button',
      session.cat.complete && cursor === history.length - 1 ? '查看结果' : cursor === history.length - 1 ? '继续测评' : '下一题');
    next.type = 'button';
    next.addEventListener('click', () => choose(state.selectedValue, viewGeneration));
    nav.append(next);
  }
  card.append(nav, element('p', 'fine-print question-hint',
    state.reviewing ? '保持原答案可继续检查；改答会重新计算后续路径。' : '选择后自动进入下一题'));

  if (message) {
    const error = element('p', 'error-message', message);
    error.setAttribute('role', 'alert');
    card.append(error);
  }
  viewGeneration = mount(card, 'question');
}

function disableQuestionButtons() {
  app.querySelectorAll('button').forEach((button) => { button.disabled = true; });
}

function allowPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function choose(value, expectedGeneration) {
  if (busy || phase !== 'question' || generation !== expectedGeneration || !session) return;
  busy = true;
  disableQuestionButtons();
  const selected = app.querySelector(`.option[data-value="${value}"]`);
  if (selected) {
    app.querySelectorAll('.option').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    selected.setAttribute('aria-pressed', 'true');
    selected.classList.add('is-confirmed');
  }

  try {
    await allowPaint();
    const { questionnaire, model, grid, strategy, riskConfig } = runtime;
    const history = session.cat.history;
    if (cursor < history.length) {
      const prior = history[cursor];
      if (prior.value === value) {
        cursor += 1;
      } else {
        session = rewindAssessmentSession(session, cursor, value, questionnaire, model, grid, strategy, riskConfig);
        cursor = session.cat.history.length;
      }
    } else {
      session = answerAssessmentSession(session, value, questionnaire, model, grid, strategy, riskConfig);
      cursor = session.cat.history.length;
    }
    if (session.cat.complete && cursor === session.cat.history.length) renderResult();
    else renderQuestion();
  } catch (error) {
    busy = false;
    renderQuestion(error?.message || '本次计算失败，请重试。');
  }
}

function riskPanel(risk) {
  const panel = element('section', 'risk-panel');
  panel.setAttribute('aria-label', '风险分型');
  panel.dataset.type = risk.typeCode;
  panel.append(element('p', 'risk-kicker', '风险分型'), element('h2', 'risk-type', risk.typeLabel));
  const reached = risk.dimensions.filter((dimension) => dimension.positive).map((dimension) => NAMES[dimension.id]);
  const description = risk.isHigh
    ? `本次综合风险分达到阈值。${reached.length ? `${reached.join('、')}维度达到分型阈值。` : '三个维度各自处于分型阈值以下。'}`
    : '本次综合风险分处于高风险阈值以下。各维度状态可在下方查看。';
  const thresholdExplanation = element('p', 'risk-description',
    '阈值是预先设定的判定界限，用于判断综合风险分是否达到高风险标准，以及各维度 θ 是否达到相应的分型标准。');
  thresholdExplanation.style.marginTop = '10px';
  panel.append(element('p', 'risk-description', description), thresholdExplanation);

  const dimensions = element('div', 'risk-dimensions');
  risk.dimensions.forEach((dimension) => {
    const item = element('div', `risk-dimension${dimension.positive ? ' is-positive' : ''}`);
    item.append(
      element('span', 'risk-dimension-name', NAMES[dimension.id]),
      element('span', 'risk-dimension-state', dimension.positive ? '达到阈值' : '阈值以下'),
    );
    dimensions.append(item);
  });
  panel.append(dimensions);

  const detail = element('details', 'risk-details');
  detail.append(element('summary', '', '查看分型依据'));
  detail.append(element('p', '', '分型先依据三维θ计算综合风险，再按维度θ与各自阈值组合判断。θ由题目参数与本次答案估计，与原始1–5分采用不同量尺。'));
  detail.append(element('p', '', `综合风险分 ${risk.score.toFixed(3)} · 阈值 ${risk.threshold.toFixed(3)}`));
  risk.dimensions.forEach((dimension) => detail.append(element('p', '',
    `${NAMES[dimension.id]} θ ${dimension.theta.toFixed(3)} · 标准误 ${dimension.se.toFixed(3)} · 阈值 ${dimension.threshold.toFixed(3)}`)));
  panel.append(detail);
  return panel;
}

function stopText(reason) {
  if (reason === 'precision_stability') return '精度与稳定性条件达成';
  if (reason === 'pser_information_exhausted') return '继续作答的预期精度收益已很低';
  return '达到最多作答题数';
}

function partialScore() {
  const itemById = new Map(runtime.questionnaire.items.map((item) => [item.id, item]));
  const dimensions = Object.fromEntries(runtime.questionnaire.dimensions.map((dimension) => [
    dimension.id, { count: 0, sum: 0, label: dimension.label },
  ]));
  let total = 0;
  session.cat.history.forEach((entry) => {
    const item = itemById.get(entry.itemId);
    total += entry.value;
    dimensions[item.dimension].count += 1;
    dimensions[item.dimension].sum += entry.value;
  });
  return { total, dimensions };
}

function renderResult() {
  const { questionnaire, model, strategy, riskConfig } = runtime;
  const view = assessmentSessionView(session, questionnaire, model, strategy, riskConfig);
  if (view.status !== 'complete') return renderQuestion();
  cursor = session.cat.history.length;
  const risk = view.result;
  const card = element('section', 'card result-card adaptive-result-card');
  card.append(element('h1', 'result-kicker', '你的测评结果'));
  card.append(element('p', 'adaptive-result-count', `本次实际作答 ${view.progress.administeredCount} 题 · 最多 ${view.progress.maxItems} 题`));
  card.append(element('p', 'adaptive-stop-reason', `停止原因：${stopText(session.cat.stopReason)}`));
  card.append(riskPanel(risk));
  card.append(element('h2', 'section-title', '三维估计'));
  const resultIntro = element('p', 'result-intro');
  resultIntro.append(
    element('strong', '', 'θ反映题目参数与本次作答共同估计的维度位置'),
    document.createTextNode('；标准误表示这次估计的不确定性。图形使用θ估计，不使用未完成量表的1–5分原始得分。'),
  );
  card.append(resultIntro);

  const estimateDimensions = risk.dimensions.map((dimension) => ({
    ...dimension,
    label: NAMES[dimension.id],
    count: session.cat.dimensionCounts[dimension.id],
  }));
  card.append(createEstimateRadar(estimateDimensions));
  card.append(element('p', 'fine-print chart-caption', '图中为三维θ估计；数值和标准误见下方。'));
  const estimates = element('div', 'estimate-dimensions');
  estimateDimensions.forEach((dimension) => {
    const row = element('section', 'estimate-row');
    const heading = element('div', 'dimension-header');
    heading.append(element('h2', 'dimension-name', dimension.label), element('span', 'estimate-count', `已作答 ${dimension.count} 题`));
    row.append(heading);
    const values = element('div', 'estimate-values');
    values.append(element('span', '', `θ ${dimension.theta.toFixed(3)}`), element('span', '', `标准误 ${dimension.se.toFixed(3)}`));
    row.append(values);
    estimates.append(row);
  });
  card.append(estimates);

  const partial = partialScore();
  const details = element('details', 'score-details partial-score-details');
  details.append(element('summary', '', '查看已作答题目的原始分（非完整量表总分）'));
  details.append(element('p', '', `已作答 ${session.cat.history.length} 题的原始分合计为 ${partial.total}。该数字只用于回顾本次已答题目，不能按完整27题总分或题均分解释。`));
  questionnaire.dimensions.forEach((dimension) => {
    const part = partial.dimensions[dimension.id];
    details.append(element('p', '', `${dimension.label}：已作答 ${part.count} 题，部分原始分 ${part.sum}`));
  });
  card.append(details);
  card.append(element('p', 'result-note fine-print', '本测评仅供研究参考，结果不作为临床诊断。作答与评分均在当前浏览器内完成；页面不会上传答案，也不会写入浏览器持久化存储。'));

  const actions = element('div', 'result-actions');
  const review = element('button', 'btn btn-secondary', '检查作答');
  review.type = 'button';
  review.addEventListener('click', () => {
    cursor = 0;
    renderQuestion();
  });
  const restart = element('button', 'btn btn-primary', '重新测评');
  restart.type = 'button';
  restart.addEventListener('click', begin);
  actions.append(review, restart);
  card.append(actions);
  mount(card, 'result');
}

async function bootstrap() {
  renderLoading();
  runtime = null;
  session = null;
  cursor = 0;
  try {
    runtime = await loadRuntime();
    renderIntro();
  } catch (error) {
    renderFatal(error);
  }
}

bootstrap();

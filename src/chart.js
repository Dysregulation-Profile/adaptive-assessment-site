const NS = 'http://www.w3.org/2000/svg';

const COLORS = Object.freeze({
  text: '#252F38',
  primary: '#3D566E',
  secondary: '#E5EBF0',
  divider: '#D9DEE2',
  soft: '#F4F7F9',
  muted: 'rgba(37, 47, 56, 0.65)',
});

function node(tag, attributes, text) {
  const element = document.createElementNS(NS, tag);
  Object.entries(attributes || {}).forEach(([key, value]) => element.setAttribute(key, value));
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createEstimateRadar(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length !== 3) throw new TypeError('three estimate dimensions are required');
  const svg = node('svg', {
    class: 'radar estimate-radar',
    viewBox: '0 0 360 320',
    role: 'img',
    'aria-labelledby': 'estimate-radar-title estimate-radar-description',
  });
  svg.append(node('title', { id: 'estimate-radar-title' }, '情绪、行为与注意的θ估计'));
  svg.append(node('desc', { id: 'estimate-radar-description' },
    dimensions.map((dimension) => `${dimension.label} θ ${dimension.theta.toFixed(3)}，标准误 ${dimension.se.toFixed(3)}`).join('；') +
      '。径向位置按θ从负3到正3显示，实际数值在下方文本中提供。'));

  const cx = 180;
  const cy = 166;
  const radius = 103;
  function point(index, ratio) {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / 3;
    return [cx + Math.cos(angle) * radius * ratio, cy + Math.sin(angle) * radius * ratio];
  }
  function points(ratios) {
    return ratios.map((ratio, index) => point(index, ratio).join(',')).join(' ');
  }

  for (let ring = 5; ring >= 1; ring -= 1) {
    const theta = -3 + ring * 6 / 5;
    svg.append(node('polygon', {
      points: points([ring / 5, ring / 5, ring / 5]),
      fill: ring % 2 ? COLORS.soft : COLORS.secondary,
      stroke: COLORS.divider,
      'stroke-width': '1',
    }));
    svg.append(node('text', {
      x: cx + 7,
      y: cy - radius * ring / 5 + 4,
      fill: COLORS.muted,
      'font-size': '10',
    }, theta.toFixed(1)));
  }

  dimensions.forEach((dimension, index) => {
    const edge = point(index, 1);
    svg.append(node('line', { x1: cx, y1: cy, x2: edge[0], y2: edge[1], stroke: COLORS.divider }));
    const label = point(index, 1.42);
    svg.append(node('text', {
      class: 'radar-label', x: label[0], y: label[1], 'text-anchor': 'middle', fill: COLORS.text, 'font-size': '14',
    }, dimension.label));
    svg.append(node('text', {
      class: 'radar-value', x: label[0], y: label[1] + 25, 'text-anchor': 'middle', fill: COLORS.primary, 'font-size': '14', 'font-weight': '600',
    }, `θ ${dimension.theta.toFixed(2)}`));
  });

  const ratio = (theta) => Math.max(0, Math.min(1, (theta + 3) / 6));
  svg.append(node('polygon', {
    points: points(dimensions.map((dimension) => ratio(dimension.theta))),
    fill: COLORS.primary,
    'fill-opacity': '.16',
    stroke: COLORS.primary,
    'stroke-width': '2',
  }));
  dimensions.forEach((dimension, index) => {
    const p = point(index, ratio(dimension.theta));
    svg.append(node('circle', { cx: p[0], cy: p[1], r: '3.5', fill: COLORS.primary }));
  });
  return svg;
}

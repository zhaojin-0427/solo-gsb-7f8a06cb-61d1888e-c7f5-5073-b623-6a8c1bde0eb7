'use strict';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];

const REASON_TEXT = {
  DOMAIN: '域不匹配（Host-Only 或子域边界）',
  PATH: '请求路径不在 Cookie 路径边界内',
  EXPIRED: '已超过 Max-Age / Expires',
  NOT_HTTPS: 'Secure Cookie 不能经 HTTP 明文发送',
  SAMESITE_STRICT: 'SameSite=Strict：跨站一律不发送',
  SAMESITE_LAX: 'SameSite=Lax：跨站仅限顶层安全方法（GET/HEAD/OPTIONS/TRACE）导航'
};

const REJECT_TEXT = {
  EMPTY: '空的 Set-Cookie',
  BAD_NAME: '名称或值格式非法',
  DOMAIN_MISMATCH: 'Domain 既不是响应主机，也不是其父域',
  PUBLIC_SUFFIX: 'Domain 是公共后缀（含 PSL 私有后缀，如 com / co.uk / s3.amazonaws.com / github.io），禁止设置 Cookie',
  SAMESITE_NONE_SECURE: 'SameSite=None 必须同时指定 Secure'
};

const STATUS_TEXT = {
  stored: '新写入',
  updated: '更新已有项',
  deleted: '删除',
  rejected: '拒绝写入'
};

let steps = deepClone(window.EXAMPLES.full.steps);
let lastResults = null; // 最近一次模拟结果，供“最小复现”选取目标
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

// ---------- 编辑器 ----------

function renderSteps() {
  const container = document.getElementById('steps');
  container.innerHTML = '';
  steps.forEach((s, i) => container.appendChild(renderStepCard(s, i)));
}

function renderStepCard(s, i) {
  const card = el('div', 'step-card');
  card.dataset.i = i;

  const head = el('div', 'step-head');
  head.appendChild(el('span', 'step-index', String(i + 1)));
  head.appendChild(el('span', 'clock-hint', '第 ' + (i + 1) + ' 步'));
  const del = el('button', 'del', '删除该步');
  del.type = 'button';
  del.addEventListener('click', () => {
    steps.splice(i, 1);
    renderSteps();
  });
  head.appendChild(del);
  card.appendChild(head);

  const r1 = el('div', 'row2');
  r1.appendChild(field('经过秒数',
    `<input type="number" min="0" step="1" data-k="seconds" value="${esc(s.seconds)}">`));
  r1.appendChild(field('请求 URL（http / https）',
    `<input type="text" data-k="url" value="${esc(s.url)}" placeholder="https://example.com/path">`));
  card.appendChild(r1);

  const r2 = el('div', 'row2');
  const opts = METHODS.map((m) =>
    `<option value="${m}"${m === (s.method || 'GET').toUpperCase() ? ' selected' : ''}>${m}</option>`).join('');
  r2.appendChild(field('方法', `<select data-k="method">${opts}</select>`));
  r2.appendChild(field('顶层页面 URL（留空 = 一方请求）',
    `<input type="text" data-k="topUrl" value="${esc(s.topUrl || '')}" placeholder="https://shop.example.com/home">`));
  card.appendChild(r2);

  const nav = el('label', 'checkline');
  nav.innerHTML =
    `<input type="checkbox" data-k="isNavigation"${s.isNavigation ? ' checked' : ''}> ` +
    `该请求为顶层导航（地址栏跳转 / 点击外链进入）`;
  card.appendChild(nav);

  card.appendChild(field('Set-Cookie 响应（每行一条，不要写 Set-Cookie: 前缀）',
    `<textarea data-k="setCookies" placeholder="sid=abc; Path=/; Max-Age=3600; Secure; SameSite=None">${
      esc((s.setCookies || []).join('\n'))}</textarea>`));

  return card;
}

function field(labelText, innerHtml) {
  const f = el('div', 'field');
  f.innerHTML = `<label>${labelText}</label>${innerHtml}`;
  return f;
}

// 输入直接写回 state，避免重渲染丢失焦点
document.getElementById('steps').addEventListener('input', (e) => {
  const card = e.target.closest('.step-card');
  if (!card) return;
  const i = Number(card.dataset.i);
  const k = e.target.dataset.k;
  if (k === 'isNavigation') steps[i][k] = e.target.checked;
  else if (k === 'setCookies') steps[i][k] = e.target.value.split('\n');
  else if (k === 'seconds') steps[i][k] = e.target.value;
  else steps[i][k] = e.target.value;
});

// ---------- 工具栏 ----------

document.getElementById('btn-add').addEventListener('click', () => {
  steps.push({ seconds: 0, url: '', method: 'GET', topUrl: '', isNavigation: false, setCookies: [''] });
  renderSteps();
  document.getElementById('steps').lastElementChild.scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('btn-clear').addEventListener('click', () => {
  steps = [];
  renderSteps();
  hideNameAnalysisPanel();
  document.getElementById('results').innerHTML =
    '<p class="placeholder">已清空。点击“＋ 新增步骤”或“载入示例”开始。</p>';
});

const menuBtn = document.getElementById('btn-example');
const menu = document.getElementById('example-menu');
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.classList.toggle('open');
});
document.addEventListener('click', () => menu.classList.remove('open'));
menu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-example]');
  if (!btn) return;
  steps = deepClone(window.EXAMPLES[btn.dataset.example].steps);
  renderSteps();
  menu.classList.remove('open');
  await runSimulation();
});

document.getElementById('btn-run').addEventListener('click', runSimulation);

// ---------- 运行与结果渲染 ----------

async function runSimulation() {
  const out = document.getElementById('results');
  out.innerHTML = '<p class="placeholder">运行中…</p>';
  hideNameAnalysisPanel(); // 同名取值分析随结果整体重算（不影响编辑内容）
  hideLifePanel(); // 结果将整体重算，旧轨迹面板随之关闭（不影响编辑内容）
  hideSolvePanel(); // 求解面板引用的是旧结果，一并关闭（不影响编辑内容）
  let data;
  try {
    const resp = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    out.innerHTML = '';
    out.appendChild(el('div', 'error-box', '模拟失败：' + esc(err.message)));
    return;
  }

  out.innerHTML = '';
  if (!data.results.length) {
    lastResults = null;
    out.appendChild(el('p', 'placeholder', '没有步骤。'));
    return;
  }
  lastResults = data.results;
  renderNameAnalysisPanel(data.nameAnalysis, data.results);
  data.results.forEach((r, i) => out.appendChild(renderResult(r, i)));
  // 绑定每个已发送 / 未发送 Cookie 上的“最小复现”按钮
  out.querySelectorAll('.mini-target').forEach((btn) => {
    btn.addEventListener('click', () => {
      minimizeToTarget(Number(btn.dataset.step), btn.dataset.kind, Number(btn.dataset.idx));
    });
  });
  // 绑定已发送 / 未发送 / 成功解析的响应处理项 / 步末 Jar 上的“生命周期”按钮
  out.querySelectorAll('.life-target').forEach((btn) => {
    btn.addEventListener('click', () => {
      openLifePanel(Number(btn.dataset.step), btn.dataset.kind, btn.dataset.resp);
    });
  });
  // 绑定成功写入的 Set-Cookie 上的“策略求解”按钮
  out.querySelectorAll('.solve-target').forEach((btn) => {
    btn.addEventListener('click', () => {
      openSolvePanel(Number(btn.dataset.step), Number(btn.dataset.resp));
    });
  });
}

function renderResult(r, stepIndex) {
  const card = el('div', 'result-card');
  card.id = 'result-step-' + stepIndex;

  const head = el('div', 'result-head');
  head.appendChild(el('span', 'method', esc(r.method)));
  head.appendChild(el('span', 'mono', esc(r.url || '(未填写)')));
  head.appendChild(el('span', 'clock', '⏱ +' + r.seconds + 's → ' + r.clockISO));
  card.appendChild(head);

  const body = el('div', 'result-body');

  (r.warnings || []).forEach((w) => body.appendChild(el('div', 'warning', '⚠ ' + esc(w))));

  // 站信息
  if (r.request) {
    const chips = el('div', 'chips');
    if (r.sameSite === true) chips.appendChild(chip('同站请求', 'ok'));
    else if (r.sameSite === false) chips.appendChild(chip('跨站请求', 'bad'));
    if (r.isNavigation) chips.appendChild(chip('顶层导航', 'nav'));
    if (r.crossSite && r.topLevelSafeNavigation) chips.appendChild(chip('跨站顶层安全方法 → Lax 放行', 'ok'));
    chips.appendChild(chip('请求站：' + (r.requestSite || '?')));
    if (r.topUrl) chips.appendChild(chip('顶层站：' + (r.topSite || '无法解析')));
    body.appendChild(chips);
  }

  // 发送项
  body.appendChild(el('div', 'section-title', '① 判定发送（应用响应之前）'));
  const headerText = r.cookieHeader
    ? 'Cookie: ' + r.cookieHeader
    : '（本请求不发送任何 Cookie）';
  body.appendChild(el('div', 'cookie-header' + (r.cookieHeader ? '' : ' empty'), esc(headerText)));

  if (r.sent.length) {
    body.appendChild(cookieTable(r.sent, (c) => {
      const tags = [attrBadge(c.hostOnly ? 'host-only' : 'Domain=' + stripDot(c.domain)),
        attrBadge('Path=' + c.path)];
      if (c.secure) tags.push(attrBadge('Secure'));
      tags.push(attrBadge('SameSite=' + c.sameSite));
      return tags.join('');
    }, (c, k) => targetButtons(stepIndex, 'sent', k), '操作'));
  }

  if (r.unsent.length) {
    const t = tableWith(['Cookie', '域 / 路径', '未发送原因', '操作'], r.unsent.map((u, k) => [
      esc(u.cookie.name) + '=' + esc(u.cookie.value),
      esc(u.cookie.domain) + ' ' + esc(u.cookie.path),
      '<div class="reasons">' +
        u.reasons.map((x) => `<span class="reason">${esc(REASON_TEXT[x] || x)}</span>`).join('') +
        '</div>',
      targetButtons(stepIndex, 'unsent', k)
    ]));
    body.appendChild(t);
  }

  // 服务端同名取值：严格按实际 Cookie 头顺序、名称区分大小写
  body.appendChild(renderNameReadsSection(r));

  // Set-Cookie 应用
  body.appendChild(el('div', 'section-title', '② 应用 Set-Cookie 响应'));
  if (!r.responses || !r.responses.length) {
    body.appendChild(el('p', 'jarline', '本步没有 Set-Cookie。'));
  } else {
    body.appendChild(tableWith(['Set-Cookie 原文', '处理结果', '操作'], r.responses.map((x, k) => {
      const detail = x.cookie
        ? `<div class="jarline">键：<span class="mono">${esc(x.cookie.name)} @ ${esc(x.cookie.domain)} ${esc(x.cookie.path)}</span></div>`
        : '';
      const extra = x.status === 'rejected'
        ? `<div class="jarline">${esc(REJECT_TEXT[x.reason] || x.reason)}</div>`
        : (x.status === 'deleted'
          ? `<div class="jarline">${x.existed ? '命中已有项并删除' : '没有找到同名/域/路径的项（删除为空操作）'}</div>`
          : '');
      const actionCell = x.status === 'rejected'
        ? '<span class="jarline muted">被拒写入不进入轨迹</span>'
        : '<div class="cell-actions">' + lifeButton(stepIndex, 'response', k) +
          (x.status === 'deleted' ? '' : solveButton(stepIndex, k)) + '</div>';
      return [
        '<span class="mono">' + esc(x.raw) + '</span>',
        `<span class="badge ${x.status}">${esc(STATUS_TEXT[x.status] || x.status)}${
          x.action === 'updated' ? '（覆盖）' : ''}</span>` + detail + extra,
        actionCell
      ];
    })));
  }

  // Jar 快照
  body.appendChild(el('div', 'section-title', '本步结束后 Cookie Jar（' + r.jarAfter.length + ' 项）'));
  if (r.jarAfter.length) {
    body.appendChild(cookieTable(r.jarAfter, (c) => {
      const tags = [attrBadge(c.hostOnly ? 'host-only' : 'Domain=' + stripDot(c.domain)),
        attrBadge('Path=' + c.path)];
      if (c.secure) tags.push(attrBadge('Secure'));
      tags.push(attrBadge('SameSite=' + c.sameSite));
      return tags.join('');
    }, (c, k) => {
      const validity = c.session
        ? '<span class="badge attr">会话期</span>'
        : `<span class="badge ${c.remainingSec > 0 ? 'attr' : 'expired'}">剩余 ${esc(c.remainingSec)}s</span>`;
      return '<div class="cell-actions">' + validity + lifeButton(stepIndex, 'jar', k) + '</div>';
    }, '有效期 / 追踪'));
  } else {
    body.appendChild(el('p', 'jarline', 'Jar 为空。'));
  }

  card.appendChild(body);
  return card;
}

function stripDot(domain) {
  return String(domain).replace(/^\./, '');
}

function chip(text, cls) {
  return el('span', 'chip' + (cls ? ' ' + cls : ''), esc(text));
}

function attrBadge(text) {
  return `<span class="badge attr">${esc(text)}</span>`;
}

function tableWith(headers, rows) {
  const t = el('table', 'cookies');
  t.innerHTML = '<thead><tr>' + headers.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr></thead>';
  const tb = el('tbody');
  rows.forEach((cells) => {
    const tr = el('tr');
    cells.forEach((c) => {
      const td = el('td');
      td.innerHTML = c;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  return t;
}

function cookieTable(cookies, attrFn, extraFn, extraHeader) {
  const headers = extraFn ? ['名称=值', '属性', extraHeader || ''] : ['名称=值', '属性'];
  return tableWith(headers,
    cookies.map((c, k) => {
      const cells = [
        '<span class="mono">' + esc(c.name) + '=' + esc(c.value) + '</span>',
        attrFn(c)
      ];
      if (extraFn) cells.push(extraFn(c, k));
      return cells;
    }));
}

// ---------- 服务端同名取值 ----------

function domainLabel(item) {
  return item.hostOnly ? 'host-only: ' + stripDot(item.domain) : 'Domain=' + stripDot(item.domain);
}

/** 逐步卡片中的“服务端同名取值”小节（按实际头顺序、名称区分大小写）。 */
function renderNameReadsSection(r) {
  const wrap = el('div', 'name-reads');
  wrap.appendChild(el('div', 'section-title', '服务端同名取值（按实际 Cookie 头顺序，名称区分大小写）'));

  if (!r.request) {
    wrap.appendChild(el('p', 'jarline muted', '本步骤被跳过（URL 非法），没有发送请求，无同名取值分析。'));
    return wrap;
  }
  if (!r.cookieHeader) {
    wrap.appendChild(el('p', 'jarline muted', 'Cookie 头为空：没有任何已发送 Cookie，不存在同名项。'));
    return wrap;
  }
  if (!r.nameReads || !r.nameReads.length) {
    wrap.appendChild(el('p', 'jarline muted', '本请求头中没有同名（区分大小写）的 Cookie，服务端取首项 / 取末项无区别。'));
    return wrap;
  }

  r.nameReads.forEach((g) => {
    const box = el('div', 'read-group' + (g.divergent ? ' divergent' : ''));

    const head = el('div', 'read-group-head');
    head.appendChild(el('span', 'read-name mono', g.name));
    head.appendChild(el('span', 'badge attr', '同名 ' + g.items.length + ' 项'));
    head.appendChild(el('span', 'badge ' + (g.divergent ? 'dead' : 'alive'),
      g.divergent ? '⚠ 首项 ≠ 末项：服务端取值存在分歧' : '首项 = 末项：取值一致'));
    box.appendChild(head);

    const reads = el('div', 'read-values');
    reads.innerHTML =
      '<span class="read-pick">取首项读到：<code class="mono">' + esc(g.name) + '=' + esc(g.firstValue) + '</code></span>' +
      '<span class="read-pick">取末项读到：<code class="mono">' + esc(g.name) + '=' + esc(g.lastValue) + '</code></span>';
    box.appendChild(reads);

    const rows = g.items.map((it, k) => [
      '<span class="mono">' + esc(it.name) + '=' + esc(it.value) + '</span>' +
        '<div class="jarline muted">头中第 ' + (k + 1) + ' 项（头顺序位置 ' + (it.headerIndex + 1) + '）</div>',
      '<span class="badge attr">' + esc(domainLabel(it)) + '</span>' +
        '<span class="badge attr">Path=' + esc(it.path) + '</span>',
      '<span class="jarline">创建次序 #' + esc(it.creationOrder + 1) + '</span>'
    ]);
    box.appendChild(tableWith(['头中逐项的值', '域 / 路径', '创建次序'], rows));
    wrap.appendChild(box);
  });
  return wrap;
}

// ---------- 同名取值分歧时间线（全局面板） ----------

function nameAnalysisPanel() {
  return document.getElementById('name-analysis-panel');
}

function hideNameAnalysisPanel() {
  const panel = nameAnalysisPanel();
  if (!panel) return;
  panel.className = 'hidden';
  panel.innerHTML = '';
}

function renderNameAnalysisPanel(analysis, results) {
  const panel = nameAnalysisPanel();
  panel.innerHTML = '';
  panel.className = 'name-analysis-panel';

  const head = el('div', 'na-head');
  head.appendChild(el('div', 'section-title', '🔀 服务端同名取值分析（时间线）'));
  panel.appendChild(head);
  panel.appendChild(el('p', 'na-stats',
    '名称按区分大小写匹配；同名组沿有效请求时间线追踪。每一步先发送后处理响应：某步响应只能影响后续请求，' +
    '过期淘汰发生在该步发送决策阶段。下表每个单元格代表一个有效请求：'));

  if (!analysis || !analysis.validStepCount) {
    panel.appendChild(el('p', 'placeholder', '没有有效请求（URL 合法且为 http/https），暂无可分析的 Cookie 头。'));
    return;
  }
  if (!analysis.duplicateNames.length) {
    panel.appendChild(el('p', 'placeholder',
      '全部 ' + analysis.validStepCount + ' 个有效请求的 Cookie 头中均未出现同名（区分大小写）的 Cookie，没有同名取值。'));
    return;
  }

  // 图例
  const legend = el('div', 'na-legend');
  legend.innerHTML =
    '<span class="na-cell absent"><i></i>无同名组</span>' +
    '<span class="na-cell same"><i></i>同名但取值一致</span>' +
    '<span class="na-cell divergent"><i></i>首末取值分歧</span>';
  panel.appendChild(legend);

  analysis.timeline.forEach((t) => {
    panel.appendChild(renderNameTimelineCard(t, results));
  });

  if (!analysis.divergentNames.length) {
    panel.appendChild(el('p', 'placeholder na-summary',
      '共出现 ' + analysis.duplicateNames.length + ' 个同名名称，但所有同名组的首项与末项取值始终一致，从未产生分歧。'));
  } else {
    panel.appendChild(el('p', 'jarline na-summary',
      '共 ' + analysis.duplicateNames.length + ' 个同名名称，其中 ' + analysis.divergentNames.length +
      ' 个出现过首末取值分歧（红色单元格）。'));
  }
}

function stateCellClass(state) {
  return state === 'divergent' ? 'divergent' : state === 'same' ? 'same' : 'absent';
}

function stateSymbol(state) {
  return state === 'divergent' ? '⚠' : state === 'same' ? '=' : '·';
}

function stateTitle(name, state) {
  return state === 'divergent' ? `名称 ${name}：该请求同名项首末取值分歧`
    : state === 'same' ? `名称 ${name}：该请求有同名项但取值一致`
    : `名称 ${name}：该请求没有同名组`;
}

function renderNameTimelineCard(t, results) {
  const card = el('div', 'na-card' + (t.divergences.length ? ' has-div' : ''));

  const title = el('div', 'na-card-title');
  title.innerHTML = '名称 <span class="mono">' + esc(t.name) + '</span>' +
    (t.divergences.length
      ? ' <span class="badge dead">' + t.divergences.length + ' 段分歧</span>'
      : ' <span class="badge alive">从未分歧</span>');
  card.appendChild(title);

  // 时间线单元格（仅有效请求）
  const strip = el('div', 'na-strip');
  t.states.forEach(({ step, state }) => {
    const cell = el('button', 'na-cell ' + stateCellClass(state), stateSymbol(state));
    cell.type = 'button';
    cell.title = '第 ' + (step + 1) + ' 步 · ' + stateTitle(t.name, state);
    cell.addEventListener('click', () => jumpToStep(step));
    const num = el('span', 'na-cell-step', String(step + 1));
    cell.appendChild(num);
    strip.appendChild(cell);
  });
  card.appendChild(strip);

  // 每段分歧的产生 / 消失与事件关联
  t.divergences.forEach((d) => card.appendChild(renderDivergenceCard(t.name, d, results)));
  return card;
}

const NAME_EVENT_TEXT = {
  stored: '写入',
  updated: '覆盖',
  deleted: '删除',
  evicted: '过期淘汰'
};

const RISE_KIND_TEXT = {
  'appeared-divergent': '该名称此前没有同名组，本步头中首次出现同名即首末取值分歧（由上一有效请求之后的写入 / 覆盖造成）',
  'became-divergent': '该名称此前已有同名组且取值一致，本步起首末取值出现分歧'
};

const FALL_KIND_TEXT = {
  resolved: '分歧在下一步消失：仍存在同名组，但首末取值已一致（被覆盖为同值或项数变化）',
  disappeared: '分歧在下一步消失：该名称在下一有效请求中不再构成同名组（删除、过期淘汰或请求作用域变化）'
};

function nameEventRow(ev) {
  const target = ev.domain + ' ' + ev.path;
  const phase = ev.phase === 'at-send' ? '发送阶段淘汰' : '响应处理';
  const valueChange = ev.type === 'stored'
    ? '写入值 <span class="mono">' + esc(ev.afterValue) + '</span>'
    : ev.type === 'updated'
      ? '<span class="mono">' + esc(ev.beforeValue) + '</span> → <span class="mono">' + esc(ev.afterValue) + '</span>'
      : ev.type === 'deleted'
        ? (ev.beforeValue != null
          ? '删除前值 <span class="mono">' + esc(ev.beforeValue) + '</span>'
          : '<span class="na">空操作：未命中任何项</span>')
        : '淘汰前值 <span class="mono">' + esc(ev.beforeValue) + '</span>';
  return '<div class="na-event ' + esc(ev.type) + '">' +
    '<button type="button" class="life-jump na-jump" data-jump="' + ev.step + '">↩ 第 ' + (ev.step + 1) + ' 步</button>' +
    '<span class="badge ' + esc(ev.type) + '">' + esc(NAME_EVENT_TEXT[ev.type] || ev.type) + '</span>' +
    '<span class="badge attr">' + esc(phase) + '</span>' +
    (ev.member ? '<span class="badge alive">本组项</span>' : '<span class="badge miss">同名其他域/路径</span>') +
    '<span class="na-event-target mono">' + esc(target) + '</span>' +
    (ev.raw
      ? '<span class="na-event-raw mono">' + esc(ev.raw) + '</span>'
      : '<span class="na-event-raw na">（引擎内部事件，无对应 Set-Cookie）</span>') +
    '<span class="na-event-values jarline">' + valueChange + '</span>' +
    '</div>';
}

function bindNaJumps(scope) {
  scope.querySelectorAll('.na-jump').forEach((btn) => {
    btn.addEventListener('click', () => jumpToStep(Number(btn.dataset.jump)));
  });
}

function renderDivergenceCard(name, d, results) {
  const box = el('div', 'na-divergence');

  const range = el('div', 'na-div-range');
  range.innerHTML =
    (d.toStep === d.fromStep
      ? '第 <b>' + (d.fromStep + 1) + '</b> 步'
      : '第 <b>' + (d.fromStep + 1) + '</b> 步 → 第 <b>' + (d.toStep + 1) + '</b> 步') +
    ' <span class="jarline muted">(' + esc(d.fromClockISO) + ' 起' +
    (d.toStep === d.fromStep ? '' : '，至 ' + esc(d.toClockISO)) + ')</span>' +
    ' · 首项 <span class="mono">' + esc(name) + '=' + esc(d.firstValue) + '</span>' +
    ' / 末项 <span class="mono">' + esc(name) + '=' + esc(d.lastValue) + '</span>';
  box.appendChild(range);

  // 产生
  box.appendChild(el('div', 'na-phase-title', '分歧何时产生：' + esc(RISE_KIND_TEXT[d.riseKind] || d.riseKind)));
  if (d.riseEvents.length) {
    const list = el('div', 'na-event-list');
    list.innerHTML = d.riseEvents.map(nameEventRow).join('');
    box.appendChild(list);
  } else {
    box.appendChild(el('p', 'jarline muted na-noevent',
      '相邻步骤之间没有命中该名称的写入 / 覆盖 / 删除 / 过期淘汰事件；该分歧仅由请求作用域变化（域 / 路径 / Secure / SameSite 决定哪些项进入头）产生。'));
  }

  // 消失
  if (d.ongoing) {
    box.appendChild(el('div', 'na-phase-title', '何时消失：分歧持续到最后一个有效请求，之后没有更多请求可观察。'));
    if (d.fallEvents.length) {
      box.appendChild(el('p', 'jarline muted', '最后一步的响应（先发送后处理）只能影响后续请求，时间线中已无后续请求：'));
      const list = el('div', 'na-event-list');
      list.innerHTML = d.fallEvents.map(nameEventRow).join('');
      box.appendChild(list);
    } else {
      box.appendChild(el('p', 'jarline muted na-noevent', '末尾步也没有命中该名称的响应事件。'));
    }
  } else {
    box.appendChild(el('div', 'na-phase-title', '分歧何时消失：' + esc(FALL_KIND_TEXT[d.fallKind] || d.fallKind)));
    if (d.fallEvents.length) {
      const list = el('div', 'na-event-list');
      list.innerHTML = d.fallEvents.map(nameEventRow).join('');
      box.appendChild(list);
    } else {
      box.appendChild(el('p', 'jarline muted na-noevent',
        '相邻步骤之间没有命中该名称的写入 / 覆盖 / 删除 / 过期淘汰事件；该变化仅由请求作用域（域 / 路径 / Secure / SameSite）改变造成。'));
    }
  }

  bindNaJumps(box);
  return box;
}

// ---------- 最小复现 ----------

function targetButton(stepIndex, kind, idx) {
  return `<button type="button" class="mini-target" data-step="${stepIndex}" data-kind="${kind}" data-idx="${idx}">🎯 最小复现</button>`;
}

// ---------- 生命周期 ----------

function lifeButton(stepIndex, kind, idx) {
  return `<button type="button" class="life-target" data-step="${stepIndex}" data-kind="${kind}" data-resp="${idx}">🕰 生命周期</button>`;
}

/** 已发送 / 未发送行：“最小复现” + “生命周期”两个操作。 */
function targetButtons(stepIndex, kind, idx) {
  return '<div class="cell-actions">' + targetButton(stepIndex, kind, idx) + lifeButton(stepIndex, kind, idx) + '</div>';
}

function lifePanel() {
  return document.getElementById('life-panel');
}

function hideLifePanel() {
  const panel = lifePanel();
  if (!panel) return;
  panel.className = 'hidden';
  panel.innerHTML = '';
}

/**
 * 把按钮位置解析为轨迹目标。
 * 同名（不区分大小写）、规范化域（去前导点）、路径相同才是同一条轨迹。
 */
function resolveLifeTarget(stepIndex, kind, respIdx) {
  const r = lastResults && lastResults[stepIndex];
  if (!r) return null;
  if (kind === 'sent') {
    const c = r.sent[respIdx];
    return c ? { name: c.name, domain: c.domain, path: c.path, sourceLabel: '第 ' + (stepIndex + 1) + ' 步已发送项' } : null;
  }
  if (kind === 'unsent') {
    const u = r.unsent[respIdx];
    return u ? { name: u.cookie.name, domain: u.cookie.domain, path: u.cookie.path, sourceLabel: '第 ' + (stepIndex + 1) + ' 步未发送项' } : null;
  }
  if (kind === 'response') {
    const x = r.responses[respIdx];
    if (!x || !x.cookie) return null;
    const label = x.status === 'deleted'
      ? '第 ' + (stepIndex + 1) + ' 步 Set-Cookie 删除项'
      : '第 ' + (stepIndex + 1) + ' 步 Set-Cookie ' + (x.action === 'updated' ? '覆盖项' : '写入项');
    return { name: x.cookie.name, domain: x.cookie.domain, path: x.cookie.path, sourceLabel: label };
  }
  // kind === 'jar'
  const c = r.jarAfter[respIdx];
  return c ? { name: c.name, domain: c.domain, path: c.path, sourceLabel: '第 ' + (stepIndex + 1) + ' 步步末 Jar' } : null;
}

function openLifePanel(stepIndex, kind, respIdxRaw) {
  const panel = lifePanel();
  const respIdx = respIdxRaw === undefined || respIdxRaw === '' ? -1 : Number(respIdxRaw);
  const target = resolveLifeTarget(stepIndex, kind, respIdx);
  if (!target) return;
  const trace = window.Lifecycle.traceOf(lastResults, target, stepIndex);
  renderLifePanel(panel, target, stepIndex, trace);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const EVENT_TEXT = {
  stored: '写入',
  updated: '覆盖',
  deleted: '删除',
  evicted: '过期淘汰'
};

function cookieMini(c) {
  if (!c) return '<span class="na">—（无此项）</span>';
  const pieces = [
    `<span class="mono">${esc(c.name)}=${esc(c.value)}</span>`,
    c.hostOnly ? '<span class="badge attr">host-only</span>'
      : `<span class="badge attr">Domain=${esc(stripDot(c.domain))}</span>`,
    `<span class="badge attr">Path=${esc(c.path)}</span>`
  ];
  if (c.secure) pieces.push('<span class="badge attr">Secure</span>');
  pieces.push(`<span class="badge attr">SameSite=${esc(c.sameSite)}</span>`);
  if (c.persistent) {
    pieces.push(c.expiresISO
      ? `<span class="badge attr">到期 ${esc(c.expiresISO)}</span>`
      : '<span class="badge attr">持久</span>');
  } else {
    pieces.push('<span class="badge attr">会话期</span>');
  }
  return pieces.join(' ');
}

function aliveLine(ev) {
  if (ev.type === 'stored' || ev.type === 'updated') {
    const c = ev.after;
    if (!c.persistent) return '<span class="badge alive">存活（会话期，无到期时间）</span>';
    return `<span class="badge alive">存活至 ${esc(c.expiresISO)}</span>`;
  }
  if (ev.type === 'deleted') {
    return ev.before
      ? '<span class="badge dead">已删除（不再存活）</span>'
      : '<span class="badge miss">空操作：未命中任何项，轨迹不变</span>';
  }
  // evicted：仍经历了本次未发送判定，随后才淘汰
  return '<span class="badge dead">已过期淘汰（本次请求先进入未发送判定，随后移除）</span>';
}

function renderLifePanel(panel, target, targetStep, trace) {
  panel.innerHTML = '';
  panel.className = 'life-panel';

  const head = el('div', 'life-head');
  head.appendChild(el('div', 'section-title', '🕰 生命周期轨迹（截至第 ' + (targetStep + 1) + ' 步）'));
  const close = el('button', 'panel-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideLifePanel);
  head.appendChild(close);
  panel.appendChild(head);

  const keyDesc = `<span class="mono">${esc(target.name)}</span> @ ` +
    `<span class="mono">${esc(stripDot(target.domain))} ${esc(target.path)}</span>`;
  panel.appendChild(el('p', 'life-stats',
    '目标键（名称不区分大小写；同名但域或路径不同者分开追踪）：' + keyDesc));
  panel.appendChild(el('p', 'life-stats', '选择自：' + esc(target.sourceLabel) +
    '。覆盖沿用同一键并重算到期时间；过期 Cookie 在首次到期后的有效请求中仍进入未发送判定，随后才淘汰。'));

  if (!trace.length) {
    panel.appendChild(el('p', 'placeholder', '截至该步没有命中该键的写入 / 覆盖 / 删除 / 过期淘汰事件。'));
  } else {
    const list = el('div', 'life-trace');
    trace.forEach((ev) => {
      const item = el('div', 'life-event ' + ev.type);

      const top = el('div', 'life-event-top');
      const jump = el('button', 'life-jump', '↩ 第 ' + (ev.step + 1) + ' 步');
      jump.type = 'button';
      jump.title = '跳回该事件所在的原步骤';
      jump.addEventListener('click', () => jumpToStep(ev.step));
      top.appendChild(jump);
      top.appendChild(el('span', 'life-clock', '⏱ ' + ev.clockISO));
      top.appendChild(el('span', 'badge ' + ev.type, EVENT_TEXT[ev.type] || ev.type));
      item.appendChild(top);

      const raw = el('div', 'life-row');
      raw.appendChild(el('span', 'life-k', 'Set-Cookie 原文'));
      raw.appendChild(el('span', 'life-v mono', ev.raw ? ev.raw : '（引擎内部事件，无对应 Set-Cookie）'));
      raw.querySelector('.life-v').classList.toggle('na', !ev.raw);
      item.appendChild(raw);

      if (ev.type === 'updated') {
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '覆盖前'));
        before.appendChild(el('span', 'life-v', cookieMini(ev.before)));
        item.appendChild(before);
        const after = el('div', 'life-row');
        after.appendChild(el('span', 'life-k', '覆盖后（重算到期）'));
        after.appendChild(el('span', 'life-v', cookieMini(ev.after)));
        item.appendChild(after);
      } else if (ev.type === 'stored') {
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '写入前'));
        before.appendChild(el('span', 'life-v', cookieMini(null)));
        item.appendChild(before);
        const after = el('div', 'life-row');
        after.appendChild(el('span', 'life-k', '写入值'));
        after.appendChild(el('span', 'life-v', cookieMini(ev.after)));
        item.appendChild(after);
      } else if (ev.type === 'deleted') {
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '删除前'));
        before.appendChild(el('span', 'life-v', cookieMini(ev.before)));
        item.appendChild(before);
      } else {
        // evicted：记录被淘汰时的状态，以及该次未发送判定命中的全部原因
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '淘汰前状态'));
        before.appendChild(el('span', 'life-v', cookieMini(ev.before)));
        item.appendChild(before);
        const reasons = el('div', 'life-row');
        reasons.appendChild(el('span', 'life-k', '本次未发送原因'));
        reasons.appendChild(el('span', 'life-v',
          '<span class="reasons">' + (ev.reasons || [])
            .map((x) => `<span class="reason">${esc(REASON_TEXT[x] || x)}</span>`).join('') +
          '</span>'));
        item.appendChild(reasons);
      }

      const alive = el('div', 'life-row');
      alive.appendChild(el('span', 'life-k', '事件后存活状态'));
      const aliveV = el('span', 'life-v');
      aliveV.innerHTML = aliveLine(ev);
      alive.appendChild(aliveV);
      item.appendChild(alive);

      list.appendChild(item);
    });
    panel.appendChild(list);
  }
}

/** 从轨迹跳回原步骤：滚动到对应结果卡片并短暂高亮（不改动任何编辑内容）。 */
function jumpToStep(stepIndex) {
  const node = document.getElementById('result-step-' + stepIndex);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  node.classList.remove('flash');
  // 强制重排以重新触发动画
  void node.offsetWidth;
  node.classList.add('flash');
}

// ---------- 最小复现（续） ----------

function minimizePanel() {
  return document.getElementById('minimize-panel');
}

function hideMinimizePanel() {
  const panel = minimizePanel();
  panel.className = 'hidden';
  panel.innerHTML = '';
}

async function minimizeToTarget(stepIndex, kind, idx) {
  const panel = minimizePanel();
  const r = lastResults && lastResults[stepIndex];
  if (!r) return;

  // 目标标识：名称 + 值 + 域 + 路径 + 发送状态；未发送时带上原因集合
  let target;
  if (kind === 'sent') {
    const c = r.sent[idx];
    if (!c) return;
    target = { stepIndex, name: c.name, value: c.value, domain: c.domain, path: c.path, sent: true };
  } else {
    const u = r.unsent[idx];
    if (!u) return;
    target = { stepIndex, name: u.cookie.name, value: u.cookie.value,
      domain: u.cookie.domain, path: u.cookie.path, sent: false, reasons: u.reasons.slice() };
  }

  panel.className = 'minimize-panel';
  panel.innerHTML = '<p class="placeholder">正在最小化：逐项尝试删减并重跑模拟核对目标…</p>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let data;
  try {
    const resp = await fetch('/api/minimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, target })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    // 无法定位目标等情况：只提示，不改当前编辑内容
    panel.innerHTML = '';
    const box = el('div', 'error-box', '无法生成最小复现：' + esc(err.message) + '（当前编辑内容未改动）');
    panel.appendChild(box);
    const dismiss = el('button', 'panel-close', '关闭');
    dismiss.type = 'button';
    dismiss.addEventListener('click', hideMinimizePanel);
    panel.appendChild(dismiss);
    return;
  }

  renderMinimizePanel(panel, data, target);
}

function renderMinimizePanel(panel, data, target) {
  panel.innerHTML = '';

  panel.appendChild(el('div', 'section-title', '🎯 最小复现（以第 ' + esc(data.targetStep) + ' 步为结尾）'));
  const targetDesc = (target.sent ? '已发送 ' : '未发送 ') +
    target.name + '=' + target.value + ' @ ' + target.domain + ' ' + target.path +
    (target.sent ? '' : '（原因：' + target.reasons.map((x) => REASON_TEXT[x] || x).join('；') + '）');
  panel.appendChild(el('p', 'minimize-stats',
    '目标：' + esc(targetDesc)));
  panel.appendChild(el('p', 'minimize-stats',
    `缩减前：${data.before.steps} 步 / ${data.before.setCookieLines} 行 Set-Cookie → ` +
    `缩减后：${data.after.steps} 步 / ${data.after.setCookieLines} 行 Set-Cookie。` +
    '目标请求的 URL、方法、顶层页面与导航标记保持不变；被删整步的经过秒数已并入下一保留步，保留请求的绝对时刻不变。'));

  // 预览（载入前不改动编辑器）
  panel.appendChild(el('div', 'section-title', '预览（载入前不会改动当前编辑内容）'));
  const rows = data.steps.map((s, i) => [
    String(i + 1),
    '+' + esc(s.seconds) + 's',
    esc((s.method || 'GET').toUpperCase()) + (s.isNavigation ? ' 🧭' : ''),
    '<span class="mono">' + esc(s.url) + '</span>' +
      (s.topUrl ? `<div class="jarline">顶层：${esc(s.topUrl)}</div>` : ''),
    s.setCookies.length
      ? '<span class="mono">' + s.setCookies.map((line) => esc(line)).join('<br>') + '</span>'
      : '<span class="jarline">（无）</span>'
  ]);
  panel.appendChild(tableWith(['#', '经过秒数', '方法', '请求 URL', 'Set-Cookie'], rows));

  const actions = el('div', 'minimize-actions');
  const load = el('button', 'primary', '✔ 载入到编辑器（替换当前步骤）');
  load.type = 'button';
  load.addEventListener('click', () => {
    steps = deepClone(data.steps);
    renderSteps();
    hideMinimizePanel();
    runSimulation();
  });
  actions.appendChild(load);
  const close = el('button', '', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideMinimizePanel);
  actions.appendChild(close);
  panel.appendChild(actions);
}

// ---------- 策略求解 ----------

function solvePanel() {
  return document.getElementById('solve-panel');
}

function hideSolvePanel() {
  const panel = solvePanel();
  if (!panel) return;
  panel.className = 'hidden';
  panel.innerHTML = '';
}

function solveButton(stepIndex, idx) {
  return `<button type="button" class="solve-target" data-step="${stepIndex}" data-resp="${idx}">🧭 策略求解</button>`;
}

/**
 * 打开求解面板：目标是第 stepIndex 步响应中第 respIdx 条成功写入的 Set-Cookie。
 * 面板列出其后的全部有效请求，允许任选至多 8 步标记应发送 / 不应发送。
 */
function openSolvePanel(stepIndex, respIdx) {
  const panel = solvePanel();
  const r = lastResults && lastResults[stepIndex];
  const resp = r && Array.isArray(r.responses) ? r.responses[respIdx] : null;
  if (!resp || !resp.cookie || (resp.status !== 'stored' && resp.status !== 'updated')) return;

  panel.className = 'solve-panel';
  panel.innerHTML = '';

  const head = el('div', 'solve-head');
  head.appendChild(el('div', 'section-title',
    '🧭 策略求解（目标：第 ' + (stepIndex + 1) + ' 步写入的 ' + esc(resp.cookie.name) + '）'));
  const close = el('button', 'panel-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideSolvePanel);
  head.appendChild(close);
  panel.appendChild(head);

  panel.appendChild(el('p', 'solve-stats',
    '目标 Set-Cookie：<span class="mono">' + esc(resp.raw) + '</span>'));
  panel.appendChild(el('p', 'solve-stats',
    '保持步骤、名称、值、有效期与其他属性不变，只枚举 Domain（host-only / 来源主机及合法父域）、' +
    'Path（/、原路径、标记请求路径的逐级前缀）、SameSite（Strict/Lax/None）与 Secure（有/无）；' +
    '候选须通过现有写入校验，再替换进原响应重跑完整序列核对。多解时按 host-only → Domain 窄到宽 → ' +
    'Path 长到短（同长字典序）→ SameSite Strict/Lax/None → Secure 有/无 取首解。'));

  // 其后的有效请求（URL 非法被跳过的步骤不可标记）
  const markable = [];
  for (let i = stepIndex + 1; i < lastResults.length; i++) {
    if (lastResults[i].request) markable.push(i);
  }
  if (!markable.length) {
    panel.appendChild(el('p', 'placeholder', '该步之后没有有效请求，无法标记发送状态。'));
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  panel.appendChild(el('div', 'section-title',
    '在其后的有效请求上标记该项应发送 / 不应发送（最多 8 个）'));
  const rows = markable.map((i) => {
    const s = lastResults[i];
    const sub = s.topUrl
      ? `<div class="jarline">顶层：${esc(s.topUrl)}${s.isNavigation ? ' · 顶层导航' : ''}</div>`
      : (s.isNavigation ? '<div class="jarline">顶层导航</div>' : '');
    return [
      '第 ' + (i + 1) + ' 步',
      '<span class="mono">' + esc(s.method) + ' ' + esc(s.url) + '</span>' + sub,
      `<select class="solve-mark" data-step="${i}">` +
        '<option value="">不标记</option>' +
        '<option value="send">应发送</option>' +
        '<option value="nosend">不应发送</option>' +
      '</select>'
    ];
  });
  panel.appendChild(tableWith(['步骤', '请求', '标记'], rows));

  const hint = el('p', 'solve-stats', '已标记 0 / 8 个请求。');
  panel.appendChild(hint);

  const actions = el('div', 'solve-actions');
  const go = el('button', 'primary', '🔍 开始求解');
  go.type = 'button';
  actions.appendChild(go);
  const cancel = el('button', '', '关闭');
  cancel.type = 'button';
  cancel.addEventListener('click', hideSolvePanel);
  actions.appendChild(cancel);
  panel.appendChild(actions);

  const resultBox = el('div', 'solve-result');
  panel.appendChild(resultBox);

  const markedSelects = () => [...panel.querySelectorAll('.solve-mark')].filter((x) => x.value !== '');
  panel.querySelectorAll('.solve-mark').forEach((sel) => {
    sel.addEventListener('change', () => {
      const marked = markedSelects();
      if (marked.length > 8) {
        sel.value = '';
        hint.textContent = '最多标记 8 个请求（已超出，本次选择未生效）。';
      } else {
        hint.textContent = '已标记 ' + marked.length + ' / 8 个请求。';
      }
      resultBox.innerHTML = ''; // 标记变化后旧解失效
    });
  });

  go.addEventListener('click', () => {
    const marks = markedSelects().map((x) => ({
      stepIndex: Number(x.dataset.step),
      sent: x.value === 'send'
    }));
    if (!marks.length) {
      hint.textContent = '请至少标记 1 个请求。';
      return;
    }
    runSolve(resultBox, { stepIndex, respIndex: respIdx, raw: resp.raw, marks });
  });

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runSolve(box, target) {
  box.innerHTML = '<p class="placeholder">求解中：枚举候选并重跑完整序列核对…</p>';
  let data;
  try {
    const resp = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, target })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    // 目标失效（步骤被改过）等情况：只提示，不改当前编辑内容
    box.innerHTML = '';
    box.appendChild(el('div', 'error-box', '无法求解：' + esc(err.message) + '（当前编辑内容未改动）'));
    return;
  }
  if (!data.ok) {
    // 无解：只提示，不改当前编辑内容
    box.innerHTML = '';
    box.appendChild(el('div', 'error-box', '无解：' + esc(data.error) + '（当前编辑内容未改动）'));
    return;
  }
  renderSolveResult(box, data);
}

function renderSolveResult(box, data) {
  box.innerHTML = '';
  box.appendChild(el('div', 'section-title',
    '✔ 找到首解（共重跑核对 ' + esc(data.attempts) + ' 个通过写入校验的候选）'));

  // 可复制的 Set-Cookie
  const lineWrap = el('div', 'solve-line-wrap');
  lineWrap.appendChild(el('code', 'solve-line', esc(data.setCookie)));
  const copy = el('button', 'solve-copy', '📋 复制');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(data.setCookie, copy));
  lineWrap.appendChild(copy);
  box.appendChild(lineWrap);

  const a = data.attributes;
  const tags = [a.hostOnly ? 'host-only' : 'Domain=' + stripDot(a.domain), 'Path=' + a.path];
  if (a.secure) tags.push('Secure');
  tags.push('SameSite=' + a.sameSite);
  box.appendChild(el('p', 'solve-stats',
    '属性：' + tags.map((t) => `<span class="badge attr">${esc(t)}</span>`).join('') +
    '（名称、值、有效期与其他属性保持原样）'));

  // 逐步核对结果
  box.appendChild(el('div', 'section-title', '逐步核对（候选替换原响应后重跑完整序列）'));
  const rows = data.checks.map((c) => [
    '第 ' + (c.stepIndex + 1) + ' 步',
    '<span class="mono">' + esc(c.method) + ' ' + esc(c.url) + '</span>',
    c.expected ? '应发送' : '不应发送',
    c.actual
      ? '<span class="badge stored">已发送</span>'
      : '<span class="badge rejected">未发送</span>' +
        (c.reasons && c.reasons.length
          ? '<div class="reasons">' +
            c.reasons.map((x) => `<span class="reason">${esc(REASON_TEXT[x] || x)}</span>`).join('') +
            '</div>'
          : ''),
    c.ok ? '<span class="badge alive">✓ 符合</span>' : '<span class="badge dead">✗ 不符</span>'
  ]);
  box.appendChild(tableWith(['步骤', '请求', '期望', '实际（候选运行）', '核对'], rows));
  box.appendChild(el('p', 'solve-stats',
    '求解只读取当前步骤做演算，不会改动编辑内容；需要时可复制上面的 Set-Cookie，' +
    '手动替换第 ' + (data.writeStep + 1) + ' 步响应中的原行。'));
}

function copyText(text, btn) {
  const done = () => {
    btn.textContent = '✔ 已复制';
    setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* 忽略 */ }
  document.body.removeChild(ta);
  done();
}

// 启动时自动载入并运行示例 1
renderSteps();
runSimulation();

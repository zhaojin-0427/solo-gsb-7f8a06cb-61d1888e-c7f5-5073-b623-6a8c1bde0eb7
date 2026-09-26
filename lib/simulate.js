'use strict';

const { parseUrl, siteKey, isSameSite } = require('./site');
const {
  CookieJar,
  parseSetCookie,
  selectForRequest
} = require('./cookies');

// 固定基准时钟，保证演示结果确定、可读
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];

/**
 * 顺序执行全部步骤。
 * @param {Array} steps 用户编辑的步骤
 * @returns {{results:Array, finalJar:Array}}
 */
function runSimulation(steps) {
  const jar = new CookieJar();
  const results = [];
  let clock = BASE_TIME;

  for (const step of steps || []) {
    const seconds = Math.max(0, Number(step.seconds) || 0);
    clock += seconds * 1000;

    const method = (step.method || 'GET').toUpperCase();
    const request = parseUrl(step.url);
    const topRaw = (step.topUrl || '').trim();
    const top = topRaw ? parseUrl(topRaw) : null;
    const navigation = step.isNavigation === true;

    const result = {
      seconds,
      clock,
      clockISO: new Date(clock).toISOString(),
      method,
      url: (step.url || '').trim(),
      topUrl: topRaw,
      isNavigation: navigation,
      warnings: []
    };

    if (!request) {
      result.warnings.push('请求 URL 非法或非 http(s) 协议，本步骤跳过（不发送请求、不应用 Set-Cookie）');
      result.request = null;
      result.requestSite = null;
      result.topSite = top ? siteKey(topRaw) : null;
      result.sameSite = null;
      result.crossSite = null;
      result.sent = [];
      result.unsent = [];
      result.cookieHeader = '';
      result.nameReads = null; // 跳过步不产生 Cookie 头，无同名取值分析
      result.responses = [];
      result.events = [];
      result.jarAfter = jar.snapshot(clock);
      results.push(result);
      continue;
    }

    // 同站判断（协议 + 可注册域）；顶层 URL 缺省时按一方请求处理
    let sameSite = true;
    let crossSite = false;
    if (topRaw) {
      if (!top) {
        result.warnings.push('顶层页面 URL 非法，无法判定同站，已按跨站处理');
        sameSite = false;
      } else {
        const s = isSameSite(step.url, topRaw);
        sameSite = s;
      }
      crossSite = sameSite === false;
    }

    const reqInfo = { scheme: request.scheme, host: request.host, port: request.port, path: request.path };
    result.request = reqInfo;
    result.requestSite = siteKey(step.url);
    result.topSite = topRaw ? siteKey(topRaw) : result.requestSite;
    result.sameSite = sameSite;
    result.crossSite = crossSite;
    result.topLevelSafeNavigation = navigation && ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method);

    // 1) 先判定本步要发送的 Cookie
    const decision = selectForRequest(
      jar,
      { scheme: request.scheme, host: request.host, path: request.path, method },
      { crossSite, sameSite, navigation },
      clock
    );
    result.sent = decision.sent;
    result.unsent = decision.unsent;
    result.cookieHeader = decision.cookieHeader;
    // 服务端同名取值分析：严格按实际 Cookie 头顺序、名称区分大小写分组。
    // 只列出同名组（组内 ≥2 项）；服务端取首项 / 取末项读到的值分别给出。
    result.nameReads = analyzeNameReads(decision.sent);

    // 生命周期事件（严格按执行顺序）：先记录发送阶段发生的过期淘汰，
    // 再逐条记录 Set-Cookie 的写入 / 覆盖 / 删除。轨迹与现有结果共用同一引擎。
    // 每个事件都携带键标识（name/domain/path，domain 为带前导点的序列化形式），
    // 这样即使是空操作删除（无 before/after）也能归到正确轨迹。
    const identity = (c) => {
      const d = describeCookie(c);
      return { name: d.name, domain: d.domain, path: d.path };
    };
    const events = (decision.evicted || []).map((x) => ({
      type: 'evicted',
      step: results.length,
      clock,
      clockISO: new Date(clock).toISOString(),
      ...identity(x.cookie),
      raw: null,
      before: describeCookie(x.cookie),
      after: null,
      reasons: x.reasons.slice()
    }));

    // 2) 再应用响应中的 Set-Cookie 列表（逐条解析，顺序应用）
    const responses = [];
    for (const raw of step.setCookies || []) {
      const line = (typeof raw === 'string' ? raw : '').trim();
      if (!line) continue;
      const parsed = parseSetCookie(line, { scheme: request.scheme, host: request.host }, clock);
      const entry = { raw: line };

      if (!parsed.ok) {
        entry.status = 'rejected';
        entry.reason = parsed.reason;
        // 被拒写入不改变轨迹：不产生生命周期事件
      } else if (parsed.isDelete) {
        const previous = jar.remove(parsed.cookie.name, parsed.cookie.domain, parsed.cookie.path);
        entry.status = 'deleted';
        entry.existed = previous !== null;
        entry.cookie = describeCookie(parsed.cookie);
        // 未命中的删除显示为空操作：仍然产生一条删除事件，before 为空
        events.push({
          type: 'deleted',
          step: results.length,
          clock,
          clockISO: new Date(clock).toISOString(),
          ...identity(parsed.cookie),
          raw: line,
          before: previous ? describeCookie(previous) : null,
          after: null
        });
      } else {
        const putResult = jar.put(parsed.cookie); // { action, previous }
        entry.status = 'stored';
        entry.action = putResult.action; // stored | updated
        entry.cookie = describeCookie(parsed.cookie);
        // 覆盖沿用同一键并重算到期时间：after 中携带新的 expires
        events.push({
          type: putResult.action === 'updated' ? 'updated' : 'stored',
          step: results.length,
          clock,
          clockISO: new Date(clock).toISOString(),
          ...identity(parsed.cookie),
          raw: line,
          before: putResult.previous ? describeCookie(putResult.previous) : null,
          after: describeCookie(parsed.cookie)
        });
      }
      responses.push(entry);
    }
    result.responses = responses;
    result.events = events;
    result.jarAfter = jar.snapshot(clock);
    results.push(result);
  }

  // 全部步骤跑完后汇总同名取值分歧时间线：仅依据逐步结果，不改动任何步骤数据
  const nameAnalysis = buildNameAnalysis(results);

  return { results, finalJar: jar.snapshot(clock), nameAnalysis };
}

/**
 * 按实际 Cookie 头顺序，把一次请求实际发送的 Cookie 按名称（区分大小写）分组。
 * 仅返回同名组（组内 ≥2 项），顺序按各组首项在头中的先后排列。
 * @param {Array} sent selectForRequest 产出的已发送项（即 Cookie 头顺序）
 */
function analyzeNameReads(sent) {
  const order = [];
  const groups = new Map();
  sent.forEach((c, headerIndex) => {
    let g = groups.get(c.name);
    if (!g) {
      g = { name: c.name, items: [] };
      groups.set(c.name, g);
      order.push(g);
    }
    g.items.push({
      headerIndex,
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      hostOnly: c.hostOnly,
      creationOrder: c.creationOrder
    });
  });
  return order
    .filter((g) => g.items.length >= 2)
    .map((g) => {
      const first = g.items[0];
      const last = g.items[g.items.length - 1];
      return {
        name: g.name,
        items: g.items,
        firstValue: first.value,
        lastValue: last.value,
        divergent: first.value !== last.value
      };
    });
}

/** 同名组中某一项对应的 Jar 键（名称小写），用于判断事件是否命中本组中的具体项。 */
function memberKeyOf(item) {
  return `${String(item.name).toLowerCase()} ${String(item.domain).replace(/^\./, '')} ${item.path}`;
}

/**
 * 沿有效请求时间线汇总每个名称（区分大小写）的同名/分歧状态，
 * 并按 Jar 键中的名称（小写）关联相邻步骤之间的写入 / 覆盖 / 删除 / 过期淘汰事件。
 *
 * 执行顺序约束：每一步先发送后处理响应，因此某次响应只能影响后续请求；
 * 过期淘汰发生在该步发送决策阶段（先判定、后淘汰），会影响同一步的状态变化。
 *
 * @param {Array} results runSimulation 逐步结果
 */
function buildNameAnalysis(results) {
  const validSteps = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].request) validSteps.push(i);
  }

  // stepGroups: 每个有效步中 名称（原样大小写）→ 同名组（≥2 项）
  const stepGroups = new Map();
  const firstSeen = new Map(); // 名称 → 第一次成为同名组的步
  for (const i of validSteps) {
    const at = new Map();
    for (const g of results[i].nameReads || []) {
      at.set(g.name, g);
      if (!firstSeen.has(g.name)) firstSeen.set(g.name, i);
    }
    stepGroups.set(i, at);
  }

  const stateAt = (step, name) => {
    const g = stepGroups.get(step).get(name);
    if (!g) return 'absent';
    return g.divergent ? 'divergent' : 'same';
  };

  // 某一状态区间内命中的事件：按 Jar 键名称（小写）关联；
  // memberKeys 给定时，只保留命中区间两端同名组具体项的事件，其余标记为关联名称下的其他键。
  // 阶段按事件类型区分：过期淘汰发生在请求发送决策阶段（at-send），
  // 写入 / 覆盖 / 删除来自该步的响应处理（response）。
  const collectEvents = (name, fromStep, toStep, keep, memberKeys) => {
    const lname = name.toLowerCase();
    const out = [];
    for (let s = Math.max(0, fromStep); s <= toStep; s++) {
      for (const ev of results[s].events || []) {
        if (String(ev.name).toLowerCase() !== lname) continue;
        if (!keep(s, ev)) continue;
        const key = `${lname} ${String(ev.domain).replace(/^\./, '')} ${ev.path}`;
        out.push({
          type: ev.type,
          step: s,
          clockISO: ev.clockISO,
          raw: ev.raw,
          domain: ev.domain,
          path: ev.path,
          phase: ev.type === 'evicted' ? 'at-send' : 'response',
          member: memberKeys.has(key),
          beforeValue: ev.before ? ev.before.value : null,
          afterValue: ev.after ? ev.after.value : null
        });
      }
    }
    return out;
  };

  const names = [...firstSeen.keys()].sort((a, b) => firstSeen.get(a) - firstSeen.get(b) || (a < b ? -1 : a > b ? 1 : 0));
  const timeline = names.map((name) => {
    const states = validSteps.map((i) => ({ step: i, state: stateAt(i, name) }));

    // 切出分歧区间（连续的 divergent 状态段）
    const segments = [];
    let runStart = -1;
    for (let k = 0; k < states.length; k++) {
      if (states[k].state === 'divergent') {
        if (runStart === -1) runStart = k;
      } else if (runStart !== -1) {
        segments.push({ fromK: runStart, toK: k - 1 });
        runStart = -1;
      }
    }
    if (runStart !== -1) segments.push({ fromK: runStart, toK: states.length - 1 });

    const divergences = segments.map((seg) => {
      const fromStep = validSteps[seg.fromK];
      const toStep = validSteps[seg.toK];
      const prevStep = seg.fromK > 0 ? validSteps[seg.fromK - 1] : -1;
      const nextStep = seg.toK < states.length - 1 ? validSteps[seg.toK + 1] : -1;
      const beforeState = seg.fromK > 0 ? states[seg.fromK - 1].state : 'absent';
      const afterState = seg.toK < states.length - 1 ? states[seg.toK + 1].state : null;

      // 分歧产生窗口（相邻有效请求之间）：
      //  - 上一有效请求步的 Set-Cookie 响应（stored/updated/deleted）在其发送之后处理，
      //    只能影响后续请求，是本步头中新分歧的来源；
      //  - 中间跳过步（URL 非法）不发送也不处理响应，没有事件；
      //  - 上一有效请求步的过期淘汰发生在其发送阶段，影响已包含在上一步状态里，不纳入；
      //  - 分歧步自身的任何事件都不纳入：该步先发送后处理响应，且本步淘汰只移除未发送项。
      const fromGroup = stepGroups.get(fromStep).get(name);
      const memberKeys = new Set(fromGroup.items.map(memberKeyOf));
      const riseEvents = collectEvents(
        name,
        prevStep < 0 ? 0 : prevStep,
        fromStep,
        (s, ev) => s < fromStep && ev.type !== 'evicted',
        memberKeys
      );

      const riseKind = beforeState === 'absent'
        ? (fromGroup.items.length >= 2 ? 'appeared-divergent' : 'appeared')
        : 'became-divergent';

      // 分歧消失窗口（从最后一个分歧步到分歧在某有效请求头中消失之间）：
      //  - 分歧步发送阶段的过期淘汰 + 分歧步自身的 Set-Cookie 响应（先发送后处理）；
      //  - 与下一有效请求之间中间步的 Set-Cookie 响应；
      //  - 下一有效请求步发送阶段的过期淘汰：先判定后淘汰，恰好解释该步头中的消失；
      //  - 下一有效请求步自身的 Set-Cookie 响应不纳入（晚于该步已发出的头）。
      let fallEvents = [];
      let fallKind = null;
      if (nextStep >= 0) {
        const toGroup = stepGroups.get(toStep).get(name);
        const nextGroup = stepGroups.get(nextStep).get(name);
        const keys = new Set([
          ...toGroup.items.map(memberKeyOf),
          ...(nextGroup ? nextGroup.items.map(memberKeyOf) : [])
        ]);
        fallEvents = collectEvents(
          name,
          toStep,
          nextStep,
          (s, ev) => {
            if (s === nextStep) return ev.type === 'evicted'; // 下一步头之前：仅其发送阶段淘汰
            if (s === toStep) return true;                    // 末分歧步：淘汰 + 响应
            return ev.type !== 'evicted';                     // 中间步（通常为跳过步，无事件）
          },
          keys
        );
        fallKind = afterState === 'absent' ? 'disappeared' : 'resolved';
      } else {
        // 分歧持续到最后一个有效请求；该步响应只能影响后续（本时间线中不存在的）请求
        const toGroup = stepGroups.get(toStep).get(name);
        fallEvents = collectEvents(
          name,
          toStep,
          results.length - 1,
          (s, ev) => ev.type !== 'evicted',
          new Set(toGroup.items.map(memberKeyOf))
        );
      }

      return {
        fromStep,
        toStep,
        fromClockISO: results[fromStep].clockISO,
        toClockISO: results[toStep].clockISO,
        beforeState,
        afterState,
        riseKind,
        fallKind,
        ongoing: nextStep < 0,
        firstValue: fromGroup.firstValue,
        lastValue: fromGroup.lastValue,
        riseEvents,
        fallEvents
      };
    });

    return { name, states, divergences };
  });

  const duplicateNames = names.slice();
  const divergentNames = names.filter((n) =>
    timeline.find((t) => t.name === n).divergences.length > 0);

  return {
    validStepCount: validSteps.length,
    duplicateNames,
    divergentNames,
    timeline
  };
}

function describeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.hostOnly ? c.domain : '.' + c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    sameSite: c.sameSite,
    persistent: c.persistent,
    expiresISO: c.expires ? new Date(c.expires).toISOString() : null
  };
}

module.exports = { runSimulation, BASE_TIME, METHODS };

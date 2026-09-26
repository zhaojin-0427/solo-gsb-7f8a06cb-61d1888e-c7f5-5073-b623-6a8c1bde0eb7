'use strict';

// 冒烟测试：直接跑引擎核心逻辑（node test/smoke.js）
const assert = require('assert');
const { runSimulation } = require('../lib/simulate');
const { minimizeSteps, targetMatches } = require('../lib/minimize');
const { parseSetCookie, CookieJar, selectForRequest, domainMatches, pathMatches } = require('../lib/cookies');
const { siteKey, isSameSite } = require('../lib/site');
const { isPublicSuffix, analyzeDomain, isIpAddress, normalizeHostname, parsePsl } = require('../lib/psl');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// --- 基础匹配 ---
ok(domainMatches('a.example.com', 'example.com'));
ok(domainMatches('example.com', 'example.com'));
ok(!domainMatches('notexample.com', 'example.com'));
ok(pathMatches('/app/x', '/app/'));
ok(pathMatches('/app', '/app'));
ok(pathMatches('/appx', '/app') === false);
ok(pathMatches('/app2/x', '/app') === false);

// --- 站判断 ---
assert.strictEqual(siteKey('https://www.example.com/a'), 'https://example.com');
assert.strictEqual(siteKey('http://a.b.co.uk:8080'), 'http://b.co.uk');
assert.strictEqual(siteKey('http://192.168.1.1:9000'), 'http://192.168.1.1');
assert.strictEqual(isSameSite('https://a.example.com', 'https://www.example.com/p'), true);
assert.strictEqual(isSameSite('https://example.com', 'http://example.com'), false); // schemeful
assert.strictEqual(isSameSite('https://example.co.uk', 'https://evil.co.uk'), false);
ok(isPublicSuffix('com'));
ok(isPublicSuffix('co.uk'));
ok(!isPublicSuffix('example.com'));

// --- Set-Cookie 写入校验 ---
const now = Date.parse('2026-01-01T00:00:00Z');
ok(parseSetCookie('a=1; Domain=evil.com', { scheme: 'https', host: 'example.com' }, now).reason === 'DOMAIN_MISMATCH');
ok(parseSetCookie('a=1; Domain=com', { scheme: 'https', host: 'x.com' }, now).reason === 'PUBLIC_SUFFIX');
ok(parseSetCookie('a=1; Domain=co.uk', { scheme: 'https', host: 'x.co.uk' }, now).reason === 'PUBLIC_SUFFIX');
ok(parseSetCookie('a=1; SameSite=None', { scheme: 'https', host: 'example.com' }, now).reason === 'SAMESITE_NONE_SECURE');
const pc = parseSetCookie('sid=abc; Path=/app; Max-Age=60', { scheme: 'https', host: 'shop.example.com' }, now);
ok(pc.ok && pc.cookie.domain === 'shop.example.com' && pc.cookie.hostOnly === true);
ok(pc.cookie.path === '/app' && pc.cookie.expires === now + 60000);
const def = parseSetCookie('sid=abc', { scheme: 'https', host: 'h.example.com' }, now);
ok(def.cookie.path === '/' && def.cookie.sameSite === 'Lax');

// --- 完整示例：完整流程 ---
const stepsA = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [
      'sid=abc123; Domain=example.com; Path=/; Max-Age=3600',
      'cart=2; Path=/cart',
      'track=xyz; Domain=example.com; SameSite=None; Secure; Max-Age=7200'
    ] },
  { seconds: 5, url: 'https://api.shop.example.com/v1/user', method: 'GET',
    topUrl: 'https://shop.example.com/home', isNavigation: false, setCookies: [] },
  { seconds: 3600, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://ads.net/track', method: 'POST', topUrl: 'https://shop.example.com/home', isNavigation: false,
    setCookies: ['p=1; Path=/'] },
  { seconds: 1, url: 'https://ads.net/landing', method: 'GET', topUrl: 'https://ads.net/', isNavigation: true, setCookies: [] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=; Domain=example.com; Path=/; Max-Age=0'] }
];
const simA = runSimulation(stepsA).results;
ok(simA[0].sent.length === 0 && simA[0].responses.length === 3);
assert.deepStrictEqual(simA[1].sent.map((c) => c.name), ['sid', 'track']);
ok(simA[1].unsent.find((u) => u.cookie.name === 'cart').reasons.includes('PATH'));
ok(simA[1].unsent.find((u) => u.cookie.name === 'cart').reasons.includes('DOMAIN'));
assert.deepStrictEqual(simA[2].sent.map((c) => c.name), ['track'], 'sid 已过期');
ok(simA[2].sent.length === 1);
ok(simA[3].sent.length === 0, '跨站 POST 无 Cookie');
const trackUnsent = simA[3].unsent.find((u) => u.cookie.name === 'track');
ok(trackUnsent && trackUnsent.reasons.includes('DOMAIN') && !trackUnsent.reasons.includes('SAMESITE_LAX'),
  'None 不因跨站拦截（此处仅因域不匹配不发送）');
// ads.net 自己的 p
assert.deepStrictEqual(simA[4].sent.map((c) => c.name), ['p'], 'Lax 跨站顶层 GET 放行');
ok(simA[5].responses[0].status === 'deleted');
ok(simA[5].jarAfter.find((c) => c.name === 'sid') === undefined);
ok(simA[5].jarAfter.find((c) => c.name === 'track'));

// --- 非法 Set-Cookie 示例 ---
const simB = runSimulation([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [
    'a=1; Domain=evil.org',
    'b=2; Domain=com',
    'c=3; SameSite=None',
    'd=4; Path=/ok',
    'e=5; Path=relative',
    'f=6; Domain=.example.com'
  ] }
]).results[0];
assert.deepStrictEqual(simB.responses.map((r) => r.status),
  ['rejected', 'rejected', 'rejected', 'stored', 'stored', 'stored']);
assert.deepStrictEqual(simB.responses.map((r) => r.reason).filter(Boolean),
  ['DOMAIN_MISMATCH', 'PUBLIC_SUFFIX', 'SAMESITE_NONE_SECURE']);
const eCookie = simB.responses.find((r) => r.raw.startsWith('e=')).cookie;
ok(eCookie.path === '/', '非法 path 回退为 /');
ok(simB.responses.find((r) => r.raw.startsWith('f=')).cookie.domain === '.example.com');

// --- Secure 与同站协议 ---
const simC = runSimulation([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: ['sec=1; Secure; Path=/', 'plain=1; Path=/'] },
  { seconds: 1, url: 'http://example.com/', method: 'GET', setCookies: [] }
]).results;
assert.deepStrictEqual(simC[1].sent.map((c) => c.name), ['plain']);
ok(simC[1].unsent.find((u) => u.cookie.name === 'sec').reasons.includes('NOT_HTTPS'));

// --- 完整离线 PSL：私有后缀 / 通配最长匹配 / 例外优先 / 边界回归 ---

// 漏洞场景：s3.amazonaws.com 是 PSL 私有后缀
ok(isPublicSuffix('s3.amazonaws.com'), 's3.amazonaws.com 是公共后缀（PRIVATE DOMAINS）');
ok(!isPublicSuffix('alice.s3.amazonaws.com'), '桶主机本身不是公共后缀');
ok(analyzeDomain('alice.s3.amazonaws.com').registrable === 'alice.s3.amazonaws.com');
ok(analyzeDomain('bob.s3.amazonaws.com').registrable === 'bob.s3.amazonaws.com');
assert.strictEqual(
  isSameSite('https://alice.s3.amazonaws.com/', 'https://bob.s3.amazonaws.com/'), false,
  '两个 S3 桶跨站'
);
assert.strictEqual(
  isSameSite('https://alice.s3.amazonaws.com/a', 'https://alice.s3.amazonaws.com/b'), true,
  '同一个 S3 桶内部同站'
);
// Domain=s3.amazonaws.com 必须以公共后缀为由拒绝
ok(parseSetCookie('sid=1; Domain=s3.amazonaws.com; Path=/',
  { scheme: 'https', host: 'alice.s3.amazonaws.com' }, now).reason === 'PUBLIC_SUFFIX');
// 可注册域（非后缀）仍可写 Domain
ok(parseSetCookie('sid=1; Domain=amazonaws.com; Path=/',
  { scheme: 'https', host: 'amazonaws.com' }, now).ok === true);

// 其他私有后缀（github.io 精确、*.compute.herokuapp.com / *.platformsh.site 通配）
ok(isPublicSuffix('github.io'));
assert.strictEqual(isSameSite('https://a.github.io/', 'https://b.github.io/'), false);
ok(parseSetCookie('x=1; Domain=github.io',
  { scheme: 'https', host: 'a.github.io' }, now).reason === 'PUBLIC_SUFFIX');
ok(isPublicSuffix('herokuapp.com'));
ok(!isPublicSuffix('foo.herokuapp.com'), 'foo.herokuapp.com 是可注册域而非后缀');
ok(analyzeDomain('foo.herokuapp.com').registrable === 'foo.herokuapp.com');
ok(isPublicSuffix('app.compute.herokuapp.com'));
ok(analyzeDomain('app.compute.herokuapp.com').registrable === null);
ok(analyzeDomain('x.app.compute.herokuapp.com').registrable === 'x.app.compute.herokuapp.com');
ok(isPublicSuffix('tenant.platformsh.site'));
ok(analyzeDomain('a.platformsh.site').registrable === null, '通配命中本身是后缀');
ok(analyzeDomain('x.a.platformsh.site').registrable === 'x.a.platformsh.site');

// 通配规则：*.ck / *.kobe.jp —— 最长匹配
ok(isPublicSuffix('xyz.ck'), '通配 *.ck 使 xyz.ck 成为后缀');
ok(analyzeDomain('a.xyz.ck').registrable === 'a.xyz.ck');
ok(isPublicSuffix('foo.kobe.jp'));
ok(analyzeDomain('x.foo.kobe.jp').registrable === 'x.foo.kobe.jp');
// 例外规则优先：!www.ck、!city.kobe.jp
ok(!isPublicSuffix('www.ck'), '例外规则：www.ck 不是后缀而是可注册域');
ok(analyzeDomain('www.ck').registrable === 'www.ck');
ok(analyzeDomain('sub.www.ck').registrable === 'www.ck');
ok(!isPublicSuffix('city.kobe.jp'), '例外规则：city.kobe.jp 是可注册域');
ok(analyzeDomain('city.kobe.jp').registrable === 'city.kobe.jp');
ok(analyzeDomain('a.city.kobe.jp').registrable === 'city.kobe.jp');
// 多标签主机下，更具体的规则覆盖更短规则（最长匹配）
ok(analyzeDomain('shop.example.co.uk').registrable === 'example.co.uk');

// 漏洞场景端到端：写入被拒 + 跨桶不发送 + 判为跨站
const simS3 = runSimulation([
  { seconds: 0, url: 'https://alice.s3.amazonaws.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=1; Domain=s3.amazonaws.com; Path=/', 'own=1; Path=/'] },
  { seconds: 1, url: 'https://bob.s3.amazonaws.com/', method: 'GET',
    topUrl: 'https://alice.s3.amazonaws.com/home', isNavigation: false, setCookies: [] }
]).results;
assert.strictEqual(simS3[0].responses[0].status, 'rejected');
assert.strictEqual(simS3[0].responses[0].reason, 'PUBLIC_SUFFIX');
assert.strictEqual(simS3[0].responses[1].status, 'stored');
assert.strictEqual(simS3[1].crossSite, true, 'bob 相对 alice 是跨站');
assert.strictEqual(simS3[1].cookieHeader, '', 'alice 的 host-only Cookie 不发给 bob');
ok(simS3[1].unsent.find((u) => u.cookie.name === 'own').reasons.includes('DOMAIN'));

// --- 国际化域名（IDN）：Unicode 规则 / 主机 / Cookie Domain 统一为 ASCII ---

// 规则加载归一化：精确、通配、例外三种形式中的 Unicode 域名都转 punycode
const idnRules = parsePsl([
  '// ===BEGIN ICANN DOMAINS===',
  '公司.cn',
  '*.公司.hk',
  '!www.公司.hk',
  'xn--fiqs8s'
].join('\n'));
ok(idnRules.exact.has('xn--55qx5d.cn'), '精确规则中的 Unicode 域名转为 punycode');
ok(idnRules.wildcard.has('xn--55qx5d.hk'), '通配规则中的 Unicode 域名转为 punycode');
ok(idnRules.exceptions.has('www.xn--55qx5d.hk'), '例外规则中的 Unicode 域名转为 punycode');
ok(idnRules.exact.has('xn--fiqs8s'), '已是 punycode 的规则保持不变');

// 主机归一化：Unicode 与 punycode 得到同一表示
assert.strictEqual(normalizeHostname('Alice.公司.cn.'), 'alice.xn--55qx5d.cn');
assert.strictEqual(normalizeHostname('alice.xn--55qx5d.cn'), 'alice.xn--55qx5d.cn');

// 公共后缀判断：公司.cn（PSL 中以 Unicode 书写）两种写法都命中
ok(isPublicSuffix('xn--55qx5d.cn'), '公司.cn 的 punycode 形式是公共后缀');
ok(isPublicSuffix('公司.cn'), '公司.cn 的 Unicode 形式是公共后缀');
ok(!isPublicSuffix('alice.xn--55qx5d.cn'), '可注册域本身不是公共后缀');
ok(isPublicSuffix('公司') && isPublicSuffix('xn--55qx5d'), '单标签 IDN TLD 两种形式都是公共后缀');
ok(analyzeDomain('alice.公司.cn').registrable === 'alice.xn--55qx5d.cn');
ok(analyzeDomain('bob.xn--55qx5d.cn').registrable === 'bob.xn--55qx5d.cn');

// 可注册域与同站计算使用同一 ASCII 表示
assert.strictEqual(siteKey('https://alice.公司.cn/'), 'https://alice.xn--55qx5d.cn');
assert.strictEqual(siteKey('https://bob.xn--55qx5d.cn/'), 'https://bob.xn--55qx5d.cn');
assert.strictEqual(
  isSameSite('https://alice.公司.cn/', 'https://bob.公司.cn/'), false,
  '两个 公司.cn 站点跨站'
);
assert.strictEqual(
  isSameSite('https://alice.公司.cn/', 'https://www.alice.xn--55qx5d.cn/'), true,
  'Unicode 与 punycode 混写仍同站'
);

// Cookie Domain 无论 Unicode 还是 Punycode，都按同一 ASCII 表示校验、保存
ok(parseSetCookie('sid=1; Domain=xn--55qx5d.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now).reason === 'PUBLIC_SUFFIX');
ok(parseSetCookie('sid=1; Domain=公司.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now).reason === 'PUBLIC_SUFFIX',
  'Unicode Domain 同样以公共后缀拒绝');
ok(parseSetCookie('sid=1; Domain=xn--55qx5d.cn; Path=/',
  { scheme: 'https', host: 'alice.公司.cn' }, now).reason === 'PUBLIC_SUFFIX',
  'Unicode 响应主机同样命中公共后缀校验');
const idnCookie = parseSetCookie('sid=1; Domain=alice.公司.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now);
ok(idnCookie.ok && idnCookie.cookie.domain === 'alice.xn--55qx5d.cn',
  'Unicode Domain 归一化为 punycode 保存');
ok(parseSetCookie('sid=1; Domain=bob.公司.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now).reason === 'DOMAIN_MISMATCH',
  'IDN 下 Domain 不匹配校验仍然生效');

// 漏洞场景端到端：公司.cn 写入被拒、两站跨站、bob 收不到 Cookie
const simIDN = runSimulation([
  { seconds: 0, url: 'https://alice.公司.cn/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=1; Domain=xn--55qx5d.cn; Path=/', 'own=1; Domain=alice.公司.cn; Path=/'] },
  { seconds: 1, url: 'https://bob.公司.cn/', method: 'GET',
    topUrl: 'https://alice.公司.cn/', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://www.alice.公司.cn/', method: 'GET',
    topUrl: 'https://alice.公司.cn/', isNavigation: false, setCookies: [] }
]).results;
assert.strictEqual(simIDN[0].responses[0].status, 'rejected');
assert.strictEqual(simIDN[0].responses[0].reason, 'PUBLIC_SUFFIX');
assert.strictEqual(simIDN[0].responses[1].status, 'stored');
assert.strictEqual(simIDN[0].responses[1].cookie.domain, '.alice.xn--55qx5d.cn');
assert.strictEqual(simIDN[1].crossSite, true, 'bob 相对 alice 是跨站');
assert.strictEqual(simIDN[1].cookieHeader, '', 'bob 不收到 alice 的 Cookie');
assert.strictEqual(simIDN[2].sameSite, true, '子域与 alice 同站');
assert.strictEqual(simIDN[2].cookieHeader, 'own=1', 'ASCII 存储的 Cookie 能匹配 Unicode URL 主机');

// Unicode 与 punycode 两种 Domain 写法命中同一 Cookie 键（覆盖更新而非共存）
const simIDN2 = runSimulation([
  { seconds: 0, url: 'https://alice.公司.cn/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Domain=alice.公司.cn; Path=/'] },
  { seconds: 1, url: 'https://alice.xn--55qx5d.cn/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=2; Domain=alice.xn--55qx5d.cn; Path=/'] }
]).results;
assert.strictEqual(simIDN2[1].responses[0].action, 'updated', '两种写法命中同一 Cookie 键');
assert.strictEqual(simIDN2[1].jarAfter.filter((c) => c.name === 'k').length, 1);
assert.strictEqual(simIDN2[1].jarAfter[0].value, '2');

// --- 边界：IP 地址（IPv4 / IPv6，含 URL 中的方括号）---
ok(isIpAddress('192.168.1.1'));
ok(isIpAddress('[::1]'));
ok(isIpAddress('[2001:db8::1]'));
ok(!isIpAddress('example.com'));
assert.strictEqual(siteKey('http://192.168.1.1:9000/'), 'http://192.168.1.1');
assert.strictEqual(siteKey('http://[2001:db8::1]:8080/'), 'http://[2001:db8::1]');
assert.strictEqual(isSameSite('http://[::1]:3000/', 'http://[::1]:8080/'), true);
assert.strictEqual(isSameSite('http://192.168.1.1/', 'http://192.168.1.2/'), false);
assert.strictEqual(isSameSite('http://[2001:db8::1]/', 'http://[2001:db8::2]/'), false);
// IP 不做公共后缀判断；host-only Cookie 写入保持既有行为
ok(!isPublicSuffix('192.168.1.1'));
ok(parseSetCookie('a=1; Domain=10.0.0.99',
  { scheme: 'http', host: '192.168.1.1' }, now).reason === 'DOMAIN_MISMATCH');
ok(parseSetCookie('a=1; Path=/',
  { scheme: 'http', host: '192.168.1.1' }, now).ok === true);

// --- 边界：localhost 与普通单标签内网名保留既有行为 ---
assert.strictEqual(siteKey('http://localhost:3000/x'), 'http://localhost');
assert.strictEqual(isSameSite('http://localhost:3000/', 'http://localhost:8080/'), true);
ok(!isPublicSuffix('localhost'));
ok(parseSetCookie('sid=1; Domain=localhost; Path=/',
  { scheme: 'http', host: 'localhost' }, now).ok === true, 'Domain=localhost 仍允许写入');
ok(!isPublicSuffix('intranet'), '未知单标签内网名不视为公共后缀');
assert.strictEqual(siteKey('http://intranet/app'), 'http://intranet');

// --- 边界：普通域名行为不变 ---
assert.strictEqual(siteKey('https://www.example.com/a'), 'https://example.com');
assert.strictEqual(siteKey('http://a.b.co.uk:8080'), 'http://b.co.uk');
assert.strictEqual(isSameSite('https://a.example.com', 'https://www.example.com/p'), true);
assert.strictEqual(isSameSite('https://example.com', 'http://example.com'), false);
ok(isPublicSuffix('com') && isPublicSuffix('co.uk') && !isPublicSuffix('example.com'));

// --- 最小复现（minimize）---

// 场景：已发送目标，含无关整步与无关 Set-Cookie 行，目标步之后还有多余步骤
const stepsMin = [
  { seconds: 0, url: 'https://a.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] }, // 与目标无关的整步，可删
  { seconds: 3, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/; Max-Age=3600', 'noise=1; Path=/'] }, // noise 行可删
  { seconds: 2, url: 'https://other.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['y=2; Path=/'] }, // 与目标无关的整步，可删
  { seconds: 4, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // 目标步：发送 sid
  { seconds: 7, url: 'https://tail.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['z=3; Path=/'] } // 目标步之后，截断
];
const fullMin = runSimulation(stepsMin).results;
const sidSent = fullMin[3].sent.find((c) => c.name === 'sid');
ok(sidSent, '目标步应发送 sid');
const targetSid = { stepIndex: 3, name: sidSent.name, value: sidSent.value,
  domain: sidSent.domain, path: sidSent.path, sent: true };
const minA = minimizeSteps(stepsMin, targetSid);
ok(minA.ok === true, '已发送目标应能最小化');
assert.strictEqual(minA.before.steps, 5);
assert.strictEqual(minA.before.setCookieLines, 5);
assert.strictEqual(minA.after.steps, 2, '无关整步与目标步之后的步骤都被去掉');
assert.strictEqual(minA.after.setCookieLines, 1, '无关 Set-Cookie 行被去掉');
// 保留步：原第 2 步（写入 sid）与目标步
assert.strictEqual(minA.steps[0].url, 'https://shop.example.com/');
assert.deepStrictEqual(minA.steps[0].setCookies, ['sid=abc; Path=/; Max-Age=3600']);
// 秒数并入：删第 1 步（0s）并入第 2 步；删原第 3 步（2s）并入目标步
assert.strictEqual(minA.steps[0].seconds, 3);
assert.strictEqual(minA.steps[1].seconds, 6);
// 目标请求的 URL / 方法 / 顶层页面 / 导航标记不变
assert.strictEqual(minA.steps[1].url, 'https://shop.example.com/');
assert.strictEqual(minA.steps[1].method, 'GET');
assert.strictEqual(minA.steps[1].topUrl, '');
assert.strictEqual(minA.steps[1].isNavigation, false);
// 绝对时刻不变：末步时钟 = 原目标步时钟
const minAResults = runSimulation(minA.steps).results;
assert.strictEqual(minAResults[minAResults.length - 1].clock, fullMin[3].clock);
assert.strictEqual(minA.keptClock, minA.targetClock);
// 末步仍复现目标
ok(targetMatches(minAResults[minAResults.length - 1], targetSid), '最小化后末步仍发送 sid');
// 1-minimal：任何单项再删都会改变目标结果
{
  const cur = minA.steps;
  // 删任意整步（除目标步）
  for (let i = 0; i < cur.length - 1; i++) {
    const cand = cur.map((s) => ({ ...s, setCookies: [...s.setCookies] }));
    const rm = cand.splice(i, 1)[0];
    cand[i].seconds += rm.seconds;
    const rr = runSimulation(cand).results;
    ok(!targetMatches(rr[rr.length - 1], targetSid), `再删第 ${i + 1} 步应改变目标结果`);
  }
  // 删任意 Set-Cookie 行
  cur.forEach((s, i) => s.setCookies.forEach((line, j) => {
    const cand = cur.map((t) => ({ ...t, setCookies: [...t.setCookies] }));
    cand[i].setCookies.splice(j, 1);
    const rr = runSimulation(cand).results;
    ok(!targetMatches(rr[rr.length - 1], targetSid), `再删第 ${i + 1} 步第 ${j + 1} 行应改变目标结果`);
  }));
}

// 场景：未发送目标，原因集合必须保留
const stepsUnsent = [
  { seconds: 0, url: 'https://bank.example/login', method: 'POST', topUrl: '', isNavigation: false,
    setCookies: ['s1=1; SameSite=Strict; Path=/', 'l1=1; SameSite=Lax; Path=/', 'junk=9; Path=/'] },
  { seconds: 5, url: 'https://bank.example/transfer', method: 'POST',
    topUrl: 'https://evil.example/', isNavigation: false, setCookies: [] }
];
const fullUnsent = runSimulation(stepsUnsent).results;
const s1Unsent = fullUnsent[1].unsent.find((u) => u.cookie.name === 's1');
ok(s1Unsent && s1Unsent.reasons.includes('SAMESITE_STRICT'), 's1 应因 Strict 未发送');
const targetS1 = { stepIndex: 1, name: 's1', value: '1',
  domain: s1Unsent.cookie.domain, path: '/', sent: false, reasons: s1Unsent.reasons.slice() };
const minB = minimizeSteps(stepsUnsent, targetS1);
ok(minB.ok === true, '未发送目标应能最小化');
assert.strictEqual(minB.after.steps, 2);
assert.strictEqual(minB.after.setCookieLines, 1, 'l1 与 junk 行均可删');
assert.deepStrictEqual(minB.steps[0].setCookies, ['s1=1; SameSite=Strict; Path=/']);
assert.strictEqual(minB.steps[0].seconds, 0);
assert.strictEqual(minB.steps[1].seconds, 5);
const minBResults = runSimulation(minB.steps).results;
ok(targetMatches(minBResults[minBResults.length - 1], targetS1), '最小化后末步仍复现未发送目标及原因集合');
// 原因集合不一致不算复现
ok(!targetMatches(minBResults[minBResults.length - 1],
  { ...targetS1, reasons: ['SAMESITE_LAX'] }), '原因集合不同不匹配');
ok(!targetMatches(minBResults[minBResults.length - 1],
  { ...targetS1, sent: true }), '发送状态不同不匹配');

// 场景：目标就是第一步（之前没有可删的整步）
const minC = minimizeSteps(
  [{ seconds: 0, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false,
     setCookies: ['a=1; Path=/', 'b=2; Path=/'] }],
  { stepIndex: 0, name: 'a', value: '1', domain: 'x.example', path: '/', sent: false,
    reasons: ['PATH'] }
);
// 第一步执行时 Jar 为空，a 尚未写入，未发送列表里不存在 a → 定位失败
ok(minC.ok === false, '无法定位目标时返回错误');

// 场景：无法定位（名称不存在 / 下标越界）
const minD = minimizeSteps(stepsUnsent,
  { stepIndex: 1, name: 'nope', value: '1', domain: 'bank.example', path: '/', sent: true });
ok(minD.ok === false && /找不到/.test(minD.error), '不存在的目标应报错');
const minE = minimizeSteps(stepsUnsent,
  { stepIndex: 9, name: 's1', value: '1', domain: 'bank.example', path: '/', sent: true });
ok(minE.ok === false, '下标越界应报错');

// 场景：过期目标依赖时钟，秒数并入保证绝对时刻不变
const stepsClock = [
  { seconds: 10, url: 'https://t.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['tmp=1; Path=/; Max-Age=100', 'pad=1; Path=/'] },
  { seconds: 50, url: 'https://pad.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // 无关步，可删，但 50s 必须并入目标步
  { seconds: 40, url: 'https://t.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] } // 目标步：tmp 仍存活（10+50+40=100 边界上不发送？<= now 过期 → 恰好 100s 过期）
];
const fullClock = runSimulation(stepsClock).results;
// 时钟 10+50+40=100s，tmp 的 expires = 10s+100s=110s > 100s，仍发送
const tmpSent = fullClock[2].sent.find((c) => c.name === 'tmp');
ok(tmpSent, '目标步 tmp 仍在有效期内');
const minF = minimizeSteps(stepsClock,
  { stepIndex: 2, name: 'tmp', value: '1', domain: tmpSent.domain, path: '/', sent: true });
ok(minF.ok === true, '时钟敏感目标应能最小化');
assert.strictEqual(minF.after.steps, 2, '无关整步被删');
assert.strictEqual(minF.steps[1].seconds, 90, '被删步的 50s 并入目标步');
const minFResults = runSimulation(minF.steps).results;
assert.strictEqual(minFResults[minFResults.length - 1].clock, fullClock[2].clock, '绝对时刻不变');
ok(targetMatches(minFResults[minFResults.length - 1],
  { stepIndex: 1, name: 'tmp', value: '1', domain: tmpSent.domain, path: '/', sent: true }),
  '时钟不变所以 tmp 仍发送');

// --- 策略求解（solve）---

const { solveStrategy } = require('../lib/solve');

// 场景 1：host-only 优先；SameSite Strict 先于 Lax；Secure 有先于无；有效期保留
const stepsSol1 = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/; Max-Age=3600'] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const sol1 = solveStrategy(stepsSol1, {
  stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [{ stepIndex: 1, sent: true }]
});
ok(sol1.ok === true, '简单场景应有解');
assert.strictEqual(sol1.setCookie, 'sid=abc; Max-Age=3600; Path=/; Secure; SameSite=Strict',
  '名称、值、有效期保留，四属性按候选替换');
assert.strictEqual(sol1.attempts, 1, '首候选即解');
ok(sol1.attributes.hostOnly === true, 'host-only 优先于 Domain 形式');
ok(sol1.attributes.secure === true && sol1.attributes.sameSite === 'Strict',
  'SameSite Strict 先于 Lax/None，Secure 有先于无');
assert.strictEqual(sol1.checks.length, 1);
ok(sol1.checks[0].ok && sol1.checks[0].actual === true && sol1.checks[0].expected === true);

// 场景 2：子域请求需要 Domain 形式；Path 从长到短逐个淘汰
const stepsSol2 = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/'] },
  { seconds: 1, url: 'https://api.shop.example.com/v1/user', method: 'GET',
    topUrl: 'https://shop.example.com/home', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const sol2 = solveStrategy(stepsSol2, {
  stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 2, sent: true }]
});
ok(sol2.ok === true, '子域场景应有解');
assert.strictEqual(sol2.setCookie, 'sid=abc; Domain=shop.example.com; Path=/; Secure; SameSite=Strict');
assert.strictEqual(sol2.attributes.domain, '.shop.example.com', '最窄的可用 Domain 优先');
ok(sol2.checks.every((c) => c.ok && c.actual === true));

// 场景 3：不应发送标记 → 用更长的 Path 排除；同长字典序取先
const sol3 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/app/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://example.com/other', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], {
  stepIndex: 0, respIndex: 0, raw: 'k=1; Path=/',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 2, sent: false }]
});
ok(sol3.ok === true, '路径排除场景应有解');
assert.strictEqual(sol3.setCookie, 'k=1; Path=/app/x; Secure; SameSite=Strict',
  '最长的可用路径（标记请求路径本身）优先');
const sol3c2 = sol3.checks.find((c) => c.stepIndex === 2);
ok(sol3c2 && sol3c2.actual === false && sol3c2.reasons.includes('PATH'),
  '未发送的标记步带 PATH 原因供展示');

// 场景 4：逐级前缀中的中间层成为解（完整路径与 / 都被淘汰）
const sol4 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/app/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://example.com/app/other', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://example.com/other', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], {
  stepIndex: 0, respIndex: 0, raw: 'k=1; Path=/',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 2, sent: true }, { stepIndex: 3, sent: false }]
});
ok(sol4.ok === true, '中间前缀场景应有解');
assert.strictEqual(sol4.setCookie, 'k=1; Path=/app; Secure; SameSite=Strict',
  '两个标记请求的公共逐级前缀 /app 成为解');

// 场景 5：跨站 POST 要发送 → SameSite=None 且必须 Secure
const sol5 = solveStrategy([
  { seconds: 0, url: 'https://bank.example/', method: 'POST', topUrl: '', isNavigation: false,
    setCookies: ['s=1; Path=/'] },
  { seconds: 1, url: 'https://bank.example/transfer', method: 'POST',
    topUrl: 'https://evil.example/', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 's=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol5.ok === true, '跨站 POST 场景应有解');
assert.strictEqual(sol5.setCookie, 's=1; Path=/transfer; Secure; SameSite=None');
ok(sol5.attributes.sameSite === 'None' && sol5.attributes.secure === true);

// 场景 6：跨站顶层 GET 导航要发送 → Strict 不行，Lax 放行
const sol6 = solveStrategy([
  { seconds: 0, url: 'https://bank.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['l=1; Path=/'] },
  { seconds: 1, url: 'https://bank.example/landing', method: 'GET',
    topUrl: 'https://other.example/', isNavigation: true, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'l=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol6.ok === true, '跨站顶层导航场景应有解');
assert.strictEqual(sol6.setCookie, 'l=1; Path=/landing; Secure; SameSite=Lax');

// 场景 7：需要更宽的父域（host-only 与主机 Domain 都不行）
const sol7 = solveStrategy([
  { seconds: 0, url: 'https://a.b.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] },
  { seconds: 1, url: 'https://b.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'x=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol7.ok === true, '父域场景应有解');
assert.strictEqual(sol7.setCookie, 'x=1; Domain=b.example.com; Path=/; Secure; SameSite=Strict',
  'Domain 从窄到宽，取第一个能覆盖标记主机的父域');

// 场景 8：覆盖更新项同样可作为目标
const sol8 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=2; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 1, respIndex: 0, raw: 'k=2; Path=/', marks: [{ stepIndex: 2, sent: true }] });
ok(sol8.ok === true, '覆盖更新项可作为目标');
assert.strictEqual(sol8.setCookie, 'k=2; Path=/; Secure; SameSite=Strict');

// 场景 9：无解（请求主机与来源主机无任何合法 Domain 关系）
const sol9 = solveStrategy([
  { seconds: 0, url: 'https://a.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] },
  { seconds: 1, url: 'https://other.net/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'x=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol9.ok === false && sol9.invalid !== true, '确实无解而不是目标无效');
ok(sol9.attempts > 0, '无解前实际重跑过候选');

// 场景 10：候选不得包含公共后缀（Domain=com 不可作为解）
const sol10 = solveStrategy([
  { seconds: 0, url: 'https://a.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] },
  { seconds: 1, url: 'https://b.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'x=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol10.ok === true);
assert.strictEqual(sol10.setCookie, 'x=1; Domain=example.com; Path=/; Secure; SameSite=Strict');
ok(!sol10.setCookie.includes('Domain=com;'), '公共后缀不会成为候选');

// 场景 11：求解不修改输入步骤
const sol11Steps = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/'] },
  { seconds: 1, url: 'https://api.shop.example.com/v1', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const sol11Frozen = JSON.stringify(sol11Steps);
solveStrategy(sol11Steps, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/',
  marks: [{ stepIndex: 1, sent: true }] });
assert.strictEqual(JSON.stringify(sol11Steps), sol11Frozen, '求解不得修改输入步骤');

// 场景 12：非法目标 / 非法标记一律拒绝
const badTarget1 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['bad=1; Domain=evil.org'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'bad=1; Domain=evil.org', marks: [{ stepIndex: 1, sent: true }] });
ok(badTarget1.ok === false && badTarget1.invalid === true, '被拒写入不可作为目标');

const badTarget2 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=; Path=/; Max-Age=0'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 1, respIndex: 0, raw: 'k=; Path=/; Max-Age=0', marks: [{ stepIndex: 2, sent: false }] });
ok(badTarget2.ok === false && badTarget2.invalid === true, '删除项不可作为目标');

ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [{ stepIndex: 0, sent: true }] }).invalid === true, '标记不晚于写入步被拒绝');
ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [] }).invalid === true, '空标记被拒绝');
ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 1, sent: false }] }).invalid === true,
  '重复标记被拒绝');
ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=CHANGED; Path=/',
  marks: [{ stepIndex: 1, sent: true }] }).invalid === true, 'raw 不一致判定目标失效');
ok(solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['a=1; Path=/'] },
  { seconds: 1, url: 'not-a-url', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'a=1; Path=/', marks: [{ stepIndex: 1, sent: true }] })
  .invalid === true, '无效请求步不可标记');
const nineSteps = [{ seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '',
  isNavigation: false, setCookies: ['a=1; Path=/'] }];
for (let i = 0; i < 9; i++) {
  nineSteps.push({ seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '',
    isNavigation: false, setCookies: [] });
}
ok(solveStrategy(nineSteps, { stepIndex: 0, respIndex: 0, raw: 'a=1; Path=/',
  marks: Array.from({ length: 9 }, (_, i) => ({ stepIndex: i + 1, sent: true })) }).invalid === true,
  '超过 8 个标记被拒绝');

// --- 生命周期事件（写入 / 覆盖 / 删除含空操作 / 过期淘汰）---

const { runSimulation: runSimLC } = require('../lib/simulate');
const Lifecycle = require('../public/lifecycle');

const stepsLC = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [
      'sid=v1; Path=/; Max-Age=100',
      'SID=other; Domain=example.com; Path=/admin', // 同名称（忽略大小写）但域/路径不同 → 另一条轨迹
      'bad=1; SameSite=None'                        // 被拒写入，不产生事件
    ] },
  { seconds: 20, url: 'https://shop.example.com/admin/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=v2; Path=/; Max-Age=300'] }, // 覆盖同键并重算到期
  { seconds: 60, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=; Path=/; Max-Age=0', 'ghost=1; Path=/x; Max-Age=0'] }, // 命中删除 + 空操作删除
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['temp=1; Path=/; Max-Age=10; Secure'] },
  { seconds: 5, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // temp 仍存活（clock 85 < 到期 90）
  { seconds: 6, url: 'http://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] } // clock 91：temp 在首次到期后的有效请求仍进入未发送判定，随后才淘汰
];
const lc = runSimLC(stepsLC).results;

// 第 1 步：两条 stored（sid 与另一条同名不同域/路径的 SID），被拒写入不上轨迹
const e0 = lc[0].events;
assert.strictEqual(e0.length, 2);
assert.strictEqual(e0[0].type, 'stored');
assert.strictEqual(e0[0].raw, 'sid=v1; Path=/; Max-Age=100');
ok(e0[0].before === null && e0[0].after.name === 'sid' && e0[0].after.value === 'v1');
assert.strictEqual(e0[0].after.expiresISO, new Date(lc[0].clock + 100000).toISOString());

// 第 2 步：覆盖同键，before/after 值与新到期时间正确
const e1 = lc[1].events;
assert.strictEqual(e1.length, 1);
assert.strictEqual(e1[0].type, 'updated');
assert.strictEqual(e1[0].before.value, 'v1');
assert.strictEqual(e1[0].after.value, 'v2');
assert.strictEqual(Date.parse(e1[0].after.expiresISO), lc[1].clock + 300000, '覆盖重算到期时间');
assert.strictEqual(e1[0].before.domain, e1[0].after.domain, '覆盖沿用同一键（域不变）');

// 第 3 步：命中删除（有 before）+ 未命中删除（空操作，before 为空）
const e2 = lc[2].events;
assert.strictEqual(e2.length, 2);
assert.strictEqual(e2[0].type, 'deleted');
ok(e2[0].before && e2[0].before.value === 'v2');
assert.strictEqual(e2[1].type, 'deleted');
ok(e2[1].before === null, '未命中的删除是空操作');
assert.ok(e2[1].raw.includes('ghost='));

// 第 4 步：temp 写入
assert.strictEqual(lc[3].events.length, 1);
assert.strictEqual(lc[3].events[0].type, 'stored');

// 第 5 步：temp 仍存活（写入时刻 80 + 10s 到期 90，此刻 85）
assert.strictEqual(lc[4].events.length, 0);
ok(lc[4].sent.some((c) => c.name === 'temp'));

// 第 6 步：clock=91 > 到期 90，temp 进入未发送判定（EXPIRED 等），随后淘汰
const e5 = lc[5].events;
assert.strictEqual(e5.length, 1);
assert.strictEqual(e5[0].type, 'evicted');
assert.strictEqual(e5[0].raw, null, '淘汰事件无 Set-Cookie 原文');
assert.strictEqual(e5[0].before.name, 'temp');
ok(e5[0].after === null);
ok(e5[0].reasons.includes('EXPIRED'), '淘汰前进入了未发送判定');
ok(e5[0].reasons.includes('NOT_HTTPS'), '该次判定的全部原因都被记录');
// 与现有结果一致：未发送列表中同一时刻仍能看到 temp
ok(lc[5].unsent.some((u) => u.cookie.name === 'temp' && u.reasons.includes('EXPIRED')),
  '轨迹与现有未发送结果一致：先判定、后淘汰');
ok(!lc[5].jarAfter.some((c) => c.name === 'temp'), '淘汰后步末 Jar 中不存在 temp');

// 键归一：名称忽略大小写；域去前导点；同名不同域/路径分开
assert.strictEqual(
  Lifecycle.keyOf('SID', '.example.com', '/'),
  Lifecycle.keyOf('sid', 'example.com', '/'),
  '名称大小写不敏感、域前导点归一'
);
assert.notStrictEqual(
  Lifecycle.keyOf('sid', 'shop.example.com', '/'),
  Lifecycle.keyOf('sid', 'example.com', '/'),
  '域不同必须分开'
);
assert.notStrictEqual(
  Lifecycle.keyOf('sid', 'example.com', '/'),
  Lifecycle.keyOf('sid', 'example.com', '/admin'),
  '路径不同必须分开'
);

// traceOf：从第 6 步的未发送 temp 回溯，只能看到它自己的写入与淘汰
const tempUnsent = lc[5].unsent.find((u) => u.cookie.name === 'temp');
const traceTemp = Lifecycle.traceOf(lc, tempUnsent.cookie, 5);
assert.deepStrictEqual(traceTemp.map((x) => x.type), ['stored', 'evicted']);
assert.deepStrictEqual(traceTemp.map((x) => x.step), [3, 5]);

// 从被覆盖后的步末 Jar 选 sid（host-only），轨迹含写入与覆盖，不含 admin 路径的 SID
const sidJar = lc[1].jarAfter.find((c) => c.name === 'sid' && c.hostOnly);
ok(sidJar);
const traceSid = Lifecycle.traceOf(lc, sidJar, 1);
assert.deepStrictEqual(traceSid.map((x) => x.type), ['stored', 'updated']);
ok(traceSid.every((x) => x.step <= 1));

// admin 路径的 Domain Cookie 是另一条轨迹（即使同名）
const sidAdmin = lc[1].jarAfter.find((c) => c.name === 'SID' && c.path === '/admin');
ok(sidAdmin);
const traceAdmin = Lifecycle.traceOf(lc, sidAdmin, 1);
assert.strictEqual(traceAdmin.length, 1);
assert.strictEqual(traceAdmin[0].after.path, '/admin');

// 截至目标步：从第 2 步选 sid 看不到第 3 步的删除
assert.strictEqual(Lifecycle.traceOf(lc, sidJar, 1)
  .every((x) => x.type !== 'deleted'), true);

// 空操作删除项本身也可作为选择项，其轨迹截至该步 = 写入 → 覆盖 → 删除（空操作）
const ghostResp = { name: 'ghost', domain: 'shop.example.com', path: '/x' };
const traceGhost = Lifecycle.traceOf(lc, ghostResp, 2);
assert.strictEqual(traceGhost.length, 1);
assert.strictEqual(traceGhost[0].type, 'deleted');
ok(Lifecycle.isDeleteMiss(traceGhost[0]));

// 非法 URL 跳过步不产生事件，时钟仍推进
const lcSkip = runSimLC([
  { seconds: 30, url: 'not-a-url', method: 'GET', setCookies: ['x=1'] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', setCookies: [] }
]).results;
assert.deepStrictEqual(lcSkip[0].events, []);
assert.strictEqual(lcSkip[1].clock, lcSkip[0].clock + 1000);

// --- 服务端同名取值分析（nameReads / nameAnalysis）---

// 场景：同名不同路径共存 → 同名组；覆盖把末项改成同值 → 分歧消失；再删除 → 同名组消失
const stepsNA = [
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=a; Path=/', 'sid=b; Path=/x', 'uniq=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=a; Path=/x'] }, // 覆盖 /x 的项为同值 a
  { seconds: 1, url: 'https://example.com/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // 同名但取值一致
  { seconds: 1, url: 'https://example.com/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=; Path=/; Max-Age=0', 'sid=; Path=/x; Max-Age=0'] },
  { seconds: 1, url: 'https://example.com/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const naRun = runSimLC(stepsNA);
const naR = naRun.results;

// 第 1 步：空头无同名组（nameReads 为空数组；跳过步才是 null）
assert.ok(naR[0].request && Array.isArray(naR[0].nameReads) && naR[0].nameReads.length === 0);

// 第 2 步：头顺序 = 路径更长的 /x 在前；首 b 末 a，分歧
const g2 = naR[1].nameReads;
assert.strictEqual(g2.length, 1);
assert.strictEqual(g2[0].name, 'sid');
assert.deepStrictEqual(g2[0].items.map((x) => x.value), ['b', 'a']);
assert.deepStrictEqual(g2[0].items.map((x) => x.path), ['/x', '/']);
assert.strictEqual(g2[0].firstValue, 'b');
assert.strictEqual(g2[0].lastValue, 'a');
assert.strictEqual(g2[0].divergent, true);
// 逐项携带域、路径、创建次序
assert.strictEqual(g2[0].items[0].creationOrder, 1, '创建次序为 Jar 单调序（0 基）');
assert.strictEqual(g2[0].items[1].creationOrder, 0);
assert.strictEqual(g2[0].items[0].domain, 'example.com');

// 第 3 步：同名一致，不分歧
assert.strictEqual(naR[2].nameReads.length, 1);
assert.strictEqual(naR[2].nameReads[0].divergent, false);
assert.strictEqual(naR[2].nameReads[0].firstValue, 'a');

// 第 4 步：删除响应在发送之后处理，本步头里仍是 sid=a 同名组（取值一致，不分歧）
assert.strictEqual(naR[3].nameReads.length, 1);
assert.strictEqual(naR[3].nameReads[0].divergent, false);
assert.deepStrictEqual(naR[3].nameReads[0].items.map((x) => x.value), ['a', 'a']);
// 第 5 步：两项均已删除，无同名组
assert.strictEqual(naR[4].nameReads.length, 0);

// 全局时间线：有效请求 5 个；只有 sid 一个同名名称；分歧仅第 2 步
const na = naRun.nameAnalysis;
assert.strictEqual(na.validStepCount, 5);
assert.deepStrictEqual(na.duplicateNames, ['sid']);
assert.deepStrictEqual(na.divergentNames, ['sid']);
const tSid = na.timeline[0];
assert.strictEqual(tSid.name, 'sid');
assert.deepStrictEqual(tSid.states.map((s) => s.state), ['absent', 'divergent', 'same', 'same', 'absent']);
assert.strictEqual(tSid.divergences.length, 1);
const d1 = tSid.divergences[0];
assert.strictEqual(d1.fromStep, 1);
assert.strictEqual(d1.toStep, 1);
assert.strictEqual(d1.riseKind, 'appeared-divergent');
assert.strictEqual(d1.fallKind, 'resolved');
assert.strictEqual(d1.ongoing, false);

// 产生窗口：第 1 步响应中的两条写入（本步响应不纳入）
{
  const rise = d1.riseEvents;
  assert.strictEqual(rise.length, 2, '两条同名写入都关联到产生窗口');
  assert.ok(rise.every((e) => e.step === 0 && e.phase === 'response' && e.type === 'stored'));
  assert.ok(rise.every((e) => e.member), '两条都命中分歧同名组中的具体项');
  assert.deepStrictEqual(rise.map((e) => e.path), ['/', '/x']);
}
// 消失窗口：第 2 步的覆盖响应（先发送后处理，影响第 3 步）
{
  const fall = d1.fallEvents;
  assert.strictEqual(fall.length, 1);
  assert.strictEqual(fall[0].step, 1);
  assert.strictEqual(fall[0].type, 'updated');
  assert.strictEqual(fall[0].phase, 'response');
  assert.strictEqual(fall[0].path, '/x');
  assert.strictEqual(fall[0].member, true);
  assert.strictEqual(fall[0].beforeValue, 'b');
  assert.strictEqual(fall[0].afterValue, 'a');
}

// 场景：同名组按名称区分大小写（Jar 键本身名称不区分大小写，故大小写不同但域/路径相同会覆盖，
// 只有大小写不同且域或路径不同的项才可能同时出现在头里并被分到不同名称组）
const naCase = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: [
    'sid=a; Path=/', 'SID=A; Domain=example.com; Path=/admin', 'sid=b; Path=/x'
  ]},
  { seconds: 1, url: 'https://example.com/x', method: 'GET', setCookies: [] }
]).results;
{
  // /x 只收到 sid=b 与 sid=a（Path=/admin 不匹配），小写 sid 构成同名分歧组
  const sidLower = naCase[1].nameReads.find((g) => g.name === 'sid');
  assert.ok(sidLower, '小写 sid 有两项构成同名组');
  assert.deepStrictEqual(sidLower.items.map((x) => x.value), ['b', 'a']);
  assert.strictEqual(sidLower.divergent, true);
  // 大写 SID 本步头中没有（路径 /admin 不匹配），自然不构成同名组
  assert.ok(!naCase[1].nameReads.some((g) => g.name === 'SID'));
  assert.strictEqual(naCase[1].nameReads.length, 1);
}
// 请求 /admin 时：收到 SID=A 与 sid=a（不同名称，区分大小写，互不同名）
const naCase2 = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: [
    'sid=a; Path=/', 'SID=A; Domain=example.com; Path=/admin'
  ]},
  { seconds: 1, url: 'https://example.com/admin', method: 'GET', setCookies: [] }
]).results;
assert.ok(naCase2[1].cookieHeader.includes('SID=A') && naCase2[1].cookieHeader.includes('sid=a'));
assert.strictEqual(naCase2[1].nameReads.length, 0, '名称大小写不同不算同名组');

// 场景：无同名 → 明确状态
const naNone = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: ['a=1; Path=/', 'b=2; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', setCookies: [] }
]);
assert.deepStrictEqual(naNone.nameAnalysis.duplicateNames, []);
assert.deepStrictEqual(naNone.nameAnalysis.divergentNames, []);
assert.strictEqual(naNone.nameAnalysis.validStepCount, 2);
assert.strictEqual(naNone.results[1].nameReads.length, 0);

// 场景：跳过步 nameReads = null，且不计入有效请求
const naSkip = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: ['k=1; Path=/', 'k=2; Path=/x'] },
  { seconds: 1, url: 'bad-url', method: 'GET', setCookies: ['k=9; Path=/'] },
  { seconds: 1, url: 'https://example.com/x', method: 'GET', setCookies: [] }
]);
assert.strictEqual(naSkip.results[1].nameReads, null);
assert.strictEqual(naSkip.nameAnalysis.validStepCount, 2);

// 场景：过期淘汰在发送阶段发生 → 关联为消失窗口的 at-send 事件
const naEvict = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: [
    'k=1; Path=/; Max-Age=10', 'k=2; Path=/x; Max-Age=10'
  ]},
  { seconds: 1, url: 'https://example.com/x', method: 'GET', setCookies: [] }, // 分歧
  { seconds: 10, url: 'https://example.com/x', method: 'GET', setCookies: [] }  // 两项均到期
]);
const eRun = naEvict.nameAnalysis;
assert.strictEqual(eRun.divergentNames.length, 1);
const eDiv = eRun.timeline[0].divergences[0];
assert.strictEqual(eDiv.toStep, 1);
assert.strictEqual(eDiv.fallKind, 'disappeared');
assert.ok(eDiv.fallEvents.length >= 2, '两项淘汰都关联到消失窗口');
assert.ok(eDiv.fallEvents.every((e) => e.type === 'evicted' && e.phase === 'at-send' && e.step === 2));
assert.ok(eDiv.fallEvents.every((e) => e.member));

// 场景：分歧持续到最后一个有效请求（ongoing）；末尾步的响应只作“影响后续”提示
const naOngoing = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: ['k=1; Path=/', 'k=2; Path=/x'] },
  { seconds: 1, url: 'https://example.com/x', method: 'GET', setCookies: ['k=3; Path=/x'] },
  { seconds: 1, url: 'https://example.com/x', method: 'GET', setCookies: ['k=4; Path=/x'] }
]);
const oDiv = naOngoing.nameAnalysis.timeline[0].divergences[0];
assert.strictEqual(oDiv.fromStep, 1, '第 2 步起分歧（首 2 末 1）');
assert.strictEqual(oDiv.toStep, 2, '第 3 步仍分歧（首 3 末 1）');
assert.strictEqual(oDiv.ongoing, true);
assert.strictEqual(oDiv.fallKind, null);
// 第 2 步（index 1）的覆盖维持了已存在的分歧：不属于产生窗口（产生窗口只含首分歧步之前的事件）
assert.deepStrictEqual(oDiv.riseEvents.map((e) => e.step + ':' + e.type), ['0:stored', '0:stored']);
// 末步（index 2）自身的覆盖列入提示：它不能影响任何已展示的请求
assert.deepStrictEqual(oDiv.fallEvents.map((e) => e.step + ':' + e.type), ['2:updated']);
assert.strictEqual(oDiv.fallEvents[0].afterValue, '4');

// 场景：请求作用域变化导致同名组消失（无任何事件）→ fallEvents 为空但仍标 disappeared
const naScope = runSimLC([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: ['k=1; Path=/', 'k=2; Path=/x'] },
  { seconds: 1, url: 'https://example.com/x', method: 'GET', setCookies: [] }, // 分歧
  { seconds: 1, url: 'https://example.com/y', method: 'GET', setCookies: [] }  // 路径变化：只剩 / 的 k=1
]);
const sDiv = naScope.nameAnalysis.timeline[0].divergences[0];
assert.strictEqual(sDiv.fallKind, 'disappeared');
assert.strictEqual(sDiv.fallEvents.length, 0, '无写入/覆盖/删除/淘汰事件，纯作用域变化');

console.log(`全部 ${passed} 条断言通过，另含若干深度比较断言。`);
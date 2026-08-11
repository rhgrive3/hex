/*
 * 自動解析 — 利用者が何も指示しなくても、分かることを全部やる。
 *
 * このツールの入口は「何を調べたいですか？」だが、初心者は
 * **何を調べればいいのかも分からない**ことが多い。だからファイルを開いた時点で、
 * 押されなくても次の全部を自動で回す。
 *
 *   1. プログラム全体の索引（呼び出し・データ参照・命令統計）    ← 事実
 *   2. 文字列の収集と、機能への振り分け                          ← 事実 + 分類
 *   3. すべての目的（HP・攻撃力・課金・通信…）を総当たりで採点   ← 根拠つきの候補
 *   4. 目的に関係なく「注目すべき関数」を選ぶ                     ← 計数にもとづく
 *   5. 気づいたこと（通信先・反解析・暗号・広告）を拾う           ← 参照元つき
 *   6. 上位の候補だけ、実際に逆アセンブルして中身まで踏み込む     ← 変更候補まで
 *
 * ここも日本語は作らない。返すのは構造と根拠だけ（文にするのは narrate/panels）。
 *
 * 重い処理の順番には意味がある。索引 → 採点（軽い）→ 深掘り（重い）の順で、
 * 途中経過を都度返すので、UI は分かったところから出せる。
 */
import { GOALS, goalFromPreset } from './goals.js';
import { rankCandidates } from './rank.js';
import { groupByFeature, detectEngine } from './features.js';
import { findValueUpdates, constantComparisons } from './dataflow.js';
import { buildAppMap, buildStringMap } from './appmap.js';

/* ── 気づいたこと（目的を指定しなくても言えること） ────────
   どれも「その文字列が実在する」という事実が起点で、
   参照している関数まで辿れたものだけを findings に載せる。 */

const SIGNALS = [
  {
    id: 'endpoint', level: 'high',
    re: /^https?:\/\/[^\s"']{4,}/i,
    max: 12,
  },
  {
    id: 'anticheat', level: 'high',
    re: /jailbr|jailbroken|cydia|frida|substrate|tamper|integrity|debugger|ptrace|sandbox_?check|不正|改造|チート/i,
    max: 8,
  },
  {
    id: 'crypto', level: 'normal',
    re: /\baes\b|\bsha(1|256|512)\b|\bhmac\b|\brsa\b|encrypt|decrypt|cipher|keychain|private_?key/i,
    max: 8,
  },
  {
    id: 'ads', level: 'normal',
    re: /admob|applovin|unityads|ironsource|vungle|tapjoy|adjust\.com|appsflyer|interstitial|rewarded/i,
    max: 6,
  },
  {
    id: 'purchase', level: 'high',
    re: /storekit|skpayment|receipt|verifyreceipt|subscription|in_?app_?purchase/i,
    max: 6,
  },
  {
    id: 'debuglog', level: 'low',
    re: /\bdebug\b|verbose|assert|\bTODO\b|FIXME/i,
    max: 4,
  },
  {
    id: 'path', level: 'low',
    re: /^\/(Users|var|private|tmp|Applications)\/[^\s"']{4,}/,
    max: 6,
  },
];

/**
 * 目的に関係なく「今見るべき関数」を選ぶ。
 *
 * 点はすべて数えられるものだけで付ける（何回呼ばれているか、掛け算が何回あるか…）。
 * 名前や文字列の当てはまりは使わない。ここは目的が決まる前の話なので。
 */
export function notableFunctions(program, symbols, region, limit = 12) {
  if (!program || !symbols || !symbols.functionCount) return [];
  const list = symbols.functionList(region, 20000);
  const out = [];
  for (const f of list) {
    const range = program.functionRange(f.addr);
    if (!range) continue;
    const stats = program.statsOf(range.start, range.end);
    if (!stats.total) continue;
    const called = program.callCountOf(f.addr);
    const reasons = [];
    let score = 0;

    if (called >= 2) {
      score += Math.min(18, called * 3);
      reasons.push({ code: 'called', points: Math.min(18, called * 3), detail: { n: called } });
    }
    if (stats.numeric) {
      const p = Math.min(12, stats.numeric * 3);
      score += p;
      reasons.push({ code: 'numeric', points: p, detail: { mul: stats.mul, div: stats.div, fmul: stats.fmul } });
    }
    if (stats.store && stats.load) {
      const p = Math.min(10, stats.store * 2);
      score += p;
      reasons.push({ code: 'readwrite', points: p, detail: { load: stats.load, store: stats.store } });
    }
    if (f.name) {
      score += 6;
      reasons.push({ code: 'named', points: 6, detail: { name: f.name } });
    }
    if (stats.cmp >= 2) {
      score += 4;
      reasons.push({ code: 'compare', points: 4, detail: { n: stats.cmp } });
    }
    // 巨大な関数は「全部入り」であることが多く、最初に読む場所ではない
    if (stats.total > 1500) {
      score -= 10;
      reasons.push({ code: 'huge', points: -10, detail: { n: stats.total } });
    }
    if (score <= 6) continue;
    out.push({ addr: f.addr, name: f.name, score, reasons, stats, called, range });
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));
  return out.slice(0, limit);
}

/** 文字列から「気づいたこと」を拾い、参照している関数まで結びつける。 */
export function findings(strings, program, symbols, limit = 40) {
  const out = [];
  for (const sig of SIGNALS) {
    let taken = 0;
    for (const s of strings) {
      if (taken >= sig.max || out.length >= limit) break;
      if (!sig.re.test(s.text)) continue;
      const users = program
        ? program.functionsReferencing(s.addr, BigInt(Math.min(s.text.length, 256)), 8)
        : [];
      out.push({
        id: sig.id,
        level: sig.level,
        text: s.text,
        addr: s.addr,
        users: users.map((u) => ({
          addr: u.addr, site: u.site,
          name: u.addr != null && symbols ? symbols.nameAt(u.addr) : null,
        })),
      });
      taken++;
    }
  }
  // 参照元まで辿れたものを先に見せる（そのまま次の一手になるので）
  out.sort((a, b) => b.users.length - a.users.length);
  return out;
}

/**
 * 全部まとめて自動で回す。
 *
 * @param {object} opts
 *   strings   [{addr, text}]
 *   program   ProgramIndex
 *   symbols   SymbolIndex
 *   region    コードのセクション
 *   analyze   async (start:BigInt, end:BigInt) => model   … 深掘り用（省略可）
 *   deepLimit 深掘りする関数の数
 *   onProgress ({phase, done, all}) => void
 *   isCancelled () => boolean
 */
export async function autoAnalyze(opts) {
  const o = opts || {};
  const { strings = [], program = null, symbols = null, region = null } = o;
  const progress = o.onProgress || (() => {});
  const cancelled = o.isCancelled || (() => false);
  const deepLimit = o.deepLimit != null ? o.deepLimit : 12;

  const report = {
    map: null,
    engine: null,
    features: [],
    goals: [],
    notable: [],
    findings: [],
    deep: [],
    stats: {
      strings: strings.length,
      calls: program ? program.callCount : 0,
      refs: program ? program.refCount : 0,
      functions: symbols ? symbols.functionCount : 0,
      statsComplete: program ? program.statsComplete : false,
      // 索引が上限で打ち切られたかどうか。打ち切ったなら、そう言う。
      capped: !!(program && (program.callsCapped || program.refsCapped)),
    },
    notes: [],
  };

  /* 1. 言葉から分かること */
  progress({ phase: 'features', done: 0, all: 1 });
  report.engine = detectEngine(strings);
  report.features = groupByFeature(strings);
  report.findings = findings(strings, program, symbols);

  /* 2. アプリの地図。数万の関数を、人が把握できる数の部品に畳む。
        ここが「どれがどの処理か分からない」への答えになる。 */
  progress({ phase: 'map', done: 0, all: 1 });
  const fields = o.fields || null;
  report.map = (fields && fields.classCount)
    ? buildAppMap({ fields, program, symbols, strings, region })
    : buildStringMap({ program, symbols, strings });
  report.stats.classes = fields ? fields.classCount : 0;
  report.stats.fields = fields ? fields.fieldCount : 0;
  await tick();

  /* 3. すべての目的を総当たりで採点する。
        1 目的あたりの計算は索引の二分探索なので、16 個回しても軽い。 */
  const all = GOALS.length;
  for (let i = 0; i < GOALS.length; i++) {
    if (cancelled()) { report.notes.push('cancelled'); return report; }
    progress({ phase: 'goals', done: i, all });
    const goal = goalFromPreset(GOALS[i].id);
    const ranked = rankCandidates({ goal, strings, program, symbols, region, limit: 5 });
    if (!ranked.candidates.length) continue;
    report.goals.push({
      goal,
      candidates: ranked.candidates,
      best: ranked.candidates[0],
      matchedStrings: ranked.matchedStrings.length,
      notes: ranked.notes,
    });
    // 待たせないように、目的ごとに 1 回息継ぎする
    await tick();
  }
  // 最有力の目的から先に見せる
  report.goals.sort((a, b) => b.best.score - a.best.score);

  /* 4. 目的とは無関係の「注目すべき関数」 */
  progress({ phase: 'notable', done: 0, all: 1 });
  report.notable = notableFunctions(program, symbols, region);

  /* 5. 上位だけ、実際に中身まで踏み込む。
        ここだけ逆アセンブルが走るので、数を厳しく絞る。 */
  if (o.analyze && deepLimit > 0) {
    const targets = [];
    const seen = new Set();
    const push = (addr, why, goal) => {
      if (addr == null) return;
      const key = addr.toString();
      if (seen.has(key) || targets.length >= deepLimit) return;
      seen.add(key);
      targets.push({ addr, why, goal: goal || null });
    };
    for (const g of report.goals) {
      push(g.best.addr, 'goal', g.goal);
      if (g.candidates[1]) push(g.candidates[1].addr, 'goal', g.goal);
    }
    for (const n of report.notable) push(n.addr, 'notable', null);

    for (let i = 0; i < targets.length; i++) {
      if (cancelled()) { report.notes.push('deep-cancelled'); break; }
      progress({ phase: 'deep', done: i, all: targets.length });
      const t = targets[i];
      const range = program ? program.functionRange(t.addr) : null;
      let model = null;
      try {
        model = await o.analyze(t.addr, range ? range.end : null);
      } catch { model = null; }
      if (!model) continue;
      const updates = findValueUpdates(model).filter((u) => u.kind === 'read-modify-write');
      const compares = constantComparisons(model);
      /*
       * ここで「x0 + 0x20」を「BattleManager の hp」に置き換える。
       * この 1 手で、報告の意味が初心者にも通じるものに変わる。
       */
      const owner = fields ? fields.ownerOf(t.addr) : null;
      for (const u of updates) {
        u.field = owner
          ? fields.resolveAccess({ base: u.location.base, disp: u.location.disp }, owner.className)
          : null;
      }
      report.deep.push({
        addr: t.addr,
        owner,
        name: symbols ? symbols.nameAt(t.addr) : null,
        why: t.why,
        goal: t.goal ? t.goal.id : null,
        goalLabel: t.goal ? t.goal.text : null,
        updates: updates.slice(0, 4),
        compares: compares.slice(0, 4),
        instructions: model.facts ? model.facts.instructionCount : 0,
        selectors: (model.calls || []).map((c) => c.selector).filter(Boolean).slice(0, 4),
        strings: (model.facts && model.facts.strings ? model.facts.strings : []).slice(0, 3),
      });
      await tick();
    }
    // 値を書き換えている関数を先に。「どこを変えればいいか」に直結するので。
    report.deep.sort((a, b) => b.updates.length - a.updates.length ||
      (b.goal ? 1 : 0) - (a.goal ? 1 : 0));
  }

  progress({ phase: 'done', done: 1, all: 1 });
  return report;
}

/** 次に何をすればいいか。自動解析の結果から決める。 */
export function autoNextSteps(report) {
  const steps = [];
  if (!report) return steps;
  const withUpdates = report.deep.filter((d) => d.updates.length);
  if (withUpdates.length) {
    steps.push({ code: 'open-update', detail: { addr: withUpdates[0].updates[0].store.address, name: withUpdates[0].name } });
  }
  if (report.goals.length) {
    steps.push({ code: 'open-goal', detail: { label: report.goals[0].goal.text, addr: report.goals[0].best.addr } });
  }
  if (report.findings.some((f) => f.id === 'endpoint')) {
    steps.push({ code: 'check-endpoint', detail: null });
  }
  if (report.findings.some((f) => f.id === 'anticheat')) {
    steps.push({ code: 'check-anticheat', detail: null });
  }
  if (!report.goals.length && !report.notable.length) {
    steps.push({ code: 'nothing-found', detail: null });
  }
  if (report.engine) steps.push({ code: 'other-binary', detail: { engine: report.engine.id } });
  steps.push({ code: 'verify-runtime', detail: null });
  return steps;
}

/** UI スレッドを譲る（自動解析中もスクロールを止めない）。 */
function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

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
 *   4. 目的ごとに値を 1 個まで絞り、逆アセンブルして裏を取る      ← 決着（pinpoint）
 *   5. 目的に関係なく「注目すべき関数」を選ぶ                     ← 計数にもとづく
 *   6. 気づいたこと（通信先・反解析・暗号・広告）を拾う           ← 参照元つき
 *   7. 上位の候補だけ、実際に逆アセンブルして中身まで踏み込む     ← 変更候補まで
 *
 * 4 がこのツールの答えそのものになる。候補を並べて終わりにせず、
 * 「HP は BattleManager.hp です」まで言い切る（言い切れないものは言い切らない）。
 * 中身は pinpoint.js / evidence.js / verify.js。
 *
 * ここも日本語は作らない。返すのは構造と根拠だけ（文にするのは narrate/panels）。
 *
 * 重い処理の順番には意味がある。索引 → 採点（軽い）→ 決着 → 深掘り（重い）の順で、
 * 途中経過を都度返すので、UI は分かったところから出せる。
 * 逆アセンブルの回数には全体で予算を切ってあり、使い切ったら
 * 「決着しなかった」と正直に返す（時間をかけて断定しにいくことはしない）。
 */
import { GOALS, goalFromPreset } from './goals.js';
import { rankCandidates } from './rank.js';
import { vendorsOf } from './vendors.js';
import { groupByFeature, detectEngine } from './features.js';
import { findValueUpdates, constantComparisons } from './dataflow.js';
import { buildAppMap, buildStringMap } from './appmap.js';
import { pinpointField, pinpointFunction, pinpointLocation } from './pinpoint.js';
import { VERDICT, verdictRank } from './evidence.js';
import { inferRole } from './role.js';

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
    pinned: [],
    confirmed: [],
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
  const rankedByGoal = new Map();
  for (let i = 0; i < GOALS.length; i++) {
    if (cancelled()) { report.notes.push('cancelled'); return report; }
    progress({ phase: 'goals', done: i, all });
    const goal = goalFromPreset(GOALS[i].id);
    const ranked = rankCandidates({
      goal, strings, program, symbols, region, limit: 5, vendors: vendorsOf(fields),
    });
    rankedByGoal.set(goal.id, { goal, ranked });
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

  /* ── 3.5 目的ごとに「これです」まで決めにいく ────────────
   *
   * ここが従来との分かれ目。候補を並べて終わりにせず、
   * クラス表の値と、逆アセンブルによる裏取りを突き合わせて 1 個に絞る。
   * 決着したものだけを confirmed に積む（付かなかったものは付かなかったと言う）。
   *
   * 逆アセンブルの回数は全体で予算を切る。16 個の目的が青天井に読みにいくと
   * 「開いた瞬間に終わっている」という前提が壊れるため。
   */
  const startBudget = o.pinpointBudget != null ? o.pinpointBudget : 72;
  const budget = { left: startBudget };
  const memo = o.analyze ? memoize(o.analyze) : null;
  const hasClasses = !!(fields && fields.classCount);
  if (memo || hasClasses) {
    for (let i = 0; i < GOALS.length; i++) {
      if (cancelled()) { report.notes.push('pin-cancelled'); break; }
      progress({ phase: 'pinpoint', done: i, all });
      const entry = rankedByGoal.get(GOALS[i].id);
      const goal = entry ? entry.goal : goalFromPreset(GOALS[i].id);
      const common = {
        goal, fields, program, symbols, strings, region,
        map: report.map,
        // 値のふるまい（名前のないアプリで唯一の手がかり）
        shapes: o.shapes || null,
        analyze: memo,
        scanAccess: o.scanAccess || null,
        budget,
        isCancelled: cancelled,
        limit: 8,
      };
      let pin = null;
      if (hasClasses) {
        try { pin = await pinpointField(common); } catch { pin = null; }
      }
      /*
       * 名前から決められなかった目的は、形から場所を決めにいく。
       * クラス表のないアプリでも「ここを書き換えれば変わる」までは出したい。
       */
      if ((!pin || !pin.top) && memo && entry && entry.ranked.candidates.length) {
        try {
          pin = await pinpointLocation(Object.assign({}, common, {
            ranked: entry.ranked.candidates,
          }));
        } catch { /* 出せなくても、ほかの目的は続ける */ }
      }
      if (!pin || !pin.top || pin.verdict === VERDICT.NONE) continue;
      /*
       * 目的に結びつく手がかりが 1 つも無いものは載せない。
       * 「バトルのクラスにある 4 バイトの整数」は、防御力を探している人にとっては
       * 答えではなくノイズで、しかも並んでいると答えに見えてしまう。
       */
      if (!(pin.top.fusion.identifying > 0)) continue;
      report.pinned.push(pin);
      const g = report.goals.find((x) => x.goal.id === goal.id);
      if (g) g.pinned = pin;
      await tick();
    }
    /* 確定 → 有力 → 割れている の順。確率の高いものを先に。 */
    report.pinned.sort((a, b) => (verdictRank(b.verdict) - verdictRank(a.verdict)) ||
      (b.top.fusion.probability - a.top.fusion.probability));
    report.confirmed = report.pinned.filter((p) => p.verdict === VERDICT.CONFIRMED);
    report.stats.pinpointUsed = startBudget - budget.left;
  }

  /* 3.6 いちばん確度の高い目的については、処理そのものも決めにいく。 */
  if (memo && report.pinned.length && budget.left > 0) {
    const best = report.pinned[0];
    const entry = rankedByGoal.get(best.goal.id);
    // 名前まで決まった値のときだけ。名前のない場所では、処理の裏取りに使えない。
    if (entry && entry.ranked.candidates.length && best.top.kind === 'field') {
      progress({ phase: 'pinpoint-fn', done: 0, all: 1 });
      try {
        const fn = await pinpointFunction({
          goal: best.goal, ranked: entry.ranked.candidates,
          program, symbols, fields, analyze: memo, budget,
          functionCount: symbols ? symbols.functionCount : 0,
          field: {
            offset: best.top.offset, className: best.top.className,
            plain: best.top.plain, name: best.top.field.name,
          },
          isCancelled: cancelled,
        });
        if (fn && fn.top) best.function = fn;
      } catch { /* 決められなくても、値の特定だけは残す */ }
    }
  }

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
        // 特定のときに読んだ関数は取ってある。同じものを 2 度読まない。
        model = await (memo || o.analyze)(t.addr, range ? range.end : null);
      } catch { model = null; }
      if (!model) continue;
      /*
       * 増減の連鎖だけでなく、素の読み書き（アクセサ）も採る。
       * アプリの関数の大半はこの形で、ここを外すと「何をしているか分かりません」
       * としか言えない関数が何万本も残る。
       */
      const updates = findValueUpdates(model)
        .filter((u) => u.kind !== 'compute-store');
      const compares = constantComparisons(model);
      /*
       * ここで「x0 + 0x20」を「BattleManager の hp」に置き換える。
       * この 1 手で、報告の意味が初心者にも通じるものに変わる。
       */
      const owner = fields ? fields.ownerOf(t.addr) : null;
      for (const u of updates) {
        u.field = fields
          ? fields.resolveAccess({
            base: u.location.base, disp: u.location.disp,
            indexAddr: u.location.indexAddr, self: u.location.self,
          }, owner ? owner.className : null)
          : null;
      }
      const f = model.facts || {};
      const selectors = (model.calls || []).map((c) => c.selector).filter(Boolean);
      const strings = f.strings || [];
      /*
       * ここまでで「どの値をどう加工しているか」は分かっている。あと 1 歩、
       * 「それはアプリの何の処理なのか」まで名前を付ける。この 1 行がないと、
       * 画面に残るのは `sub_1001A74E4` と `x0 + 0x20 を 1 増やす` だけになり、
       * 読む人はここから先へ進めない。
       */
      const role = inferRole({
        name: symbols ? symbols.nameAt(t.addr) : null,
        owner,
        updates,
        apis: f.apis || [],
        selectors,
        strings: strings.map((text) => ({ text })),
        callees: f.calledNames || [],
        callers: [],
        comparisons: compares.length,
        conditionals: f.conditionals || 0,
        calls: f.calls || 0,
        stores: f.stores || 0,
        verified: true,
      });

      report.deep.push({
        addr: t.addr,
        owner,
        name: symbols ? symbols.nameAt(t.addr) : null,
        why: t.why,
        goal: t.goal ? t.goal.id : null,
        goalLabel: t.goal ? t.goal.text : null,
        role,
        updates: updates.slice(0, 4),
        compares: compares.slice(0, 4),
        instructions: f.instructionCount || 0,
        selectors: selectors.slice(0, 4),
        strings: strings.slice(0, 3),
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

  /* 決着が付いた目的があるなら、それが最初の一手。ほかの案内より先に出す。 */
  const confirmed = (report.confirmed || []).filter((p) => p.top && p.top.kind === 'field');
  if (confirmed.length) {
    const p = confirmed[0];
    const write = (p.changeSites || []).find((s) => s.stores);
    steps.push({
      code: 'open-pinned',
      detail: {
        label: p.goal.text,
        className: p.top.className,
        field: p.top.plain,
        addr: write ? write.first : null,
      },
    });
  } else {
    // 割れている目的は、決め手が何かを言えるものだけ案内する
    const split = (report.pinned || []).find((x) => x.verdict === VERDICT.AMBIGUOUS &&
      x.top && x.top.kind === 'field');
    if (split) {
      steps.push({
        code: 'decide-ambiguous',
        detail: {
          label: split.goal.text,
          a: split.top.plain,
          b: split.runnerUp && split.runnerUp.kind === 'field' ? split.runnerUp.plain : null,
        },
      });
    }
  }

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

/*
 * 同じ関数を何度も逆アセンブルしない。
 * 目的が 16 個あると、同じアクセサに何度も行き当たる（`count` は所持金でも
 * アイテムでもレベルでも候補になる）。ここで 1 回に抑える。
 */
function memoize(analyze) {
  const cache = new Map();
  return (addr, end) => {
    const key = addr == null ? 'null' : addr.toString();
    if (cache.has(key)) return cache.get(key);
    const p = Promise.resolve()
      .then(() => analyze(addr, end))
      .catch(() => null);
    cache.set(key, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return p;
  };
}

/*
 * 特定 — 「選ぶだけで、それが 1 個に決まる」ための層。
 *
 * これまでの流れはこうだった。
 *
 *     目的を選ぶ → 候補が 40 個出る → 上から順に開いて自分で確かめる
 *
 * これでは「解析できる人」しか使えない。40 個の中から選べる人は、そもそも
 * このツールを必要としていない。だからここでは流れをひっくり返す。
 *
 *     目的を選ぶ → **これです** と 1 個出す → なぜそう言えるかを全部見せる
 *
 * 1 個に決めるには、候補を並べるだけでは足りない。決め手が要る。
 * 決め手は次の 3 つで、どれもバイナリから直接取れる。
 *
 *   1. クラス表に残っている **値の名前・型・位置**（_hp / 4 バイト整数 / +0x20）
 *   2. その名前と位置の対応を、**アクセサを逆アセンブルして確かめる**
 *      -[BattleManager hp] が本当に [x0, #0x20] を読んで返しているか
 *   3. その位置を **読んで・計算して・書き戻している** 場所が実在するか
 *
 * 1 だけなら「表にそう書いてある」に過ぎない。2 と 3 が付いて初めて
 * 「命令がそう動いている」と言える。ここまでやると、確率は 12% から 99.9% に跳ねる。
 * その計算は evidence.js、確かめる作業は verify.js が持っている。
 *
 * そして決着が付かなかったときは、**付かなかったと言う**。
 * 上位 2 つが拮抗しているなら「この 2 つのどちらかです」と出して、
 * 何を確かめれば決まるかまで書く。適当に 1 位を選んで断言することはしない。
 *
 * 日本語は作らない。返すのは構造と、掛け算の内訳だけ。
 */
import {
  matchField, typeFits, accessorKind, matchText, matchName, normalizeFieldName, fieldRole,
} from './goals.js';
import { evidence, exclusiveLR, rarityLR, EXCLUSIVE_MAX_STRINGS, fuse, decide, explain, starsOf, VERDICT } from './evidence.js';
import { verifyAccessor, verifyFunctionHandlesField, selfRegisters } from './verify.js';
import { findValueUpdates, constantComparisons } from './dataflow.js';
import { plainFieldName } from './fields.js';
import { vendorsOf, vendorOf, vendorConflicts } from './vendors.js';
import { evidenceFor as shapeEvidenceFor, byGoal as shapesByGoal } from './shapes.js';
import { describePurpose, changeAt } from './purpose.js';

/* 目的 → 地図の部品。クラスの担当が目的と合っているかを見るために使う。 */
const GOAL_TO_CATEGORY = {
  hp: ['battle', 'character'],
  attack: ['battle', 'character'],
  defense: ['battle', 'character'],
  damage: ['battle'],
  money: ['purchase', 'item'],
  gacha: ['gacha'],
  purchase: ['purchase'],
  login: ['login'],
  ads: ['ads'],
  save: ['save'],
  network: ['network'],
  score: ['ranking'],
  level: ['character'],
  stamina: ['character', 'battle'],
  item: ['item'],
  anticheat: ['anticheat'],
};

const MAX_CANDIDATES = 400;      // 証拠を組むところまで進める数
const VERIFY_ROUND = 4;          // 1 巡で逆アセンブルする候補の数
const MAX_ROUNDS = 3;            // 決着が付くまで、最大この回数まで粘る

/**
 * 目的から、値（フィールド）を 1 個に決める。
 *
 * @param {object} opts
 *   goal        目的（goals.js）
 *   fields      FieldIndex（クラスとフィールド）
 *   program     ProgramIndex
 *   symbols     SymbolIndex
 *   strings     [{addr, text}]
 *   map         buildAppMap の結果（クラスの担当。なくてもよい）
 *   analyze     async (addr, end) => model   逆アセンブル（なければ検証なしで返す）
 *   scanAccess  async (list) => Map          位置ごとの読み書き箇所（なくてもよい）
 *   isCancelled () => boolean
 *   onProgress  ({phase, done, all}) => void
 * @returns {object} 決着つきの結果
 */
export async function pinpointField(opts) {
  const o = opts || {};
  const goal = o.goal;
  const fields = o.fields;
  const progress = o.onProgress || (() => {});
  const cancelled = o.isCancelled || (() => false);

  const empty = {
    goal, kind: 'field', verdict: VERDICT.NONE, top: null, runnerUp: null,
    candidates: [], universe: 0, missing: ['no-class-table'], checked: 0, changeSites: [],
  };
  if (!goal || !fields || !fields.classCount) return empty;

  /* ── 1. クラスごとの前提を作る ──────────────────────────
     値そのものではなく「その値を持っているクラス」が目的に合っているか。
     これは値の名前とは独立した証拠なので、あとで別の系統として数えられる。 */

  progress({ phase: 'collect', done: 0, all: 1 });
  const categoryOf = new Map();
  if (o.map && o.map.classes) {
    for (const c of o.map.classes) categoryOf.set(c.name, c);
  }
  const wantCategories = GOAL_TO_CATEGORY[goal.id] || [];

  // その目的の文字列を参照しているクラス（実際の参照関係から）
  const classStringHits = classesReferencingGoalStrings(goal, o);

  /*
   * どのクラスが「組み込んだ SDK のもの」かを、このバイナリ自身から学ぶ。
   * ゲーム本体が C++ のアプリでは、名前が残っているのが広告 SDK だけになるので、
   * これをやらないと「所持金 ＝ 広告報酬の数」を自信満々で答えてしまう。
   */
  const vendors = vendorsOf(fields);

  /* ── 2. 候補を集める ───────────────────────────────────
     名前が当たった値だけでなく、「目的に合うクラスが持っている数値」も拾う。
     名前が消されている／英語でない場合でも取りこぼさないため。 */

  let universe = 0;
  const raw = [];
  for (const cls of fields.classes.values()) {
    const ctx = classContext(cls, goal, categoryOf, classStringHits, vendors);
    for (const iv of cls.ivars || []) {
      universe++;
      const nameHit = matchField(goal, iv.name);
      const propHit = iv.property ? matchField(goal, iv.property.name) : null;
      const fit = typeFits(goal, iv.type);
      if (fit === 'conflict' && !nameHit && !propHit) continue;
      // 名前も当たらず、クラスの担当も違うなら、証拠が 1 つもないので候補にしない
      if (!nameHit && !propHit && !ctx.categoryHit && !ctx.nameHit) continue;
      raw.push({ cls, iv, nameHit, fit, ctx });
    }
  }
  if (!raw.length) {
    return Object.assign({}, empty, { universe, missing: ['no-match'] });
  }

  /* ── 3. 証拠を組んで、いったん並べる（ここまで逆アセンブルなし）── */

  let candidates = raw.map((r) => buildFieldCandidate(r, goal));

  /*
   * 打ち込まれた名前と、そっくり同じ名前の値があったなら、話はそこで終わっている。
   *
   * これを別枠にしないと、名前がぴたり一致している値が、
   * 「クラスの担当が合っている・兄弟の値が多い・アクセサがある」を寄せ集めた
   * 別の値に負ける。実測では `allowConcurrentAssetResourceLoadingRequests` を
   * 探しているのに `_requestTimeout` を**確定と言い切って**いた。
   * 名前で探した人に、名前が違うものを返してはいけない。
   */
  let asked = candidates.filter((c) => c.askedByName);
  if (!asked.length) {
    /*
     * 丸ごと同じ名前は無いが、打ち込まれた語がそのままの並びで入っている
     * （「show time」→ `_adShowTime`）。うろ覚えで打つ人はこちらのほうが多い。
     * 語彙ごしの当てはまりより、はるかに具体的な手がかりなので別枠にする。
     */
    asked = candidates.filter((c) => c.askedBySequence);
  }
  const narrowed = asked.length > 0 && asked.length < candidates.length;
  if (asked.length) candidates = asked;

  // 事前オッズは「値の総数」から。2 万個あるなら 1/20000 から始める。
  for (const c of candidates) c.fusion = fuse(c.evidence, { candidates: narrowed ? asked.length : universe });
  candidates.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);
  let ranked = candidates.slice(0, MAX_CANDIDATES);
  let result = decide(ranked);

  /* ── 4. 決着が付くまで、上位を実際に逆アセンブルして確かめる ──
     ここがこのツールの新しいところ。候補を並べて終わりにしない。 */

  let checked = 0;
  if (o.analyze) {
    const verified = new Set();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (result.verdict === VERDICT.CONFIRMED) break;
      if (cancelled() || spent(o)) break;
      const targets = ranked.filter((c) => !verified.has(c.key)).slice(0, VERIFY_ROUND);
      if (!targets.length) break;

      for (let i = 0; i < targets.length; i++) {
        if (cancelled() || spent(o)) break;
        progress({ phase: 'verify', done: checked, all: checked + targets.length - i });
        const c = targets[i];
        verified.add(c.key);
        try {
          /*
           * アクセサを読むのは 2 命令ぶんなので全員に対してやるが、
           * クラスのメソッドを何本も読むのは重い。それは上位 2 つだけにする。
           * 3 位以下を深追いしても、決着には効かないので。
           */
          await verifyCandidate(c, goal, o, { deep: ranked.indexOf(c) < 2 });
        } catch { /* 1 個読めなくても、ほかは確かめる */ }
        checked++;
      }
      for (const c of ranked) c.fusion = fuse(c.evidence, { candidates: universe });
      ranked.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);
      result = decide(ranked);
    }
  }

  /* ── 5. 「どこを変えればいいか」まで出す ────────────────
     値が決まっただけでは足りない。触っている場所が分かって初めて次に進める。 */

  let changeSites = [];
  const top = result.top;
  if (top && o.scanAccess) {
    try {
      changeSites = await collectChangeSites(top, o);
    } catch { changeSites = []; }
  } else if (top) {
    changeSites = top.sites || [];
  }

  for (const c of ranked) {
    c.probability = c.fusion.probability;
    c.stars = starsOf(c.fusion.probability, c === top ? result.verdict : null);
    c.why = explain(c.fusion);
  }

  return {
    goal, kind: 'field',
    verdict: result.verdict,
    top: result.top || null,
    runnerUp: result.runnerUp || null,
    margin: result.margin,
    marginRatio: result.marginRatio,
    missing: result.missing,
    candidates: ranked.slice(0, o.limit || 12),
    universe,
    checked,
    changeSites,
  };
}

/* ── クラスの前提 ────────────────────────────────────────── */

function classContext(cls, goal, categoryOf, classStringHits, vendors) {
  const info = categoryOf.get(cls.name) || null;
  const wanted = GOAL_TO_CATEGORY[goal.id] || [];
  const nameHit = matchText(goal, cls.name);
  // 同じクラスに、その目的の仲間の値がいくつあるか（hp があるクラスには attack もある）
  let siblings = 0;
  for (const iv of cls.ivars || []) {
    if (matchField(goal, iv.name)) siblings++;
  }
  // その目的の言葉を含むメソッドが、このクラスにあるか
  let selectors = 0;
  for (const m of (cls.methods || []).slice(0, 120)) {
    if (m.sel && matchName(goal, m.sel)) selectors++;
  }
  const vendor = vendorOf(cls.name, vendors);
  return {
    info,
    category: info ? info.category : null,
    categoryHit: !!(info && wanted.includes(info.category)),
    nameHit,
    siblings,
    selectors,
    strings: classStringHits.get(cls.name) || 0,
    vendor,
    // 広告 SDK の値を「ゲームの所持金」として答えないための印
    vendorConflict: vendorConflicts(goal.id, vendor),
  };
}

/** その目的の文字列を、実際に参照しているクラス。参照関係から数える（推測しない）。 */
function classesReferencingGoalStrings(goal, o) {
  const out = new Map();
  const { program, fields, strings } = o;
  if (!program || !fields || !strings || !strings.length) return out;

  const matched = [];
  for (const s of strings) {
    const m = matchText(goal, s.text);
    if (m && m.score >= 0.5) matched.push({ s, m });
  }
  matched.sort((a, b) => b.m.score - a.m.score);

  for (const { s } of matched.slice(0, 120)) {
    const span = BigInt(Math.max(1, Math.min(s.text.length, 256)));
    for (const u of program.functionsReferencing(s.addr, span, 20)) {
      if (u.addr == null) continue;
      const owner = fields.ownerOf(u.addr);
      if (!owner) continue;
      out.set(owner.className, (out.get(owner.className) || 0) + 1);
    }
  }
  return out;
}

/* ── 候補 1 つぶんの証拠 ─────────────────────────────────── */

function buildFieldCandidate({ cls, iv, nameHit, fit, ctx }, goal) {
  const ev = [];

  /* 名前 — いちばん直接的だが、これだけでは確定にしない（evidence.js が上限を掛ける） */
  if (nameHit) {
    /*
     * 打ち込まれた名前と、変数の名前が、そっくりそのまま同じ。
     * 探しものの名前を知っている人が名前で探しているのだから、
     * これ以上の手がかりは無い。語彙ごしの一致とは別格に扱う。
     */
    if (nameHit.literal && nameHit.exact) {
      ev.push(evidence('field-name-asked', 1, { name: iv.name, term: nameHit.term }));
    } else if (nameHit.literal && nameHit.sequence) {
      ev.push(evidence('field-name-contains', 1, { name: iv.name, term: nameHit.term }));
    } else if (nameHit.exact) ev.push(evidence('field-name-exact', nameHit.score, { name: iv.name, term: nameHit.term }));
    else if (nameHit.score >= 0.6) ev.push(evidence('field-name-strong', nameHit.score, { name: iv.name, term: nameHit.term }));
    else ev.push(evidence('field-name-weak', Math.max(0.3, nameHit.score), { name: iv.name, term: nameHit.term }));
  }
  const askedByName = !!(nameHit && nameHit.literal && nameHit.exact);
  const askedBySequence = !!(nameHit && nameHit.literal && nameHit.sequence);

  /*
   * プロパティとして宣言された名前。ivar 名とは別の場所に書いてあるので、
   * 名前が 2 通り取れることになる（`_a1` のように ivar 名が潰されていても拾える）。
   */
  const prop = iv.property || null;
  if (prop) {
    const pm = matchField(goal, prop.name);
    if (pm) {
      ev.push(evidence('property-name', pm.score, {
        name: prop.name, term: pm.term, ivar: iv.name,
      }));
    }
    const pfit = typeFits(goal, prop.type || iv.declaredType);
    if (pfit === 'fit') ev.push(evidence('type-declared', 1, { type: prop.type }));
    else if (pfit === 'conflict' && !nameHit) {
      ev.push(evidence('type-conflict', 1, { type: prop.type }));
    }
  }

  /* 宣言された型 */
  if (fit === 'fit') ev.push(evidence('type-numeric', 1, { type: iv.type }));
  else if (fit === 'conflict') ev.push(evidence('type-conflict', 1, { type: iv.type }));
  if (iv.size && iv.size <= 8) ev.push(evidence('size-fits', 0.6, { size: iv.size }));

  /* まわり — 値の名前とは独立した手がかり */
  if (ctx.categoryHit) {
    ev.push(evidence('class-category', 1, { className: cls.name, category: ctx.category }));
  }
  if (ctx.nameHit) {
    ev.push(evidence('class-name', ctx.nameHit.score, { className: cls.name, term: ctx.nameHit.term }));
  }
  if (ctx.siblings >= 2) {
    ev.push(evidence('sibling-fields', Math.min(1, ctx.siblings / 4), { n: ctx.siblings, className: cls.name }));
  }
  if (ctx.selectors) {
    ev.push(evidence('selector-match', Math.min(1, ctx.selectors / 3), { n: ctx.selectors, className: cls.name }));
  }
  if (ctx.strings) {
    ev.push(evidence('class-string', Math.min(1, ctx.strings / 3), { n: ctx.strings, className: cls.name }));
  }
  /*
   * 組み込んだ SDK のクラスなら、ここで打ち消す。
   * 名前がどれだけ完璧に一致していても、それはゲームの値ではない。
   */
  if (ctx.vendorConflict && !askedByName) {
    const sure = ctx.vendor.confidence === 'high';
    ev.push(evidence(sure ? 'third-party-class' : 'library-prefix-class', 1, {
      className: cls.name, vendor: ctx.vendor.vendor, kind: ctx.vendor.kind,
      via: ctx.vendor.via, classes: ctx.vendor.classes || null,
    }));
  }

  /* アクセサが実在するか（名前の話。中身は verifyCandidate で確かめる） */
  const accessors = findAccessors(cls, iv);
  if (accessors.getter || accessors.setter) {
    ev.push(evidence('accessor-name', accessors.getter && accessors.setter ? 1 : 0.7, {
      getter: accessors.getter ? accessors.getter.sel : null,
      setter: accessors.setter ? accessors.setter.sel : null,
      className: cls.name,
    }));
  }

  return {
    key: cls.name + '#' + iv.offset + '#' + iv.name,
    kind: 'field',
    className: cls.name,
    field: iv,
    plain: plainFieldName(iv.name),
    normalized: normalizeFieldName(iv.name),
    role: fieldRole(iv.name),
    offset: iv.offset,
    size: iv.size,
    type: iv.type,
    instanceSize: cls.instanceSize,
    superName: cls.superName || null,
    accessors,
    context: ctx,
    // 打ち込まれた名前そのものだったか（pinpointField が別枠にするための印）
    askedByName,
    askedBySequence,
    evidence: ev,
    verifications: [],
    sites: [],
    verified: false,
    fusion: null,
  };
}

/**
 * そのクラスの中から、その値の getter / setter を名前で探す。
 *
 * プロパティの表があるなら、そこに書かれているアクセサ名を優先する
 * （`@property(getter=isReady)` のような別名まで正しく拾えるため）。
 * なければ ivar 名から素直に組み立てる。
 */
function findAccessors(cls, iv) {
  const out = { getter: null, setter: null };
  const prop = iv.property || null;
  const wantGet = prop ? prop.getter : null;
  const wantSet = prop ? prop.setter : null;

  for (const m of (cls.methods || [])) {
    if (!m.sel || m.addr == null) continue;
    if (wantGet && m.sel === wantGet && !out.getter) { out.getter = m; continue; }
    if (wantSet && m.sel === wantSet && !out.setter) { out.setter = m; continue; }
    const kind = accessorKind(m.sel, iv.name) ||
      (prop ? accessorKind(m.sel, prop.name) : null);
    if (kind === 'getter' && !out.getter) out.getter = m;
    else if (kind === 'setter' && !out.setter) out.setter = m;
    if (out.getter && out.setter) break;
  }
  return out;
}

/* ── 検証（ここだけ逆アセンブルが走る） ──────────────────── */

/**
 * 候補 1 つを、実際に命令まで読んで確かめる。
 *
 *   1. getter / setter があるなら、それを読んで位置が一致するか見る  ← 決め手
 *   2. なければ、そのクラスのメソッドを何本か読んで、その位置を触っているか見る
 *
 * 確かめられたぶんだけ証拠を足す。だめだったら何も足さない（減点もしない。
 * 「読めなかった」ことは「違う」ことの証拠にはならないため）。
 */
/*
 * 逆アセンブルの回数には上限を置く。目的は 16 個あるので、上限がないと
 * 「開いた瞬間に終わっている」が守れなくなる。使い切ったら検証はやめて、
 * 決着していないことを正直に返す（無理に断定しない）。
 */
function spent(o) {
  const b = o.budget;
  if (!b) return false;
  return !(b.left > 0);
}
function charge(o, n) {
  if (o.budget && o.budget.left != null) o.budget.left -= (n || 1);
}

async function verifyCandidate(c, goal, o, how) {
  const analyze = o.analyze;
  const program = o.program;
  if (!analyze) return;
  const deep = !how || how.deep !== false;
  const offset = BigInt(c.offset);

  const endOf = (addr) => {
    const r = program ? program.functionRange(addr) : null;
    return r ? r.end : null;
  };

  /* 1. アクセサ */
  for (const [which, m] of [['getter', c.accessors.getter], ['setter', c.accessors.setter]]) {
    if (!m || m.addr == null || spent(o)) continue;
    charge(o);
    const model = await analyze(m.addr, endOf(m.addr));
    if (!model) continue;
    const v = verifyAccessor(model, { offset, size: c.size });
    c.verifications.push({ what: which, sel: m.sel, addr: m.addr, result: v });
    if (which === 'getter' && v.getter) {
      c.verified = true;
      c.evidence.push(evidence('getter-verified', v.exclusive ? 1 : 0.75, {
        sel: m.sel, addr: m.addr, className: c.className,
        offset: c.offset, size: v.size, exclusive: v.exclusive,
      }));
      // 実測した大きさが、表に書いてある大きさと合っているか
      if (v.size && c.size && v.size === c.size) {
        c.evidence.push(evidence('size-fits', 1, { size: v.size, measured: true }));
      }
    }
    if (which === 'setter' && v.setter) {
      c.verified = true;
      c.evidence.push(evidence('setter-verified', v.fromArgument ? 1 : 0.7, {
        sel: m.sel, addr: m.addr, className: c.className,
        offset: c.offset, fromArgument: !!v.fromArgument,
      }));
    }
  }

  /*
   * 2. そのクラス自身のメソッドが、その位置を触っているか。
   *    アクセサがない（直接メンバ変数を使っている）クラスではこちらが決め手になる。
   */
  if (deep && (!c.verified || !c.rmwFound)) {
    const methods = (c.context.info && c.context.info.info ? c.context.info.info.methods : null) ||
      methodsOfClass(o.fields, c.className);
    const pick = pickMethodsToRead(methods, goal, 3);
    for (const m of pick) {
      if (m.addr == null || spent(o)) continue;
      charge(o);
      const model = await analyze(m.addr, endOf(m.addr));
      if (!model) continue;
      const use = verifyFunctionHandlesField(model, offset);
      if (!use.touches) continue;
      c.verified = true;
      c.sites.push({
        addr: m.addr, sel: m.sel, className: c.className,
        loads: use.use.loads, stores: use.use.stores,
        rmw: use.use.rmw.slice(0, 2), compares: use.use.compares.slice(0, 3),
      });
      c.evidence.push(evidence('access-verified', 1, {
        sel: m.sel, addr: m.addr, className: c.className,
        loads: use.use.loads, stores: use.use.stores,
      }));
      if (use.rmw) {
        c.rmwFound = true;
        c.evidence.push(evidence('rmw-verified', 1, {
          sel: m.sel, addr: m.addr,
          address: use.use.rmw[0] ? use.use.rmw[0].store.address : null,
        }));
      }
      if (use.guard) {
        c.evidence.push(evidence('guard-verified', 0.8, {
          sel: m.sel, addr: m.addr,
          value: use.use.compares[0] ? use.use.compares[0].value : null,
        }));
      }
      if (use.writes) {
        c.evidence.push(evidence('written-in-class', 1, { sel: m.sel, n: use.use.stores }));
      }
    }
  }
}

function methodsOfClass(fields, className) {
  const info = fields ? fields.classInfo(className) : null;
  return info ? (info.methods || []) : [];
}

/**
 * どのメソッドを読むか。全部読むのは重すぎるので、当たりそうなものから。
 *   - 目的の言葉を含むもの（applyDamage: / addCoin:）
 *   - 値を変えそうな動詞（set / add / update / reset / consume / gain）
 *   - それ以外は最初に出てくるもの
 */
function pickMethodsToRead(methods, goal, n) {
  const scored = [];
  for (const m of methods || []) {
    if (m.addr == null || !m.sel) continue;
    let score = 0;
    if (matchName(goal, m.sel)) score += 3;
    if (/^(set|add|sub|inc|dec|update|apply|consume|gain|use|reset|init|recover|heal|damage|take|spend|earn)/i.test(m.sel)) score += 2;
    if (/^(init|dealloc|description|copyWith|encodeWith|isEqual|hash)$/i.test(m.sel)) score -= 3;
    scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((x) => x.m);
}

/* ── 「どこを変えればいいか」 ─────────────────────────────
   決まった値について、コード全体からその位置を触っている命令を集め、
   関数ごとにまとめる。同じクラスのメソッドの中にあるものが本命。 */

async function collectChangeSites(top, o) {
  const res = await o.scanAccess([{ offset: top.offset, size: top.size || 0 }]);
  const list = (res && (res.get ? res.get(String(top.offset)) : res[String(top.offset)])) || [];
  return groupSites(list, o.program, o.fields, top.className);
}

/**
 * 読み書きしている命令を、関数ごとにまとめる。
 * 同じクラスのメソッドの中にあるものが本命なので、それを先頭に持ってくる。
 */
export function groupSites(list, program, fields, className) {
  const byFunc = new Map();

  for (const s of list || []) {
    const fn = program ? program.functionStartOf(s.addr) : null;
    const key = fn != null ? fn.toString() : 's' + s.addr.toString();
    if (!byFunc.has(key)) {
      const owner = fn != null && fields ? fields.ownerOf(fn) : null;
      byFunc.set(key, {
        addr: fn, owner, first: s.addr, loads: 0, stores: 0,
        sameClass: !!(owner && className && owner.className === className),
        subclass: !!(owner && className && isRelated(fields, owner.className, className)),
      });
    }
    const e = byFunc.get(key);
    if (s.kind === 'load') e.loads++; else e.stores++;
  }

  const out = Array.from(byFunc.values());
  // 同じクラスの中で、書き込んでいるものが最優先。そこが「変える場所」。
  out.sort((a, b) => (b.sameClass - a.sameClass) || (b.subclass - a.subclass) ||
    (b.stores - a.stores) || (b.loads - a.loads));
  return out.slice(0, 40);
}

/** 親子関係にあるクラスか（親の値を子のメソッドが触るのは普通のこと）。 */
function isRelated(fields, a, b) {
  if (!fields || !a || !b) return false;
  let cur = fields.classInfo(a);
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.name === b) return true;
    cur = cur.superName ? fields.classInfo(cur.superName) : null;
  }
  cur = fields.classInfo(b);
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.name === a) return true;
    cur = cur.superName ? fields.classInfo(cur.superName) : null;
  }
  return false;
}

/* ────────────────────────────────────────────────────────────
   クラス表がないバイナリで、名前のない「場所」を特定する
   ────────────────────────────────────────────────────────────

   Swift だけで書かれたアプリ、C++ のゲーム、名前を潰したアプリには
   Objective-C のクラス表がない。名前が 1 つも読めないので、上のやり方は使えない。

   しかし、名前が読めなくても **形** は読める。ゲームの数値はどれも

       読む → 計算する → 同じ場所へ書き戻す

   という形をしていて、しかも「ダメージ %d」のような文言を参照している関数の
   中にある。この 2 つが重なる場所は、そう多くない。だから

       目的の文言を参照している関数を逆アセンブルし、
       その中で読んで計算して書き戻している場所を集め、
       同じ場所を触っている命令がコード全体にいくつあるかを数える

   ところまでやれば、「+0x20 にある 4 バイトの値」までは特定できる。
   名前が付けられない以上「確定」とは呼ばないが、
   「ここを書き換えれば変わります」と言うには十分な材料になる。 */

/**
 * @param {object} opts pinpointField と同じ。加えて
 *   ranked  rank.js の候補（この中の関数を読みにいく）
 */
export async function pinpointLocation(opts) {
  const o = opts || {};
  const goal = o.goal;
  const ranked = o.ranked || [];
  const program = o.program;
  const progress = o.onProgress || (() => {});
  const cancelled = o.isCancelled || (() => false);

  const empty = {
    goal, kind: 'location', verdict: VERDICT.NONE, top: null, runnerUp: null,
    candidates: [], universe: 0, missing: ['no-candidate'], checked: 0, changeSites: [],
  };
  // ふるまいの索引があるなら、目的の文言を参照する関数が 1 つも無くても進める
  const haveShapes = !!(o.shapes && o.shapes.size);
  if (!goal || (!haveShapes && (!ranked.length || !o.analyze))) return empty;

  /* 1. 目的に関係する関数を読んで、触っている場所を集める */
  const byKey = new Map();
  let checked = 0;
  for (const cand of (o.analyze ? ranked.slice(0, 8) : [])) {
    if (cancelled() || spent(o)) break;
    progress({ phase: 'verify-loc', done: checked, all: Math.min(8, ranked.length) });
    charge(o);
    const range = program ? program.functionRange(cand.addr) : null;
    let model = null;
    try { model = await o.analyze(cand.addr, range ? range.end : null); } catch { model = null; }
    if (!model) continue;
    checked++;

    const goalStrings = (cand.strings || []).length;
    const touched = [];
    for (const u of findValueUpdates(model)) {
      const loc = u.location;
      // スタックの一時置き場は「アプリが持っている値」ではないので採らない
      if (loc.stack || loc.key == null) continue;
      const key = loc.base + '@' + loc.disp.toString();
      if (!byKey.has(key)) {
        byKey.set(key, {
          key, kind: 'location',
          base: loc.base, offset: loc.disp, size: loc.size,
          functions: [], updates: [], compares: [],
          goalStringRefs: 0, evidence: [], verifications: [],
          sites: [], siteCount: 0, fusion: null,
        });
      }
      const e = byKey.get(key);
      touched.push(e);
      if (!e.functions.some((f) => f.addr === cand.addr)) {
        e.functions.push({ addr: cand.addr, name: cand.name || null, strings: goalStrings });
        if (goalStrings) e.goalStringRefs++;
      }
      if (u.kind === 'read-modify-write' && e.updates.length < 4) e.updates.push(u);
    }
    // どの場所と比べているかまでは命令からは決められないので、
    // 同じ関数の中で見つかった場所にだけ、しきい値の判定を添える。
    if (touched.length) {
      const cmps = constantComparisons(model).slice(0, 4);
      for (const e of new Set(touched)) {
        for (const cmp of cmps) if (e.compares.length < 4) e.compares.push(cmp);
      }
    }
  }
  /*
   * 2'. ふるまいからも候補を出す。
   *
   * 上の 1 は「目的の文言を参照している関数」から降りてくるやり方なので、
   * 文言が 1 つも残っていないアプリでは何も出せない（The Battle Cats には
   * 「attack」も「攻撃」もバイナリ中に無い）。そこで、コード全体の増減の形から
   * 直接候補を立てる。名前も文言も要らない、この 1 本だけが通る道になる。
   */
  if (o.shapes && o.shapes.size) {
    for (const sh of shapesByGoal(o.shapes, goal.id, 8)) {
      const key = 'shape@' + sh.offset;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key, kind: 'location', fromShape: true,
        base: null, offset: BigInt(sh.offset), size: sh.size || 4,
        functions: [], updates: [], compares: [],
        goalStringRefs: 0, evidence: [], verifications: [],
        sites: (sh.sites || []).map((s) => ({ first: s.addr, addr: null, loads: 0, stores: 1 })),
        // 走査で「ここで変わった」と見えた場所。裏取りはこの住所から始める。
        shapeSites: (sh.sites || []).map((s) => s.addr),
        siteCount: sh.usedAsAmount || (sh.decreases + sh.increases),
        fusion: null, shape: sh, proof: [],
      });
    }
  }

  if (!byKey.size) return Object.assign({}, empty, { checked, missing: ['no-value-change'] });

  /* 2. コード全体で、同じ場所を触っている命令がいくつあるかを数える */
  let list = Array.from(byKey.values());
  if (o.scanAccess) {
    try {
      const groups = await o.scanAccess(list.slice(0, 8).map((e) => ({
        offset: e.offset, size: e.size || 0,
      })));
      for (const e of list) {
        const sites = (groups && (groups.get ? groups.get(e.offset.toString())
          : groups[e.offset.toString()])) || [];
        e.siteCount = sites.length;
        e.sites = groupSites(sites, program, o.fields, null);
      }
    } catch { /* 数えられなくても、形の証拠だけで並べる */ }
  }

  /*
   * 2''. 形から立てた候補を、命令まで降りて裏取りする。
   *
   * ここまでの候補は「セクションを 1 回舐めた統計」でしかない。統計は
   * 「+0x30 は 17 か所で減っている」とは言うが、**その 1 か所を開いて見せる**
   * ことはできない。読む人が確かめられないものを答えとは呼べない。
   *
   * そこで上位だけ、その場所を書き換えている関数を実際に逆アセンブルして、
   * 「0x1002f4aa0 の 5 命令がそれだ」というところまで持っていく。
   * 確かめられなかった候補は、確かめられなかったぶん点を下げる。
   */
  await verifyShapes(list, o, progress, cancelled);

  /*
   * 2'''. 同じ場所を指している候補を 1 つにまとめる。
   *
   * 候補は 2 つの入口から立つ（目的の文言を参照する関数の中で見つけた場所と、
   * コード全体のふるまいから立てた場所）。同じ +0x30 が両方から出てくると、
   * 一覧に +0x30 が 2 行並び、しかも **お互いを 2 位として競わせてしまう**。
   * 2 位との差で決着を測っているので、これは「自分自身に負けて絞りきれない」
   * という壊れ方になる。同じ場所は同じ 1 つの主張なので、証拠は足し合わせる。
   *
   * クラス表の無いバイナリでは、場所の身元はずらし幅そのもの
   * （ベースレジスタ名 x8 / x19 は、その関数の中でしか意味を持たない）。
   */
  list = mergeByOffset(list);

  /* 3. 証拠を組む */
  for (const e of list) {
    if (e.updates.length) {
      const last = e.updates[0].steps.length ? e.updates[0].steps[e.updates[0].steps.length - 1] : null;
      e.evidence.push(evidence('loc-rmw', 1, {
        n: e.updates.length,
        address: e.updates[0].store.address,
        op: last ? last.op : null,
      }));
      if (e.updates.some((u) => u.steps && u.steps.length)) {
        e.evidence.push(evidence('loc-arith', 1, { n: e.updates.length }));
      }
    }
    if (e.compares.length) {
      e.evidence.push(evidence('loc-guard', Math.min(1, e.compares.length / 2), {
        value: e.compares[0].value,
      }));
    }
    if (e.goalStringRefs) {
      e.evidence.push(evidence('loc-in-goal-fn', Math.min(1, e.goalStringRefs / 2), {
        n: e.goalStringRefs,
        name: e.functions[0] ? e.functions[0].name : null,
        addr: e.functions[0] ? e.functions[0].addr : null,
      }));
    }
    if (e.functions.length >= 2) {
      e.evidence.push(evidence('loc-shared', Math.min(1, e.functions.length / 3), { n: e.functions.length }));
    }
    if (e.size === 4 || e.size === 8) e.evidence.push(evidence('loc-size', 0.8, { size: e.size }));
    if (e.base) e.evidence.push(evidence('loc-not-stack', 1, { base: e.base }));

    /*
     * コード全体でのふるまい。名前が 1 つも残っていないアプリでは、
     * これが「その値がその目的のものだ」と言える唯一の手がかりになる。
     */
    if (o.shapes) {
      const sh = shapeEvidenceFor(o.shapes, Number(e.offset), goal.id);
      if (sh) {
        e.shape = sh.shape;
        /*
         * そのふるまいが、どれだけ珍しいか。
         *
         * 走査で見えた位置は 342 個あって、そのうち体力の形（減って・増えて・
         * 0 で止まって・減らす量がよそから来る）に当てはまるのは 4 個しかない。
         * ここを固定の ×7 で数えていたので、いくら形が合っていても
         * 「文言を参照している関数の中にあった」に負けていた。
         * 珍しさは測れるのだから、測った値を使う。
         */
        for (const c of sh.codes) {
          const lr = SHAPE_CODES.has(c.code)
            ? rarityLR(o.shapes.size, shapeMatchCount(o.shapes, goal.id))
            : null;
          e.evidence.push(evidence(c.code, c.strength, c.detail, lr));
        }
      }
    }

    /*
     * 命令まで降りて確かめられたこと。ここだけが「開いて見せられる」証拠になる。
     */
    if (e.fromShape) {
      const proof = e.proof || [];
      const drains = proof.filter((p) => p.change &&
        (p.change.work === 'drain' || p.change.work === 'feed'));
      const changes = proof.filter((p) => p.change);
      if (drains.length) {
        e.evidence.push(evidence('loc-drain-verified', Math.min(1, drains.length / 2), {
          n: drains.length, address: drains[0].change.address,
          fn: drains[0].fn, from: drains[0].change.amount || null,
          offset: e.offset,
        }));
      } else if (changes.length) {
        e.evidence.push(evidence('loc-rmw', Math.min(1, changes.length / 2), {
          n: changes.length, address: changes[0].change.address,
          op: (changes[0].change.ops || [])[0] || null,
        }));
      }
      const clamped = changes.filter((p) => p.change.clamped);
      if (clamped.length) {
        e.evidence.push(evidence('loc-clamp-verified', Math.min(1, clamped.length / 2), {
          n: clamped.length, address: clamped[0].change.address,
        }));
      }
      /*
       * 上限がもう 1 つの値にある（＝「今の値／上限」の組）。
       * 体力・スタミナ・ゲージだけが持つ形で、所持金やスコアは持たない。
       */
      const capped = changes.find((p) => p.change.cappedBy);
      if (capped) {
        e.evidence.push(evidence('loc-capped-by-field', 1, {
          offset: e.offset, cap: capped.change.cappedBy.disp,
          address: capped.change.address, fn: capped.fn,
        }));
      }
      /*
       * どの裏取りでも「1 ずつしか動いていない」なら、それは数える物であって
       * 体力や所持金ではない（残り回数・添字・フレーム数）。
       * これを入れるまで、1 ずつ減って 0 で止まるカウンタが所持金の 1 位だった。
       */
      const moves = changes.filter((p) => p.change.work !== 'set' && p.change.work !== 'read');
      const byOne = moves.filter((p) => p.change.amount &&
        p.change.amount.kind === 'imm' &&
        (p.change.amount.value === 1 || p.change.amount.value === 1n));
      /*
       * 「よそから来た量」を 1 度も見なかったか。
       *
       * 体力なら、どこかに必ず「別のオブジェクトの値ぶん引く」場所がある。
       * 開いて確かめた場所がぜんぶ ±1 で、外から来た量が 1 つも無いなら、
       * それは数える物のほう。全部が ±1 のときだけを見ていると、量の取れなかった
       * 1 件が混ざるだけで、カウンタが体力の 1 位のまま通ってしまう。
       */
      const fromOutside = moves.some((p) => p.change.amount &&
        (p.change.amount.kind === 'field' || p.change.amount.kind === 'call' ||
         p.change.amount.kind === 'arg'));
      if (moves.length >= 2 && byOne.length * 2 >= moves.length && !fromOutside) {
        e.evidence.push(evidence('loc-counter-verified', 1,
          { n: moves.length, byOne: byOne.length }));
      }
      if (e.verifyTried && !changes.length) {
        // 開いてみたが、その場所を書き換えている命令が 1 つも見当たらなかった
        e.evidence.push(evidence('loc-unverified', 1, { tried: e.verifyTried }));
      }
    }
  }

  /*
   * ここでの選択肢は「目的に関係する処理の中で見つかった場所」そのもの。
   * すでに目的で絞ったあとなので、値の総数から始める必要はない。
   * ただし「この中に無い」ぶんの重みは残しておく。
   */
  for (const e of list) e.fusion = fuse(e.evidence, { candidates: list.length, absent: 12 });
  list.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);

  /*
   * 名前が読めない以上、「確定」とは呼ばない。
   * 位置と形は確かめられても、それが HP であることの裏付けにはならないため。
   */
  const result = decide(list, { maxVerdict: VERDICT.LIKELY });
  for (const e of list) {
    e.probability = e.fusion.probability;
    e.stars = starsOf(e.fusion.probability, null);
    e.why = explain(e.fusion);
  }

  return {
    goal, kind: 'location',
    verdict: result.verdict,
    top: result.top || null,
    runnerUp: result.runnerUp || null,
    margin: result.margin,
    marginRatio: result.marginRatio,
    missing: result.missing,
    candidates: list.slice(0, o.limit || 10),
    universe: list.length,
    checked,
    changeSites: result.top ? (result.top.sites || []) : [],
  };
}

/* ────────────────────────────────────────────────────────────
   処理（関数）を 1 個に決める
   ────────────────────────────────────────────────────────────

   「課金の処理はどこ？」のように、答えが値ではなく処理そのものである目的がある。
   こちらも同じやり方で決める。違うのは決め手で、値のときはアクセサの中身、
   処理のときは「その処理が本当にその値を書き換えているか」になる。 */

/**
 * @param {object} opts pinpointField と同じ。加えて
 *   ranked  rank.js の候補（あれば再利用する）
 *   field   決まった値（あれば、それを触っているかで決め手にする）
 */
export async function pinpointFunction(opts) {
  const o = opts || {};
  const goal = o.goal;
  const ranked = o.ranked || [];
  const progress = o.onProgress || (() => {});
  const cancelled = o.isCancelled || (() => false);

  if (!goal || !ranked.length) {
    return { goal, kind: 'function', verdict: VERDICT.NONE, top: null, candidates: [], checked: 0 };
  }

  // 事前オッズは「関数の総数」から。1 万個あるなら 1/10000 から始める。
  const universe = Math.max(50, o.functionCount || (o.symbols ? o.symbols.functionCount : 0) || 2000);

  const candidates = ranked.slice(0, 40).map((c) => buildFunctionCandidate(c, goal, o));
  for (const c of candidates) c.fusion = fuse(c.evidence, { candidates: universe });
  candidates.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);
  let result = decide(candidates);

  let checked = 0;
  if (o.analyze) {
    const seen = new Set();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (result.verdict === VERDICT.CONFIRMED) break;
      if (cancelled() || spent(o)) break;
      const targets = candidates.filter((c) => !seen.has(c.key)).slice(0, VERIFY_ROUND);
      if (!targets.length) break;
      for (const c of targets) {
        if (cancelled() || spent(o)) break;
        seen.add(c.key);
        progress({ phase: 'verify-fn', done: checked, all: checked + targets.length });
        charge(o);
        try { await verifyFunctionCandidate(c, goal, o); } catch { /* 読めなくても続ける */ }
        checked++;
      }
      for (const c of candidates) c.fusion = fuse(c.evidence, { candidates: universe });
      candidates.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);
      result = decide(candidates);
    }
  }

  for (const c of candidates) {
    c.probability = c.fusion.probability;
    c.stars = starsOf(c.fusion.probability, c === result.top ? result.verdict : null);
    c.why = explain(c.fusion);
  }

  /*
   * 「絞りきれていません」には 2 通りある。
   *   決め手が無くて並んでいる  … まだ何も分かっていない
   *   どれも命令で確かめられた  … その処理が本当に複数ある
   *
   * 攻撃力の計算が sub_100036588（アップ・コンボ）と sub_10003950C（ダウン・無効）に
   * 分かれているのは、絞り込みの失敗ではなく、そういう作りだという答え。
   * 数えておいて、画面で言い分けられるようにする。
   */
  const tiedVerified = candidates.filter(
    (c) => c.fusion && c.fusion.verified > 0 && c.fusion.probability >= CONFIRM_P).length;

  return {
    goal, kind: 'function',
    verdict: result.verdict,
    top: result.top || null,
    runnerUp: result.runnerUp || null,
    margin: result.margin,
    marginRatio: result.marginRatio,
    missing: result.missing,
    tiedVerified,
    candidates: candidates.slice(0, o.limit || 12),
    universe, checked,
  };
}

/* ────────────────────────────────────────────────────────────
   形から立てた候補を、逆アセンブルで裏取りする
   ──────────────────────────────────────────────────────────── */

/* 裏取りに開く関数の数と、開く候補の数。ここを増やすと確実に遅くなる。 */
const VERIFY_CANDIDATES = 4;
const VERIFY_FUNCTIONS = 3;

/**
 * 候補の中の「形から出たもの」について、その位置を書き換えている関数を実際に開き、
 * 何をしているのかを命令から取り出して e.proof に積む。
 */
async function verifyShapes(list, o, progress, cancelled) {
  if (!o.analyze) return;
  const targets = list.filter((e) => e.fromShape && (e.shapeSites || []).length)
    .slice(0, VERIFY_CANDIDATES);
  if (!targets.length) return;
  const program = o.program || null;
  let done = 0;
  for (const e of targets) {
    e.proof = [];
    e.verifyTried = 0;
    const seen = new Set();
    for (const site of e.shapeSites) {
      if (cancelled() || spent(o)) return;
      if (e.proof.length >= VERIFY_FUNCTIONS) break;
      const range = program ? program.functionRange(site) : null;
      const start = range ? range.start : null;
      if (start == null || seen.has(start.toString())) continue;
      seen.add(start.toString());
      progress({ phase: 'verify-shape', done: done++, all: targets.length * VERIFY_FUNCTIONS });
      charge(o);
      e.verifyTried++;
      let model = null;
      try { model = await o.analyze(start, range.end != null ? range.end : null); }
      catch { model = null; }
      if (!model) continue;
      const purpose = describePurpose({
        model, addr: start, fields: o.fields, textAt: o.textAt || null,
      });
      if (!purpose) continue;
      const change = changeAt(purpose, e.offset);
      /*
       * その場所を触っていなければ、証拠にはしない。
       * 走査の側の取り違え（分岐をまたいだ追跡）はここで落ちる。
       */
      if (!change) continue;
      e.proof.push({ fn: start, change, purpose, site });
      if (!e.functions.some((f) => f.addr === start)) {
        e.functions.push({ addr: start, name: null, strings: 0 });
      }
    }
    /*
     * 大きさは、実際に読み書きしている命令に合わせる。
     *
     * 見出しに「8 バイト」と出しながら、そのすぐ下の裏取りが
     * 「4 バイトを減らす」と言っている、という食い違いがここで消える。
     * 走査や別の候補が見た大きさより、開いて数えたほうが確か。
     */
    const tally = new Map();
    for (const p of e.proof) {
      const s = p.change.size;
      if (s) tally.set(s, (tally.get(s) || 0) + 1);
    }
    let best = null;
    for (const [s, n] of tally) if (!best || n > best[1]) best = [s, n];
    if (best) { e.size = best[0]; e.sizeVerified = true; }
  }
}

/**
 * 同じずらし幅を指している候補を 1 つにたたむ。
 *
 * 残すのは「材料の多いほう」。目的の文言を参照する関数から出たものは
 * 読んだ命令と比較を持っているので、そちらを台にして、ふるまい側の
 * 裏取り（proof / shape / 走査で数えた場所）を足し込む。
 */
function mergeByOffset(list) {
  const byOffset = new Map();
  const out = [];
  for (const e of list) {
    const key = e.offset != null ? e.offset.toString() : e.key;
    const hit = byOffset.get(key);
    if (!hit) { byOffset.set(key, e); out.push(e); continue; }
    // 大きさは、実際に開いて数えたほうを優先する（見出しと裏取りを食い違わせない）
    if (e.sizeVerified && !hit.sizeVerified) { hit.size = e.size; hit.sizeVerified = true; }
    else if (!hit.size && e.size) hit.size = e.size;
    if (!hit.base && e.base) hit.base = e.base;
    if (e.fromShape) {
      hit.fromShape = true;
      hit.shape = hit.shape || e.shape;
      hit.shapeSites = (hit.shapeSites || []).concat(e.shapeSites || []);
      hit.proof = (hit.proof || []).concat(e.proof || []);
      if (e.verifyTried) hit.verifyTried = (hit.verifyTried || 0) + e.verifyTried;
    } else {
      hit.updates = hit.updates.concat(e.updates);
      hit.compares = hit.compares.concat(e.compares);
      hit.goalStringRefs += e.goalStringRefs;
    }
    for (const f of e.functions) {
      if (!hit.functions.some((x) => x.addr === f.addr)) hit.functions.push(f);
    }
    if ((e.siteCount || 0) > (hit.siteCount || 0)) {
      hit.siteCount = e.siteCount;
      if (e.sites && e.sites.length) hit.sites = e.sites;
    }
  }
  return out;
}

/* 「命令で確かめたうえで、ほぼ確実」と言える確率。 */
const CONFIRM_P = 0.99;

/* ふるまいが「その目的の値である」と名指ししている証拠。珍しさから尤度比を作る。 */
const SHAPE_CODES = new Set(['loc-damage-source', 'loc-resource-drain', 'loc-self-resource']);

/* その目的のふるまいに当てはまる位置が、走査で見えた中に何個あるか。 */
const shapeMatchCache = new WeakMap();
function shapeMatchCount(shapes, goalId) {
  let per = shapeMatchCache.get(shapes);
  if (!per) { per = new Map(); shapeMatchCache.set(shapes, per); }
  if (!per.has(goalId)) per.set(goalId, Math.max(1, shapesByGoal(shapes, goalId, 64).length));
  return per.get(goalId);
}

/* rank.js の理由コード → 尤度比つきの証拠へ翻訳する。
   点数のままだと、候補の数を考えに入れられないため。 */
const REASON_TO_EVIDENCE = {
  'string-ref': 'fn-string-ref',
  'name-match': 'fn-name-match',
  'callee-name': 'fn-callee-match',
  'caller-name': 'fn-caller-match',
  'calls-match': 'fn-caller-match',
  'called-by-match': 'fn-callee-match',
  numeric: 'fn-numeric',
  popular: 'fn-called-often',
  'size-penalty': 'fn-too-large',
};

function buildFunctionCandidate(c, goal, o) {
  const ev = [];
  const owner = o.fields ? o.fields.ownerOf(c.addr) : null;

  for (const r of c.reasons || []) {
    const code = REASON_TO_EVIDENCE[r.code];
    if (!code) continue;
    // 元の配点を 0..1 の濃さに直す（配点の最大で割る）
    const strength = Math.max(0.2, Math.min(1, Math.abs(r.points) / 25));
    ev.push(evidence(code, strength, r.detail));
  }

  /*
   * 開発者が書いた文言による名指し。
   *
   * 「攻撃力アップ:%d 基ダ×(100+%d+[コンボ:%d])÷100」を参照している関数が、
   * 17MB の中にこの 1 個しかない ——「攻撃力の計算はここ」と言い切れる材料は、
   * クラス名が残っていないアプリではこれしかない。上の rank 由来の証拠は
   * 「文字列を参照している」までしか見ておらず、何個の関数が参照しているかを
   * 捨てていたので、ここで排他性から尤度比を作り直す。
   *
   * 別々の文言はそれぞれ独立した観測として数える（同じ文言の重複は数えない）。
   */
  const total = o.functionCount || (o.symbols ? o.symbols.functionCount : 0) || 0;
  if (total > 0) {
    const seenText = new Set();
    const named = [];
    for (const s of c.strings || []) {
      if (!s || s.users == null || seenText.has(s.text)) continue;
      seenText.add(s.text);
      const lr = exclusiveLR(total, s.users, s.score || 0, s.text);
      if (lr <= 1) continue;
      named.push({ s, lr });
    }
    // 効きの強い（＝いちばん排他的な）ものから、決められた本数だけ数える
    named.sort((a, b) => b.lr - a.lr);
    for (const { s, lr } of named.slice(0, EXCLUSIVE_MAX_STRINGS)) {
      ev.push(evidence('fn-string-exclusive', 1,
        { text: s.text, addr: s.addr, site: s.site, users: s.users, of: total }, lr));
    }
  }
  if (owner) {
    const m = matchName(goal, owner.sel || '');
    if (m) ev.push(evidence('fn-selector', m.score, { sel: owner.sel, className: owner.className }));
    const cm = matchText(goal, owner.className);
    if (cm) ev.push(evidence('fn-owner-class', cm.score, { className: owner.className }));
  }
  if (c.name && matchName(goal, c.name)) {
    const norm = normalizeFieldName(c.name.replace(/^[-+]\[[^\s]+\s|\]$/g, ''));
    const m = matchField(goal, norm);
    if (m && m.exact) ev.push(evidence('fn-name-exact', 1, { name: c.name }));
  }

  return {
    key: c.addr.toString(),
    kind: 'function',
    addr: c.addr,
    name: c.name || null,
    owner,
    stats: c.stats || null,
    strings: c.strings || [],
    evidence: ev,
    verifications: [],
    updates: [],
    fusion: null,
  };
}

/*
 * 文言に書かれている計算式の数字が、命令の即値として実在するか。
 *
 * 「攻撃力アップ:%d 基ダ×(100+%d+[コンボ:%d])÷100」の 100 が、
 * その文言を参照している関数の中に即値として 12 個ある——これは偶然ではない。
 * 開発者の書いた説明と、コンパイラが吐いた命令が、別々の出どころで一致している。
 *
 * 小さい数（0〜9）は何にでも出るので数えない。
 */
const FORMULA_MIN_CONST = 10;

function verifyFormula(c, insns) {
  const wanted = new Map();          // 定数 → それを書いている文言
  for (const s of c.strings || []) {
    if (!s || !s.text || s.users == null || s.users > 2) continue;
    for (const m of String(s.text).matchAll(/\d+/g)) {
      const v = Number(m[0]);
      if (!(v >= FORMULA_MIN_CONST) || !Number.isSafeInteger(v)) continue;
      if (!wanted.has(v)) wanted.set(v, s.text);
    }
  }
  if (!wanted.size) return null;

  const seen = new Map();
  for (const i of insns) {
    for (const op of i.ops || []) {
      if (!op || op.k !== 'imm') continue;
      const v = Number(op.value);
      if (!wanted.has(v)) continue;
      seen.set(v, (seen.get(v) || 0) + 1);
    }
  }
  if (!seen.size) return null;

  const hits = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  const [value, count] = hits[0];
  return {
    // 何度も出てくるほど、たまたま同じ数字だった見込みは薄い
    strength: Math.min(1, 0.5 + 0.1 * count),
    detail: { value, count, text: wanted.get(value), constants: hits.length },
  };
}

/**
 * その関数が、目的の値を本当に書き換えているかを命令で確かめる。
 * 「名前がそれっぽい」から「その値をここで減らしている」へ上げる工程。
 */
async function verifyFunctionCandidate(c, goal, o) {
  const program = o.program;
  const range = program ? program.functionRange(c.addr) : null;
  const model = await o.analyze(c.addr, range ? range.end : null);
  if (!model) return;
  c.instructions = (model.instructions || []).length;

  const field = o.field || null;
  if (field) {
    const use = verifyFunctionHandlesField(model, BigInt(field.offset));
    if (use.touches) {
      c.evidence.push(evidence(use.writes ? 'fn-writes-field' : 'fn-touches-field', 1, {
        className: field.className, name: field.plain || field.name,
        loads: use.use.loads, stores: use.use.stores,
      }));
      c.updates = use.use.rmw.slice(0, 3);
      c.verified = true;
    }
  }

  /* 目的が期待している命令の形が、本当にあるか（統計ではなく実物で） */
  const expects = goal.expects || {};
  const insns = model.instructions || [];
  if (expects.store) {
    const { set } = selfRegisters(model);
    const stores = insns.filter((i) => i.memory && i.memory.kind === 'store' &&
      !i.memory.stack && set.has(i.memory.base));
    if (stores.length) {
      c.evidence.push(evidence('fn-writes-field', 0.55, { n: stores.length, self: true }));
      c.verified = true;
    }
  }
  if (!field && expects.numeric) {
    const use = insns.filter((i) => /^(mul|madd|msub|sdiv|udiv|fmul|fdiv)/i.test(i.mnemonic || ''));
    if (use.length) c.evidence.push(evidence('fn-numeric', Math.min(1, use.length / 3), { n: use.length }));
  }

  /*
   * 文言が書いている計算式を、命令の即値で確かめる。
   * クラス表が無いアプリでは、これが唯一の「逆アセンブルで確かめた」になる。
   */
  const formula = verifyFormula(c, insns);
  if (formula) {
    c.evidence.push(evidence('fn-formula-verified', formula.strength, formula.detail));
    c.verifications.push(Object.assign({ what: 'formula' }, formula.detail));
    c.verified = true;
  }

  c.verifications.push({ what: 'instructions', instructions: c.instructions });
}

/**
 * 値と処理をまとめて決める。UI はこれ 1 本を呼べばよい。
 *
 * 値が決まったら、その値を書き換えている処理も同じ確度で決めにいく。
 * 「HP はここ、変えるならこの処理のこの命令」までを 1 回で出すのが狙い。
 */
export async function pinpoint(opts) {
  const o = opts || {};
  let field = await pinpointField(o);

  /*
   * クラス表がなくて名前から特定できなかったときは、形から場所を特定しにいく。
   * ここで諦めると、Swift だけのアプリや名前を潰したアプリで何も言えなくなる。
   */
  if (!field.top && o.ranked && o.ranked.length) {
    const loc = await pinpointLocation(o);
    if (loc.top) field = loc;
  }

  let fn = null;
  if (o.ranked && o.ranked.length) {
    fn = await pinpointFunction(Object.assign({}, o, {
      field: field.top ? {
        offset: field.top.offset, className: field.top.className,
        plain: field.top.plain, name: field.top.field.name,
      } : null,
    }));
  }

  return {
    goal: o.goal,
    field,
    function: fn,
    // 何をもって「決まった」と言えるかは、値と処理で別々に持つ
    verdict: bestVerdict(field, fn),
  };
}

function bestVerdict(field, fn) {
  const order = { confirmed: 3, likely: 2, ambiguous: 1, none: 0 };
  const a = field ? field.verdict : VERDICT.NONE;
  const b = fn ? fn.verdict : VERDICT.NONE;
  return (order[a] || 0) >= (order[b] || 0) ? a : b;
}

export { VERDICT };

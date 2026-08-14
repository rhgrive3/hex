/*
 * 関数の役割 — 「sub_100A3C0」を、アプリの言葉で名指しする層。
 *
 * このツールは命令を 1 行ずつ説明できるし、値を 1 個に決めることもできる。
 * それでも、画面に `sub_100A3C0` と出た瞬間に読む人は止まってしまう。
 *
 *     「stp / ldr / add / str …は分かった。で、これは何の処理なの？」
 *
 * 命令の説明は「どう動くか」を答えるが、「アプリの何の話か」には答えていない。
 * 人が知りたいのは後者しかない。だからここでは、関数 1 つにつき 1 行の
 * **名前**を作る。作る名前は必ずこの形にそろえる。
 *
 *     ［機能］ ［対象］ を ［動作］ する処理
 *      🎒アイテム  ItemManager.count  1 増やす
 *
 * 3 つに分けているのは、それぞれ**証拠の出どころが違う**ため。
 *
 *   動作（動詞）… 命令の形そのもの。ldr → add #1 → str が実在すれば、
 *                 「1 増やしている」ことは推測ではなく事実。逆アセンブルで確かめられる。
 *   対象（目的語）… どの値を触っているか。Objective-C のクラス表があれば名前まで、
 *                 無ければ「オブジェクトの +0x30」までは確実に言える。
 *   機能（話題）  … アプリのどの機能の話か。これだけは名前と文言にしか宿っていない。
 *                 参照している文言・メソッド名・クラス名・呼び出し元から拾う。
 *
 * この分け方には実利がある。**動詞の証拠は、対象について何ひとつ言っていない**。
 * 「+1 している」ことをどれだけ厳密に確かめても、それがアイテムなのかコインなのか
 * ログイン回数なのかは 1 ミリも決まらない。混ぜると「+1 する処理はぜんぶアイテム獲得」
 * という、いちばんやってはいけない断定が出る。だから evidence.js の id 印は
 * 機能・対象の側にしか付けていない（`role-verb-*` に id は無い）。
 *
 * 決め方は既存の枠組みに乗せる。役割の候補を組み立てて尤度比で合成し（evidence.js）、
 * 1 個に決まらなければ「絞りきれていません」と言う。名前をでっち上げない。
 *
 * ここも日本語は 1 文字も作らない。返すのはコードと数字だけ（文にするのは narrate.js）。
 */
import { evidence, fuse, decide, explain, starsOf, VERDICT, verdictRank } from './evidence.js';
import { GOALS, matchField, matchText, typeFits } from './goals.js';
import { apiInfo } from './blocks.js';

/* ── 動作（動詞） ────────────────────────────────────────────
 * 「このデータをどう加工しているか」。命令の形から決まるものだけを並べる。
 * 想像で足さない（「初期化する」「更新する」のような、形の伴わない語は入れない）。 */
export const ACTION = {
  INCREASE: 'increase',   // 読んで、足して、同じ場所へ書き戻す
  DECREASE: 'decrease',   // 読んで、引いて、同じ場所へ書き戻す
  SCALE: 'scale',         // 掛け算で増やす（倍率・ダメージ計算でよく出る）
  SHRINK: 'shrink',       // 割り算・右シフトで減らす
  SET: 'set',             // 別の値をそのまま入れる
  GET: 'get',             // 読んで、そのまま返す（アクセサ）
  CLEAR: 'clear',         // 0 を入れる（リセット）
  FLAG: 'flag',           // ビット単位で立てる・落とす
  SWAP: 'swap',           // 条件によって入れ替える（csel）
  CHECK: 'check',         // 定数と比べて分岐する（しきい値の判定）
  SAVE: 'save',           // 端末に保存する
  LOAD: 'load',           // 端末から読み出す
  SEND: 'send',           // サーバーへ送る
  SHOW: 'show',           // 画面に出す
  MAKE: 'make',           // オブジェクトを作る
  DISPATCH: 'dispatch',   // ほかの処理へ振り分けるだけ
  /*
   * 1 本の値を、何段もの倍率・加減で作り上げて渡す。
   * ここは他の動作と違い、1 つの命令ではなく **式の連なり** から決まる
   * （comprehend.js が復元する）。ゲームの計算処理はほぼこの形になる。
   */
  COMPUTE: 'compute',
  UNKNOWN: 'unknown',
};

/* 命令 → 動作。changeVerb（narrate.js）と食い違わないようにそろえてある。 */
const OP_ACTION = {
  add: ACTION.INCREASE, adds: ACTION.INCREASE, fadd: ACTION.INCREASE,
  sub: ACTION.DECREASE, subs: ACTION.DECREASE, fsub: ACTION.DECREASE, msub: ACTION.DECREASE,
  mul: ACTION.SCALE, madd: ACTION.SCALE, fmul: ACTION.SCALE, lsl: ACTION.SCALE,
  sdiv: ACTION.SHRINK, udiv: ACTION.SHRINK, fdiv: ACTION.SHRINK,
  lsr: ACTION.SHRINK, asr: ACTION.SHRINK,
  and: ACTION.FLAG, orr: ACTION.FLAG, eor: ACTION.FLAG, bic: ACTION.FLAG,
  mov: ACTION.SET, movz: ACTION.SET, movk: ACTION.SET, fmov: ACTION.SET,
  csel: ACTION.SWAP, csinc: ACTION.SWAP, csinv: ACTION.SWAP, csneg: ACTION.SWAP,
};

/* API の分類 → 動作。呼んでいる相手が分かれば、値を触っていなくても動作は言える。 */
const API_ACTION = {
  storage: ACTION.SAVE, io: ACTION.SAVE, network: ACTION.SEND,
  ui: ACTION.SHOW, secret: ACTION.SAVE, crypto: ACTION.CHECK, antidebug: ACTION.CHECK,
};

/* 「増える」向きの動作。UI で ＋/− を出し分けるのに使う。 */
const UP = new Set([ACTION.INCREASE, ACTION.SCALE]);
const DOWN = new Set([ACTION.DECREASE, ACTION.SHRINK]);

export function actionDirection(action) {
  if (UP.has(action)) return 'up';
  if (DOWN.has(action)) return 'down';
  return 'none';
}

/** 値の書き換えを伴う動作か（＝「変更候補」として案内できるか）。 */
export function changesValue(action) {
  return UP.has(action) || DOWN.has(action) ||
    action === ACTION.SET || action === ACTION.CLEAR ||
    action === ACTION.FLAG || action === ACTION.SWAP;
}

/* ── 話題（機能）の手がかり ──────────────────────────────────
 * 出どころごとに証拠の重みが違う。関数自身の名前がいちばん強く、
 * 呼び出し元の名前がいちばん弱い（遠いので）。 */
const TOPIC_SOURCES = [
  { key: 'name', code: 'role-topic-name', weight: 1 },
  { key: 'selector', code: 'role-topic-selector', weight: 1 },
  { key: 'string', code: 'role-topic-string', weight: 1 },
  { key: 'class', code: 'role-topic-class', weight: 1 },
  { key: 'callee', code: 'role-topic-callee', weight: 1 },
  { key: 'caller', code: 'role-topic-caller', weight: 1 },
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * 話題ごとに手がかりを集める。
 *
 * @returns {Map<string, {id, total, sources:Map<string,{strength, detail}>}>}
 */
function collectTopics(input) {
  const found = new Map();

  const add = (goalId, key, strength, detail) => {
    const s = clamp01(strength);
    if (!(s > 0.05)) return;
    if (!found.has(goalId)) found.set(goalId, { id: goalId, total: 0, sources: new Map() });
    const t = found.get(goalId);
    const prev = t.sources.get(key);
    // 同じ出どころで何本当たっても、いちばん濃い 1 本ぶんしか数えない
    if (!prev || prev.strength < s) t.sources.set(key, { strength: s, detail });
  };

  const texts = [];
  const push = (key, text, scale) => {
    if (!text) return;
    texts.push({ key, text: String(text), scale: scale == null ? 1 : scale });
  };

  /*
   * 関数自身の名前。`sub_100A3C0` は名前ではないので手がかりにしない
   * （アドレスを名前として当てはめると、16 進が語に化けて誤爆する）。
   */
  if (input.name && !/^sub_[0-9a-f]+$/i.test(input.name)) push('name', input.name);
  if (input.owner && input.owner.sel) push('selector', input.owner.sel);
  if (input.owner && input.owner.className) push('class', input.owner.className);
  for (const sel of (input.selectors || []).slice(0, 12)) push('selector', sel, 0.8);
  for (const s of (input.strings || []).slice(0, 24)) push('string', s.text != null ? s.text : s, 1);
  for (const c of (input.callees || []).slice(0, 24)) push('callee', c.name || c, 0.9);
  for (const c of (input.callers || []).slice(0, 24)) push('caller', c.name || c, 0.9);

  for (const g of GOALS) {
    for (const t of texts) {
      // 名前らしいもの（メソッド名・変数名）は名前用の語彙で、文言は文言用の語彙で当てる
      const m = (t.key === 'string')
        ? matchText(g, t.text)
        : (matchField(g, t.text) || matchText(g, t.text));
      if (!m) continue;
      const src = TOPIC_SOURCES.find((x) => x.key === t.key);
      add(g.id, t.key, m.score * t.scale * (src ? src.weight : 1), { text: t.text, term: m.term });
    }
  }

  for (const t of found.values()) {
    let total = 0;
    for (const s of t.sources.values()) total += s.strength;
    t.total = total;
  }
  return found;
}

/* ── 対象（どの値を触っているか） ──────────────────────────── */

function subjectOfUpdate(u) {
  const loc = u.location || {};
  if (u.field) {
    return {
      kind: 'field',
      className: u.field.className || null,
      name: u.field.name || null,
      plain: u.field.plain || null,
      type: u.field.type || null,
      offset: u.field.offset != null ? u.field.offset : loc.disp,
      base: loc.base, disp: loc.disp, size: loc.size, stack: !!loc.stack,
      certain: !!u.field.certain,
    };
  }
  return {
    kind: loc.stack ? 'local' : 'location',
    className: null, name: null, plain: null, type: null,
    offset: loc.disp,
    base: loc.base, disp: loc.disp, size: loc.size, stack: !!loc.stack,
    certain: false,
  };
}

/**
 * 復元した計算の連なりを、役割の「対象」にする。
 *
 * 触っている場所ではなく **作っている値そのもの** が主題なので、
 * フィールド名ではなく、何から作って何段変えたかで名乗る。
 */
/** 対象を 1 つの鍵にする。同じものを触っている候補をまとめるのに使う。 */
function subjectKey(s) {
  if (!s) return 'none';
  if (s.kind === 'field') return 'field:' + (s.className || '') + '.' + (s.name || s.disp);
  if (s.kind === 'computed') return 'computed:' + (s.reg || '');
  if (s.kind === 'none') return 'none';
  return s.kind + ':' + (s.base || '') + '@' + (s.disp != null ? s.disp.toString() : '?');
}

function subjectOfChain(chain) {
  return {
    kind: 'computed',
    className: null, name: null, plain: null, type: null,
    offset: null, base: null, disp: null, size: null, stack: false,
    reg: chain.accumulator ? chain.accumulator.reg : null,
    steps: chain.steps.length,
    certain: !!(chain.formula && chain.formula.distinct >= 2),
  };
}

function actionOfUpdate(u) {
  // 素の読み書き（アクセサ）。計算が挟まっていないので、動作はそのまま決まる。
  if (u.kind === 'read') return { action: ACTION.GET, amount: null, op: null };
  if (u.kind === 'write') return { action: ACTION.SET, amount: null, op: null };
  const steps = u.steps || [];
  const last = steps.length ? steps[steps.length - 1] : null;
  if (!last) {
    // 読んだ値をそのまま別の場所へ置いている（値の移動）
    return { action: ACTION.SET, amount: null, op: null };
  }
  let action = OP_ACTION[last.op] || ACTION.SET;
  const amount = last.imm != null ? last.imm : null;
  // 0 を入れているならリセット。「設定する」より、こちらの方が伝わる。
  if (action === ACTION.SET && amount != null && amount === 0n) action = ACTION.CLEAR;
  return { action, amount, op: last.op, float: last.immFloat != null ? last.immFloat : null };
}

/** 値を触っていない関数の動作を、呼んでいる相手と命令の形から決める。 */
function actionOfShape(input) {
  const apis = (input.apis || []);
  for (const a of apis) {
    if (a.id === 'objc_alloc') return { action: ACTION.MAKE, api: a };
    if (a.id === 'prefs' || a.id === 'database' || a.id === 'file' || a.id === 'filemanager') {
      // 書き込みが 1 つも無いなら、保存ではなく読み出し
      return { action: (input.stores || 0) > 0 ? ACTION.SAVE : ACTION.LOAD, api: a };
    }
    const mapped = API_ACTION[a.cat];
    if (mapped) return { action: mapped, api: a };
  }
  if ((input.comparisons || 0) > 0 && (input.conditionals || 0) > 0) {
    return { action: ACTION.CHECK, api: null };
  }
  if ((input.calls || 0) >= 3) return { action: ACTION.DISPATCH, api: null };
  return { action: ACTION.UNKNOWN, api: null };
}

/* ── 役割の候補を組み立てる ────────────────────────────────── */

function accessorSpec(owner) {
  const sel = owner && owner.sel ? String(owner.sel) : '';
  if (!sel) return null;
  const set = /^set(.+):$/.exec(sel);
  if (set && set[1]) return { kind: 'write', name: set[1].replace(/^_+/, '').toLowerCase(), selector: sel };
  // 引数なし selector だけを getter とみなす。`foo:` のような通常メソッドを
  // getter 扱いすると、たまたま同名の ivar を読んだだけで誤固定する。
  if (!sel.includes(':')) return { kind: 'read', name: sel.replace(/^_+/, '').toLowerCase(), selector: sel };
  return null;
}

function exactAccessorUpdate(input, updates) {
  const spec = accessorSpec(input.owner);
  if (!spec) return null;
  for (const u of updates) {
    if (!u || u.kind !== spec.kind || !u.field || !u.field.certain) continue;
    if (input.owner && input.owner.className && u.field.className &&
        input.owner.className !== u.field.className) continue;
    const name = String(u.field.plain || u.field.name || '').replace(/^_+/, '').toLowerCase();
    if (name === spec.name) return { update: u, spec };
  }
  return null;
}

function buildCandidates(input, topics) {
  const updates = (input.updates || []);
  /*
   * Objective-C の accessor は selector 自身が対象名を宣言している。
   * `setFoo:` の中にログ・KVO・補助フィールドの読み書きが何本あっても、
   * 実際に self.foo へ書く命令が確認できたなら、それを候補から落としてはいけない。
   * 以前は updates の先頭 4 件だけだったため、本物の setter/getter が 5 件目以降に
   * あるだけで別フィールドを「主役」と誤認していた。
   */
  const accessor = exactAccessorUpdate(input, updates);
  const ordered = accessor
    ? [accessor.update, ...updates.filter((u) => u !== accessor.update)]
    : updates;
  /*
   * 値を触っている場所を、確からしい順に。
   * 「読んで計算して書き戻す」が閉じているものだけが、動作を命令で裏取りできる。
   */
  const changes = ordered.slice(0, 4);

  const topicList = Array.from(topics.values()).sort((a, b) => b.total - a.total).slice(0, 3);
  // 「機能までは言えない」も必ず候補に残す。ここを外すと、弱い手がかりが必ず勝ってしまう。
  const topicChoices = topicList.concat([null]);

  const out = [];
  const seats = [];
  for (const u of changes) seats.push({ update: u });
  // 「値の書き換えは主役ではない」可能性も候補に入れる
  seats.push({ update: null });
  /*
   * 復元した計算の連なりも 1 つの候補として立てる。
   *
   * これを候補に入れていなかったころ、6000 命令の計算処理はいつも
   * 「スタックの一時的な値を入れ替える処理（確からしさ 0.2%）」になっていた。
   * 値の書き換えだけを主役の候補にしていたので、**計算そのものが主役**という
   * 読み方を、候補としてすら持っていなかった。
   */
  const cm = input.comprehension || null;
  if (cm && cm.steps && cm.steps.length >= 2) seats.push({ chain: cm });

  for (const seat of seats) {
    const u = seat.update;
    const chain = seat.chain || null;
    const subject = chain ? subjectOfChain(chain) : (u ? subjectOfUpdate(u) : { kind: 'none' });
    const verb = chain ? { action: ACTION.COMPUTE, amount: null, op: null }
      : (u ? actionOfUpdate(u) : actionOfShape(input));
    if (!u && !chain && verb.action === ACTION.UNKNOWN && changes.length) continue;

    for (const topic of topicChoices) {
      const items = [];

      /* ── 動作の証拠。命令の形そのもの。 ── */
      if (chain) {
        /*
         * 何段の作り変えを、実際に式まで戻せたか。
         * 段数が多いほど「たまたまそう見えた」見込みは薄い。
         */
        items.push(evidence('role-chain-verified',
          Math.min(1, 0.4 + 0.1 * chain.steps.length),
          { steps: chain.steps.length, reg: chain.accumulator ? chain.accumulator.reg : null }));
        if (chain.formula) {
          /*
           * 開発者が文言に書いた計算式と、命令から復元した計算式の一致。
           * 一致した数の **種類** が多いほど強い（1 種類では偶然が残る）。
           */
          items.push(evidence('role-formula-verified', chain.formula.strength, {
            distinct: chain.formula.distinct,
            matched: chain.formula.matched,
            claimed: chain.formula.claimed,
            texts: chain.formula.texts.slice(0, 3),
            address: chain.formula.hits.length ? chain.formula.hits[0].address : null,
          }));
        }
        const labelled = chain.steps.filter((s) => s.label).length;
        if (labelled >= 2) {
          items.push(evidence('role-step-labelled', Math.min(1, labelled / 6), {
            n: labelled, of: chain.steps.length,
            texts: chain.steps.filter((s) => s.label).slice(0, 3).map((s) => s.label.text),
          }));
        }
      } else if (u) {
        if (u.kind === 'read-modify-write' && input.verified) {
          items.push(evidence('role-verb-rmw', 1, {
            address: u.store ? u.store.address : null,
            op: verb.op, imm: verb.amount,
          }));
        }
        if (verb.amount != null && input.verified) {
          items.push(evidence('role-verb-imm', 1, { op: verb.op, imm: verb.amount }));
        }
        if (u.kind === 'read' || u.kind === 'write') {
          /*
           * 読んで返すだけ・引数を入れるだけ。命令はこの 1 本しかないので、
           * 「何をしているか」については、増減の連鎖と同じくらい確かに言える。
           */
          items.push(evidence('role-verb-accessor', 1, {
            kind: u.kind, address: u.store ? u.store.address : null,
          }));
          if (accessor && u === accessor.update && input.verified) {
            /*
             * selector (`foo` / `setFoo:`) と self の ivar 名が一致し、さらに
             * その read/write 命令まで実在する。Objective-C runtime metadata と
             * 逆アセンブルが同じ対象を指した場合だけ立つ、accessor 固有の証拠。
             */
            items.push(evidence('role-accessor-match', 1, {
              selector: accessor.spec.selector,
              field: u.field ? (u.field.plain || u.field.name) : null,
              className: u.field ? u.field.className : null,
            }));
          }
        } else if (u.kind !== 'read-modify-write') {
          // 読み書きの往復が閉じていない。動作の言い方を弱める。
          items.push(evidence('role-verb-shape', 0.4, { kind: u.kind }));
        }
      } else {
        items.push(evidence('role-verb-none', 1, null));
        if (verb.api) items.push(evidence('role-verb-api', 1, { api: verb.api.id, cat: verb.api.cat }));
        if (verb.action === ACTION.CHECK) {
          items.push(evidence('role-verb-shape', 1, { comparisons: input.comparisons }));
        }
      }

      /* ── 対象の証拠。名前が読めたときだけ強い。 ── */
      if (subject.kind === 'field' && subject.name) {
        const goal = topic ? GOALS.find((g) => g.id === topic.id) : null;
        const m = goal ? matchField(goal, subject.name) : null;
        if (m) {
          items.push(evidence('role-subject-field', clamp01(m.score), {
            name: subject.name, className: subject.className, term: m.term, exact: m.exact,
          }));
          if (goal && subject.type) {
            const fit = typeFits(goal, subject.type);
            if (fit === 'fit') items.push(evidence('type-numeric', 1, { type: subject.type }));
            else if (fit === 'conflict') items.push(evidence('type-conflict', 1, { type: subject.type }));
          }
        } else if (topic) {
          /*
           * 名前は読めているのに、その機能の語がどこにも入っていない。
           * 「アイテムの話らしいのに、触っている値は _viewController」という形。
           * 名指しの反証なので、下げる。
           */
          items.push(evidence('role-topic-conflict', 0.6, { name: subject.name }));
        }
      } else if (subject.kind === 'field' || subject.kind === 'location') {
        items.push(evidence('role-subject-unnamed', 1, { disp: subject.disp, base: subject.base }));
      }

      /* ── 機能の証拠。人が付けた名前と文言にしか宿っていない。 ── */
      if (topic) {
        let sources = 0;
        for (const src of TOPIC_SOURCES) {
          const hit = topic.sources.get(src.key);
          if (!hit) continue;
          sources++;
          items.push(evidence(src.code, hit.strength, hit.detail));
        }
        // 別々の出どころが同じ機能を指している。手がかり 1 本ぶんより強い。
        if (sources >= 3) items.push(evidence('role-topic-agree', 1, { sources }));
        else if (sources === 2) items.push(evidence('role-topic-agree', 0.5, { sources }));

        // ほかの機能も同じくらい強く手を挙げているなら、名指しは弱まる
        let other = 0;
        for (const t of topics.values()) {
          if (t.id === topic.id) continue;
          if (t.total > other) other = t.total;
        }
        if (other > 0) {
          items.push(evidence('role-topic-conflict',
            clamp01(other / Math.max(topic.total, 0.01)), { rival: other }));
        }
      }

      out.push({
        action: verb.action,
        amount: verb.amount != null ? verb.amount : null,
        op: verb.op || null,
        api: verb.api || null,
        subject,
        topic: topic ? topic.id : null,
        update: u,
        chain,
        address: chain
          ? (chain.steps.length ? chain.steps[0].address : null)
          : (u && u.store ? u.store.address : null),
        row: chain
          ? (chain.steps.length ? chain.steps[0].row : null)
          : (u && u.store ? u.store.row : null),
        items,
      });
    }
  }
  return out;
}

/*
 * 「このツールが言い得たこと」の総数 ＝ 事前オッズの分母。
 * 動作の種類 × 触っている場所の数。ここを小さく見積もると、
 * 手がかり 1 本で「確定」が出てしまう。
 */
function roleSpace(input) {
  const actions = Object.keys(ACTION).length;
  /*
   * 「触っている場所の数」ではなく、**実際に候補として立てた席の数**。
   *
   * ここで updates の総数を使っていたころ、スタックの一時置き場を 30 か所
   * 書くだけで分母が 700 になり、どれだけ強い材料をそろえても
   * 「あと少しで確定」から動かなくなっていた。置き場の多さは、この関数が
   * 何をしているかについて何も言っていないのだから、分母に入れる筋合いがない。
   * 席は buildCandidates が立てるぶん（値の書き換え 4 つ＋なし＋計算の連なり）。
   */
  const seats = Math.min(4, (input.updates || []).length) + 2;
  return Math.max(12, actions * seats);
}

/**
 * 関数 1 つの役割を決める。
 *
 * @param {object} input
 *   name         関数の名前（無ければ null）
 *   owner        {className, sel}   Objective-C のメソッドなら
 *   updates      findValueUpdates の結果（field 解決済みが望ましい）
 *   apis         [{id, cat}]        呼んでいる外部 API
 *   selectors    []                 送っているメッセージ名
 *   strings      [{text}] または []  参照している文言
 *   callers      [{name}]           呼び出し元
 *   callees      [{name}]           呼び出し先
 *   comparisons  定数比較の数 / conditionals 条件分岐の数 / calls 呼び出しの数 / stores 書き込みの数
 *   verified     逆アセンブルまで降りて確かめた入力か（一覧向けの下見なら false）
 * @returns {object|null}
 */
export function inferRole(input) {
  if (!input) return null;
  const topics = collectTopics(input);
  const candidates = buildCandidates(input, topics);
  if (!candidates.length) {
    return {
      verdict: VERDICT.NONE, probability: 0, stars: 1,
      action: ACTION.UNKNOWN, amount: null, subject: { kind: 'none' }, topic: null,
      evidence: [], missing: ['role-no-clue'], runnerUp: null,
      depth: input.verified ? 'full' : 'sketch',
    };
  }

  const space = roleSpace(input);
  for (const c of candidates) {
    c.fusion = fuse(c.items, { candidates: space, absent: 8 });
  }
  candidates.sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);

  /*
   * 決着は「主張」ごとに付ける。
   *
   * 候補は（動作・対象・機能）の組で作ってあるので、機能が 2 つ拮抗しているだけで、
   * 動作と対象がまったく同じ候補が 1 位と 2 位に並ぶ。そこを 2 位との差として
   * 数えていたころ、
   *
   *   1 位: 攻撃力の計算処理（98.8%） / 2 位: ダメージの計算処理（98.8%）
   *
   * となり、**何をしている関数かは完全に決まっているのに**「割れています」しか
   * 言えなかった。攻撃力とダメージのどちらの話かが決まっていないことは、
   * topicSettled が別に持っている（見出しでは機能を名乗らない）。
   * 動作と対象の決着は、機能が違うだけの候補ではなく、
   * **別の読み方**（別の動作・別の対象）と比べて付ける。
   */
  const claimKey = (c) => c.action + '|' + subjectKey(c.subject);
  const byClaim = new Map();
  for (const c of candidates) {
    const k = claimKey(c);
    const cur = byClaim.get(k);
    if (!cur || cur.fusion.logOdds < c.fusion.logOdds) byClaim.set(k, c);
  }
  const claims = Array.from(byClaim.values()).sort((a, b) => b.fusion.logOdds - a.fusion.logOdds);

  const d = decide(claims);
  const top = d.top || candidates[0];
  const missing = d.missing.slice();

  let verdict = d.verdict;
  /*
   * 名前の読めない場所（クラス表のないバイナリの「+0x30」）は、動作をどれだけ
   * 命令で確かめても「確定」とは呼ばない。何を加工しているかが言えていないため。
   */
  if (top.subject && (top.subject.kind === 'location' || top.subject.kind === 'local') &&
      verdictRank(verdict) > verdictRank(VERDICT.LIKELY)) {
    verdict = VERDICT.LIKELY;
  }
  /*
   * 計算そのものが主題の関数には、書き換えているフィールドが無い。
   * 「値の名前が読めない」を足すのは筋違いなので、そこは黙る
   * （代わりに、式が復元できているかどうかで語る）。
   */
  if (top.subject && top.subject.kind !== 'field' && top.subject.kind !== 'none' &&
      top.subject.kind !== 'computed') {
    if (!missing.includes('role-no-field-name')) missing.push('role-no-field-name');
  }
  if (top.subject && top.subject.kind === 'computed' && !top.subject.certain &&
      !missing.includes('role-no-formula')) {
    missing.push('role-no-formula');
  }
  if (!top.topic && !missing.includes('role-no-topic')) missing.push('role-no-topic');
  if (!input.verified && !missing.includes('role-not-disassembled')) {
    missing.push('role-not-disassembled');
    if (verdictRank(verdict) > verdictRank(VERDICT.LIKELY)) verdict = VERDICT.LIKELY;
  }

  /*
   * 機能の名指しが決着しているか。
   *
   * 本物のアプリの関数は、文言を何百本も参照している。そういう関数では
   * 「アイテム」と「スコア」の両方に手がかりが立ち、どちらが勝つかは
   * ほとんど紙一重になる。そこで勝った方だけを見出しに出すと、
   * すぐ下の行に書いてある根拠（「/ranking/ を参照している」）と
   * 食い違った名前が出る — 実際に出た。
   *
   * 動作（+1 している）は決まっていても、機能が決まっていないことはある。
   * その 2 つは別々に決着させて、決まっていない方は名乗らない。
   */
  const rival = candidates.find((c) => c !== top && c.topic && c.topic !== top.topic);
  const topicSettled = !top.topic ? false
    : (!rival || (top.fusion.logOdds - rival.fusion.logOdds) >= Math.log(4));
  if (top.topic && !topicSettled && !missing.includes('role-topic-unsettled')) {
    missing.push('role-topic-unsettled');
  }
  const rivalTopic = !topicSettled && rival ? rival.topic : null;

  /*
   * 「ほかの読み方」は、決着の判定とは別に選ぶ。
   *
   * 決着は主張（動作・対象）どうしで付けるが、読む人に見せたい 2 番目は
   * 「機能が違うだけの読み方」でもかまわない ——
   * 「アイテムの数を 1 増やす」と「ログインボーナスの数を 1 増やす」は、
   * 読む人にとっては立派に別の読み方だから。
   */
  const alt = candidates.find((c) => c !== top &&
    (claimKey(c) !== claimKey(top) || c.topic !== top.topic)) || d.runnerUp;
  const runnerUp = alt && alt !== top ? {
    action: alt.action, amount: alt.amount,
    subject: alt.subject, topic: alt.topic,
    probability: alt.fusion.probability,
  } : null;

  return {
    verdict,
    probability: top.fusion.probability,
    stars: starsOf(top.fusion.probability, verdict),
    action: top.action,
    amount: top.amount,
    op: top.op,
    api: top.api,
    subject: top.subject,
    topic: top.topic,
    // 機能が決まっていないことは、必ず持ち回る。見出しに出すかどうかがこれで変わる。
    topicSettled,
    rivalTopic,
    address: top.address,
    row: top.row,
    update: top.update,
    chain: top.chain || null,
    direction: actionDirection(top.action),
    evidence: explain(top.fusion, 8),
    fusion: top.fusion,
    marginRatio: d.marginRatio,
    runnerUp,
    missing,
    depth: input.verified ? 'full' : 'sketch',
    // 上位いくつかは、UI で「ほかの読み方」として出せるように残す
    others: candidates.slice(1, 4).map((c) => ({
      action: c.action, amount: c.amount, subject: c.subject, topic: c.topic,
      probability: c.fusion.probability,
    })),
  };
}

/**
 * 関数レポート（report.js）から役割を決める。命令まで降りた入力なので verified。
 *
 * @param {object} report buildFunctionReport の結果
 * @param {object} [extra] {name, apis, comparisons…} 足りないものを補うとき
 */
export function roleFromReport(report, extra) {
  if (!report) return null;
  const e = extra || {};
  const facts = report.facts || [];
  const at = (code) => facts.find((f) => f.code === code);
  const calls = at('calls');
  const memory = at('memory');

  return inferRole({
    name: (report.identity && report.identity.name) || e.name || null,
    owner: report.owner || null,
    updates: report.updates || [],
    /* 復元した計算の連なり（comprehend.js）。無ければ従来どおり。 */
    comprehension: e.comprehension || report.comprehension || null,
    apis: e.apis || (report.apis || []),
    selectors: report.selectors || [],
    strings: report.strings || [],
    callers: report.callers || [],
    callees: report.callees || [],
    comparisons: (report.comparisons || []).length,
    conditionals: (at('conditionals') || { detail: {} }).detail.n || 0,
    calls: calls ? calls.detail.n : 0,
    stores: memory ? memory.detail.stores : 0,
    verified: true,
  });
}

/* ── 一覧向けの下見 ──────────────────────────────────────────
 *
 * 呼び出し元・呼び出し先の一覧にも役割を出したいが、そこに並ぶ数十個を
 * 全部逆アセンブルするわけにはいかない（スクロールが死ぬ）。
 * ProgramIndex が 1 パスで集めた事実だけで下見をする。値の書き換えまでは
 * 見えないので、動作は「呼んでいる相手」と「命令の統計」からしか言わない。
 * verified を渡さないので、ここから「確定」は絶対に出ない。 */

/** 文字列一覧（{addr,text} の配列）を、アドレスから引ける形にする。1 回だけ作る。 */
export function stringLookup(list) {
  if (!list) return () => null;
  if (list.__lookup) return list.__lookup;
  const sorted = list.slice().sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
  const fn = (addr) => {
    if (addr == null) return null;
    let lo = 0, hi = sorted.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].addr <= addr) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best < 0) return null;
    const s = sorted[best];
    // 文字列の途中を指していることもある。長さの外なら別物。
    const len = BigInt((s.text || '').length + 1);
    return addr < s.addr + len ? s : null;
  };
  try { Object.defineProperty(list, '__lookup', { value: fn, enumerable: false }); } catch { /* 凍結配列なら諦める */ }
  return fn;
}

/**
 * 逆アセンブルせずに役割を下見する。
 *
 * @param {object} o
 *   start, end   関数の範囲
 *   program      ProgramIndex
 *   symbols      SymbolIndex
 *   fields       FieldIndex（メソッドの持ち主を引く）
 *   strings      ensureStrings の結果
 */
export function sketchRole(o) {
  if (!o || !o.program || o.start == null) return null;
  const { program, symbols, start } = o;
  /*
   * ここは「関数の先頭」だと分かっているアドレスにしか使わない。
   *
   * スタブ（外部ライブラリへの中継地点）や、関数一覧に載っていないアドレスを
   * 渡されると、functionRange は「その手前にある別の関数」を返してくる。
   * それに気づかず解析すると、_puts の行に隣の関数の役割が出る。
   * 名前をでっち上げるのと同じことなので、範囲が確かめられなければ何も言わない。
   */
  const range = program.functionRange(start);
  if (!range || range.start !== start) return null;
  /*
   * 終わりが分からないときに端まで走らせると、アプリ全体の呼び出しと文言を
   * 1 つの関数のものとして数えてしまう。分からないときは窓を切る。
   */
  const end = range.end != null ? range.end : start + 0x1000n;

  const callees = [];
  const apis = [];
  for (const c of program.calleesOf(range.start, end, 40)) {
    const name = symbols ? symbols.nameAt(c.addr) : null;
    if (!name) continue;
    callees.push({ name });
    const api = apiInfo(name);
    if (api && !apis.some((a) => a.id === api.id)) apis.push({ id: api.id, cat: api.cat });
  }
  const callers = program.callersOf(range.start, 20)
    .map((c) => ({ name: c.addr != null && symbols ? symbols.nameAt(c.addr) : null }))
    .filter((c) => c.name);

  const lookup = stringLookup(o.strings || []);
  const strings = [];
  for (const r of program.refsFrom(range.start, end, 60)) {
    const s = lookup(r.target);
    if (s && !strings.some((x) => x.text === s.text)) strings.push({ text: s.text, addr: s.addr });
  }

  const stats = program.statsOf(range.start, end);
  const owner = o.fields ? o.fields.ownerOf(range.start) : null;

  return inferRole({
    name: symbols ? symbols.nameAt(range.start) : null,
    owner,
    updates: [],
    apis, callees, callers, strings,
    selectors: [],
    comparisons: stats.cmp, conditionals: stats.condbr,
    calls: stats.call + stats.indcall, stores: stats.store,
    verified: false,
  });
}

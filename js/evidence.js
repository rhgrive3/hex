/*
 * 証拠の合成 — 「たぶんこれ」を「これです」に変えるための層。
 *
 * これまでの点数付け（rank.js）は、証拠に点を付けて足していた。読みやすいが、
 * 「87 点」が何の 87 なのかは説明できない。候補が 3 個のときの 87 点と、
 * 候補が 2 万個のときの 87 点はまったく意味が違うのに、同じ数字になってしまう。
 * だから「87% です」と出しても、当たっているのかどうか誰にも分からなかった。
 *
 * ここはそこを根本から直す。点ではなく **尤度比** を持たせる。
 *
 *     尤度比 ＝ その証拠が、本物で観測される確率 ÷ 本物でないもので観測される確率
 *
 * 「クラス表に _hp と書いてある」は、本物の HP ならほぼ必ず観測されるが、
 * 無関係な 2 万個の値ではまず観測されない。だから尤度比は大きい（×18 くらい）。
 * 「4 バイトの整数である」は本物でも偽物でもよくあるので、小さい（×2 くらい）。
 * 「オブジェクト型なのに数を数える目的だ」は本物ではまず起きないので、1 未満（×0.06）。
 *
 * 出発点（事前オッズ）は **候補の数** から決める。候補が 2 万個あれば 1/20000 から始める。
 * そこに尤度比を掛けていって、最後に確率へ戻す。こうすると
 *
 *     名前が一致しただけ                     …  0.005% → 0.1%   （まだ何も言えない）
 *     名前 ＋ 型 ＋ クラスの担当が合う         …  0.1%   → 12%    （候補どまり）
 *     ＋ アクセサを逆アセンブルして位置を確認   …  12%    → 99.9%  （確定と言える）
 *
 * という、人の感覚に合う数字になる。しかも「×18」「×45」という掛け算の内訳を
 * そのまま画面に出せるので、なぜ確定なのかを 1 つずつ確かめられる。
 *
 * このファイルの絶対のきまり:
 *
 *   1. 同じ種類の証拠を並べても確定にはならない（相関の割引を必ず掛ける）。
 *      名前が 3 通りの書き方で一致しても、それは 1 つの手がかりでしかない。
 *   2. 「確定」を名乗れるのは、**独立した系統が 2 つ以上**あり、かつ
 *      そのうち 1 つが **実際に逆アセンブルして確かめた証拠**であるときだけ。
 *      名前と型だけでは、どれだけ数字が大きくても確定にしない。
 *   3. 2 位との差（マージン）を必ず見る。1 位が 99% でも、2 位も 99% なら確定ではない。
 *
 * 日本語は作らない。コードと数字だけを返す（文にするのは narrate.js）。
 */

/* ── 証拠の系統 ──────────────────────────────────────────────
   同じ系統の証拠は互いに相関しているとみなし、合算に上限を設ける。
   「確定」には別々の系統が 2 つ以上要る、という判定にも使う。 */

export const FAMILY = {
  NAME: 'name',          // 名前（ivar 名・プロパティ名・アクセサ名・クラス名）
  TYPE: 'type',          // 型（何バイトの何か）
  CONTEXT: 'context',    // まわり（クラスの担当・兄弟の値・参照している文字列）
  USAGE: 'usage',        // 使われ方（読み書きの回数・読んで計算して書き戻す形）
  VERIFIED: 'verified',  // 逆アセンブルして確かめたもの
  STRUCT: 'struct',      // 構造（オフセット・大きさの整合）
};

/* 1 つの系統だけで到達できる尤度比の上限。
   名前がどれだけ当たっても、それだけでは 60 倍を超えられない。 */
const FAMILY_CAP = {
  [FAMILY.NAME]: 60,
  [FAMILY.TYPE]: 6,
  [FAMILY.CONTEXT]: 25,
  [FAMILY.USAGE]: 30,
  [FAMILY.STRUCT]: 12,
  [FAMILY.VERIFIED]: 4000,   // 実測だけは強い。ただし後述のとおり単独では確定にしない
};

/* ── 証拠の表 ────────────────────────────────────────────────
 *
 *   lr     … 尤度比。1 より大きければ「本物らしい」、小さければ「本物らしくない」。
 *   family … 系統
 *   kind   … 'verified'（逆アセンブルで確かめた） / 'fact'（バイナリから直接読めた） /
 *            'inference'（そこから組み立てた解釈）
 *   id     … **その目的に結びつける証拠**かどうか（後述）。
 *
 * ここでいちばん大事なのが `id` の印。
 *
 * 「この位置は 4 バイトの整数で、バトルのクラスにあって、読んで計算して
 * 書き戻されている」——これは全部、逆アセンブルで確かめられる立派な事実だが、
 * **それが HP なのか防御力なのかスタミナなのかは何も言っていない**。
 * バトルのクラスにある数値は、どれもこの条件を満たしてしまう。
 *
 * この区別を持たないと、「防御力を探したら HP が確定で出てくる」という、
 * いちばんやってはいけない間違いが起きる（実際に起きた）。
 * だから目的に結びつける証拠（名前・目的の文言・目的の語を含むメソッド名）と、
 * それを裏打ちするだけの証拠（型・大きさ・読み書きの形）を分けて扱う。
 *
 *   - 結びつける証拠が 1 つも無ければ、確定は名乗らせない。
 *   - 結びつける証拠が弱ければ、裏打ちの証拠の効きも一緒に弱める
 *     （裏打ちは、結びつきがあって初めて意味を持つため）。
 *
 * 数字はここに集めてある。画面に出るのはこの数字そのもの。
 */
export const EVIDENCE = {
  /* 値（フィールド）を特定するための証拠 */
  'field-name-exact':   { lr: 55,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'field-name-strong':  { lr: 16,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'field-name-weak':    { lr: 3,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'property-name':      { lr: 10,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'accessor-name':      { lr: 8,    family: FAMILY.NAME,     kind: 'fact' },
  'class-name':         { lr: 3.5,  family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  // 担当が「バトル」なのは HP も攻撃力も防御力も同じ。目的 1 つには結びつかない。
  'class-category':     { lr: 3,    family: FAMILY.CONTEXT,  kind: 'inference' },
  'sibling-fields':     { lr: 2.6,  family: FAMILY.CONTEXT,  kind: 'inference' },
  'class-string':       { lr: 2.4,  family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'selector-match':     { lr: 3,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },

  'type-numeric':       { lr: 2.2,  family: FAMILY.TYPE,     kind: 'fact' },
  'type-declared':      { lr: 3,    family: FAMILY.TYPE,     kind: 'fact' },
  'type-conflict':      { lr: 0.06, family: FAMILY.TYPE,     kind: 'fact' },
  'size-fits':          { lr: 1.6,  family: FAMILY.STRUCT,   kind: 'fact' },

  'rmw-observed':       { lr: 6,    family: FAMILY.USAGE,    kind: 'fact' },
  'compare-observed':   { lr: 2.4,  family: FAMILY.USAGE,    kind: 'fact' },
  'written-in-class':   { lr: 3.2,  family: FAMILY.USAGE,    kind: 'fact' },
  'usage-balanced':     { lr: 1.9,  family: FAMILY.USAGE,    kind: 'fact' },
  'usage-none':         { lr: 0.3,  family: FAMILY.USAGE,    kind: 'fact' },

  /*
   * 逆アセンブルして実際に確かめたもの。
   * これは「表に書いてある名前と位置の対応が本当か」を確かめる証拠であって、
   * 「その値がこの目的のものか」を確かめる証拠ではない。だから id は付けない。
   */
  'getter-verified':    { lr: 40,   family: FAMILY.VERIFIED, kind: 'verified' },
  'setter-verified':    { lr: 40,   family: FAMILY.VERIFIED, kind: 'verified' },
  'access-verified':    { lr: 12,   family: FAMILY.VERIFIED, kind: 'verified' },
  'rmw-verified':       { lr: 20,   family: FAMILY.VERIFIED, kind: 'verified' },
  'guard-verified':     { lr: 9,    family: FAMILY.VERIFIED, kind: 'verified' },

  /* クラス表のないバイナリで、名前のない「場所」を特定するための証拠 */
  'loc-rmw':            { lr: 9,    family: FAMILY.VERIFIED, kind: 'verified' },
  'loc-guard':          { lr: 4,    family: FAMILY.VERIFIED, kind: 'verified' },
  // 名前が無いときに、目的へ結びつけられる唯一の糸がこれ
  'loc-in-goal-fn':     { lr: 7,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'loc-shared':         { lr: 3.2,  family: FAMILY.USAGE,    kind: 'fact' },
  'loc-size':           { lr: 1.7,  family: FAMILY.STRUCT,   kind: 'fact' },
  'loc-not-stack':      { lr: 2.2,  family: FAMILY.STRUCT,   kind: 'fact' },
  'loc-arith':          { lr: 2.6,  family: FAMILY.USAGE,    kind: 'fact' },

  /* 処理（関数）を特定するための証拠 */
  'fn-name-exact':      { lr: 30,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'fn-name-match':      { lr: 9,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'fn-selector':        { lr: 7,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'fn-string-ref':      { lr: 6,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  // すでに特定できている値を触っている＝目的に結びついている
  'fn-touches-field':   { lr: 14,   family: FAMILY.VERIFIED, kind: 'verified', id: true },
  'fn-writes-field':    { lr: 26,   family: FAMILY.VERIFIED, kind: 'verified', id: true },
  'fn-owner-class':     { lr: 3.4,  family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'fn-numeric':         { lr: 2.2,  family: FAMILY.USAGE,    kind: 'fact' },
  'fn-called-often':    { lr: 1.7,  family: FAMILY.USAGE,    kind: 'fact' },
  'fn-too-large':       { lr: 0.45, family: FAMILY.USAGE,    kind: 'inference' },
  'fn-caller-match':    { lr: 2.6,  family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'fn-callee-match':    { lr: 2.8,  family: FAMILY.CONTEXT,  kind: 'fact', id: true },

  /* ── 関数の「役割」を名指しするための証拠（role.js） ──────
   *
   * ここで決めたいのは値ではなく **処理の名前** —
   * 「sub_100A3C0 は、アイテムの所持数を 1 増やす処理である」。
   * 主張が 2 つに分かれるので、証拠も 2 系統に分けてある。
   *
   *   どう加工するか（動詞）… 命令の形そのもの。逆アセンブルで確かめられる。
   *   何の話か（対象）      … 名前・文言。人が付けたものだけが手がかり。
   *
   * 動詞の証拠は、どれだけ強くても「何の値か」を何ひとつ言っていない。
   * だから id を付けるのは対象側だけ。ここを混ぜると
   * 「+1 している処理はぜんぶアイテム獲得」になってしまう。
   */
  'role-verb-rmw':      { lr: 14,   family: FAMILY.VERIFIED, kind: 'verified' },
  'role-verb-imm':      { lr: 5,    family: FAMILY.VERIFIED, kind: 'verified' },
  'role-verb-api':      { lr: 6,    family: FAMILY.CONTEXT,  kind: 'fact' },
  'role-verb-shape':    { lr: 2.4,  family: FAMILY.USAGE,    kind: 'fact' },
  'role-verb-none':     { lr: 0.4,  family: FAMILY.USAGE,    kind: 'inference' },

  'role-subject-field': { lr: 22,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'role-subject-prop':  { lr: 8,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'role-subject-unnamed': { lr: 0.5, family: FAMILY.NAME,    kind: 'inference' },

  'role-topic-name':    { lr: 18,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'role-topic-selector':{ lr: 9,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'role-topic-string':  { lr: 6,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'role-topic-class':   { lr: 4,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'role-topic-callee':  { lr: 3,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  'role-topic-caller':  { lr: 2.6,  family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  // 別々の出どころが同じ機能を指している。手がかり 1 本ぶんより強い。
  'role-topic-agree':   { lr: 3,    family: FAMILY.USAGE,    kind: 'inference' },
  // 手がかりが別々の機能を指している。名指しの邪魔になるので、下げる。
  'role-topic-conflict':{ lr: 0.35, family: FAMILY.CONTEXT,  kind: 'inference' },
};

/** その証拠は「目的に結びつける」ものか。裏打ちするだけのものか。 */
export function isIdentifying(code) {
  const e = EVIDENCE[code];
  return !!(e && e.id);
}

export function evidenceInfo(code) { return EVIDENCE[code] || null; }
export function evidenceFamily(code) {
  const e = EVIDENCE[code];
  return e ? e.family : FAMILY.CONTEXT;
}
export function evidenceKind(code) {
  const e = EVIDENCE[code];
  return e ? e.kind : 'inference';
}

/**
 * 証拠 1 件。
 * @param {string} code    EVIDENCE の鍵
 * @param {number} [strength] 0..1。手がかりの濃さ。尤度比を lr^strength にする。
 * @param {object} [detail] 画面に出すための材料（名前・アドレス・回数…）
 */
export function evidence(code, strength, detail) {
  const info = EVIDENCE[code];
  const s = strength == null ? 1 : Math.max(0, Math.min(1, strength));
  return {
    code,
    strength: s,
    lr: info ? info.lr : 1,
    family: info ? info.family : FAMILY.CONTEXT,
    kind: info ? info.kind : 'inference',
    id: !!(info && info.id),
    detail: detail || null,
  };
}

/*
 * 同じ系統の証拠が重なったときの割引。
 * 1 件目はそのまま、2 件目は半分、3 件目は 1/4 …と効きを落とす。
 * 「名前が 3 通りの書き方で一致した」を 3 つぶんの証拠として数えないため。
 */
function damping(nth) {
  if (nth <= 0) return 1;
  return 1 / (1 + nth * 1.2);
}

const LN = Math.log;

/**
 * 証拠を合成する。
 *
 * @param {Array} items    evidence() の配列
 * @param {object} opts
 *   candidates  候補の総数（事前オッズをここから決める）。省略時は 200。
 *   absent      「そもそもこのバイナリに答えが無い」ぶんの重み。既定 40。
 *   prior       事前確率を直接与えたいとき（0..1）
 * @returns {{logOdds, probability, prior, items, families, verified, byFamily}}
 */
export function fuse(items, opts) {
  const o = opts || {};
  /*
   * 事前オッズは候補の数から決める。ここで大事なのは、選択肢の中に
   * **「どれでもない」** を必ず入れておくこと。値が 5 個しかないバイナリで
   * 「5 個のうちどれか」を前提にすると、ろくな根拠がなくても 20% から始まってしまう。
   * 実際には「この目的の値は、このバイナリには無い」ことの方が多い。
   */
  const absent = o.absent != null ? o.absent : 40;
  const n = Math.max(2, (o.candidates != null ? o.candidates : 200) + absent);
  const prior = o.prior != null
    ? Math.max(1e-9, Math.min(0.5, o.prior))
    : 1 / n;
  let logOdds = LN(prior / (1 - prior));

  // 系統ごとに、割引を掛けながら足す
  const perFamily = new Map();
  const counted = new Map();          // 同じ code が何回目か
  const detailed = [];

  const byEffect = (a, b) => {
    // 効きの大きいものから採る。割引は後ろに回した方が損が小さい。
    const ea = Math.abs(LN(Math.max(1e-6, a.lr)) * a.strength);
    const eb = Math.abs(LN(Math.max(1e-6, b.lr)) * b.strength);
    return eb - ea;
  };
  const all = (items || []).filter((x) => x && x.code);
  /*
   * 目的に結びつける証拠を先に処理する。そのあとで、裏打ちの証拠を
   * 「結びつきがどれだけ強いか」に応じて割り引く。順番に意味がある。
   */
  const identifying = all.filter((x) => x.id).sort(byEffect);
  const corroborating = all.filter((x) => !x.id).sort(byEffect);

  const apply = (it, scale) => {
    const lr = Math.max(1e-6, it.lr);
    const family = it.family || FAMILY.CONTEXT;
    const key = family + ':' + it.code;
    const nth = counted.get(key) || 0;
    counted.set(key, nth + 1);

    // 1 件の効き（対数オッズ）。濃さで指数を落とし、重複で割り引く。
    let delta = LN(lr) * (it.strength == null ? 1 : it.strength) * damping(nth);
    // 打ち消す証拠（尤度比が 1 未満）は割り引かない。危険側に倒さないため。
    if (delta > 0) delta *= scale;

    // 系統ごとの上限。名前だけで確定させないための歯止め。
    const cap = LN(FAMILY_CAP[family] != null ? FAMILY_CAP[family] : 20);
    const already = perFamily.get(family) || 0;
    if (delta > 0) {
      const room = Math.max(0, cap - already);
      if (delta > room) delta = room;
    }
    perFamily.set(family, already + delta);

    if (delta !== 0) {
      logOdds += delta;
      detailed.push(Object.assign({}, it, {
        applied: delta,
        factor: Math.exp(delta),         // 「×12 倍」として出せる形
        nth,
      }));
    }
    return delta;
  };

  let idLogOdds = 0;
  for (const it of identifying) {
    const d = apply(it, 1);
    if (d > 0) idLogOdds += d;
  }

  /*
   * 裏打ちの証拠の効き。
   *
   * 「4 バイトの整数で、バトルのクラスにあって、読んで計算して書き戻されている」は、
   * その値が **ゲームの数値であること** の証拠にはなるが、**どの数値か** は言っていない。
   * だから目的への結びつきが無いときは、ほとんど効かせない（2 割）。
   * 結びつきが十分に強ければ（10 倍以上）、そのまま効かせる。
   */
  const scale = 0.2 + 0.8 * Math.max(0, Math.min(1, idLogOdds / LN(10)));
  for (const it of corroborating) apply(it, scale);

  const probability = 1 / (1 + Math.exp(-logOdds));
  const families = new Set();
  let verified = 0;
  for (const d of detailed) {
    if (d.applied > 0) families.add(d.family);
    if (d.kind === 'verified' && d.applied > 0) verified++;
  }

  return {
    logOdds,
    probability,
    prior,
    items: detailed.sort((a, b) => b.applied - a.applied),
    families: Array.from(families),
    verified,
    identifying: idLogOdds,
    corroborationScale: scale,
    byFamily: Object.fromEntries(perFamily),
  };
}

/* ── 決着 ────────────────────────────────────────────────────
 *
 * 「一発で確定させる」のがこのツールの狙いだが、確定と言えないものを
 * 確定と言うのは、何も言わないより悪い。だから条件は厳しくする。
 *
 *   確定 (confirmed)  … 逆アセンブルで確かめた証拠が 1 つ以上あり、
 *                       独立した系統が 3 つ以上、確率 99% 以上、
 *                       2 位との差が 20 倍以上。
 *   有力 (likely)     … 確率 85% 以上で、2 位との差が 4 倍以上。
 *   割れている (ambiguous) … 上位が拮抗している。何が足りないかを言う。
 *   なし (none)
 */

export const VERDICT = {
  CONFIRMED: 'confirmed',
  LIKELY: 'likely',
  AMBIGUOUS: 'ambiguous',
  NONE: 'none',
};

const CONFIRM = { p: 0.99, margin: LN(20), families: 3 };
const LIKELY = { p: 0.85, margin: LN(4) };

const VERDICT_ORDER = { none: 0, ambiguous: 1, likely: 2, confirmed: 3 };

/** 決着の強さを比べる。UI と auto.js の並び替えはこれ 1 本に寄せる。 */
export function verdictRank(v) { return VERDICT_ORDER[v] || 0; }

/**
 * 並べた候補から結論を出す。
 *
 * @param {Array} ranked  [{fusion:{logOdds, probability, verified, families}, ...}] 降順
 * @param {object} [opts]
 *   maxVerdict  これより上には行かせない。名前が読めない相手（クラス表のない
 *               バイナリの「+0x20 の値」など）を「確定」と呼ばないために使う。
 * @returns {{verdict, top, runnerUp, margin, marginRatio, missing:Array<string>}}
 */
export function decide(ranked, opts) {
  const list = (ranked || []).filter((c) => c && c.fusion);
  if (!list.length) return { verdict: VERDICT.NONE, top: null, runnerUp: null, margin: 0, marginRatio: 1, missing: ['no-candidate'] };

  const top = list[0];
  const runnerUp = list[1] || null;
  const margin = runnerUp ? top.fusion.logOdds - runnerUp.fusion.logOdds : Infinity;
  const marginRatio = Number.isFinite(margin) ? Math.exp(margin) : Infinity;

  const missing = [];
  /*
   * まず、目的に結びつける証拠があるか。
   * これが無いまま確定を名乗ると「防御力を探したら HP が確定で出る」ことになる。
   * 命令で確かめたかどうかとは、まったく別の話。
   */
  if (!(top.fusion.identifying > 0)) missing.push('need-name-evidence');
  if (!top.fusion.verified) missing.push('need-verification');
  if (top.fusion.families.length < CONFIRM.families) missing.push('need-independent-evidence');
  if (top.fusion.probability < CONFIRM.p) missing.push('need-more-evidence');
  if (margin < CONFIRM.margin) missing.push('need-separation');

  let verdict = VERDICT.NONE;
  if (!missing.length) verdict = VERDICT.CONFIRMED;
  else if (top.fusion.probability >= LIKELY.p && margin >= LIKELY.margin) verdict = VERDICT.LIKELY;
  else if (top.fusion.probability >= 0.35 || (runnerUp && margin < LIKELY.margin)) verdict = VERDICT.AMBIGUOUS;
  else verdict = VERDICT.NONE;

  /*
   * 目的に結びつく手がかりが無いものは、どれだけ形が確かでも「見つかった」とは言わない。
   * 「バトルのクラスにある、読み書きされている 4 バイトの整数」は、
   * 防御力の答えではなく、ただのゲームの数値でしかない。
   */
  if (!(top.fusion.identifying > 0) && verdictRank(verdict) > verdictRank(VERDICT.AMBIGUOUS)) {
    verdict = VERDICT.AMBIGUOUS;
  }

  /*
   * 名前が読めない相手（クラス表のないバイナリの「+0x20 の値」）は、
   * どれだけ形が確かめられても確定とは呼ばない。名前が無いこと自体が
   * 「足りないもの」なので、天井に当たったかどうかに関わらず必ず書き残す。
   */
  const cap = opts && opts.maxVerdict;
  if (cap && verdict !== VERDICT.NONE) {
    if (verdictRank(verdict) > verdictRank(cap)) verdict = cap;
    if (!missing.includes('no-name')) missing.push('no-name');
  }

  return { verdict, top, runnerUp, margin, marginRatio, missing };
}

/** 確率 → ★ の数。決着の言葉と食い違わないように、ここで一本化する。 */
export function starsOf(probability, verdict) {
  if (verdict === VERDICT.CONFIRMED) return 5;
  if (probability >= 0.85) return 4;
  if (probability >= 0.5) return 3;
  if (probability >= 0.15) return 2;
  return 1;
}

/**
 * 内訳を、画面にそのまま並べられる形にまとめる。
 * 同じ理由が何度も出ないよう、code ごとに束ねて効きの大きい順にする。
 */
export function explain(fusion, limit = 12) {
  if (!fusion) return [];
  const merged = new Map();
  for (const it of fusion.items) {
    const key = it.code;
    if (!merged.has(key)) {
      merged.set(key, {
        code: it.code, family: it.family, kind: it.kind,
        applied: 0, count: 0, detail: it.detail,
      });
    }
    const m = merged.get(key);
    m.applied += it.applied;
    m.count++;
    if (!m.detail) m.detail = it.detail;
  }
  return Array.from(merged.values())
    .map((m) => Object.assign(m, { factor: Math.exp(m.applied) }))
    .sort((a, b) => Math.abs(b.applied) - Math.abs(a.applied))
    .slice(0, limit);
}

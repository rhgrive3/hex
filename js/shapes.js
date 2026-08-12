/*
 * 名前のないアプリで、値を「ふるまい」から見分ける層。
 *
 * worker の scanValueShapes が集めてくるのは、こういう出来事の山:
 *
 *     0x1004a2b0  +0x2c を 4 バイトぶん減らした。0 で止めた。
 *                 引いた量は、別のオブジェクトの +0x18 から来ていた。
 *
 * 1 件ずつ見ても何も分からない。18 MB のコードから数万件出てくる。
 * ところが **同じ位置で集計する** と、いきなり顔つきが出る。
 *
 *     +0x2c … 37 か所で減る。うち 31 か所は 0 で止める。減らす量は別オブジェクト
 *             から来る。増える場所も 8 か所ある。
 *             → 減って、増えて、0 で止まる。これは体力・残量のたぐい。
 *
 *     +0x18 … 自分はほとんど変わらない。なのに 24 か所で「+0x2c を減らす量」
 *             として読まれている。しかも倍率が掛かっている。
 *             → 他人の体力を減らすための数。これが攻撃力。
 *
 * ここが大事なところで、**攻撃力は「攻撃力である」という証拠を自分では持たない**。
 * 攻撃力が攻撃力であるゆえんは、体力を減らすのに使われていることだけ。
 * だから体力を先に決めて、そこから攻撃力へ降りる。順番に意味がある。
 *
 * 日本語は作らない。返すのは構造と数だけ（文にするのは narrate.js）。
 */

/* worker と同じ印。ここが食い違うと静かに壊れるので、値は直接書く。 */
export const SHAPE = {
  DECREASE: 1,
  INCREASE: 2,
  CLAMP: 4,
  CROSS: 8,
  SCALED: 16,
};
export const AMOUNT = { NONE: 0, FIELD: 1, IMM: 2, CALL: 3 };

/* ── 入れ物の大きさで、ゲームの値と C++ の容器を分ける ────────
 *
 * std::vector の要素数・shared_ptr の参照カウンタ・std::string の長さは、
 * どれも +0x0 / +0x8 / +0x10 にあって、減って増えて 0 で止まる。
 * ゲームの体力とふるまいがまったく同じなので、形だけでは選り分けられない。
 * 分かれるのは **入れ物の大きさ** で、そこは走査中に実際に見たずらし幅で決まる。
 *
 *   容器        … そのポインタは 0x0〜0x18 しか触られない
 *   ゲーム構造体 … 同じポインタが +0x2c も +0x9f4 も触る
 */
const CONTAINER_SPAN = 0x20;     // これ以下しか触られない入れ物は、容器の頭とみなす
const BIG_OBJECT = 0x80;         // これ以上のずらし幅がある入れ物は、値の多い構造体
const BIG_RATIO = 0.25;          // 大きい入れ物での出現がこの割合を下回れば、容器の頭

/**
 * 出来事の山を、位置ごとにまとめる。
 *
 * @param {object} scan backend.valueShapes() の結果
 * @returns {Map<number, object>} ずらし幅 → その位置のふるまい
 */
export function foldShapes(scan) {
  const out = new Map();
  if (!scan || !scan.count) return out;
  const { disp, size, flags, amtKind, amtDisp, addr } = scan;
  const span = scan.span || null;

  for (let i = 0; i < scan.count; i++) {
    const d = disp[i];
    let e = out.get(d);
    if (!e) {
      e = {
        offset: d, size: size[i],
        decreases: 0, increases: 0, clamped: 0, crossObject: 0, scaled: 0,
        // この位置を減らすのに使われた「量」の出どころ
        amountFrom: new Map(),      // ずらし幅 → 回数
        amountFromCall: 0,
        amountFromImm: 0,
        sites: [],
        // 逆向き: この位置が「他の位置を減らす量」として使われた回数
        usedAsAmount: 0,
        usedAgainst: new Map(),     // 相手のずらし幅 → 回数
        usedScaled: 0,
        usedCross: 0,
        /*
         * その位置を持っているオブジェクトの大きさ。
         * いちばん大きかったものではなく **何件が大きい入れ物だったか** を数える。
         * 最大値だけを見ると、2000 件のうち 1 件が大きいだけで
         * 「これは大きな構造体だ」になってしまう。
         */
        objectSpan: 0,
        events: 0,
        inBigObject: 0,
      };
      out.set(d, e);
    }
    e.events++;
    if (span) {
      if (span[i] > e.objectSpan) e.objectSpan = span[i];
      if (span[i] >= BIG_OBJECT) e.inBigObject++;
    }
    const f = flags[i];
    if (f & SHAPE.DECREASE) e.decreases++;
    if (f & SHAPE.INCREASE) e.increases++;
    if (f & SHAPE.CLAMP) e.clamped++;
    if (f & SHAPE.CROSS) e.crossObject++;
    if (f & SHAPE.SCALED) e.scaled++;
    if (e.sites.length < 8) e.sites.push({ addr: addr[i], flags: f });

    if (amtKind[i] === AMOUNT.FIELD) {
      const a = amtDisp[i];
      e.amountFrom.set(a, (e.amountFrom.get(a) || 0) + 1);
    } else if (amtKind[i] === AMOUNT.CALL) e.amountFromCall++;
    else if (amtKind[i] === AMOUNT.IMM) e.amountFromImm++;
  }

  /*
   * 逆向きの索引。「攻撃力」はこちら側からしか見えない。
   *
   * 攻撃力は自分では 1 度も増減しないので、行き側の集計には出てこない。
   * 出てくるのは「誰かを減らすのに使われた量」としてだけ。だから
   * 大きさと入れ物の大きさも、量の側で観測したものを使う。
   * ここを取り違えると、攻撃力を C++ の容器の頭として捨ててしまう。
   */
  const amtSize = scan.amtSize || null;
  const amtSpan = scan.amtSpan || null;
  for (let i = 0; i < scan.count; i++) {
    if (amtKind[i] !== AMOUNT.FIELD) continue;
    if (!(flags[i] & SHAPE.DECREASE)) continue;      // 減らすのに使われたときだけ
    const a = amtDisp[i];
    let src = out.get(a);
    if (!src) {
      src = {
        offset: a, size: 0,
        decreases: 0, increases: 0, clamped: 0, crossObject: 0, scaled: 0,
        amountFrom: new Map(), amountFromCall: 0, amountFromImm: 0, sites: [],
        usedAsAmount: 0, usedAgainst: new Map(), usedScaled: 0, usedCross: 0,
        objectSpan: 0, events: 0, inBigObject: 0,
      };
      out.set(a, src);
    }
    // 量の側で観測した大きさ。行き側で 1 度も現れない値には、これしか手がかりがない。
    if (!src.size && amtSize && amtSize[i]) src.size = amtSize[i];
    const sp = amtSpan ? amtSpan[i] : (span ? span[i] : 0);
    if (sp > src.objectSpan) src.objectSpan = sp;
    src.events++;
    if (sp >= BIG_OBJECT) src.inBigObject++;
    src.usedAsAmount++;
    src.usedAgainst.set(disp[i], (src.usedAgainst.get(disp[i]) || 0) + 1);
    if (flags[i] & SHAPE.SCALED) src.usedScaled++;
    if (flags[i] & SHAPE.CROSS) src.usedCross++;
  }
  return out;
}

/**
 * その位置は、C++ の容器の頭（要素数・参照カウンタ・文字列の長さ）ではないか。
 *
 * 前寄りのずらし幅で、しかも **ほとんどの出現が小さい入れ物の中** なら容器。
 * 「いちばん大きかったとき」ではなく割合で見る。2000 件のうち 1 件が
 * 大きな構造体だっただけで、ゲームの値に格上げしてはいけない。
 */
function looksLikeContainerHead(e) {
  if (e.offset >= CONTAINER_SPAN) return false;
  const events = e.events || 1;
  const ratio = (e.inBigObject || 0) / events;
  return ratio < BIG_RATIO;
}

/**
 * ゲームの数値として、その大きさはありうるか。
 *
 * 体力・攻撃力・所持金はどれも 4 バイトの整数（まれに 2 バイト）で持つ。
 * 8 バイトで持たれているものは、たいていポインタか、ミリ秒の時刻・締め切り。
 * ここを見ないと「15000 ミリ秒の待ち時間」が攻撃力の 1 位に出てくる。
 */
function plausibleStatSize(e) {
  if (!e.size) return true;            // 観測していない = 除く理由がない
  return e.size === 4 || e.size === 2;
}

/*
 * 「減って、増えて、0 で止まる」ものほど資源らしい。
 *
 * ただの下がるだけのカウンタ（残り時間、ループの残り回数）と分けたいので、
 * 増える場所があること・0 で止めていることの両方を見る。
 */
function resourceScore(e) {
  if (!e.decreases) return 0;
  if (looksLikeContainerHead(e) || !plausibleStatSize(e)) return 0;
  let s = Math.min(1, e.decreases / 6) * 0.4;
  if (e.increases) s += Math.min(1, e.increases / 4) * 0.25;
  if (e.clamped) s += Math.min(1, e.clamped / Math.max(1, e.decreases)) * 0.2;
  if (e.crossObject) s += Math.min(1, e.crossObject / 3) * 0.15;
  /*
   * 大きな構造体の中にある値ほど、ゲームの数値らしい。
   * 容器の頭かどうかの線引きだけでは、境目のものを取りこぼす。
   */
  if ((e.inBigObject || 0) / (e.events || 1) >= 0.5) s = Math.min(1, s + 0.1);
  return Math.min(1, s);
}

/**
 * 「減らされる資源」を強い順に。体力・残量・所持金がここに出る。
 * @returns {Array<object>}
 */
export function resources(folded, limit = 12) {
  const out = [];
  for (const e of folded.values()) {
    const score = resourceScore(e);
    if (score <= 0) continue;
    out.push(Object.assign({}, e, { score, role: 'resource' }));
  }
  out.sort((a, b) => b.score - a.score ||
    (b.decreases + b.increases) - (a.decreases + a.increases));
  return out.slice(0, limit);
}

/*
 * 「他人の資源を減らすための数」らしさ。
 *
 * 自分はほとんど変わらないのに、他のオブジェクトの資源を減らす量として
 * 何度も読まれている。倍率が掛かっていればなおさら（攻撃力 × レベル補正）。
 * 逆に自分がしょっちゅう増減しているなら、それは資源のほうであって攻撃力ではない。
 */
function damageSourceScore(e, resourceOffsets) {
  if (!e.usedAsAmount) return 0;
  if (looksLikeContainerHead(e) || !plausibleStatSize(e)) return 0;
  let s = Math.min(1, e.usedAsAmount / 4) * 0.45;
  if (e.usedCross) s += Math.min(1, e.usedCross / 3) * 0.25;
  if (e.usedScaled) s += Math.min(1, e.usedScaled / 3) * 0.15;
  // 相手が「資源らしい値」なら、その分だけ強い
  let againstResource = 0;
  for (const [off, n] of e.usedAgainst) {
    if (resourceOffsets.has(off)) againstResource += n;
  }
  if (againstResource) s += Math.min(1, againstResource / 3) * 0.25;
  // 自分が動く値なら、それは「引く量」ではなく資源のほう
  const churn = e.decreases + e.increases;
  if (churn > e.usedAsAmount) s *= 0.3;
  return Math.min(1, s);
}

/**
 * 「他人の資源を減らす量」を強い順に。攻撃力・威力がここに出る。
 *
 * @param {Map} folded
 * @param {Array} res resources() の結果（相手が資源かどうかを見るのに使う）
 */
export function damageSources(folded, res, limit = 12) {
  const resourceOffsets = new Set((res || []).map((r) => r.offset));
  const out = [];
  for (const e of folded.values()) {
    const score = damageSourceScore(e, resourceOffsets);
    if (score <= 0) continue;
    out.push(Object.assign({}, e, { score, role: 'damage-source' }));
  }
  out.sort((a, b) => b.score - a.score || b.usedAsAmount - a.usedAsAmount);
  return out.slice(0, limit);
}

/**
 * ずらし幅 1 つぶんの「ふるまいから言えること」を、証拠の材料にして返す。
 *
 * pinpointLocation は「命令の形」までは見ているが、それはコード全体での
 * ふるまいを何も見ていない。ここがその欠けている側を埋める。
 *
 * @param {Map} folded foldShapes の結果
 * @param {number} offset
 * @param {string} goalId
 * @returns {{codes:Array<{code:string, strength:number, detail:object}>, shape:object}|null}
 */
export function evidenceFor(folded, offset, goalId) {
  if (!folded || !folded.size) return null;
  const e = folded.get(offset);
  if (!e) return null;
  const codes = [];

  if (looksLikeContainerHead(e)) {
    codes.push({
      code: 'loc-container-head',
      strength: 1,
      detail: { offset, events: e.events, objectSpan: e.objectSpan },
    });
    return { codes, shape: e };
  }

  const res = resources(folded, 24);
  const resourceOffsets = new Set(res.map((r) => r.offset));

  if (goalId === 'attack' || goalId === 'damage') {
    const s = damageSourceScore(e, resourceOffsets);
    if (s > 0) {
      codes.push({
        code: 'loc-damage-source',
        strength: s,
        detail: {
          offset, usedAsAmount: e.usedAsAmount, crossObject: e.usedCross,
          scaled: e.usedScaled,
          against: Array.from(e.usedAgainst.keys()).slice(0, 3),
        },
      });
    }
  } else if (goalId === 'hp' || goalId === 'stamina') {
    // 体力は「よそから減らされる」。そこが所持金との分かれ目。
    if (resourceScore(e) > 0 && (e.crossObject > 0 || e.amountFromCall > 0)) {
      codes.push({
        code: 'loc-resource-drain',
        strength: resourceScore(e),
        detail: {
          offset, decreases: e.decreases, increases: e.increases,
          clamped: e.clamped, crossObject: e.crossObject,
        },
      });
    }
  } else if (goalId === 'money' || goalId === 'score' || goalId === 'item') {
    // 所持金は自分のオブジェクトの中だけで増減する（誰かに殴られたりしない）
    if (resourceScore(e) > 0 && e.crossObject === 0) {
      codes.push({
        code: 'loc-self-resource',
        strength: resourceScore(e),
        detail: {
          offset, decreases: e.decreases, increases: e.increases, clamped: e.clamped,
        },
      });
    }
  }
  return codes.length ? { codes, shape: e } : { codes: [], shape: e };
}

/**
 * 目的 → そのふるまいを持つ値の並び。
 *
 * ここが「名前が 1 文字も残っていないアプリ」で答えを出せる唯一の入口になる。
 * 目的ごとに見るべき形が違うので、その対応だけをここに書く。
 *
 * @param {Map} folded foldShapes の結果
 * @param {string} goalId
 * @returns {Array<object>} 強い順
 */
export function byGoal(folded, goalId, limit = 8) {
  const res = resources(folded, 24);
  switch (goalId) {
    case 'attack':
    case 'damage':
      return damageSources(folded, res, limit);
    case 'hp':
    case 'stamina':
      // 体力は「別のオブジェクトから減らされる」もの。所持金と分ける決め手がこれ。
      return res.filter((e) => e.crossObject > 0 || e.amountFromCall > 0).slice(0, limit);
    case 'money':
    case 'score':
      // 所持金は自分のオブジェクトの中で完結して増減する（誰かに殴られたりしない）
      return res.filter((e) => e.crossObject === 0).slice(0, limit);
    case 'level':
    case 'item':
      return res.slice(0, limit);
    default:
      return [];
  }
}

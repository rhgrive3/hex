/*
 * 「何を調べたいですか？」 — 目的から入るための語彙。
 *
 * 初心者は関数名を知らない。知っているのは「攻撃力を増やしたい」「コインを調べたい」
 * という目的だけ。そこでまず目的を受け取り、それをバイナリの中で探せる形
 * （語の並び ＋ 期待される命令の形）に翻訳する。
 *
 * ここは語彙だけを持ち、点数付けはしない（点数は rank.js）。
 * 日本語で書かれたアプリと英語で書かれたアプリの両方を想定して、
 * どちらの語も入れてある。
 *
 * 大事な注意: ここに並んでいるのは「手がかりの語」であって「正解」ではない。
 * 語が一致しただけでは何も証明しない。証明の材料は参照関係と命令の実在（rank.js）。
 */
import { pick } from './i18n.js';

/*
 * 目的 1 つぶん。
 *   terms   … 手がかりの語。strong は具体的な語、weak はよくある一般語。
 *   expects … その目的の処理なら「命令の形として」何が出るはずか。
 *             numeric: 数値計算がある / store: 値を書き換える /
 *             compare: しきい値と比べる / call: ほかを呼ぶ
 */
export const GOALS = [
  {
    id: 'hp', ja: 'HP・体力', en: 'HP / health', icon: '❤️',
    strong: [/\bhp\b/i, /health/i, /\blife\b/i, /体力/, /ライフ/, /耐久/],
    weak: [/damage/i, /heal/i, /revive/i, /回復/, /死亡/, /\bdie\b/i],
    /*
     * health は体力とは限らない。広告 SDK の死活監視（healthCheck）や
     * 端末情報（healthPercentile）まで拾うと、HP を探した人に
     * IronSource の通信設定が並ぶ。同じことが lifecycle / lifetime にも起きる。
     */
    avoid: [
      /health[\s_-]*(check|monitor|status|state|report|percentile|kit)/i,
      /life[\s_-]*(cycle|time|span|line)/i,
    ],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'attack', ja: '攻撃力', en: 'Attack power', icon: '⚔️',
    strong: [/attack/i, /\batk\b/i, /power/i, /strength/i, /攻撃/, /こうげき/, /威力/],
    weak: [/damage/i, /weapon/i, /skill/i, /武器/, /スキル/],
    expects: { numeric: true, store: true },
  },
  {
    id: 'defense', ja: '防御力', en: 'Defence', icon: '🛡️',
    strong: [/defen[cs]e/i, /\bdef\b/i, /armor|armour/i, /resist/i, /防御/, /ぼうぎょ/, /耐性/],
    weak: [/guard/i, /shield/i, /盾/],
    expects: { numeric: true, store: true },
  },
  {
    id: 'damage', ja: 'ダメージ計算', en: 'Damage calculation', icon: '💥',
    strong: [/damage/i, /\bdmg\b/i, /ダメージ/, /被弾/],
    weak: [/critical/i, /hit/i, /attack/i, /クリティカル/, /命中/],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'money', ja: '所持金・コイン', en: 'Money and coins', icon: '🪙',
    strong: [/\bcoin/i, /\bgold\b/i, /\bgem\b/i, /jewel/i, /money/i, /currency/i, /wallet/i,
      /コイン/, /ゴールド/, /所持金/, /ジェム/, /石/, /通貨/],
    weak: [/balance/i, /amount/i, /price/i, /cost/i, /残高/, /金額/],
    /*
     * `currency` は `concurrency` の中にも入っている。これを外さないと
     * 所持金を探した人の首位が IronSource の
     * `useWaterfallLifecycleHolderConcurrency` になる（実際になっていた）。
     * `bid_floor_currency` のほうは綴りは正しいが、広告の入札下限額であって
     * ゲームの所持金ではないので、語ごと外す。
     */
    avoid: [/concurren(cy|t)/i, /\bbid[\s_-]*floor\w*/i, /price[\s_-]*floor\w*/i],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'gacha', ja: 'ガチャ・抽選', en: 'Gacha / loot', icon: '🎰',
    strong: [/gacha/i, /lottery/i, /\bdraw\b/i, /summon/i, /ガチャ/, /抽選/, /召喚/],
    weak: [/rate/i, /probability/i, /rare/i, /reward/i, /確率/, /レア/, /排出/],
    expects: { numeric: true, call: true },
  },
  {
    id: 'purchase', ja: '購入・課金', en: 'Purchases', icon: '💳',
    strong: [/purchase/i, /payment/i, /billing/i, /receipt/i, /storekit/i, /transaction/i,
      /subscription/i, /課金/, /購入/, /決済/, /レシート/],
    weak: [/price/i, /product/i, /restore/i, /価格/, /商品/],
    expects: { call: true, compare: true },
  },
  {
    id: 'login', ja: 'ログイン・認証', en: 'Login', icon: '🔑',
    strong: [/login/i, /logout/i, /sign_?in/i, /auth/i, /credential/i, /password/i, /token/i,
      /ログイン/, /認証/, /パスワード/],
    weak: [/account/i, /session/i, /user_?id/i, /アカウント/, /会員/],
    expects: { call: true, compare: true },
  },
  {
    id: 'ads', ja: '広告', en: 'Advertising', icon: '📺',
    strong: [/admob/i, /unityads/i, /applovin/i, /ironsource/i, /vungle/i, /tapjoy/i,
      /interstitial/i, /rewarded/i, /banner_?ad/i, /広告/],
    weak: [/\bads?\b/i, /impression/i, /campaign/i],
    expects: { call: true },
  },
  {
    id: 'save', ja: 'セーブ・保存', en: 'Save data', icon: '💾',
    strong: [/save_?data/i, /savefile/i, /autosave/i, /userdefault/i, /nskeyedarchiv/i,
      /セーブ/, /保存/, /記録/],
    weak: [/write/i, /store/i, /persist/i, /progress/i, /進行/],
    expects: { call: true, store: true },
  },
  {
    id: 'network', ja: '通信', en: 'Server communication', icon: '🌐',
    strong: [/https?:\/\//i, /nsurlsession/i, /endpoint/i, /\/api\//i, /\/v\d\//i,
      /websocket/i, /request/i, /通信/, /サーバー/],
    weak: [/response/i, /json/i, /header/i, /timeout/i, /接続/],
    expects: { call: true },
  },
  {
    id: 'score', ja: 'スコア', en: 'Score', icon: '🏆',
    strong: [/\bscore\b/i, /ranking/i, /leaderboard/i, /highscore/i, /スコア/, /得点/, /ランキング/],
    weak: [/point/i, /result/i, /record/i, /順位/],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'level', ja: 'レベル・経験値', en: 'Level and EXP', icon: '⬆️',
    strong: [/level_?up/i, /\blevel\b/i, /\bexp\b/i, /experience/i, /レベル/, /経験値/, /ランクアップ/],
    weak: [/upgrade/i, /grow/i, /rank/i, /強化/, /育成/],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'stamina', ja: 'スタミナ', en: 'Stamina', icon: '⚡',
    strong: [/stamina/i, /energy/i, /\bap\b/i, /スタミナ/, /行動力/],
    weak: [/recover/i, /consume/i, /回復/, /消費/],
    expects: { numeric: true, store: true, compare: true },
  },
  {
    id: 'item', ja: 'アイテム・所持品', en: 'Items', icon: '🎒',
    strong: [/inventory/i, /item_?id/i, /equipment/i, /アイテム/, /所持品/, /装備/],
    weak: [/count/i, /quantity/i, /material/i, /個数/, /素材/],
    expects: { numeric: true, store: true },
  },
  {
    id: 'anticheat', ja: 'チート対策・改造検知', en: 'Anti-cheat', icon: '🚨',
    strong: [/jailbreak|jailbroken/i, /cydia/i, /frida/i, /substrate/i, /tamper/i,
      /integrity/i, /debugger/i, /cheat/i, /改造/, /不正/],
    weak: [/detect/i, /verify/i, /signature/i, /検知/],
    expects: { compare: true, call: true },
  },
];

/* ── 値（フィールド）の名前をあてるための語彙 ────────────────
 *
 * 上の strong / weak は「画面に出る文言」を想定して書いてある。ところが
 * メンバ変数の名前はそれとは書き方がまるで違う。
 *
 *     文言:   「HP が足りません」「ダメージ %d」
 *     変数名:  _hp  _currentHP  m_hitPoint  hpMax
 *
 * さらに厄介なのは `\bhp\b` が `_hp` に当たらないこと（`_` は単語の文字なので
 * 単語の境目にならない）。これを直さないと、いちばん効くはずの
 * 「クラス表に書いてある名前」がまるごと素通りしてしまう。
 *
 * そこで名前を正規化してから当てる。`_currentHP` → `current hp`。
 * ついでに「今の値なのか、上限なのか、初期値なのか」（役割）も見る。
 * HP を増やしたい人が触りたいのは `hp` であって `maxHp` ではないので、
 * ここを見分けられるかどうかで「1 位が正解かどうか」が変わる。
 */

/** `_currentHP` → `current hp`。当てはめはすべてこの形に対してやる。 */
export function normalizeFieldName(name) {
  let s = String(name || '');
  s = s.replace(/^_+/, '').replace(/^m_/i, '').replace(/^s_/i, '').replace(/^g_/i, '');
  // camelCase / PascalCase を分ける。HPValue → HP Value のように連続大文字も守る。
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 開いた名前 haystack の中に、開いた語の並び needle がそのまま入っているか。 */
function wordSequence(haystack, needle) {
  const h = ' ' + haystack + ' ';
  const n = ' ' + needle + ' ';
  return h.indexOf(n) >= 0;
}

/** needle の語のうち、何割が haystack に入っているか。 */
function wordCoverage(haystack, needle) {
  const words = needle.split(' ').filter((w) => w.length >= 2);
  if (!words.length) return 0;
  const have = new Set(haystack.split(' '));
  let hit = 0;
  for (const w of words) if (have.has(w)) hit++;
  return hit / words.length;
}

/* 値の役割。同じ「hp」でも、今の値・上限・初期値では意味がまるで違う。 */
const ROLE_RULES = [
  { role: 'max', re: /\b(max|maximum|limit|cap|upper|full|総|最大)\b/ },
  { role: 'min', re: /\b(min|minimum|lower|最小)\b/ },
  { role: 'base', re: /\b(base|default|initial|init|origin|original|start|starting|素|基本|初期)\b/ },
  { role: 'delta', re: /\b(delta|diff|add|bonus|buff|modifier|mod|rate|ratio|percent|倍率|補正)\b/ },
  { role: 'count', re: /\b(count|num|number|times|total|len|length|size|回数|個数)\b/ },
  { role: 'flag', re: /\b(is|has|can|should|enabled|flag)\b/ },
  { role: 'current', re: /\b(cur|current|now|present|現在|今)\b/ },
];

/**
 * その名前が「今の値」なのか「上限」なのかを見分ける。
 * 何も付いていなければ 'plain'（＝素の値。たいていこれが本命）。
 */
export function fieldRole(name) {
  const s = normalizeFieldName(name);
  for (const r of ROLE_RULES) if (r.re.test(s)) return r.role;
  return 'plain';
}

/*
 * 目的ごとの、変数名としての語彙と、期待される型。
 *
 *   strong  … その目的の値なら、まずこの語が入っている
 *   weak    … 入っていることもある、程度
 *   type    … 'number'（整数か小数）/ 'bool' / 'text' / 'any'
 *   prefer  … 望ましい役割。ここが合うと上がり、外れると下がる。
 */
const FIELD_VOCAB = {
  hp: {
    strong: [/\bhp\b/, /\bhps\b/, /\bhealth\b/, /\bhit ?points?\b/, /\blife\b/, /\blives\b/,
      /体力/, /ライフ/, /耐久/],
    weak: [/\bvitality\b/, /\bvit\b/, /\bdurability\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  attack: {
    strong: [/\battack\b/, /\batk\b/, /\bpower\b/, /\bstrength\b/, /\bstr\b/, /\boffen[cs]e\b/,
      /攻撃/, /威力/],
    weak: [/\bdamage\b/, /\bdmg\b/, /\bweapon\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  defense: {
    strong: [/\bdefen[cs]e\b/, /\bdef\b/, /\barmou?r\b/, /\bresist(ance)?\b/, /\bguard\b/,
      /防御/, /耐性/],
    weak: [/\bshield\b/, /\bblock\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  damage: {
    strong: [/\bdamage\b/, /\bdmg\b/, /ダメージ/],
    weak: [/\bcritical\b/, /\bcrit\b/, /\bhit\b/],
    type: 'number', prefer: ['plain', 'delta'],
  },
  money: {
    strong: [/\bcoins?\b/, /\bgold\b/, /\bgems?\b/, /\bjewels?\b/, /\bmoney\b/, /\bcurrency\b/,
      /\bwallet\b/, /\bcash\b/, /\bcredits?\b/, /\bbalance\b/,
      /コイン/, /ゴールド/, /所持金/, /ジェム/, /通貨/],
    weak: [/\bamount\b/, /\bprice\b/, /\bcost\b/, /\bstone\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  gacha: {
    strong: [/\bgacha\b/, /\blottery\b/, /\bsummon\b/, /\bdraw\b/, /ガチャ/, /抽選/],
    weak: [/\brate\b/, /\bprobability\b/, /\bchance\b/, /\brarity\b/, /\bweight\b/],
    type: 'number', prefer: ['plain'],
  },
  purchase: {
    strong: [/\bpurchase\b/, /\bpayment\b/, /\bbilling\b/, /\breceipt\b/, /\btransaction\b/,
      /\bproduct\b/, /\bsubscription\b/, /課金/, /購入/],
    weak: [/\bprice\b/, /\bstore\b/, /\bpaid\b/],
    type: 'any', prefer: ['plain'],
  },
  login: {
    strong: [/\blogin\b/, /\bauth\b/, /\btoken\b/, /\bpassword\b/, /\bcredential\b/,
      /\bsession\b/, /\baccount\b/, /ログイン/, /認証/],
    weak: [/\buser\b/, /\buid\b/, /\bprofile\b/],
    type: 'any', prefer: ['plain'],
  },
  ads: {
    strong: [/\bads?\b/, /\binterstitial\b/, /\brewarded\b/, /\bbanner\b/, /\badmob\b/, /広告/],
    weak: [/\bimpression\b/, /\bplacement\b/],
    type: 'any', prefer: ['plain'],
  },
  save: {
    strong: [/\bsave\b/, /\bsave ?data\b/, /\bpersist\b/, /\barchive\b/, /\buser ?defaults?\b/,
      /セーブ/, /保存/],
    weak: [/\bstorage\b/, /\bcache\b/, /\bfile\b/],
    type: 'any', prefer: ['plain'],
  },
  network: {
    strong: [/\burl\b/, /\bendpoint\b/, /\brequest\b/, /\bresponse\b/, /\bhost\b/, /\bapi\b/,
      /\bsession\b/, /通信/],
    weak: [/\btimeout\b/, /\bretry\b/, /\bheader\b/],
    type: 'any', prefer: ['plain'],
  },
  score: {
    strong: [/\bscore\b/, /\bhigh ?score\b/, /\branking\b/, /\brank\b/, /スコア/, /得点/],
    weak: [/\bpoints?\b/, /\brecord\b/, /\bresult\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  level: {
    strong: [/\blevel\b/, /\blv\b/, /\blvl\b/, /\bexp\b/, /\bexperience\b/, /レベル/, /経験値/],
    weak: [/\brank\b/, /\bgrade\b/, /\bstage\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  stamina: {
    strong: [/\bstamina\b/, /\benergy\b/, /\bap\b/, /\bsp\b/, /\bfuel\b/, /スタミナ/, /行動力/],
    weak: [/\brecover\b/, /\bconsume\b/],
    type: 'number', prefer: ['plain', 'current'],
  },
  item: {
    strong: [/\bitems?\b/, /\binventory\b/, /\bequip(ment)?\b/, /\bbag\b/, /アイテム/, /所持品/, /装備/],
    weak: [/\bcount\b/, /\bquantity\b/, /\bstock\b/, /\bmaterial\b/],
    type: 'any', prefer: ['plain'],
  },
  anticheat: {
    strong: [/\bjailbroken?\b/, /\btamper(ed)?\b/, /\bintegrity\b/, /\bcheat(ing)?\b/,
      /\bdebugger\b/, /\bsecure\b/, /改造/, /不正/],
    weak: [/\bdetect(ed)?\b/, /\bverified\b/, /\bvalid\b/],
    type: 'bool', prefer: ['flag', 'plain'],
  },
};

export function fieldVocab(goalId) { return FIELD_VOCAB[goalId] || null; }

/**
 * 変数の名前が、その目的にどれだけ当てはまるか。
 *
 * @returns {{score:number, term:string, exact:boolean, role:string}|null}
 */
export function matchField(goal, name) {
  if (!goal || !name) return null;
  const norm = normalizeFieldName(name);
  if (!norm) return null;
  const role = fieldRole(name);
  const vocab = FIELD_VOCAB[goal.id];
  let best = null;
  /*
   * 変数名にも「同じつづりの別の言葉」は出る。normalizeFieldName が
   * `_lifeCycleHolder` を「life cycle holder」に開くので、文字列と同じ物差しで外せる。
   * ここを素通しにすると、HP を探した人に IronSource の
   * `waterfallLifeCycleHolder` が出る（実際に出ていた）。
   */
  const blocked = avoidSpans(goal, norm);
  const consider = (score, term, exact, literal, sequence, at, words) => {
    if (at != null && overlaps(blocked, at, term.length)) return;
    if (!best || score > best.score) {
      best = { score, term, exact: !!exact, role, literal: !!literal, sequence: !!sequence, words: !!words };
    }
  };

  if (vocab) {
    for (const re of vocab.strong) {
      for (const m of allMatches(re, norm, blocked.length)) {
        // 名前がその語だけでできている（`_hp` → `hp`）なら、これ以上ない一致
        const whole = norm === m.text.trim();
        consider(whole ? 1 : 0.75, m.text, whole, false, false, m.at);
      }
    }
    for (const re of vocab.weak) {
      for (const m of allMatches(re, norm, blocked.length)) {
        consider(0.4, m.text, false, false, false, m.at);
      }
    }
  }
  /*
   * 打ち込まれた言葉そのもの。
   *
   * これが無いと、`adController` と打った人に `_adController` を返せない
   * — それどころか語彙に「request」が入っているせいで、
   * `allowConcurrentAssetResourceLoadingRequests` を探しているのに
   * `_requestTimeout` を「確定」と言い切る、という最悪の外し方をする。
   * 名前がそのまま一致しているなら、それ以上の証拠は無い。
   *
   * 比較は normalizeFieldName どうしで行う。`adController` は
   * 「ad controller」に開かれるので、文字列のまま比べても永久に一致しない。
   */
  const asked = normalizeFieldName(goal.text);
  if (asked && asked.length >= 2) {
    if (norm === asked) consider(1.2, goal.text, true, true);
    else if (wordSequence(norm, asked)) consider(1.0, goal.text, false, true, true);
    else {
      const cover = wordCoverage(norm, asked);
      if (cover >= 0.99) consider(0.95, goal.text, false, true, false, null, true);
      else if (cover >= 0.6) consider(0.45 * cover, goal.text, false, true);
    }
  }

  // 自由入力（プリセットにない目的）は、入力から開いた語で当てる
  for (const term of goal.extraTerms || []) {
    const w = normalizeFieldName(term.word);
    if (!w || w.length < 2) continue;
    if (wordSequence(norm, w)) consider((norm === w ? 0.95 : 0.7) * (term.weight || 1), term.word, norm === w);
  }
  if (!best && !vocab) {
    // プリセットの文言用の語彙でも一応見る（日本語名の変数など）
    const m = matchText(goal, norm);
    if (m) consider(m.score * 0.6, m.term, false);
  }
  if (!best) return null;

  /*
   * 役割による上下。「今の値」が本命で、「上限」「初期値」は別物。
   * ただし打ち込まれた名前そのものが一致しているなら、上下しない
   * （`maxHp` を探している人に、`maxHp` を「上限だから」と下げる意味はない）。
   */
  if (!best.literal) {
    const prefer = (vocab && vocab.prefer) || ['plain'];
    if (prefer.includes(best.role)) best.score *= 1;
    else if (best.role === 'max' || best.role === 'base' || best.role === 'min') best.score *= 0.45;
    else if (best.role === 'delta' || best.role === 'count') best.score *= 0.7;
    else best.score *= 0.85;
  }
  best.score = Math.min(1, best.score);
  return best;
}

/**
 * 目的が期待している型に、その値の型が合っているか。
 * @returns {'fit'|'conflict'|'unknown'}
 */
export function typeFits(goal, type) {
  if (!goal || !type) return 'unknown';
  const want = (FIELD_VOCAB[goal.id] || {}).type || 'any';
  if (want === 'any') return 'unknown';
  const kind = type.kind;
  if (want === 'number') {
    if (kind === 'int' || kind === 'float') {
      // BOOL（1 バイトの char）は数値ではあるが、HP や所持金ではない
      if (type.bool && type.bytes === 1) return 'conflict';
      return 'fit';
    }
    if (kind === 'object' || kind === 'cstring' || kind === 'class' ||
        kind === 'selector' || kind === 'block' || kind === 'pointer') return 'conflict';
    return 'unknown';
  }
  if (want === 'bool') {
    if (kind === 'bool' || (kind === 'int' && type.bytes === 1)) return 'fit';
    if (kind === 'object' || kind === 'float') return 'conflict';
    return 'unknown';
  }
  if (want === 'text') {
    if (kind === 'object' && (!type.className || /String/i.test(type.className))) return 'fit';
    if (kind === 'cstring') return 'fit';
    if (kind === 'int' || kind === 'float') return 'conflict';
  }
  return 'unknown';
}

/**
 * セレクタ（メソッド名）が、その値のアクセサかどうか。
 *   hp / isHp        → getter
 *   setHp:           → setter
 */
export function accessorKind(sel, fieldName) {
  if (!sel || !fieldName) return null;
  const plain = String(fieldName).replace(/^_+/, '');
  const s = String(sel).replace(/:$/, '');
  if (s === plain) return 'getter';
  if (s.toLowerCase() === plain.toLowerCase()) return 'getter';
  const setter = 'set' + plain.charAt(0).toUpperCase() + plain.slice(1);
  if (s === setter || s.toLowerCase() === setter.toLowerCase()) return 'setter';
  if (s === 'is' + plain.charAt(0).toUpperCase() + plain.slice(1)) return 'getter';
  return null;
}

export function goalById(id) { return GOALS.find((g) => g.id === id) || null; }

export function goalLabel(goal) {
  if (!goal) return '';
  if (goal.free) return goal.text;
  return pick(goal.ja, goal.en);
}

/*
 * 自由入力を手がかりの語に開く辞書。
 * 「敵にダメージを与える処理」と書かれても、バイナリの中にあるのは damage / dmg。
 * 日本語 → 実際に埋まっていそうな語、の橋渡しをする。
 */
const SYNONYMS = [
  [/ダメージ|damage|だめーじ/i, ['damage', 'dmg', 'hurt', 'ダメージ']],
  [/攻撃|こうげき|attack|atk/i, ['attack', 'atk', 'attk', '攻撃']],
  [/防御|ぼうぎょ|defense|defence/i, ['defense', 'defence', 'def', '防御']],
  [/体力|hp|ヒットポイント|health/i, ['hp', 'health', 'life', '体力']],
  [/所持金|お金|金|コイン|coin|money|gold/i, ['coin', 'gold', 'money', 'currency', '所持金']],
  [/ジェム|石|gem|jewel/i, ['gem', 'jewel', 'crystal', 'ジェム']],
  [/ガチャ|gacha|抽選|召喚/i, ['gacha', 'lottery', 'draw', 'summon', 'ガチャ']],
  [/課金|購入|買|purchase|payment/i, ['purchase', 'payment', 'billing', 'receipt', '購入']],
  [/ログイン|login|認証|auth/i, ['login', 'auth', 'signin', 'ログイン']],
  [/広告|ad\b|ads\b/i, ['ad', 'ads', 'interstitial', 'rewarded', '広告']],
  [/セーブ|保存|save/i, ['save', 'store', 'persist', 'セーブ']],
  [/通信|サーバ|server|network|api/i, ['http', 'api', 'request', 'session', '通信']],
  [/スコア|score|得点/i, ['score', 'point', 'スコア']],
  [/レベル|level|経験値|exp/i, ['level', 'exp', 'experience', 'レベル']],
  [/スタミナ|stamina|行動力/i, ['stamina', 'energy', 'スタミナ']],
  [/アイテム|item|装備/i, ['item', 'inventory', 'equip', 'アイテム']],
  [/敵|enemy|モンスター|monster/i, ['enemy', 'monster', 'mob', '敵']],
  [/味方|player|プレイヤー|自分/i, ['player', 'user', 'hero', 'プレイヤー']],
  [/時間|time|タイマー|timer/i, ['time', 'timer', 'duration']],
  [/回数|count|カウント/i, ['count', 'num', 'times']],
  [/速度|speed|スピード/i, ['speed', 'velocity', 'rate']],
  [/確率|probability|rate/i, ['rate', 'probability', 'chance', '確率']],
];

/** 目的を表す文字を、実際に探す語の並びに開く。 */
export function expandTerms(text) {
  const raw = String(text || '').trim();
  const terms = [];
  const push = (word, weight) => {
    const w = String(word).trim();
    if (w.length < 2) return;
    if (terms.some((x) => x.word.toLowerCase() === w.toLowerCase())) return;
    terms.push({ word: w, weight });
  };

  for (const [re, words] of SYNONYMS) {
    if (re.test(raw)) for (const w of words) push(w, 1);
  }
  // 入力そのものに含まれる単語も、そのまま手がかりにする（弱め）
  for (const token of raw.split(/[\s、。,.:;（）()「」"'/\\|+*]+/)) {
    if (token.length >= 2 && !/^[はがのをにでとやもへ]+$/.test(token)) push(token, 0.6);
  }
  return terms;
}

/**
 * 自由入力から目的を組み立てる。
 * 既存のプリセットに強く当てはまるならそれを使い、なければ自由目的として扱う。
 */
export function parseGoal(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // プリセットの語が入っていれば、その目的として扱う（期待する命令の形まで使える）
  let best = null;
  for (const g of GOALS) {
    let hit = 0;
    for (const re of g.strong) if (re.test(raw)) hit += 2;
    for (const re of g.weak) if (re.test(raw)) hit += 1;
    if (hit > 0 && (!best || hit > best.hit)) best = { goal: g, hit };
  }
  const terms = expandTerms(raw);
  if (best && best.hit >= 2) {
    return Object.assign({}, best.goal, { text: raw, extraTerms: terms, free: false });
  }
  return {
    id: 'free', free: true, text: raw,
    ja: raw, en: raw,
    strong: [], weak: [], extraTerms: terms,
    // 自由入力では「どんな命令が出るはず」とは決めつけない
    expects: {},
  };
}

/** プリセットを、自由入力と同じ形に整える。 */
export function goalFromPreset(id) {
  const g = goalById(id);
  if (!g) return null;
  return Object.assign({}, g, { text: pick(g.ja, g.en), extraTerms: [], free: false });
}

/* ── 「同じつづりだが、別の言葉」を外す ──────────────────────
 *
 * `health` は体力だが、`healthCheck`（サーバの死活監視）の health は体力ではない。
 * 名前としては完璧に一致するので、点の付け方をどう変えても上がってくる。
 * 目的の avoid に当たった範囲を先に取っておき、そこに重なった一致だけを捨てる。
 * 「attack と healthcheck が両方書いてある文字列」の attack までは捨てない。 */

function avoidSpans(goal, s) {
  const spans = [];
  for (const re of (goal && goal.avoid) || []) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(s)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return spans;
}

function overlaps(spans, at, len) {
  for (const [lo, hi] of spans) if (at < hi && at + len > lo) return true;
  return false;
}

/*
 * 外す範囲があるときだけ、2 個目以降の一致も見る。
 * `healthcheck then health` の後ろの health を取りこぼさないため。
 * 外す範囲が無いふつうの目的では、これまでどおり最初の 1 個で止める。
 */
function allMatches(re, s, hasAvoid) {
  if (!hasAvoid) {
    const m = s.match(re);
    return m ? [{ text: m[0], at: m.index }] : [];
  }
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out = [];
  let m;
  while ((m = g.exec(s)) !== null) {
    out.push({ text: m[0], at: m.index });
    if (m[0].length === 0) g.lastIndex++;
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 文字列 1 本が、その目的にどれだけ当てはまるか。
 *
 * @returns {{score:number, term:string}|null} 当てはまらなければ null
 */
export function matchText(goal, text) {
  if (!goal) return null;
  const s = String(text || '');
  if (s.length < 2) return null;
  let best = null;
  const blocked = avoidSpans(goal, s);
  const consider = (score, term, at) => {
    if (at != null && overlaps(blocked, at, term.length)) return;
    if (!best || score > best.score) best = { score, term };
  };
  for (const re of goal.strong || []) {
    for (const m of allMatches(re, s, blocked.length)) consider(1, m.text, m.at);
  }
  for (const re of goal.weak || []) {
    for (const m of allMatches(re, s, blocked.length)) consider(0.5, m.text, m.at);
  }
  for (const term of goal.extraTerms || []) {
    const i = s.toLowerCase().indexOf(term.word.toLowerCase());
    if (i >= 0) consider(0.85 * term.weight, term.word, i);
  }
  if (!best) return null;

  /*
   * 手がかりとしての「濃さ」を掛ける。
   * 人が読む文言ほど当たりやすく、記号だらけや極端に長いものは外れやすい。
   */
  let quality = 1;
  if (s.length > 160) quality -= 0.4;
  if (/^[\-_./\\%@#$*+0-9]+$/.test(s)) quality -= 0.5;
  if (/[ぁ-んァ-ヶ一-龥]/.test(s)) quality += 0.1;
  best.score *= Math.max(0.2, Math.min(1.1, quality));
  return best;
}

/** 名前（シンボル・Objective-C メソッド）との当てはまり。 */
export function matchName(goal, name) {
  if (!goal || !name) return null;
  return matchText(goal, String(name));
}

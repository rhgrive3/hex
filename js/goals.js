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
  const consider = (score, term) => {
    if (!best || score > best.score) best = { score, term };
  };
  for (const re of goal.strong || []) {
    const m = s.match(re);
    if (m) consider(1, m[0]);
  }
  for (const re of goal.weak || []) {
    const m = s.match(re);
    if (m) consider(0.5, m[0]);
  }
  for (const term of goal.extraTerms || []) {
    const i = s.toLowerCase().indexOf(term.word.toLowerCase());
    if (i >= 0) consider(0.85 * term.weight, term.word);
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

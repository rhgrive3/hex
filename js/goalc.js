/*
 * goalc.js — Goal Compiler。「知りたいこと」を、engine が探せる問い合わせに翻訳する。
 *
 * これまでの GOALS は 16 個のプリセットだった。初心者の入口としては良いが、
 *
 *     「戦闘終了時にXPが増える場所」
 *
 * のような普通の質問には答えられない。プリセットを 100 個に増やしても
 * 101 個目で同じことが起きる。だからプリセットを増やすのではなく、
 * 文を分解して問い合わせに変える。
 *
 *     ENTITY            XP / experience
 *     EVENT             battle end
 *     ACTION            increase
 *     EXPECTED DATAFLOW oldValue → arithmetic → store
 *     CONTEXT           battle result / reward / clear
 *     SINK              persistent player state
 *
 * ここは翻訳だけを担う。探索も点数付けもしない（rank.js / pinpoint.js の仕事）。
 *
 * きまり:
 *   1. 分からない問いは「分からない」と言う。当てずっぽうの ENTITY を作らない。
 *   2. 何が足りないかを missing に必ず書く。利用者が言い直せるように。
 *   3. ここで出す語は「手がかり」であって「正解」ではない。証明は命令が行う。
 */

import { GOALS, parseGoal, expandTerms } from './goals.js';
import { pick } from './i18n.js';

/* ── 動き（ACTION） ─────────────────────────────────────────
 *
 * 順番に意味がある。「決める」を「調べる」より先に見ないと、
 * 「ガチャでレア度を決めてる」が単なる検索になってしまう。
 */
const ACTIONS = [
  { id: 'increase', ja: '増える', en: 'increases',
    re: /増え|増や|加算|足し|足す|加える|上がる|貰|もら|獲得|入手|付与|報酬|\badd(s|ed|ing)?\b|increas|\bgain/i },
  { id: 'decrease', ja: '減る', en: 'decreases',
    re: /減ら|減る|減っ|引く|消費|失う|下がる|喰らう|くらう|被ダメ|\bsub(tract)?\b|decreas|reduce|\bspend|consume|\blose\b/i },
  { id: 'decide', ja: '決める', en: 'decides',
    re: /決め|決ま|決定|抽選|選ば|選ぶ|振り分け|決めて|抽出|lottery|\bdecid|determin|\bpick\b|\broll\b|choose/i },
  { id: 'detect', ja: '見つける・検知する', en: 'detects',
    re: /検知|検出|不正|改造|チート|見破|バレ|ban\b|detect|cheat|tamper|jailbreak|integrity/i },
  { id: 'send', ja: '送る', en: 'sends',
    re: /送信|送る|送っ|アップロード|通信し|post\b|upload|\bsend/i },
  { id: 'save', ja: '保存する', en: 'saves',
    re: /保存|セーブ|書き込|永続|persist|\bsave\b|\bwrite\b/i },
  { id: 'check', ja: '調べる', en: 'checks',
    re: /判定|チェック|確認|検証|比べ|しきい値|閾値|\bcheck|verif|validat|compare/i },
  { id: 'set', ja: '設定する', en: 'sets',
    re: /設定|セット|書き換え|変更|上書き|\bset\b|assign|overwrite/i },
  { id: 'read', ja: '読み出す', en: 'reads',
    re: /読み|取得|取り出|参照し|\bget\b|\bread\b|fetch|load\b/i },
];

/* ── できごと（EVENT） ──────────────────────────────────────── */

const EVENTS = [
  { id: 'battle-end', ja: '戦闘の終わり', en: 'battle end',
    re: /戦闘(終了|後|の終わり)|バトル(終了|後)|クリア(時|後)|リザルト|勝利|敗北|決着|battle[\s_-]*(end|result|finish)|\bvictory\b|\bresult\b/i,
    terms: ['battle', 'result', 'clear', 'finish', 'victory', '戦闘', 'クリア', 'リザルト'] },
  { id: 'launch', ja: 'アプリの起動', en: 'app launch',
    re: /起動(時|直後)?|立ち上げ|launch|didFinishLaunching|\bstartup\b/i,
    terms: ['launch', 'startup', 'didFinishLaunching', '起動'] },
  { id: 'purchase-done', ja: '購入の完了', en: 'purchase completed',
    re: /購入(後|完了|時)|課金(後|完了)|決済(後|完了)|transaction[\s_-]*(complete|finish)|purchased/i,
    terms: ['purchase', 'transaction', 'receipt', 'restore', '購入'] },
  { id: 'login', ja: 'ログイン', en: 'login',
    re: /ログイン(時|後)|サインイン|\blogin\b|sign[\s_-]*in/i,
    terms: ['login', 'signin', 'auth', 'session', 'ログイン'] },
  { id: 'level-up', ja: 'レベルアップ', en: 'level up',
    re: /レベルアップ|レベルが上が|level[\s_-]*up/i,
    terms: ['levelup', 'level', 'rankup', 'レベルアップ'] },
  { id: 'damage-taken', ja: 'ダメージを受けたとき', en: 'on damage',
    re: /攻撃(を)?受け|被弾|ダメージ(を)?受け|やられ|take[\s_-]*damage|onHit/i,
    terms: ['damage', 'hit', 'hurt', 'applyDamage', '被弾'] },
  { id: 'tick', ja: '毎フレーム', en: 'every frame',
    re: /毎(フレーム|秒)|定期的|フレームごと|update(時)?|\btick\b/i,
    terms: ['update', 'tick', 'frame', 'step'] },
];

/* ── 実体（ENTITY）を補う語彙 ────────────────────────────────
 *
 * goals.js の SYNONYMS は「経験値」は拾うが「XP」は拾わない（exp とは綴りが違う）。
 * 目的語だけをここで補う。プリセットの語彙は goals.js のものを使う。
 */
const ENTITY_EXTRA = [
  { re: /\bxp\b|経験値|\bexp\b|experience/i, terms: ['exp', 'experience', 'xp', '経験値'], goal: 'level' },
  { re: /レア(度|リティ)|rarity|\brare\b/i, terms: ['rarity', 'rare', 'grade', 'tier', 'レア'], goal: 'gacha' },
  { re: /所持数|個数|在庫|stock|count\b/i, terms: ['count', 'num', 'amount', 'stock'], goal: 'item' },
  { re: /クールダウン|再使用|cooldown/i, terms: ['cooldown', 'recast', 'interval'], goal: null },
  { re: /チケット|ticket/i, terms: ['ticket', 'pass', 'チケット'], goal: null },
  { re: /ハート|heart/i, terms: ['heart', 'life', 'ハート'], goal: 'stamina' },
];

/* ── 期待するデータフローの形 ───────────────────────────────── */

const SHAPES = {
  /* 読んで、計算して、同じところへ書き戻す。増減はほぼ必ずこの形。 */
  RMW: 'read-modify-write',
  /* 何かを作って返す（乱数から等級を決める、など）。 */
  PRODUCE: 'produce',
  /* しきい値と比べて分かれる。 */
  COMPARE: 'compare',
  /* どこかへ渡す（通信・保存）。 */
  TRANSFER: 'transfer',
  /* 形を決めつけない。 */
  ANY: 'any',
};

const RANDOM_CALLS = ['arc4random', 'arc4random_uniform', 'rand', 'random', 'srand',
  'mt19937', 'SecRandomCopyBytes', 'drand48'];
const NETWORK_CALLS = ['NSURLSession', 'CFNetwork', 'send', 'connect', 'curl_easy_perform'];
const SAVE_CALLS = ['NSUserDefaults', 'fopen', 'fwrite', 'NSKeyedArchiver', 'sqlite3_step', 'write'];

/* 動きごとに、命令の形として何を期待するか。 */
function expectationOf(action, entityGoal) {
  const base = { calls: [], control: [], memory: [], constants: [] };
  switch (action) {
    case 'increase':
    case 'decrease':
      return Object.assign(base, {
        memory: ['load', 'store'],
        control: ['compare'],           // 上限・下限で丸めていることが多い
        shape: SHAPES.RMW,
        steps: ['read', 'arithmetic', 'store'],
      });
    case 'set':
      return Object.assign(base, { memory: ['store'], shape: SHAPES.RMW, steps: ['value', 'store'] });
    case 'decide':
      return Object.assign(base, {
        calls: RANDOM_CALLS.slice(),
        control: ['branch', 'compare'],
        memory: ['store'],
        shape: SHAPES.PRODUCE,
        steps: ['random', 'compare', 'branch', 'result'],
      });
    case 'detect':
    case 'check':
      return Object.assign(base, {
        control: ['branch', 'compare'],
        shape: SHAPES.COMPARE,
        steps: ['read', 'compare', 'branch'],
      });
    case 'send':
      return Object.assign(base, { calls: NETWORK_CALLS.slice(), shape: SHAPES.TRANSFER, steps: ['collect', 'call'] });
    case 'save':
      return Object.assign(base, { calls: SAVE_CALLS.slice(), memory: ['load'], shape: SHAPES.TRANSFER, steps: ['read', 'call'] });
    case 'read':
      return Object.assign(base, { memory: ['load'], shape: SHAPES.ANY, steps: ['read'] });
    default:
      return Object.assign(base, {
        shape: entityGoal ? SHAPES.RMW : SHAPES.ANY,
        steps: [],
      });
  }
}

/* 動きと実体から、値の行き先を決める。 */
function sinkOf(action, entityGoal) {
  if (action === 'send') return 'network';
  if (action === 'save') return 'persistent-state';
  if (action === 'decide') return 'produced-value';
  if (action === 'detect' || action === 'check') return 'branch-decision';
  if (action === 'read') return 'display';
  if (action === 'increase' || action === 'decrease' || action === 'set') {
    return entityGoal === 'network' ? 'network' : 'persistent-state';
  }
  return 'unknown';
}

/* ── 本体 ───────────────────────────────────────────────────── */

/**
 * 自由入力を AnalysisQuery に翻訳する。
 *
 * @param {string} text
 * @returns {object} AnalysisQuery
 */
export function compileGoal(text) {
  const raw = String(text || '').trim();

  const action = ACTIONS.find((a) => a.re.test(raw)) || null;
  const event = EVENTS.find((e) => e.re.test(raw)) || null;

  /* ── 実体 ── */
  const entityTerms = [];
  const pushTerm = (t) => {
    const s = String(t || '').trim();
    if (!s) return;
    if (!entityTerms.some((x) => x.toLowerCase() === s.toLowerCase())) entityTerms.push(s);
  };

  let entityGoal = null;
  let goalHits = 0;
  for (const g of GOALS) {
    let hit = 0;
    for (const re of g.strong) if (re.test(raw)) hit += 2;
    for (const re of g.weak) if (re.test(raw)) hit += 1;
    if (hit > goalHits) { goalHits = hit; entityGoal = g; }
  }
  for (const extra of ENTITY_EXTRA) {
    if (!extra.re.test(raw)) continue;
    for (const t of extra.terms) pushTerm(t);
    if (!entityGoal && extra.goal) entityGoal = GOALS.find((g) => g.id === extra.goal) || null;
  }
  if (entityGoal) {
    // プリセットの語彙をそのまま使う（正規表現から素の語を取り出す）
    for (const re of entityGoal.strong) pushTerm(plainWord(re));
    for (const t of (goalTerms(entityGoal.id) || [])) pushTerm(t);
  }
  for (const t of expandTerms(raw)) {
    if (t.weight >= 1) pushTerm(t.word);
  }

  /* ── 文脈 ── */
  const contextTerms = [];
  if (event) for (const t of event.terms) contextTerms.push(t);
  if (entityGoal && entityGoal.id === 'gacha') contextTerms.push('reward', 'drop', 'box');
  if (action && (action.id === 'increase' || action.id === 'decrease')) contextTerms.push('reward', 'apply', 'update');

  /* ── 足りないもの ── */
  const missing = [];
  if (raw.length < 2) missing.push('text');
  if (!entityTerms.length) missing.push('entity');
  if (!action) missing.push('action');

  const expect = expectationOf(action ? action.id : null, entityGoal ? entityGoal.id : null);

  const query = {
    text: raw,
    entity: {
      terms: entityTerms,
      goal: entityGoal ? entityGoal.id : null,
      label: entityGoal ? pick(entityGoal.ja, entityGoal.en) : (entityTerms[0] || null),
      icon: entityGoal ? entityGoal.icon : null,
    },
    event: event ? { id: event.id, label: pick(event.ja, event.en), terms: event.terms } : null,
    action: action ? action.id : null,
    actionLabel: action ? pick(action.ja, action.en) : null,
    dataflow: { shape: expect.shape, steps: expect.steps || [] },
    context: { terms: contextTerms },
    sink: sinkOf(action ? action.id : null, entityGoal ? entityGoal.id : null),
    expect: { calls: expect.calls, control: expect.control, memory: expect.memory, constants: expect.constants },
    /* 既存の探索系（rank.js / pinpoint.js）にそのまま渡せる形も添える */
    goal: parseGoal(raw),
    confident: !missing.length,
    missing,
  };
  return query;
}

/* 正規表現から、探し語として使える素の文字を取り出す。取れなければ null。 */
function plainWord(re) {
  const src = String(re.source || '')
    .replace(/\\b/g, '')
    .replace(/^\^|\$$/g, '');
  if (/[[\](){}|*+?.\\]/.test(src)) return null;
  return src.length >= 2 ? src : null;
}

/* プリセットごとの、確実に使える探し語。正規表現から取り出せないものを補う。 */
const GOAL_TERMS = {
  hp: ['hp', 'health', 'life', '体力'],
  attack: ['attack', 'atk', 'power', '攻撃'],
  defense: ['defense', 'def', 'armor', '防御'],
  damage: ['damage', 'dmg', 'ダメージ'],
  money: ['coin', 'gold', 'money', 'currency', 'gem', '所持金'],
  gacha: ['gacha', 'lottery', 'draw', 'summon', 'ガチャ'],
  purchase: ['purchase', 'payment', 'billing', 'receipt'],
  login: ['login', 'auth', 'token', 'session'],
  ads: ['ad', 'interstitial', 'rewarded', '広告'],
  save: ['save', 'persist', 'userdefaults', 'セーブ'],
  network: ['http', 'api', 'request', 'session'],
  score: ['score', 'point', 'ranking', 'スコア'],
  level: ['level', 'exp', 'experience', 'xp', 'レベル'],
  stamina: ['stamina', 'energy', 'スタミナ'],
  item: ['item', 'inventory', 'equip', 'アイテム'],
  anticheat: ['cheat', 'tamper', 'jailbreak', 'integrity'],
};

function goalTerms(id) { return GOAL_TERMS[id] || null; }

/**
 * 問い合わせを一文で説明する。「そう受け取りました」を利用者に見せるため。
 * ここで初めて日本語（または英語）になる。
 */
export function describeQuery(q) {
  if (!q) return '';
  const entity = q.entity.label || (q.entity.terms.length ? q.entity.terms[0] : null);
  const action = q.actionLabel;
  const where = q.event ? q.event.label : null;

  if (!entity && !action) {
    return pick('何を知りたいのか、まだ読み取れていません。', 'The goal is not clear yet.');
  }
  const ja = [];
  if (where) ja.push(where + 'に');
  if (entity) ja.push(entity + 'が');
  ja.push((action || pick('関わる', 'is involved')) + pick('ところを探します。', ''));
  const en = [];
  if (entity) en.push(entity);
  en.push(action || 'is involved');
  if (where) en.push('at ' + where);
  return pick(ja.join(''), 'Looking for where ' + en.join(' ') + '.');
}

/**
 * 問い合わせを、探索の手順に開く。AI エージェントと決定的エンジンの両方が同じ計画を使う。
 *
 * @returns {Array<{step, tool, args, why}>}
 */
export function queryPlan(q) {
  if (!q) return [];
  const plan = [];
  const terms = q.entity.terms.slice(0, 8);
  if (terms.length) {
    plan.push({ step: 'strings', tool: 'search_strings', args: { any: terms },
      why: 'entity' });
    plan.push({ step: 'names', tool: 'search_functions', args: { any: terms },
      why: 'entity' });
  }
  if (q.context.terms.length) {
    plan.push({ step: 'context', tool: 'search_strings', args: { any: q.context.terms.slice(0, 8) },
      why: 'context' });
  }
  if (q.expect.calls.length) {
    plan.push({ step: 'calls', tool: 'find_callers_of', args: { any: q.expect.calls },
      why: 'expected-call' });
  }
  if (q.dataflow.shape === SHAPES.RMW) {
    plan.push({ step: 'rmw', tool: 'find_read_modify_write', args: { terms },
      why: 'expected-dataflow' });
  }
  if (q.expect.control.includes('branch')) {
    plan.push({ step: 'branch', tool: 'find_branching_on', args: { terms }, why: 'expected-control' });
  }
  plan.push({ step: 'verify', tool: 'slice_backward', args: {}, why: 'proof' });
  return plan;
}

export { SHAPES };

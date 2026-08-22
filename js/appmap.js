/*
 * アプリの地図 — 数万の関数を、人が把握できる数の「部品」に畳む層。
 *
 * 関数を 1 つずつ説明できても、数万個の中から目当ての 1 つを見つけるのは無理。
 * 人が実際にやっているのは、まず
 *
 *     「このアプリは、バトルと課金と通信と画面でできている」
 *       → 「バトルは BattleManager と EnemyUnit と SkillEffect が担当している」
 *         → 「BattleManager は hp と attack と defense を持っている」
 *           → 「hp を書き換えているのはこの 3 か所」
 *
 * という絞り込み。1 画面に出るものを常に十数個に保ったまま、上から降りていける。
 * このファイルはその「地図」を作る。
 *
 * 分類の材料は 3 つとも独立している（どれか 1 つでは決めない）。
 *   1. クラス名そのもの                  … 人が付けた名前
 *   2. そのクラスが参照している文字列     … 実際の参照関係（事実）
 *   3. そのクラスが呼んでいる API の分類   … 実際の呼び出し関係（事実）
 *
 * ここも日本語は作らない。ラベルの id だけを返す。
 */
import { classifyString, featureLabelOf } from './features.js';
import { pick } from './i18n.js';
import { apiInfo, FEATURE_OF_CATEGORY } from './blocks.js';
import { vendorsOf, vendorOf } from './vendors.js';

/** 部品の見出しに使う絵文字。文字だけの一覧より、地図に見える。 */
export const CATEGORY_ICON = {
  battle: '⚔️', character: '🧑', item: '🎒', quest: '🗺️', gacha: '🎰',
  purchase: '💳', login: '🔑', social: '💬', ranking: '🏆', network: '🌐',
  save: '💾', anticheat: '🚨', ads: '📺', ui: '📱', audio: '🔊',
  tutorial: '🎓', error: '⚠️', settings: '⚙️',
  system: '🔧', unknown: '❓',
};

/** API の分類 → 地図の部品。 */
const API_CATEGORY_TO_FEATURE = {
  network: 'network', httpapi: 'network',
  crypto: 'anticheat', keychain: 'anticheat', antidebug: 'anticheat',
  storage: 'save', io: 'save', database: 'save', prefs: 'save',
  ui: 'ui', log: 'error', error: 'error',
};

/*
 * blocks.js は命令を分類するための語彙を持っていて、地図の語彙とは別物。
 * そちらの名前をそのまま部品の名前にすると、地図に「❓ objc」「❓ runtime」
 * という、絵文字も日本語も付かない部品が出る（実際に出ていた）。
 *
 * 対応するものだけ翻訳し、objc / runtime / data は捨てる。
 * メモリ管理や Objective-C の土台はどのクラスにもあるので、
 * 「このアプリはこういう部品でできています」の答えにならない。
 */
const BLOCK_FEATURE_TO_CATEGORY = {
  network: 'network', security: 'anticheat', storage: 'save',
  ui: 'ui', diagnostics: 'error',
};

/*
 * クラス名は、画面に出る文言とは語彙が違う。
 * 「ログインに失敗しました」ではなく LoginViewController、
 * 「購入を復元しています」ではなく ShopManager と書かれている。
 * だからクラス名専用の表を持つ。points が大きいほど、その名前らしさが強い。
 *
 * 並び順に意味はない（票を足して、いちばん多いものを採る）。
 * ただし ui と system は「どのクラスにも付きうる語」なので、わざと弱くしてある。
 */
const CLASS_NAME_HINTS = [
  { id: 'battle', points: 3, re: /battle|combat|damage|attack|skill|buff|enemy|monster|boss|weapon|bullet|hitbox|\bhp\b/i },
  { id: 'character', points: 3, re: /character|chara|hero|avatar|actor|unit(?!test)|player(?!prefs)|party|team/i },
  { id: 'item', points: 3, re: /item|inventory|equip|bag|gear|material|consumable/i },
  { id: 'gacha', points: 3, re: /gacha|lottery|draw|reward|bonus|present|gift|loot|treasure/i },
  { id: 'purchase', points: 3, re: /shop|store(?!kit)|purchase|payment|billing|\biap\b|receipt|product|price|checkout|wallet|currency|coin|gem/i },
  { id: 'login', points: 3, re: /login|logout|auth(?!or)|account|credential|token|signin|signup|register/i },
  { id: 'login', points: 1, re: /session|profile(?:manager)?|\buser\b/i },
  { id: 'network', points: 3, re: /\bapi\b|api[a-z]*(client|manager|service)|http|network|request|response|socket|connection|endpoint|\burl\b|urlsession|session(task|manager|delegate|config)|download|upload|sync/i },
  { id: 'save', points: 3, re: /save|persist|database|\bdb\b|realm|coredata|sqlite|cache|archive|userdefault|storage/i },
  { id: 'quest', points: 3, re: /quest|stage|mission|chapter|dungeon|map(?:data|manager)|world/i },
  { id: 'social', points: 3, re: /friend|guild|clan|chat|message|mail|social|invite|follow/i },
  { id: 'ranking', points: 3, re: /rank|leaderboard|score|record|achievement/i },
  { id: 'ads', points: 3, re: /admob|applovin|unityads|ironsource|vungle|tapjoy|adcolony|interstitial|rewarded|banner|\bads?[a-z]*(manager|helper|view|unit)/i },
  { id: 'anticheat', points: 3, re: /jailbreak|tamper|integrity|antichea|cheat|security|crypt|cipher|hash|keychain|obfusc|protect|guard(?!ian)/i },
  { id: 'audio', points: 3, re: /audio|sound|\bbgm\b|music|voice|\bse\b(?:manager|player)/i },
  { id: 'tutorial', points: 3, re: /tutorial|onboard|guide|walkthrough/i },
  { id: 'settings', points: 2, re: /setting|config|option|preference|locale|language/i },
  { id: 'error', points: 2, re: /error|exception|crash|report|logger|logging/i },
  { id: 'ui', points: 2, re: /viewcontroller|view$|view[a-z]*(controller|model)|button|label|cell|scene|screen|dialog|popup|\bhud\b|layout|animation|widget|window|navigation|table|collection/i },
  { id: 'system', points: 1, re: /manager$|helper|util|common|base$|core$|delegate|factory|builder|observer|handler|bridge|wrapper|adapter/i },
];

/** クラス名だけから分類する。当たらなければ空。 */
export function classifyClassName(name) {
  const s = String(name || '');
  const out = [];
  for (const h of CLASS_NAME_HINTS) {
    if (h.re.test(s)) out.push({ id: h.id, points: h.points });
  }
  return out;
}

const NAME_POINTS = 3;      // クラス名が当たった
const STRING_POINTS = 2;    // 参照している文字列が当たった
const API_POINTS = 2;       // 呼んでいる API の分類が当たった
const VENDOR_POINTS = 6;    // 持ち主が分かっている（名前の語彙より強い）
const MAX_METHODS_PER_CLASS = 60;

/** SDK の役目 → 地図の部品。広告 SDK は広告のところに置く。 */
const VENDOR_KIND_TO_CATEGORY = {
  ads: 'ads', analytics: 'system', marketing: 'system',
  support: 'system', library: 'system',
};

/*
 * features.js が持たない、地図だけの部品名。
 * ここに書いておかないと、画面に `🔧 system` という id がそのまま出る。
 */
const EXTRA_LABEL = {
  system: { ja: '土台・組み込みライブラリ', en: 'Frameworks and libraries' },
  unknown: { ja: 'その他（分類できず）', en: 'Everything else' },
};

/** 部品の見出し。地図だけの部品は EXTRA_LABEL から、それ以外は features.js から。 */
export function categoryLabel(id) {
  const extra = EXTRA_LABEL[id];
  return extra ? pick(extra.ja, extra.en) : featureLabelOf(id);
}

/**
 * クラス 1 つを分類する。
 * @returns {{category:string, score:number, why:Array}}
 */
function classifyClass(cls, ctx) {
  const votes = new Map();
  const why = [];
  const add = (id, points, code, detail) => {
    if (!id) return;
    votes.set(id, (votes.get(id) || 0) + points);
    why.push({ code, id, points, detail: detail || null });
  };

  /*
   * 0. 持ち主が先。組み込んだ SDK のクラスに、ゲームの語彙を当ててはいけない。
   *
   * `ISBaseAdUnitManager` は `unit` に当たって「キャラクター・育成」になる。
   * すると地図のいちばん上の部品が IronSource になり、
   * 「このアプリはこういう部品でできています」が嘘になる。
   * SDK だと分かっているなら、その SDK の役目のところに置く。
   */
  const vendor = vendorOf(cls.name, ctx.vendors);
  if (vendor) {
    /*
     * 持ち主が分かったら、そこで決める。触っている文字列で上書きさせない。
     * IronSource の広告クラスが「報酬」の文言をいくつも持っているのは当然で、
     * それを票にすると、また「ガチャ・抽選・報酬 ＝ IronSource」に戻る。
     */
    const where = VENDOR_KIND_TO_CATEGORY[vendor.kind] || 'system';
    return {
      category: where,
      score: VENDOR_POINTS,
      why: [{ code: 'vendor', id: where, points: VENDOR_POINTS,
        detail: { name: cls.name, vendor: vendor.vendor } }],
    };
  }

  // 1. クラス名（クラス名専用の語彙で見る）
  for (const hit of classifyClassName(cls.name)) {
    add(hit.id, hit.points, 'class-name', { name: cls.name });
  }
  // 文言としても当たるなら、それも 1 票（名前が日本語のこともある）
  for (const hit of classifyString(cls.name)) {
    add(hit.id, hit.weak ? 1 : NAME_POINTS - 1, 'class-name', { name: cls.name });
  }

  // 2 と 3. メソッドが実際に触っているもの
  const methods = (cls.methods || []).slice(0, MAX_METHODS_PER_CLASS);
  let stringHits = 0;
  let apiHits = 0;
  for (const m of methods) {
    if (m.addr == null) continue;
    const range = ctx.program ? ctx.program.functionRange(m.addr) : null;
    if (!range) continue;

    if (ctx.program && ctx.textOf && stringHits < 24) {
      for (const ref of ctx.program.refsFrom(range.start, range.end, 24)) {
        const text = ctx.textOf(ref.target);
        if (!text) continue;
        for (const hit of classifyString(text)) {
          add(hit.id, hit.weak ? 1 : STRING_POINTS, 'string', { text, sel: m.sel });
          stringHits++;
        }
        if (stringHits >= 24) break;
      }
    }
    if (ctx.program && ctx.symbols && apiHits < 16) {
      for (const callee of ctx.program.calleesOf(range.start, range.end, 12)) {
        const name = ctx.symbols.nameAt(callee.addr);
        if (!name) continue;
        const api = apiInfo(name);
        if (!api) continue;
        const feature = API_CATEGORY_TO_FEATURE[api.cat] ||
          BLOCK_FEATURE_TO_CATEGORY[FEATURE_OF_CATEGORY[api.cat]];
        if (!feature) continue;
        add(feature, API_POINTS, 'api', { name, api: api.id, sel: m.sel });
        apiHits++;
        if (apiHits >= 16) break;
      }
    }
  }

  let best = null;
  for (const [id, points] of votes) {
    if (!best || points > best.points) best = { id, points };
  }
  if (!best) return { category: 'unknown', score: 0, why: [] };
  return {
    category: best.id,
    score: best.points,
    why: why.filter((w) => w.id === best.id).slice(0, 6),
  };
}

/**
 * 地図を作る。
 *
 * @param {object} opts
 *   fields   FieldIndex（クラスとフィールド）
 *   program  ProgramIndex
 *   symbols  SymbolIndex
 *   strings  [{addr, text}]
 *   region   コードのセクション
 */
export function buildAppMap(opts) {
  const o = opts || {};
  const fields = o.fields;
  const program = o.program;
  const symbols = o.symbols;

  // 文字列をアドレスから引けるようにする（参照先 → 文言）
  const textByAddr = new Map();
  for (const s of o.strings || []) textByAddr.set(s.addr.toString(), s.text);
  const textOf = (addr) => (addr == null ? null : textByAddr.get(addr.toString()) || null);
  const ctx = { program, symbols, textOf, vendors: vendorsOf(fields) };

  const classes = [];
  if (fields && fields.classCount) {
    for (const c of fields.classes.values()) {
      const hit = classifyClass(c, ctx);
      // その部品がどれだけ「厚い」か。メソッド数とフィールド数は事実。
      const weight = (c.methods ? c.methods.length : 0) +
        (c.classMethods ? c.classMethods.length : 0);
      let calls = 0;
      if (program) {
        for (const m of (c.methods || []).slice(0, 20)) {
          if (m.addr != null) calls += program.callCountOf(m.addr);
        }
      }
      classes.push({
        name: c.name,
        superName: c.superName,
        category: hit.category,
        categoryScore: hit.score,
        why: hit.why,
        methods: weight,
        fields: c.ivars ? c.ivars.length : 0,
        instanceSize: c.instanceSize,
        calls,
        addr: c.methods && c.methods.length ? c.methods[0].addr : null,
        info: c,
      });
    }
  }

  /* 部品ごとに束ねる。1 画面に出るのは常に十数個までにする。 */
  const groups = new Map();
  for (const c of classes) {
    const id = c.category || 'unknown';
    if (!groups.has(id)) groups.set(id, { id, classes: [], methods: 0, fields: 0, calls: 0, score: 0 });
    const g = groups.get(id);
    g.classes.push(c);
    g.methods += c.methods;
    g.fields += c.fields;
    g.calls += c.calls;
    g.score += c.categoryScore;
  }

  const subsystems = [];
  for (const g of groups.values()) {
    if (g.id === 'unknown') continue;
    // 中の並びは「厚くて、よく呼ばれていて、分類の確からしいもの」から
    g.classes.sort((a, b) => (b.categoryScore + b.calls / 4 + b.methods / 8) -
      (a.categoryScore + a.calls / 4 + a.methods / 8));
    subsystems.push({
      id: g.id,
      label: categoryLabel(g.id),
      icon: CATEGORY_ICON[g.id] || CATEGORY_ICON.unknown,
      classes: g.classes,
      classCount: g.classes.length,
      methods: g.methods,
      fields: g.fields,
      calls: g.calls,
      score: g.score,
    });
  }
  subsystems.sort((a, b) => (b.score + b.calls / 2) - (a.score + a.calls / 2));

  const unknown = groups.get('unknown');
  return {
    subsystems,
    classes: classes.sort((a, b) => (b.calls + b.methods) - (a.calls + a.methods)),
    unclassified: unknown ? unknown.classes.length : 0,
    unclassifiedClasses: unknown ? unknown.classes.slice(0, 200) : [],
    classCount: classes.length,
    hasClasses: classes.length > 0,
  };
}

/**
 * クラスがないバイナリ（Swift だけ・C++・難読化済み）向けの地図。
 * 関数を、参照している文字列の分類でまとめる。クラスほど正確ではないので、
 * UI 側で「粗い地図です」と伝えること。
 */
export function buildStringMap(opts) {
  const o = opts || {};
  const program = o.program;
  const symbols = o.symbols;
  const groups = new Map();
  if (!program) return { subsystems: [], hasClasses: false, classCount: 0, byStrings: true };

  let scanned = 0;
  for (const s of o.strings || []) {
    if (scanned >= 4000) break;
    const hits = classifyString(s.text);
    if (!hits.length) continue;
    const users = program.functionsReferencing(s.addr, BigInt(Math.min(s.text.length, 128)), 8);
    if (!users.length) continue;
    scanned++;
    for (const hit of hits) {
      if (!groups.has(hit.id)) groups.set(hit.id, { id: hit.id, funcs: new Map(), score: 0 });
      const g = groups.get(hit.id);
      g.score += hit.weak ? 1 : 2;
      for (const u of users) {
        if (u.addr == null) continue;
        const key = u.addr.toString();
        if (!g.funcs.has(key)) {
          g.funcs.set(key, {
            addr: u.addr,
            name: symbols ? symbols.nameAt(u.addr) : null,
            samples: [],
          });
        }
        const f = g.funcs.get(key);
        if (f.samples.length < 3) f.samples.push(s.text);
      }
    }
  }

  const subsystems = [];
  for (const g of groups.values()) {
    const funcs = Array.from(g.funcs.values());
    funcs.sort((a, b) => b.samples.length - a.samples.length);
    subsystems.push({
      id: g.id,
      label: categoryLabel(g.id),
      icon: CATEGORY_ICON[g.id] || CATEGORY_ICON.unknown,
      classes: [],
      functions: funcs.slice(0, 60),
      classCount: 0,
      methods: funcs.length,
      score: g.score,
      calls: 0,
    });
  }
  subsystems.sort((a, b) => (b.methods + b.score) - (a.methods + a.score));
  return { subsystems, hasClasses: false, classCount: 0, byStrings: true, unclassified: 0 };
}

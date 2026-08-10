/*
 * 「アプリのどの機能か」から関数を探すための入口。
 *
 * 関数が 1 万個あるバイナリで「この関数はデータをコピーしています」と言われても、
 * それがゲームのどこの処理なのかは分からない。逆から辿るしかない:
 *
 *   アプリの機能（ログイン・課金・ガチャ…）
 *     → その機能でしか出てこない言葉（文字列）
 *       → その言葉を使っている場所（既存の XREF）
 *         → その場所を含む関数
 *           → Semantic Model（この関数が何をしているか）
 *
 * 文字列は「人間が意味を込めた唯一の手がかり」なので、ここが一番効く。
 * ただし、これも推測でしかない。文字列が近くにあるからといって、その関数が
 * その機能そのものだとは限らない。UI ではそう言い切らないこと。
 */
import { pick } from './i18n.js';

/*
 * 機能ごとの手がかりになる言葉。
 *
 *   re    … 文字列の中にこれがあれば、その機能の手がかり
 *   weak  … よくある一般語。これだけでは弱いので、確からしさを下げる
 *
 * 日本語のアプリを想定して、日本語の語も入れている。
 * ここは「増やせば効く」表なので、遠慮なく足してよい。
 */
const FEATURES = [
  {
    id: 'login', ja: 'ログイン・アカウント', en: 'Login and accounts',
    re: /login|logout|signin|sign_in|sign-up|signup|account|auth|oauth|token|password|passwd|credential|session|ログイン|ログアウト|アカウント|パスワード|認証|会員|引き継ぎ|連携/i,
  },
  {
    id: 'purchase', ja: '課金・購入', en: 'Purchases',
    re: /purchase|payment|billing|receipt|storekit|skproduct|transaction|subscription|restore|price|checkout|課金|購入|決済|レシート|支払|有料|ストア|石|ジェム|コイン/i,
  },
  {
    id: 'gacha', ja: 'ガチャ・抽選・報酬', en: 'Gacha and rewards',
    re: /gacha|lottery|draw|reward|bonus|present|gift|login_?bonus|ガチャ|抽選|報酬|ボーナス|プレゼント|received|受け取|排出|確率|レア/i,
  },
  {
    id: 'save', ja: 'セーブ・データ保存', en: 'Save data',
    re: /save|savedata|autosave|progress|checkpoint|userdefault|preference|realm|sqlite|\.db\b|セーブ|保存|データ|進行|記録/i,
  },
  {
    id: 'battle', ja: 'バトル・戦闘', en: 'Battle',
    re: /battle|combat|damage|attack|defen[cs]e|\bhp\b|\bmp\b|skill|buff|debuff|critical|enemy|boss|バトル|戦闘|ダメージ|攻撃|防御|敵|ボス|スキル|必殺|勝利|敗北/i,
  },
  {
    id: 'character', ja: 'キャラクター・育成', en: 'Characters',
    re: /character|chara|hero|unit|avatar|level_?up|exp\b|evolve|awaken|キャラ|ユニット|育成|レベル|経験値|進化|覚醒|強化/i,
  },
  {
    id: 'item', ja: 'アイテム・所持品', en: 'Items and inventory',
    re: /inventory|item_?id|equipment|equip|consume|material|アイテム|装備|所持|素材|消費|倉庫/i,
  },
  {
    id: 'quest', ja: 'クエスト・ステージ', en: 'Quests and stages',
    re: /quest|stage|mission|chapter|dungeon|area_?id|difficulty|クエスト|ステージ|ミッション|章|難易度|挑戦/i,
  },
  {
    id: 'social', ja: 'フレンド・ギルド・チャット', en: 'Social',
    re: /friend|guild|clan|party|chat|message|mail|follow|フレンド|ギルド|チャット|メッセージ|メール|仲間/i,
  },
  {
    id: 'ranking', ja: 'ランキング・スコア', en: 'Ranking',
    re: /ranking|leaderboard|score|rank_?id|gamecenter|achievement|ランキング|スコア|順位|実績/i,
  },
  {
    id: 'network', ja: 'サーバー通信', en: 'Server communication',
    re: /https?:\/\/|api[/_.]|endpoint|\/v\d\/|request|response|websocket|grpc|json|maintenance|通信|サーバー|メンテナンス|接続/i,
  },
  {
    id: 'anticheat', ja: 'チート対策・改造検知', en: 'Anti-cheat',
    re: /cheat|jailbreak|jailbroken|cydia|frida|substrate|tamper|integrity|debugger|emulator|root_?detect|不正|改造|チート|検知/i,
  },
  {
    id: 'ads', ja: '広告', en: 'Advertising',
    re: /admob|unityads|applovin|ironsource|adcolony|vungle|tapjoy|adjust|appsflyer|firebase_?analytics|banner_?ad|interstitial|rewarded|広告/i,
  },
  {
    id: 'ui', ja: '画面・UI', en: 'Screens and UI',
    re: /viewcontroller|\bscene\b|screen|dialog|popup|button|canvas|prefab|画面|ボタン|ダイアログ|表示|タップ/i,
    weak: true,
  },
  {
    id: 'audio', ja: '音・BGM', en: 'Sound',
    re: /\bbgm\b|\bse_|sound|audio|volume|music|voice|音量|効果音|ボイス/i,
  },
  {
    id: 'tutorial', ja: 'チュートリアル', en: 'Tutorial',
    re: /tutorial|onboarding|guide_?step|first_?launch|チュートリアル|はじめて|案内/i,
  },
  {
    id: 'error', ja: 'エラー・通知', en: 'Errors and notices',
    re: /error|failed|failure|exception|invalid|timeout|retry|warning|エラー|失敗|できません|ください|通知|お知らせ/i,
    weak: true,
  },
  {
    id: 'settings', ja: '設定・オプション', en: 'Settings',
    re: /setting|config|option|preference|language|locale|notification|設定|オプション|言語|通知設定/i,
    weak: true,
  },
];

/** 実行エンジンの見当をつける（読み方がまるごと変わるので、先に伝えたい）。 */
const ENGINES = [
  { id: 'unity', re: /il2cpp|UnityEngine|libunity|mono_|Assembly-CSharp/i,
    ja: 'Unity 製の可能性が高いです。ゲームのロジックの大半は libil2cpp.so / UnityFramework 側にあり、この実行ファイルにはほとんど入っていないことがあります。',
    en: 'Looks like a Unity app; most game logic lives in the il2cpp binary, not here.' },
  { id: 'unreal', re: /UnrealEngine|UE4|FEngineLoop|\.uasset/i,
    ja: 'Unreal Engine 製の可能性が高いです。',
    en: 'Looks like an Unreal Engine app.' },
  { id: 'flutter', re: /flutter|dart_vm|libapp\.so/i,
    ja: 'Flutter 製の可能性が高いです。画面の処理は Dart 側にあります。',
    en: 'Looks like a Flutter app; the UI logic lives in Dart code.' },
  { id: 'rn', re: /react-?native|jsbundle|hermes/i,
    ja: 'React Native 製の可能性が高いです。画面の処理は JavaScript 側（jsbundle）にあります。',
    en: 'Looks like a React Native app; the UI logic lives in the JS bundle.' },
];

export function featureLabelOf(id) {
  const f = FEATURES.find((x) => x.id === id);
  return f ? pick(f.ja, f.en) : id;
}

/** 文字列 1 本が、どの機能の手がかりになるか。当てはまらなければ空。 */
export function classifyString(text) {
  const s = String(text || '');
  if (s.length < 3) return [];
  const out = [];
  for (const f of FEATURES) {
    if (f.re.test(s)) out.push({ id: f.id, weak: !!f.weak });
  }
  return out;
}

/** エンジンの見当。分からなければ null。 */
export function detectEngine(strings) {
  for (const e of ENGINES) {
    for (const s of strings) {
      if (e.re.test(s.text)) {
        return { id: e.id, note: pick(e.ja, e.en), sample: s.text, addr: s.addr };
      }
    }
  }
  return null;
}

/*
 * 手がかりとしての「濃さ」。
 *
 * 意味のある単語が入った、ほどよい長さの文字列ほど当たりやすい。
 * 逆に、記号だらけ・極端に長い・型名らしきものは外れやすい。
 */
function strength(text, weak) {
  const s = String(text);
  let score = weak ? 0.35 : 0.6;
  if (s.length >= 6 && s.length <= 60) score += 0.15;
  if (/[ぁ-んァ-ヶ一-龥]/.test(s)) score += 0.15;          // 日本語＝人が読む文言
  if (/\s/.test(s)) score += 0.05;                          // 単語ではなく文
  if (/^[A-Za-z0-9_]+$/.test(s) && s.length < 8) score -= 0.1;
  if (/^[\-_./\\%@#$*+]+$/.test(s)) score -= 0.3;
  if (s.length > 120) score -= 0.2;
  return Math.max(0.1, Math.min(0.95, score));
}

/**
 * 文字列の一覧を機能ごとに束ねる。
 *
 * @param {Array} strings  [{addr, text}] — worker が拾ったもの
 * @param {number} perFeature 機能あたりの上限
 */
export function groupByFeature(strings, perFeature = 200) {
  const buckets = new Map();
  for (const f of FEATURES) buckets.set(f.id, []);

  for (const s of strings) {
    const hits = classifyString(s.text);
    for (const h of hits) {
      const list = buckets.get(h.id);
      if (!list || list.length >= perFeature) continue;
      list.push({ addr: s.addr, text: s.text, score: strength(s.text, h.weak) });
    }
  }

  const out = [];
  for (const f of FEATURES) {
    const list = buckets.get(f.id);
    if (!list.length) continue;
    // 濃い手がかりから先に見せる。上から順に試すのがいちばん速い。
    list.sort((a, b) => b.score - a.score);
    out.push({ id: f.id, label: pick(f.ja, f.en), items: list });
  }
  out.sort((a, b) => b.items.length - a.items.length);
  return out;
}

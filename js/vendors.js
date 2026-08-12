/*
 * 「そのクラスは、このアプリが書いたものか。それとも組み込んだ SDK か」。
 *
 * 現代のモバイルゲームには、広告・計測・課金の SDK が 10 個も 20 個も入っている。
 * そして困ったことに、**名前が残っているのはたいてい SDK のほうだけ**になる。
 * ゲーム本体が C++（Cocos2d-x / Unity）で書かれていると、Objective-C のクラス表に
 * 出てくるのは広告 SDK ばかりで、ゲームのクラスは 1 つも載らない。
 *
 * この状態で「所持金はどこ？」と名前で探すと、こうなる:
 *
 *     LPMReward._amount          … 89.6% 確からしい
 *
 * これは LevelPlay（広告 SDK）の「動画を見た報酬の数」であって、
 * ゲームの所持金ではない。名前だけを見ると完璧に一致しているので、
 * 何もしないと **自信満々で間違える**。黙って外すのがいちばん危ない。
 *
 * そこでここでは「そのクラスがどのライブラリのものか」を先に決める。
 * 決め方は 2 段階:
 *
 *   1. 誰が見ても分かる名前で当てる（ironsource / applovin / vungle …）。
 *   2. 1 で当たったクラスの **接頭辞を、このバイナリ自身から学ぶ**。
 *      `ISBannerAdapter` が IronSource だと分かれば、`IS` で始まる 200 個の
 *      クラスもまとめて IronSource だと分かる。表に無い SDK にも効く。
 *
 * 日本語は作らない。返すのは分類だけ。
 */

/*
 * 見ればそれと分かる名前。ここに挙げたものは、ゲーム本体のクラス名としては
 * まず使われない（"vungle" という名前の自作クラスを書く人はいない）。
 */
const VENDOR_PATTERNS = [
  { vendor: 'IronSource', kind: 'ads', re: /ironsource|supersonic|levelplay/i },
  { vendor: 'AppLovin', kind: 'ads', re: /applovin|\bmax(mediation|adview|reward)/i },
  { vendor: 'Google Mobile Ads', kind: 'ads', re: /admob|googlemobileads|gadmob|interstitialad/i },
  { vendor: 'Unity Ads', kind: 'ads', re: /unityads|unityservices|unityanalytics/i },
  { vendor: 'Vungle', kind: 'ads', re: /vungle|liftoff/i },
  { vendor: 'Tapjoy', kind: 'ads', re: /tapjoy/i },
  { vendor: 'AdColony', kind: 'ads', re: /adcolony/i },
  { vendor: 'Chartboost', kind: 'ads', re: /chartboost/i },
  { vendor: 'Mintegral', kind: 'ads', re: /mintegral|mtgsdk/i },
  { vendor: 'Pangle', kind: 'ads', re: /pangle|bytedance|pangrowth/i },
  { vendor: 'InMobi', kind: 'ads', re: /inmobi/i },
  { vendor: 'Fyber', kind: 'ads', re: /fyber|digitalturbine/i },
  { vendor: 'Smaato', kind: 'ads', re: /smaato/i },
  { vendor: 'PubMatic', kind: 'ads', re: /pubmatic|openwrap/i },
  { vendor: 'Moloco', kind: 'ads', re: /moloco/i },
  { vendor: 'BidMachine', kind: 'ads', re: /bidmachine/i },
  { vendor: 'Ogury', kind: 'ads', re: /ogury/i },
  { vendor: 'Criteo', kind: 'ads', re: /criteo/i },
  { vendor: 'Meta Audience Network', kind: 'ads', re: /audiencenetwork|fbaudience|fbnativead|fbadwebkit/i },
  { vendor: 'Yandex Ads', kind: 'ads', re: /yandexmobileads/i },

  { vendor: 'Adjust', kind: 'analytics', re: /\badjust(sdk)?\b|adjustattribution/i },
  { vendor: 'AppsFlyer', kind: 'analytics', re: /appsflyer/i },
  { vendor: 'Branch', kind: 'analytics', re: /branchsdk|branchuniversal/i },
  { vendor: 'Singular', kind: 'analytics', re: /singularsdk/i },
  { vendor: 'Kochava', kind: 'analytics', re: /kochava/i },
  { vendor: 'Tenjin', kind: 'analytics', re: /tenjin/i },
  { vendor: 'Amplitude', kind: 'analytics', re: /amplitude/i },
  { vendor: 'Mixpanel', kind: 'analytics', re: /mixpanel/i },
  { vendor: 'GameAnalytics', kind: 'analytics', re: /gameanalytics/i },
  { vendor: 'Flurry', kind: 'analytics', re: /flurry/i },
  { vendor: 'Adobe', kind: 'analytics', re: /adobemobile|adbmobile/i },
  { vendor: 'Firebase', kind: 'analytics', re: /firebase|\bfirapp\b|firanalytics|googleutilities|googledatatransport/i },
  { vendor: 'Crashlytics', kind: 'analytics', re: /crashlytics/i },
  { vendor: 'Sentry', kind: 'analytics', re: /sentrysdk|sentryclient/i },
  { vendor: 'Bugsnag', kind: 'analytics', re: /bugsnag/i },

  { vendor: 'Braze', kind: 'marketing', re: /\bappboy\b|brazekit/i },
  { vendor: 'Leanplum', kind: 'marketing', re: /leanplum/i },
  { vendor: 'Swrve', kind: 'marketing', re: /swrve/i },
  { vendor: 'OneSignal', kind: 'marketing', re: /onesignal/i },
  { vendor: 'Helpshift', kind: 'support', re: /helpshift/i },
  { vendor: 'Zendesk', kind: 'support', re: /zendesk/i },

  { vendor: 'Google Toolbox', kind: 'library', re: /gtmsession|gtmapp|googletoolbox/i },
  { vendor: 'Protocol Buffers', kind: 'library', re: /swiftprotobuf|google_protobuf/i },
  { vendor: 'AFNetworking', kind: 'library', re: /afnetworking|afhttp|afurl/i },
  { vendor: 'Alamofire', kind: 'library', re: /alamofire/i },
  { vendor: 'Realm', kind: 'library', re: /realmswift|rlmobject/i },
];

/*
 * よく使われる接頭辞。Objective-C には名前空間が無いので、ライブラリは
 * ぶつからないように 2〜4 文字の大文字を全クラスに付ける、という決まりが定着している。
 * その決まりを逆に使う。ここに挙げたものは、実際に配布されている SDK のもの。
 *
 * ただし接頭辞は短く、偶然ぶつかりやすい（`IS` で始まる自作クラスはありうる）。
 * そこで **同じ接頭辞のクラスが 3 個以上あるとき** だけ SDK とみなす。
 */
const VENDOR_PREFIXES = {
  GAD: 'Google Mobile Ads', GAM: 'Google Mobile Ads', GADU: 'Google Mobile Ads',
  FIR: 'Firebase', FIRCLS: 'Crashlytics', GUL: 'Firebase', GDT: 'Firebase',
  APM: 'Google App Measurement', GTM: 'Google Toolbox', GTMR: 'Google Toolbox',
  GIN: 'Google Sign-In', GTLR: 'Google API Client', GPB: 'Protocol Buffers',
  FB: 'Meta', FBSDK: 'Meta', FBAD: 'Meta Audience Network',
  IS: 'IronSource', ISN: 'IronSource', ISA: 'IronSource', LPM: 'IronSource LevelPlay',
  AL: 'AppLovin', MA: 'AppLovin MAX', ALG: 'AppLovin',
  UAD: 'Unity Ads', UADS: 'Unity Ads', USRV: 'Unity Services', UMON: 'Unity Monetization',
  VG: 'Vungle', VNG: 'Vungle',
  TJ: 'Tapjoy', CB: 'Chartboost', CHB: 'Chartboost',
  MTG: 'Mintegral', BU: 'Pangle', PAG: 'Pangle', IM: 'InMobi', FY: 'Fyber',
  POB: 'PubMatic', SML: 'Smaato', OMID: 'IAB Open Measurement', OM: 'IAB Open Measurement',
  ADJ: 'Adjust', AF: 'AppsFlyer', BNC: 'Branch', ADB: 'Adobe',
  ABK: 'Braze', OS: 'OneSignal', LP: 'Leanplum', HS: 'Helpshift',
  BSG: 'Bugsnag', SNTR: 'Sentry', AMP: 'Amplitude',
  AFN: 'AFNetworking', RLM: 'Realm', SD: 'SDWebImage', MB: 'MBProgressHUD',
};

/** ゲームの数値を探しているのに、SDK の値を答えてはいけない目的。 */
const GAME_VALUE_GOALS = new Set([
  'hp', 'attack', 'defense', 'damage', 'money', 'level', 'stamina',
  'item', 'score', 'gacha',
]);

/**
 * Swift の記号名から、それが属するモジュール（フレームワーク）名を取り出す。
 *
 *   _TtC12VungleAdsSDK14FirstPartyData  →  VungleAdsSDK
 *
 * `_TtC` のあとは「長さ＋名前」の繰り返しになっている。最初の 1 個がモジュール。
 * 読めない形なら null（当てずっぽうの名前は返さない）。
 */
export function swiftModuleOf(name) {
  const s = String(name || '');
  const m = /^_TtC[VOP]?(\d+)/.exec(s);
  if (!m) return null;
  const len = Number(m[1]);
  if (!(len > 0) || len > 64) return null;
  const start = m[0].length;
  const mod = s.slice(start, start + len);
  return mod.length === len ? mod : null;
}

/**
 * 接頭辞になりうる並びを、長いほうから全部返す。
 *
 * `ISLWSProgRvManager` は `ISLWS` とも `IS` とも読める。片方だけ見ていると
 * IronSource の `IS` を取り逃がすので、2〜5 文字を全部候補に出して、
 * どれが実際にまとまっているかは数で決める。
 */
function prefixesOf(name) {
  const s = String(name || '');
  if (!/^[A-Z]{2}/.test(s)) return [];
  const out = [];
  for (let n = Math.min(5, s.length - 1); n >= 2; n--) {
    const head = s.slice(0, n);
    if (!/^[A-Z]+$/.test(head)) continue;
    const next = s[n];
    // 接頭辞の直後は「大文字＋小文字」か「大文字の続き」。数字始まりは採らない。
    if (!/[A-Za-z]/.test(next)) continue;
    out.push(head);
  }
  return out;
}

/** 名前そのものから当てる（第 1 段階）。 */
function matchPattern(name) {
  const s = String(name || '');
  for (const p of VENDOR_PATTERNS) {
    if (p.re.test(s)) return { vendor: p.vendor, kind: p.kind, via: 'name' };
  }
  return null;
}

/**
 * このバイナリに入っているクラス名の一覧から、SDK の見分け方を学ぶ。
 *
 * 表に載っている名前で当たったクラスの接頭辞・モジュール名を集めて、
 * 「その接頭辞を持つクラスは、その SDK のもの」という規則をこのファイル用に作る。
 * ここが効くので、表に無い SDK でもクラスがまとまって除ける。
 *
 * @param {Iterable<string>} classNames
 * @returns {{prefixes:Map<string,object>, modules:Map<string,object>}}
 */
const PREFIX_MIN = 3;        // 名前の分かっている SDK を接頭辞で広げる下限
const CLUSTER_MIN = 10;      // 名前の分からないライブラリを、まとまりだけで見分ける下限

export function learnVendors(classNames) {
  const names = Array.from(classNames || []);
  const prefixCount = new Map();
  const moduleCount = new Map();
  for (const n of names) {
    for (const p of prefixesOf(n)) prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
    const mod = swiftModuleOf(n);
    if (mod) moduleCount.set(mod, (moduleCount.get(mod) || 0) + 1);
  }

  const prefixes = new Map();
  const modules = new Map();

  /* 1. 名前の分かっている SDK。接頭辞の表と、実際に当たったクラスの両方から。 */
  const seed = (p, hit) => {
    if (!p || prefixes.has(p)) return;
    if ((prefixCount.get(p) || 0) < PREFIX_MIN) return;
    prefixes.set(p, Object.assign({}, hit, { via: 'prefix', prefix: p, confidence: 'high' }));
  };
  for (const [p, vendor] of Object.entries(VENDOR_PREFIXES)) {
    seed(p, { vendor, kind: 'sdk' });
  }
  for (const n of names) {
    const hit = matchPattern(n);
    if (!hit) continue;
    const mod = swiftModuleOf(n);
    if (mod && !modules.has(mod)) {
      modules.set(mod, Object.assign({}, hit, { via: 'module', confidence: 'high' }));
    }
    for (const p of prefixesOf(n)) seed(p, hit);
  }
  for (const [mod, n] of moduleCount) {
    if (n < 4 || modules.has(mod)) continue;
    const hit = matchPattern(mod);
    if (hit) modules.set(mod, Object.assign({}, hit, { via: 'module', confidence: 'high' }));
  }

  /*
   * 2. 名前は分からないが、**まとまり方がライブラリのそれ** であるもの。
   *
   * Objective-C には名前空間が無い。だから配布されるライブラリは、ぶつからないよう
   * 全クラスに同じ 2〜4 文字の大文字を付ける。アプリが自分のクラス 10 個以上に
   * 同じ接頭辞を律儀に付けることは、まず無い。この偏りだけで見分けられる。
   *
   * ただし名前で裏が取れていないぶん、確信は下げておく（打ち消しも弱くする）。
   */
  for (const [p, n] of prefixCount) {
    if (n < CLUSTER_MIN || prefixes.has(p) || p.length > 4) continue;
    prefixes.set(p, {
      vendor: p, kind: 'library', via: 'cluster', prefix: p,
      classes: n, confidence: 'low',
    });
  }
  return { prefixes, modules };
}

/**
 * クラス 1 つが、どのライブラリのものか。アプリ自身のものなら null。
 *
 * @param {string} className
 * @param {object} [learned] learnVendors の結果（あると精度が上がる）
 */
export function vendorOf(className, learned) {
  const name = String(className || '');
  if (!name) return null;
  const direct = matchPattern(name);
  if (direct) return Object.assign({ confidence: 'high' }, direct);
  if (learned) {
    const mod = swiftModuleOf(name);
    if (mod && learned.modules && learned.modules.has(mod)) {
      return Object.assign({}, learned.modules.get(mod), { via: 'module', module: mod });
    }
    /*
     * `ISLWSProgRvManager` は `ISLWS` とも `IS` とも読める。どちらも当たったら、
     * 名前で裏の取れているほう（IronSource の `IS`）を採る。長さでは決めない。
     */
    let best = null;
    for (const p of prefixesOf(name)) {
      const hit = learned.prefixes ? learned.prefixes.get(p) : null;
      if (!hit) continue;
      if (!best || (best.confidence !== 'high' && hit.confidence === 'high')) {
        best = Object.assign({}, hit, { via: hit.via, prefix: p });
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * その目的にとって、そのライブラリのクラスは「答えになりうる」か。
 *
 * 広告の SDK は、広告のことを調べているなら正しい答えになる。
 * ゲームの数値（HP・攻撃力・所持金）を調べているときだけ外す。
 */
export function vendorConflicts(goalId, vendor) {
  if (!vendor) return false;
  if (!GAME_VALUE_GOALS.has(goalId)) return false;
  return true;
}

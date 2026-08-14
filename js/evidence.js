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
 *     重み ＝ その証拠が候補をどれだけ強めるか
 *
 * 「クラス表に _hp と書いてある」は、本物の HP ならほぼ必ず観測されるが、
 * 無関係な 2 万個の値ではまず観測されない。だから尤度比は大きい（×18 くらい）。
 * 「4 バイトの整数である」は本物でも偽物でもよくあるので、小さい（×2 くらい）。
 * 「オブジェクト型なのに数を数える目的だ」は本物ではまず起きないので、1 未満（×0.06）。
 *
 * 出発点（事前オッズ）は **候補の数** から決める。候補が 2 万個あれば 1/20000 から始める。
 * 現在の重みは手設定で未校正なので、最後の値は「確信度スコア」であり、
 * 頻度としての確率ではない。hold-out corpusで校正曲線を渡した場合だけ確率と呼べる。
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
  NAMING: 'naming',      // 開発者が書いた文言による、排他的な名指し
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
  /*
   * 排他的な名指しだけ、上限を関数の総数より上に置いてある。
   *
   * 「17MB のうち、この文字列を参照している関数はこの 1 個だけ」は、
   * 事前オッズ（10 万分の 1）を打ち消すのと同じ大きさの観測なので、
   * ここを 25 倍などで頭打ちにすると、どれだけ材料があっても確定に届かない。
   * 実際、この上限のせいで「攻撃力の計算式を日本語で書いた文字列を 4 本、
   * この関数だけが参照している」という材料が 0.09% に潰れていた。
   *
   * 単独で確定させない歯止めは、上限ではなく decide() 側にある
   * （別々の系統が 3 つ以上・逆アセンブルでの裏取り・2 位との差 20 倍）。
   */
  [FAMILY.NAMING]: 1e9,
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
  /* 打ち込まれた名前が、そのまま変数の名前だった。名前で探した人への直球の答え。 */
  'field-name-asked':   { lr: 400,  family: FAMILY.NAME,     kind: 'fact', id: true },
  'field-name-contains':{ lr: 120,  family: FAMILY.NAME,     kind: 'fact', id: true },
  'field-name-words': { lr: 45, family: FAMILY.NAME, kind: 'fact', id: true },
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
  /*
   * 組み込んだ SDK のクラスだった。
   *
   * ゲーム本体が C++ で書かれていると、名前が残っているのは広告 SDK だけになる。
   * そこで名前だけを見ると「LevelPlay の報酬の数」が「所持金」として満点で当たる。
   * 名前の一致（×55）を打ち消せる強さが要るので、ここはかなり小さくしてある。
   */
  'third-party-class':  { lr: 0.01, family: FAMILY.CONTEXT,  kind: 'fact' },
  /*
   * 名前までは分からないが、まとまり方がライブラリのもの
   * （同じ 2〜4 文字の大文字で始まるクラスが 10 個以上ある）。
   * 裏が取れていないぶん、打ち消す力は弱くしてある。
   */
  'library-prefix-class': { lr: 0.12, family: FAMILY.CONTEXT, kind: 'inference' },

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

  /* ── ふるまいから値を名指しする証拠（shapes.js） ─────────────
   *
   * 名前も文字列も 1 つも残っていないアプリ（C++ のゲームがこれ）で、
   * 唯一その値を **目的に結びつけられる** 手がかり。だから id を付ける。
   *
   * 「4 バイトの整数で、読んで計算して書き戻している」は何の値かを言っていないが、
   * 「他のオブジェクトの、0 で止められる値を減らすための量として使われている」は
   * 攻撃力そのものの定義になっている。名前が無くても、これは名指しになる。
   */
  'loc-damage-source':  { lr: 8,    family: FAMILY.USAGE,    kind: 'verified', id: true },
  'loc-resource-drain': { lr: 7,    family: FAMILY.USAGE,    kind: 'verified', id: true },
  'loc-self-resource':  { lr: 5,    family: FAMILY.USAGE,    kind: 'verified', id: true },
  /*
   * 同じ位置が「減らされる側」とも「減らす量の側」とも読める。
   *
   * 体力と攻撃力を同じ場所だと言ってしまう壊れ方が、ここで止まる。
   * 決めきれないことは弱点なので、点を下げる形で必ず持ち回る。
   */
  'loc-role-conflict':  { lr: 0.2,  family: FAMILY.USAGE,    kind: 'inference' },
  /*
   * ── 形の候補を、命令まで降りて裏取りした証拠（purpose.js） ──
   *
   * ここまでのふるまいの証拠は、セクションを 1 回舐めただけの統計でしかない
   * （分岐をまたいだ時点で追跡をやめているので、取りこぼしも取り違えもある）。
   * そこで上位の候補だけ、その場所を触っている関数を実際に逆アセンブルして、
   *
   *   「0x1002f4aa0 で、別のオブジェクトの +0xa18 を掛けた値ぶん、
   *     この +0x74 を減らして、同じ場所へ書き戻している」
   *
   * まで確かめる。統計と、名指しできる 1 命令は、まったく別の強さを持つ。
   */
  'loc-drain-verified': { lr: 30,   family: FAMILY.VERIFIED, kind: 'verified', id: true },
  'loc-amount-verified':{ lr: 24,   family: FAMILY.VERIFIED, kind: 'verified', id: true },
  'loc-clamp-verified': { lr: 6,    family: FAMILY.VERIFIED, kind: 'verified' },
  // 形からは出たが、命令まで降りたら、その場所を触る関数が 1 つも確かめられなかった
  'loc-unverified':     { lr: 0.25, family: FAMILY.VERIFIED, kind: 'inference' },
  /*
   * 上限が「もう 1 つの値」で決まっている（`csel w8, w8, w9` の w9 が [x19, #0x34]）。
   * 体力・スタミナ・ゲージは必ずこの組を持ち、所持金やスコアは持たない。
   * 名前が 1 文字も残っていないアプリで、体力を所持金から分ける決め手になる。
   */
  'loc-capped-by-field': { lr: 14,  family: FAMILY.VERIFIED, kind: 'verified', id: true },
  /*
   * どこを見ても 1 ずつしか動いていない。それは数える物（残り回数・添字・
   * フレーム数）であって、プレイヤーが増やしたい値ではない。
   */
  'loc-counter-verified': { lr: 0.2, family: FAMILY.VERIFIED, kind: 'verified' },
  // C++ の容器の頭（要素数・参照カウンタ・文字列の長さ）に見える
  'loc-container-head': { lr: 0.08, family: FAMILY.STRUCT,   kind: 'inference' },
  'loc-size':           { lr: 1.7,  family: FAMILY.STRUCT,   kind: 'fact' },
  'loc-not-stack':      { lr: 2.2,  family: FAMILY.STRUCT,   kind: 'fact' },
  'loc-arith':          { lr: 2.6,  family: FAMILY.USAGE,    kind: 'fact' },

  /* 処理（関数）を特定するための証拠 */
  'fn-name-exact':      { lr: 30,   family: FAMILY.NAME,     kind: 'fact', id: true },
  'fn-name-match':      { lr: 9,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'fn-selector':        { lr: 7,    family: FAMILY.NAME,     kind: 'fact', id: true },
  'fn-string-ref':      { lr: 6,    family: FAMILY.CONTEXT,  kind: 'fact', id: true },
  /*
   * 目的の言葉を含む文言を、このバイナリの中でこの関数「だけ」が参照している。
   * 尤度比は表に書かず、測った排他性から作って渡す（exclusiveLR）。
   * 「10 万個のうち 1 個」と「10 万個のうち 40 個」を同じ点にはできないため。
   */
  'fn-string-exclusive': { lr: 6,   family: FAMILY.NAMING,   kind: 'fact', id: true },
  /*
   * その文言が書いている計算式の数字が、この関数の命令の中に即値として実在する。
   *
   * 「基ダ×(100+%d+[コンボ:%d])÷100」を参照している関数の中に、即値 100 が 12 個ある。
   * 文言は開発者の主張、即値は命令の事実で、出どころが違う。この 2 つが一致したとき、
   * 「ここがその計算をしている」は逆アセンブルで確かめた話になる。
   * クラス表の無いアプリ（ゲーム本体が C++）で、裏取りの手段はこれしかない。
   */
  'fn-formula-verified': { lr: 20,  family: FAMILY.VERIFIED, kind: 'verified', id: true },
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
  /* 読んで返すだけ／入れるだけ。命令が 1 本しかないぶん、増減の連鎖と同じくらい確か。 */
  'role-verb-accessor': { lr: 12,   family: FAMILY.VERIFIED, kind: 'verified' },
  /* Objective-C runtime metadata itself declares `foo` / `setFoo:` as an
     accessor for an existing ivar/property. This is a naming/ABI fact, not an
     instruction-level verification, so keep it out of VERIFIED family. */
  'role-verb-selector': { lr: 80, family: FAMILY.USAGE, kind: 'fact' },
  'role-accessor-metadata': { lr: 70, family: FAMILY.NAME, kind: 'fact', id: true },
  /*
   * Objective-C の selector (`foo` / `setFoo:`) が宣言する名前と、実命令で
   * read/write した self の ivar 名が一致した。名前と場所が同じ runtime metadata
   * 系統なので独立証拠を水増しせず、NAME 1 family としてだけ数える。
   */
  'role-accessor-match': { lr: 80,  family: FAMILY.NAME,     kind: 'fact', id: true },
  'role-verb-none':     { lr: 0.4,  family: FAMILY.USAGE,    kind: 'inference' },

  /*
   * ── 復元した計算式による名指し（comprehend.js） ────────────────
   *
   * ここがクラス表の無いアプリでの決め手になる。
   *
   *   開発者の主張 … 「めっぽう強い:%d 基ダ×(1500+[宝:%d])÷1000×(100+[コンボ:%d])÷100」
   *   命令の事実   … result = result * (x + 1500) / 1000 * (y + 100) / 100
   *
   * 出どころがまったく違う 2 つが、8 種類の数まで一致する。
   * 名前も型もクラスも無いところで、これ以上の裏取りは静的解析には無い。
   *
   * 「関数のどこかに即値 100 がある」とはまるで別物であることに注意。
   * こちらは魔法数の割り算まで戻したうえで、**その数で割っている式が実在する**
   * ことを言っている。比較に使われているだけの 100 では、絶対に立たない。
   */
  'role-formula-verified': { lr: 260, family: FAMILY.VERIFIED, kind: 'verified', id: true },
  /*
   * 1 本の値を何度も作り変えて、最後に使っている。
   * 「何をしているか」の形は言えるが、「何の値か」は言っていないので id は付けない。
   */
  'role-chain-verified': { lr: 16,  family: FAMILY.VERIFIED, kind: 'verified' },
  /* その工程の直前で、開発者が書いた文言を組み立てている。 */
  'role-step-labelled': { lr: 7,    family: FAMILY.NAMING,   kind: 'fact', id: true },

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
export function evidence(code, strength, detail, lr) {
  const info = EVIDENCE[code];
  const s = strength == null ? 1 : Math.max(0, Math.min(1, strength));
  return {
    code,
    strength: s,
    // 実測から作った尤度比があれば、表の既定値より優先する
    lr: lr != null && lr > 0 ? lr : (info ? info.lr : 1),
    family: info ? info.family : FAMILY.CONTEXT,
    kind: info ? info.kind : 'inference',
    id: !!(info && info.id),
    detail: detail || null,
  };
}

/**
 * 排他性から尤度比を作る。
 *
 * このバイナリの N 個の関数のうち、その文言を参照しているのが k 個だけなら、
 * その観測は候補を N 個から k 個に絞ったのと同じ意味を持つ。だから素の効きは N/k。
 *
 * ただし「その文言が本当に目的を名指ししているか」は別の話なので、そこを掛けて割り引く。
 * 「攻撃力アップ:%d 基ダ×…」のように目的の語がそのまま入っているものは強く、
 * 「damage」がたまたま含まれているだけのものは弱い。
 *
 * @param {number} total   このバイナリの関数の総数
 * @param {number} users   その文言を参照している関数の数
 * @param {number} score   matchText の当てはまり（1 以上なら強い一致）
 */
export function exclusiveLR(total, users, score, text) {
  const n = Math.max(2, total || 0);
  const k = Math.max(1, users || 1);
  if (k > EXCLUSIVE_MAX_USERS) return 0;        // 何十か所からも使われる語は名指しではない
  if (!namesBehaviour(text)) return 0;
  /*
   * 目的の語がそのまま入っているものだけを名指しとして扱う。
   * ここを緩めて弱い一致まで数えると、`set_enemy001_zombie_revive.maanim` の
   * ようなアニメのファイル名が 50 本集まって 100% になる（実際になった）。
   * 素材のファイル名がたまたま 1 か所からしか使われていないのは当たり前で、
   * 排他的であること自体は、それが目的を名指ししている証拠にならない。
   */
  if (!(score >= EXCLUSIVE_MIN_SCORE)) return 0;
  return Math.max(1, Math.min(1e5, (n / k) * NAMES_THE_GOAL));
}

/*
 * その文言は「処理の中身」を名指ししているか。それとも素材の名前か。
 *
 * `skill_wave_attack.maanim` は攻撃という語を含み、しかもこのバイナリの中で
 * 1 か所からしか参照されていない。排他性だけで測ると満点になるが、
 * これはアニメのファイル名であって、攻撃力の計算をしている証拠ではない。
 * 実際これで、素材を読み込むだけの関数が本物の計算式より上に来ていた。
 *
 * 分ける手がかりは、開発者が誰に向けて書いたか。
 *   人に見せる文言 … `攻撃力アップ:%d 基ダ×(100+%d)÷100`
 *                    書式指定・空白・記号が入る。処理の中身を説明している。
 *   素材の名前     … `skill_wave_attack.maanim`
 *                    拡張子付きの識別子。何をするかは何も言っていない。
 */
function namesBehaviour(text) {
  const s = String(text == null ? '' : text);
  if (!s) return true;                     // 文言が渡っていないなら判定しない
  if (/%[-+ 0-9.#]*[@a-zA-Z]/.test(s)) return true;   // 書式指定があれば人に見せる文言
  // 拡張子付きの識別子＝素材（.maanim / .mamodel のように長い拡張子もある）
  if (/^[\w./\\-]+\.[a-zA-Z][a-zA-Z0-9]{1,7}$/.test(s)) return false;
  return true;
}

/**
 * ふるまいの珍しさから尤度比を作る。
 *
 * 走査で見えた位置が 342 個あって、体力の形（減って・増えて・0 で止まって・
 * 減らす量がよそから来る）に当てはまるのが 4 個なら、その形に合っていること自体が
 * 候補を 342 個から 4 個に絞る。固定の ×7 では、この絞り込みを表せていなかった。
 *
 * ただし文言と違って、形は「その目的の値である」ことまでは言い切らない。
 * 体力の形をした値は、盾でも残弾でも耐久度でもありうる。だから割引は大きい。
 */
export function rarityLR(total, matching) {
  const n = Math.max(2, total || 0);
  const k = Math.max(1, matching || 1);
  if (k >= n) return 0;
  return Math.max(1, Math.min(1e4, (n / k) * SHAPE_FITS_GOAL));
}

/* その形をした値が、本当にその目的の値である確からしさ。文言より低い。 */
const SHAPE_FITS_GOAL = 0.3;

/* これより多くの関数から参照されている文言は、名指しとして扱わない。 */
const EXCLUSIVE_MAX_USERS = 2;
/* 目的の語がそのまま入っていること（weak な当たりは名指しではない）。 */
const EXCLUSIVE_MIN_SCORE = 0.9;
/* その文言が本当に目的を名指ししている確からしさ。 */
const NAMES_THE_GOAL = 0.25;
/* 同じ主張を何本も数えないための上限（別々の文言でも 4 本まで）。 */
export const EXCLUSIVE_MAX_STRINGS = 4;

/*
 * 同じ系統の証拠が重なったときの割引。
 * 1 件目はそのまま、2 件目は半分、3 件目は 1/4 …と効きを落とす。
 * 「名前が 3 通りの書き方で一致した」を 3 つぶんの証拠として数えないため。
 *
 * ただし名指しだけは落とし方を緩める。`_hp` と `hp` と `HP` の一致は
 * 同じ 1 つの名前を 3 通りに読んだだけだが、
 *
 *   「攻撃力アップ:%d 基ダ×(100+%d+[コンボ:%d])÷100」
 *   「撃破時攻撃力アップ:%d 基ダ×(100+%d)÷100」
 *   「本能玉ダメージアップ:%d 攻撃力:%d +%d%」
 *
 * は、開発者が別々の場面について別々に書いた 3 つの文で、
 * そのどれもがこの関数だけから参照されている。1 つを 3 通りに読んだのとは違う。
 * ここを同じ割引にすると、文言を 4 本持つ本物と 1 本しか無い隣が並んでしまう。
 */
const DAMPING_RATE = { [FAMILY.NAMING]: 0.45 };

function damping(nth, family) {
  if (nth <= 0) return 1;
  const rate = DAMPING_RATE[family] != null ? DAMPING_RATE[family] : 1.2;
  return 1 / (1 + nth * rate);
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
    let delta = LN(lr) * (it.strength == null ? 1 : it.strength) * damping(nth, family);
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

  const families = new Set();
  let verified = 0;
  for (const d of detailed) {
    if (d.applied > 0) families.add(d.family);
    if (d.kind === 'verified' && d.applied > 0) verified++;
  }

  /*
   * 命令まで降りて確かめていないものは、確かさの天井を下げる。
   *
   * このファイルの冒頭に書いてあるきまりの 2 番目
   * 「確定を名乗れるのは、逆アセンブルして確かめた証拠があるときだけ」は、
   * これまで decide() の判定にしか効いていなかった。確率のほうは素通しで、
   * 表に書いてあることを足しただけの候補が 100.000% と出ていた。
   *
   * それは表示として嘘であるだけでなく、本物と 2 位を並ばせて
   * 「2 位との差が足りない」を作り出していた。実測したものと、
   * していないものが、同じ 100% で並んでいたため。
   */
  if (!verified) logOdds = Math.min(logOdds, UNVERIFIED_CEIL);

  const rawProbability = 1 / (1 + Math.exp(-logOdds));
  const probability = o.calibration ? calibrateProbability(rawProbability, o.calibration) : rawProbability;

  return {
    logOdds,
    probability, rawProbability, calibrated: !!o.calibration,
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
/* 命令で確かめていないものが名乗れる上限（97%）。確定の 99% には届かせない。 */
const UNVERIFIED_CEIL = LN(0.97 / 0.03);
/*
 * ここを下回ったら、名前を出さない。
 * 5% は「20 個に 1 個は当たる」で、答えとして見せられる下限としてはぎりぎり。
 * これより低いものを画面に出すくらいなら、見つからなかったと言う方がいい。
 */
const AMBIGUOUS_FLOOR = 0.05;

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
  else if (top.fusion.probability >= 0.35 ||
    (runnerUp && margin < LIKELY.margin && top.fusion.probability >= AMBIGUOUS_FLOOR)) {
    /*
     * 「上位が拮抗している」だけで割れていると言ってはいけない。
     * 確からしさが 0 のものどうしも拮抗する。それは割れているのではなく、
     * 何も見つかっていない。ここを緩くしていたせいで、HP を探した人の画面に
     * 「絞りきれていません／VideoFrameLoggingBufferService.curIdx／確からしさ 0%」
     * が出ていた。名前が出れば、読む人はそれを答えとして受け取る。
     */
    verdict = VERDICT.AMBIGUOUS;
  } else verdict = VERDICT.NONE;

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

/** Apply a monotone hold-out calibration curve [{score, observed}]. */
export function calibrateProbability(score, curve) {
  const pts = (curve || []).filter((p) => Number.isFinite(p.score) && Number.isFinite(p.observed))
    .slice().sort((a, b) => a.score - b.score);
  if (!pts.length) return Math.max(0, Math.min(1, score));
  if (score <= pts[0].score) return Math.max(0, Math.min(1, pts[0].observed));
  for (let i = 1; i < pts.length; i++) {
    if (score > pts[i].score) continue;
    const a = pts[i - 1], b = pts[i];
    const t = (score - a.score) / Math.max(1e-12, b.score - a.score);
    return Math.max(0, Math.min(1, a.observed + (b.observed - a.observed) * t));
  }
  return Math.max(0, Math.min(1, pts[pts.length - 1].observed));
}

/** Brier score and reliability bins for a labelled hold-out corpus. */
export function calibrationReport(samples, binCount = 10) {
  const valid = (samples || []).filter((x) => Number.isFinite(x.score) && (x.outcome === 0 || x.outcome === 1));
  const bins = Array.from({ length: Math.max(2, binCount) }, () => ({ count: 0, predicted: 0, observed: 0 }));
  let sum = 0;
  for (const x of valid) {
    const p = Math.max(0, Math.min(1, x.score));
    sum += (p - x.outcome) ** 2;
    const b = bins[Math.min(bins.length - 1, Math.floor(p * bins.length))];
    b.count++; b.predicted += p; b.observed += x.outcome;
  }
  return {
    count: valid.length,
    brier: valid.length ? sum / valid.length : null,
    bins: bins.filter((b) => b.count).map((b) => ({
      count: b.count, predicted: b.predicted / b.count, observed: b.observed / b.count,
    })),
  };
}

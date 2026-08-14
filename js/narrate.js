/*
 * Semantic Model を人間の言葉にする層。
 *
 * blocks.js は「事実」しか作らない。ここはそれを読み上げるだけで、
 * 新しい推測はしない（根拠のない断定を混ぜ込まないため、境界をはっきり分ける）。
 *
 * 方針:
 *   - レジスタ名・命令名を主語にしない。「x1 に入れる」ではなく「渡す値を用意する」。
 *   - API 名を覚えさせない。「memcpy」ではなく「データを別の場所へコピーする処理」。
 *   - 分からないものは「分かりません」と言う。埋めない。
 */
import { pick } from './i18n.js';
import { ROLE, levelOf } from './blocks.js';
import { goalById } from './goals.js';
import { shortName } from './rtti.js';

/* ── 役割の見出し ──────────────────────────────────────────── */

const ROLE_LABEL = {
  [ROLE.FUNCTION_ENTRY]: ['関数の開始', 'Function entry'],
  [ROLE.REGISTER_SETUP]: ['値を用意する', 'Set up values'],
  [ROLE.ARGUMENT_PREPARATION]: ['渡すデータを準備', 'Prepare arguments'],
  [ROLE.MEMORY_READ]: ['値を読み取る', 'Read from memory'],
  [ROLE.MEMORY_WRITE]: ['値を書き込む', 'Write to memory'],
  [ROLE.ADDRESS_CALCULATION]: ['データの場所を求める', 'Work out an address'],
  [ROLE.VALUE_CALCULATION]: ['計算する', 'Compute a value'],
  [ROLE.CONDITION_CHECK]: ['条件を確認', 'Check a condition'],
  [ROLE.BRANCH]: ['別の処理へ移る', 'Jump elsewhere'],
  [ROLE.LOOP]: ['繰り返す', 'Loop'],
  [ROLE.FUNCTION_CALL]: ['ほかの処理を呼び出す', 'Call another routine'],
  [ROLE.RETURN_VALUE]: ['結果を確認', 'Check the result'],
  [ROLE.ERROR_HANDLING]: ['異常時の処理', 'Error handling'],
  [ROLE.CLEANUP]: ['後片付け', 'Clean up'],
  [ROLE.FUNCTION_EXIT]: ['関数の終了', 'Return to the caller'],
  [ROLE.UNKNOWN]: ['解析できませんでした', 'Could not be analysed'],
};

export function roleLabel(role) {
  const e = ROLE_LABEL[role] || ROLE_LABEL[ROLE.UNKNOWN];
  return pick(e[0], e[1]);
}

/** 一覧に出す短いラベル（〔〕付き）。 */
export function roleTag(role) {
  return pick('〔' + roleLabel(role) + '〕', '[' + roleLabel(role) + ']');
}

/* ── API の言い換え ────────────────────────────────────────── */

/*
 * 「その API が何をするか」を、名前を出さずに言う。
 *   short … 見出し（▼ の右に出る）
 *   long  … 1 文の説明
 */
const API_PHRASE = {
  memcpy: [['データをコピー', 'Copy data'],
    ['データを別の場所へコピーする処理です。', 'Copies a block of data to another place.']],
  memset: [['データを埋める', 'Fill data'],
    ['決まった値でメモリを埋める処理です。', 'Fills a block of memory with one value.']],
  malloc: [['置き場所を確保', 'Reserve memory'],
    ['新しいデータの置き場所を確保する処理です。', 'Reserves a new block of memory.']],
  realloc: [['置き場所を作り直す', 'Resize memory'],
    ['確保済みの置き場所を、大きさを変えて取り直す処理です。', 'Resizes an existing block of memory.']],
  free: [['置き場所を返す', 'Release memory'],
    ['使い終わった置き場所を返す処理です。', 'Releases a block of memory that is no longer needed.']],
  memcmp: [['データを見比べる', 'Compare data'],
    ['2 つのデータが同じかどうかを見比べる処理です。', 'Compares two blocks of data.']],
  strlen: [['文字数を数える', 'Measure text'],
    ['文字列の長さを数える処理です。', 'Measures the length of a piece of text.']],
  strcmp: [['文字列を見比べる', 'Compare text'],
    ['2 つの文字列が同じかどうかを見比べる処理です。パスワードや合言葉の照合にもよく使われます。',
      'Compares two pieces of text — often how a password or token check is done.']],
  strcpy: [['文字列をコピー', 'Copy text'],
    ['文字列を別の場所へ写す処理です。', 'Copies a piece of text somewhere else.']],
  strcat: [['文字列をつなぐ', 'Append text'],
    ['文字列のうしろに別の文字列をつなげる処理です。', 'Appends one piece of text to another.']],
  sprintf: [['文言を組み立てる', 'Build text'],
    ['ひな形に値を差し込んで、文言を組み立てる処理です。', 'Builds a piece of text from a template and values.']],
  strstr: [['文字列を探す', 'Search text'],
    ['文字列の中から目的の部分を探す処理です。', 'Looks for one piece of text inside another.']],
  atoi: [['文字を数値にする', 'Parse a number'],
    ['文字で書かれた数を、計算できる数値に変える処理です。', 'Converts text into a number.']],
  log: [['記録を残す', 'Write a log'],
    ['動作の記録（ログ）を出す処理です。', 'Writes a diagnostic log line.']],
  objc_msgSend: [['オブジェクトに依頼', 'Send a message'],
    ['ある「もの」に対して、名前を指定して仕事を頼む処理です。iOS アプリの動作はほとんどこの形で書かれています。',
      'Asks an object to perform a named operation — the backbone of iOS apps.']],
  objc_retain: [['持ち主を数える', 'Adjust ownership'],
    ['そのデータを今いくつの場所が使っているかを数え直す処理です。使う人がいなくなると自動的に片付きます。',
      'Adjusts the reference count that decides when an object is freed.']],
  objc_alloc: [['新しいものを作る', 'Create an object'],
    ['新しいオブジェクト（データのかたまり）を作る処理です。', 'Creates a new object.']],
  reflect: [['名前からクラスを引く', 'Look a class up by name'],
    ['クラスやメソッドを、名前の文字列から実行時に引く処理です。難読化されたコードや、動的に組み立てる処理でよく使われます。',
      'Looks up a class or method from a name string at run time.']],
  objc_weak: [['弱い参照をあつかう', 'Handle a weak reference'],
    ['相手がいなくなったら自動的に空になる参照を、読み書きする処理です。持ち主にはなりません。',
      'Reads or writes a weak reference — one that empties itself when the object goes away.']],
  objc_runtime: [['Objective-C のしくみ', 'Objective-C plumbing'],
    ['クラスの取得や排他制御など、Objective-C のしくみが自動で入れている処理です。アプリ独自の中身ではありません。',
      'Runtime plumbing inserted by Objective-C itself, not app logic.']],
  swift_runtime: [['Swift のしくみ', 'Swift plumbing'],
    ['型の照合やメモリの排他など、Swift のしくみが自動で入れている処理です。アプリ独自の中身ではありません。',
      'Runtime plumbing inserted by Swift itself, not app logic.']],
  cxx_runtime: [['C++ のしくみ', 'C++ plumbing'],
    ['例外処理や後片付けの登録など、C++ のしくみが自動で入れている処理です。アプリ独自の中身ではありません。',
      'Runtime plumbing inserted by C++ itself, not app logic.']],
  cxx_string: [['文字列をあつかう（C++）', 'C++ string work'],
    ['C++ の標準の文字列（std::string）を作る・つなぐ・比べる処理です。',
      'Creates, joins or compares a C++ standard string.']],
  cxx_container: [['入れ物をあつかう（C++）', 'C++ container work'],
    ['C++ の配列や辞書（vector・map など）を操作する処理です。ゲームの本体はここに値を貯めています。',
      'Works on a C++ container such as vector or map.']],
  cxx_std: [['C++ 標準ライブラリ', 'C++ standard library'],
    ['C++ の標準ライブラリの処理です。', 'A call into the C++ standard library.']],
  swift_string: [['文字列をあつかう（Swift）', 'Swift string work'],
    ['Swift の文字列を作る・つなぐ・比べる処理です。', 'Creates, joins or compares a Swift string.']],
  swift_hash: [['ハッシュを計算する', 'Compute a hash'],
    ['辞書や集合で使うための値を、決まった手順で数に変える処理です。',
      'Turns a value into a number for use in a dictionary or set.']],
  swift_collection: [['入れ物をあつかう（Swift）', 'Swift collection work'],
    ['Swift の配列や辞書を操作する処理です。', 'Works on a Swift array or dictionary.']],
  swift_mangled: [['Swift の処理', 'Swift code'],
    ['Swift で書かれたライブラリの処理です。名前は飾り付き（マングル）のまま残っています。',
      'A call into Swift library code; the name is still in its mangled form.']],
  swift_stdlib: [['Swift 標準ライブラリ', 'Swift standard library'],
    ['Swift の標準ライブラリの処理です。', 'A call into the Swift standard library.']],
  swift_object: [['持ち主を数える', 'Adjust ownership'],
    ['Swift のデータの持ち主を数え直す処理です。', 'Adjusts a Swift object’s reference count.']],
  file: [['ファイルを扱う', 'Work with a file'],
    ['ファイルを開く・読む・書くといった処理です。', 'Opens, reads or writes a file.']],
  filemanager: [['ファイルを扱う', 'Work with a file'],
    ['端末の中のファイルを読み書きする処理です。', 'Reads or writes files on the device.']],
  network: [['通信する', 'Talk to the network'],
    ['ネットワークごしにデータをやり取りする処理です。', 'Sends or receives data over the network.']],
  httpapi: [['通信する', 'Talk to a server'],
    ['サーバーと通信する処理です。アプリが外へ何を送っているかの手がかりになります。',
      'Communicates with a server — a good place to look for what the app sends out.']],
  crypto: [['暗号の計算', 'Cryptographic work'],
    ['暗号化やハッシュ計算をする処理です。', 'Performs encryption or hashing.']],
  keychain: [['秘密の保管庫を使う', 'Use the secure store'],
    ['パスワードなどを安全にしまう場所を読み書きする処理です。', 'Reads or writes the device’s secure credential store.']],
  random: [['でたらめな数を作る', 'Generate randomness'],
    ['予測できない数を作る処理です。', 'Generates an unpredictable number.']],
  prefs: [['設定を読み書き', 'Read or write settings'],
    ['アプリの設定を保存したり読み出したりする処理です。', 'Stores or loads an app setting.']],
  database: [['データベースを使う', 'Use the database'],
    ['端末の中のデータベースを読み書きする処理です。', 'Reads or writes the on-device database.']],
  ui: [['画面を扱う', 'Work with the screen'],
    ['画面の表示に関わる処理です。', 'Deals with what is shown on screen.']],
  concurrency: [['並行して動かす', 'Run concurrently'],
    ['別の流れで同時に処理を進めるための処理です。', 'Starts or coordinates concurrent work.']],
  time: [['時刻を調べる', 'Read the clock'],
    ['今の時刻や経過時間を調べる処理です。', 'Reads the current time.']],
  dylink: [['部品を後から読み込む', 'Load code at runtime'],
    ['実行中に外部の部品を読み込む処理です。', 'Loads external code while running.']],
  antidebug: [['解析されていないか調べる', 'Check for analysis'],
    ['自分が解析されていないかを調べている可能性のある処理です。',
      'May be checking whether the app is being analysed.']],
  abort: [['異常として止める', 'Abort'],
    ['異常が起きたとして、処理を打ち切る処理です。', 'Gives up and terminates on an error.']],
  errorobj: [['エラー情報を作る', 'Build an error'],
    ['エラーの内容を表すデータを作る処理です。', 'Builds an object describing an error.']],
};

export function apiShort(id) {
  const e = API_PHRASE[id];
  return e ? pick(e[0][0], e[0][1]) : null;
}

export function apiLong(id) {
  const e = API_PHRASE[id];
  return e ? pick(e[1][0], e[1][1]) : null;
}

/* 引数の意味 */
const ARG_LABEL = {
  dst: ['コピー先', 'destination'], src: ['コピー元', 'source'], size: ['バイト数', 'size'],
  fill: ['埋める値', 'fill value'], ptr: ['対象のデータ', 'the block'], a: ['1 つ目', 'first'],
  b: ['2 つ目', 'second'], str: ['対象の文字列', 'the text'], needle: ['探す文字列', 'what to look for'],
  format: ['ひな形の文言', 'the template'], receiver: ['相手', 'the receiver'],
  selector: ['頼む内容', 'the operation'], object: ['対象', 'the object'], class: ['種類', 'the class'],
  path: ['場所', 'the path'], handle: ['接続', 'the connection'], request: ['依頼の内容', 'the request'],
  query: ['問い合わせ内容', 'the query'], key: ['名前', 'the key'], name: ['名前', 'the name'],
};

function argLabel(role) {
  const e = ARG_LABEL[role];
  return e ? pick(e[0], e[1]) : null;
}

const RET_LABEL = {
  heap: ['確保されたメモリ', 'the memory that was reserved'],
  length: ['長さ', 'the length'],
  diff: ['比較の結果（0 なら同じ）', 'the comparison result (0 means equal)'],
  ptr: ['見つかった場所', 'the position that was found'],
  number: ['数値', 'a number'],
  object: ['作られたオブジェクト', 'the object'],
  handle: ['扱うための番号', 'a handle'],
  status: ['成功したかどうか', 'whether it succeeded'],
};

/* ── 値の言い換え（Phase 6） ───────────────────────────────── */

/**
 * 「そのレジスタが今なにを持っていそうか」を日本語にする。
 * 根拠がなければ必ず「分からない」と言う。
 */
export function describeValue(v) {
  if (!v) return pick('不明な値', 'an unknown value');
  switch (v.kind) {
    case 'imm':
      return pick(v.value + ' という数値', 'the number ' + v.value);
    case 'arg':
      return pick((v.index + 1) + ' 番目の引数（呼び出し元から渡された値）',
        'argument ' + (v.index + 1) + ' from the caller');
    case 'string':
      return v.viaPointer
        ? pick('「' + trim(v.text) + '」という名前', 'the name “' + trim(v.text) + '”')
        : pick('「' + trim(v.text) + '」という文字列の場所', 'the text “' + trim(v.text) + '”');
    case 'address':
      return v.partial
        ? pick('アドレスの上半分（次の行と組で完成します）', 'the top half of an address (completed by the next line)')
        : pick('0x' + v.addr.toString(16).toUpperCase() + ' に置かれたデータの場所',
          'data at 0x' + v.addr.toString(16).toUpperCase());
    case 'loaded':
      return v.addr != null
        ? pick('0x' + v.addr.toString(16).toUpperCase() + ' から読み出した値',
          'a value read from 0x' + v.addr.toString(16).toUpperCase())
        : pick('メモリから読み出した値', 'a value read from memory');
    case 'callResult': {
      const api = v.call && v.call.api ? v.call.api : null;
      if (api && api.ret && RET_LABEL[api.ret]) {
        return pick(RET_LABEL[api.ret][0], RET_LABEL[api.ret][1]);
      }
      if (v.call && v.call.name) {
        return pick('直前に呼んだ処理の結果', 'the result of the call just above');
      }
      return pick('直前の呼び出しの結果', 'the result of the previous call');
    }
    case 'computed':
      return pick('計算して作られた値', 'a computed value');
    default:
      return pick('不明な値', 'an unknown value');
  }
}

function trim(s, n = 40) {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ── 確からしさ ────────────────────────────────────────────── */

const LEVEL_WORD = {
  confirmed: ['確実（バイナリから直接読み取れます）', 'confirmed — read directly from the binary'],
  high: ['ほぼ確実', 'high confidence'],
  inferred: ['推測', 'inferred'],
  unknown: ['情報不足', 'not enough information'],
};

export function confidenceText(score) {
  const lv = levelOf(score);
  const w = LEVEL_WORD[lv];
  return pick('確度 ' + Math.round(score * 100) + '%（' + w[0] + '）',
    Math.round(score * 100) + '% — ' + w[1]);
}

export function levelWord(score) {
  const w = LEVEL_WORD[levelOf(score)];
  return pick(w[0], w[1]);
}

/* ── 根拠 ──────────────────────────────────────────────────── */

export function evidenceText(e) {
  if (!e) return '';
  const d = e.detail || {};
  switch (e.code) {
    case 'api':
      return pick('「' + short(apiShort(d.api)) + '」にあたる処理を呼んでいる', 'calls a routine that ' + (apiShort(d.api) || ''));
    case 'call-named':
      return pick('名前の分かる処理「' + d.name + '」を呼んでいる', 'calls the named routine “' + d.name + '”');
    case 'call-unknown':
      return pick('名前の分からない処理を呼んでいる', 'calls a routine with no name information');
    case 'call-indirect':
      return pick('行き先が実行時に決まる呼び出しがある' + (d.n ? '（' + d.n + ' か所）' : ''),
        'has ' + (d.n || 1) + ' call(s) whose target is decided at run time');
    case 'string':
      return pick('文字列「' + trim(d.text) + '」を参照している', 'references the text “' + trim(d.text) + '”');
    case 'address':
      return pick('0x' + d.addr.toString(16).toUpperCase() + ' のデータを指している',
        'points at data at 0x' + d.addr.toString(16).toUpperCase());
    case 'imm':
      return pick('定数 ' + d.value + ' を使っている', 'uses the constant ' + d.value);
    case 'branch':
      return d.conditional
        ? pick('条件によって進む先が分かれている', 'branches depending on a condition')
        : pick('別の場所へ進んでいる', 'jumps elsewhere');
    case 'backedge':
      return pick('前の行へ戻る分岐がある' + (d.n ? '（' + d.n + ' か所）' : '') + ' → 繰り返し',
        'branches backwards — a loop');
    case 'retval':
      return pick('直前の呼び出しの結果をすぐ調べている', 'inspects the result of the call just above');
    case 'argreg':
      return pick('引数レジスタを、値を入れる前に読んでいる', 'reads an argument register before writing it');
    case 'pcrel': case 'adrp-add':
      return pick('2 行組でデータの場所を組み立てている', 'builds an address from an instruction pair');
    case 'load':
      return pick('メモリから値を読み出している', 'reads a value from memory');
    case 'stack-save': case 'stack-reload':
      return pick('スタック（作業机）に値を置いて、あとで読み直している', 'saves a value on the stack and reloads it');
    case 'copy':
      return pick(d.from + ' が持っていた値を ' + d.to + ' へ渡している', 'passes the value in ' + d.from + ' to ' + d.to);
    case 'compute':
      return pick('計算をしている', 'performs a computation');
    case 'undecodable':
      return pick('命令として読めない 4 バイトが混ざっている', 'contains 4 bytes that are not a valid instruction');
    case 'leaf':
      return pick('ほかの処理をひとつも呼んでいない', 'calls nothing else');
    case 'instructions':
      return pick('命令が ' + d.n + ' 個並んでいる', d.n + ' instructions in a row');
    default:
      return '';
  }
}

function short(s) { return s || pick('不明', 'unknown'); }

/* ── Semantic Block の説明（Phase 4 / 5） ──────────────────── */

/** 一覧・ビューアに出す短い見出し。 */
export function blockTitle(block) {
  if (!block) return '';
  // メソッド名まで分かっているなら、それがいちばん知りたいこと
  if (block.facts && block.facts.selector) {
    return pick('「' + block.facts.selector + '」を呼ぶ', 'Call “' + block.facts.selector + '”');
  }
  if (block.facts && block.facts.api) {
    const s = apiShort(block.facts.api.id);
    if (s) return s;
  }
  if (block.role === ROLE.FUNCTION_CALL && block.calls.length && !block.calls[0].name) {
    return pick('名前の分からない処理を呼ぶ', 'Call an unnamed routine');
  }
  return roleLabel(block.role);
}

/**
 * 一覧の見出し。役割と題が同じときは繰り返さない。
 * 例: 「〔関数の開始〕」 / 「〔ほかの処理を呼び出す〕 データをコピー」
 */
export function blockHeading(block) {
  const tag = roleTag(block.role);
  const title = blockTitle(block);
  return title && title !== roleLabel(block.role) ? tag + ' ' + title : tag;
}

/** 流れの 1 ステップとして並べる、さらに短い言い方。 */
export function stepLabel(block) {
  if (!block) return '';
  if (block.facts && block.facts.selector) {
    return pick('「' + block.facts.selector + '」を呼ぶ', '“' + block.facts.selector + '”');
  }
  if (block.facts && block.facts.api) {
    const s = apiShort(block.facts.api.id);
    if (s) return s;
  }
  switch (block.role) {
    case ROLE.FUNCTION_ENTRY: return pick('処理を始める', 'start');
    case ROLE.MEMORY_READ: return pick('データを取得', 'read data');
    case ROLE.MEMORY_WRITE: return pick('データを保存', 'store data');
    case ROLE.CONDITION_CHECK: return pick('条件を確認', 'check a condition');
    case ROLE.RETURN_VALUE: return pick('結果を確認', 'check the result');
    case ROLE.FUNCTION_CALL: return pick('別の処理を呼ぶ', 'call something');
    case ROLE.LOOP: return pick('繰り返す', 'repeat');
    case ROLE.BRANCH: return pick('次の処理へ移る', 'move on');
    case ROLE.ERROR_HANDLING: return pick('異常時の処理', 'handle an error');
    case ROLE.CLEANUP: return pick('後片付け', 'clean up');
    case ROLE.FUNCTION_EXIT: return pick('呼び出し元へ戻る', 'return');
    case ROLE.ADDRESS_CALCULATION: return pick('データの場所を求める', 'locate data');
    case ROLE.VALUE_CALCULATION: return pick('計算する', 'compute');
    case ROLE.ARGUMENT_PREPARATION: return pick('渡すデータを準備', 'prepare data');
    case ROLE.REGISTER_SETUP: return pick('値を用意する', 'set up values');
    default: return pick('内容を特定できない処理', 'an unidentified step');
  }
}

/**
 * ブロック 1 つぶんの説明文（複数行）。
 * 「命令が何をするか」ではなく「処理として何が起きるか」を書く。
 */
export function blockSummary(block, model) {
  const lines = [];
  if (!block) return lines;
  const n = block.instructions.length;

  switch (block.role) {
    case ROLE.FUNCTION_ENTRY:
      lines.push(pick(
        '処理のはじまりです。あとで呼び出し元へ戻れるように帰り道を控え、この処理が使う作業机（スタック）を用意しています。',
        'The start of the routine: it records the way back to the caller and sets aside its own work area.'));
      break;
    case ROLE.FUNCTION_CALL: {
      const api = block.facts.api;
      const call = block.facts.apiCall || block.calls[0];
      if (api) {
        if (block.facts.selector) {
          lines.push(pick(
            'ある「もの」に対して「' + block.facts.selector + '」という仕事を頼んでいます。',
            'Asks an object to perform “' + block.facts.selector + '”.'));
        } else {
          lines.push(apiLong(api.id));
        }
        const prep = n > (call ? 1 : 0);
        if (prep) {
          lines.push(pick(
            'ここでは、その処理に渡すデータを用意してから実行しています。',
            'Here it prepares the data to hand over, then runs it.'));
        }
        lines.push(...describeArgs(call));
      } else if (call && call.name) {
        lines.push(pick(
          '「' + call.name + '」という名前の処理を呼び出しています。この名前が何をするものかは、このツールにはまだ情報がありません。',
          'Calls a routine named “' + call.name + '”. This tool has no description for that name yet.'));
      } else if (call && call.indirect) {
        lines.push(pick(
          '呼び出し先が実行時に決まる呼び出しです。どこへ行くかは、動かしてみないと分かりません。',
          'The call target is decided while the app runs, so it cannot be resolved here.'));
      } else {
        lines.push(pick(
          '別の処理を呼び出しています。呼び出し先に名前の情報が残っていないため、何をするかは特定できません。',
          'Calls another routine, but there is no name information for the target.'));
      }
      break;
    }
    case ROLE.ARGUMENT_PREPARATION:
      lines.push(pick(
        'このあとの処理に渡す値を、決められた置き場所に並べています。',
        'Places the values that the next routine will receive into the agreed slots.'));
      lines.push(...describeInputs(block));
      break;
    case ROLE.MEMORY_READ:
      lines.push(pick(
        'メモリに置かれているデータを読み出しています。',
        'Reads data that is sitting in memory.'));
      if (block.facts.stack) {
        lines.push(pick(
          '読み出し先はこの処理自身の作業机なので、さきほど自分で置いた値を取り出しているところです。',
          'It is reading from its own work area — a value it put there earlier.'));
      }
      lines.push(...describeRefs(block));
      break;
    case ROLE.MEMORY_WRITE:
      lines.push(pick(
        '値をメモリへ書き込んで残しています。',
        'Writes a value into memory.'));
      if (block.facts.stack) {
        lines.push(pick(
          '書き込み先はこの処理自身の作業机です。あとでまた使う値を置いています。',
          'The destination is its own work area — a value it will use again later.'));
      }
      break;
    case ROLE.ADDRESS_CALCULATION:
      lines.push(pick(
        'プログラムの中に置かれているデータの場所を求めています。ARM64 では、この 2 行組でひとつの住所を作ります。',
        'Works out where a piece of data lives. On ARM64 an address is built from a pair of instructions.'));
      lines.push(...describeRefs(block));
      break;
    case ROLE.CONDITION_CHECK:
      lines.push(pick(
        '2 つの値を見比べて、次にどちらへ進むかを決めています。',
        'Compares two values to decide which way to go next.'));
      if (block.branch) {
        lines.push(pick(
          '条件に合えば別の場所へ、合わなければそのまま次の行へ進みます。',
          'If the condition holds it jumps; otherwise it carries straight on.'));
      }
      break;
    case ROLE.RETURN_VALUE: {
      const c = block.facts.checkedCall;
      const what = c && c.api && c.api.ret && RET_LABEL[c.api.ret]
        ? pick(RET_LABEL[c.api.ret][0], RET_LABEL[c.api.ret][1])
        : pick('直前の処理の結果', 'the result of the previous step');
      lines.push(pick(
        what + 'を調べて、成功したときと失敗したときで進む先を変えています。',
        'Inspects ' + what + ' and takes a different path depending on it.'));
      break;
    }
    case ROLE.LOOP:
      lines.push(pick(
        '前の行へ戻っています。同じ処理を条件が変わるまで繰り返す部分です。',
        'Jumps backwards — this is where the same work repeats until a condition changes.'));
      break;
    case ROLE.BRANCH:
      lines.push(pick(
        '続きの処理へ移っています。', 'Moves on to another part of the routine.'));
      break;
    case ROLE.ERROR_HANDLING:
      lines.push(pick(
        '異常が起きたときの行き先です。ここに来ると、処理は通常の流れには戻りません。',
        'The path taken when something has gone wrong; control does not return to the normal flow.'));
      break;
    case ROLE.VALUE_CALCULATION:
      lines.push(pick(
        '値を計算して作っています。', 'Computes a value.'));
      break;
    case ROLE.REGISTER_SETUP:
      lines.push(pick(
        'このあと使う値を、手元に用意しています。', 'Gets the values it will need into place.'));
      lines.push(...describeInputs(block));
      break;
    case ROLE.CLEANUP:
      lines.push(pick(
        '借りていた作業机を返し、預かっていた値を元に戻しています。処理の終わりの合図です。',
        'Gives back the work area and restores the values it borrowed — the routine is wrapping up.'));
      break;
    case ROLE.FUNCTION_EXIT:
      lines.push(pick(
        '呼び出し元へ帰ります。', 'Returns to whoever called this routine.'));
      break;
    default:
      lines.push(pick(
        'この部分が何をしているかは、今の解析情報だけでは特定できませんでした。',
        'What this part does could not be determined from the available information.'));
      break;
  }

  if (block.confidence < 0.5 && block.role !== ROLE.UNKNOWN) {
    lines.push(pick('※ 手がかりが少ないため、この説明は確かではありません。',
      'Note: little evidence here, so this description is uncertain.'));
  }
  void model;
  return lines.filter(Boolean);
}

/** 呼び出しの引数を、分かる範囲で説明する。分からないものは分からないと言う。 */
function describeArgs(call) {
  const out = [];
  if (!call || !call.api || !call.api.args) return out;
  const known = [];
  const unknown = [];
  for (const a of call.args) {
    const role = call.api.args[a.index];
    if (!role) continue;
    const label = argLabel(role);
    if (!label) continue;
    if (a.value && a.value.kind !== 'unknown') {
      if (role === 'size' && a.value.kind === 'imm') {
        known.push(pick(label + 'は ' + a.value.value + ' バイトです。',
          'The ' + label + ' is ' + a.value.value + ' bytes.'));
      } else if (role === 'selector' && a.value.text) {
        continue;   // メソッド名はすでに見出しと 1 文目で言っている
      } else {
        known.push(pick(label + 'は' + describeValue(a.value) + 'です。',
          'The ' + label + ' is ' + describeValue(a.value) + '.'));
      }
    } else {
      unknown.push(label);
    }
  }
  out.push(...known);
  if (unknown.length) {
    out.push(pick(
      unknown.join('・') + 'が何なのかは、今の解析情報だけでは特定できません。',
      'What the ' + unknown.join(' and ') + ' actually is cannot be determined from the available information.'));
  }
  return out;
}

function describeInputs(block) {
  const out = [];
  for (const i of block.inputs || []) {
    if (!i.value || i.value.kind === 'unknown') continue;
    if (i.value.kind === 'arg' || i.value.kind === 'string' || i.value.kind === 'callResult') {
      out.push(pick('渡そうとしているのは' + describeValue(i.value) + 'です。',
        'The value being passed is ' + describeValue(i.value) + '.'));
    }
    if (out.length >= 2) break;
  }
  return out;
}

function describeRefs(block) {
  const out = [];
  for (const r of block.refs || []) {
    if (r.text) {
      out.push(pick('指しているのは「' + trim(r.text) + '」という文字列です。',
        'It points at the text “' + trim(r.text) + '”.'));
    }
    if (out.length >= 2) break;
  }
  return out;
}

/* ── 関数の説明（Phase 8 / 9） ─────────────────────────────── */

const FEATURE_LABEL = {
  network: ['ネットワーク通信', 'network communication'],
  security: ['セキュリティ（暗号・秘密情報・解析対策）', 'security'],
  storage: ['データの保存と読み出し', 'storage'],
  ui: ['画面の表示', 'the user interface'],
  objc: ['オブジェクトの操作', 'object handling'],
  data: ['データの加工', 'data manipulation'],
  diagnostics: ['記録とエラー処理', 'logging and errors'],
  runtime: ['実行のしくみ', 'runtime plumbing'],
};

export function featureLabel(id) {
  const e = FEATURE_LABEL[id];
  return e ? pick(e[0], e[1]) : null;
}

/**
 * 関数を開いたときに最初に見せる「日本語の流れ」。
 *
 * @returns {{headline:string, steps:string[], purpose:string[], evidence:string[],
 *            confidence:number, features:string[]}}
 */
export function functionStory(model, name) {
  const f = model.facts;
  const steps = [];
  let last = '';
  // 最後の ret より後ろは、詰め物や次の関数のかけら。流れには入れない。
  let end = model.semantic.length;
  for (let i = model.semantic.length - 1; i >= 0; i--) {
    if (model.semantic[i].role === ROLE.FUNCTION_EXIT) { end = i + 1; break; }
  }
  for (let i = 0; i < end; i++) {
    const b = model.semantic[i];
    if (b.role === ROLE.FUNCTION_ENTRY || b.role === ROLE.CLEANUP) continue;
    const s = stepLabel(b);
    if (!s || s === last) continue;
    last = s;
    steps.push(s);
    if (steps.length >= 12) break;
  }
  if (!steps.length) steps.push(pick('内容を特定できませんでした', 'nothing could be identified'));

  const purpose = [];
  const label = typeof name === 'string' ? name : (name && name.name) || null;
  const who = label ? pick('この関数（' + label + '）', 'this function (' + label + ')') : pick('この処理', 'this routine');
  const Who = pick(who, who.charAt(0).toUpperCase() + who.slice(1));

  if (f.features.length) {
    purpose.push(pick(
      Who + 'は、' + f.features.map(featureLabel).filter(Boolean).join('と') + 'に関わる処理をしています。',
      Who + ' is involved in ' + f.features.map(featureLabel).filter(Boolean).join(' and ') + '.'));
  }
  /*
   * 呼んでいるメソッドの名前。人が付けた言葉がそのまま残っている唯一の場所なので、
   * この 1 文がいちばん役に立つ。だから機能の分類より先に出す。
   */
  const sels = uniq((model.calls || []).map((c) => c.selector).filter(Boolean));
  if (sels.length) {
    purpose.unshift(pick(
      '「' + sels.slice(0, 8).join('」「') + '」' +
        (sels.length > 8 ? ' など ' + sels.length + ' 個' : '') + 'というメソッドを呼んでいます。' +
        'メソッドの名前は人が付けたものなので、この関数が何の担当かを知る手がかりになります。',
      'It calls the methods ' + sels.slice(0, 8).map((x) => '“' + x + '”').join(', ') +
        '. Method names are written by people, so they say a lot about what this is for.'));
  }
  /*
   * 言語のしくみ（ARC・Swift ランタイム・C++ の下ごしらえ）は、
   * どの関数にも入っていて、その関数が何をしているかを何も言っていない。
   * ほかに言うことがあるなら、そちらを先に出す。
   */
  const meaty = f.apis.filter((a) => a.cat !== 'runtime');
  const apiPhrases = (meaty.length ? meaty : f.apis).map((a) => apiShort(a.id)).filter(Boolean);
  if (apiPhrases.length) {
    purpose.push(pick(
      '具体的には、' + uniq(apiPhrases).slice(0, 4).join('・') + 'といった処理を行っています。',
      'Concretely it does the following: ' + uniq(apiPhrases).slice(0, 4).join(', ') + '.'));
  }
  if (f.strings && f.strings.length) {
    purpose.push(pick(
      '「' + f.strings.slice(0, 3).map((s) => trim(s, 24)).join('」「') + '」といった文字列を使っています。',
      'It uses the text ' + f.strings.slice(0, 3).map((s) => '“' + trim(s, 24) + '”').join(', ') + '.'));
  }
  // 名前は分かるが意味は分からない呼び出し。ここから先へ辿るための手がかりになる。
  const plain = (f.calledNames || []).filter((c) => !f.apis.some((a) => a.name === c.name));
  if (plain.length) {
    const list = plain.slice(0, 4).map((c) => '「' + c.name + '」').join('、');
    purpose.push(pick(
      list + (plain.length > 4 ? ' など ' + plain.length + ' 種類' : '') +
        'という名前の処理を呼んでいます。それぞれが何をしているかは、その関数をたどると分かります。',
      'It calls ' + plain.slice(0, 4).map((c) => '“' + c.name + '”').join(', ') +
        (plain.length > 4 ? ' and ' + (plain.length - 4) + ' more' : '') +
        '. Follow each one to see what it does.'));
  }
  if (f.loops) {
    purpose.push(pick('同じ処理を繰り返す部分があります。', 'Part of it repeats in a loop.'));
  }
  if (f.indirectCalls) {
    purpose.push(pick(
      '行き先が実行時に決まる呼び出しがあるため、ここから先はこのツールだけでは追えません。',
      'Some calls are resolved at run time, so the trail stops there for static analysis.'));
  }
  if (!purpose.length) {
    const why = f.calls
      ? pick('呼んでいる相手の名前が残っておらず、読める文字列も使っていないため、手がかりがありません。',
        'the routines it calls have no names left and it uses no readable text')
      : pick('ほかの処理を呼ばず、読める文字列も使っていないため、手がかりがありません。',
        'it calls nothing else and uses no readable text');
    purpose.push(pick(
      Who + 'が何のためのものかは、今の情報だけでは特定できませんでした。' + why,
      'What ' + who + ' is for could not be determined: ' + why + '.'));
  }

  const evidence = uniq(f.evidence.map(evidenceText).filter(Boolean)).slice(0, 6);

  return {
    headline: headlineOf(f, name),
    steps,
    purpose,
    evidence,
    confidence: f.confidence,
    features: f.features.map(featureLabel).filter(Boolean),
  };
}

function headlineOf(f, name) {
  const main = f.mainRole || { kind: 'plain' };
  if (main.kind === 'api') {
    const label = featureLabel(({
      network: 'network', secret: 'security', crypto: 'security', antidebug: 'security',
      storage: 'storage', io: 'storage', database: 'storage', ui: 'ui', objc: 'objc',
      string: 'data', memory: 'data', log: 'diagnostics', error: 'diagnostics',
      concurrency: 'runtime',
    })[main.cat] || 'data');
    return pick(label + 'に関わる処理', 'a routine dealing with ' + label);
  }
  if (main.kind === 'tiny') return pick('とても短い処理', 'a very short routine');
  if (main.kind === 'calls') return pick('ほかの処理を順に呼び出している処理', 'a routine that calls others in turn');
  if (main.kind === 'loop') return pick('繰り返しを含む処理', 'a routine with a loop');
  if (main.kind === 'branchy') return pick('条件で枝分かれする処理', 'a routine that branches on conditions');
  void name;
  return pick('内容を特定できていない処理', 'a routine that has not been identified');
}

function uniq(arr) {
  const out = [];
  for (const a of arr) if (a && !out.includes(a)) out.push(a);
  return out;
}

/* ────────────────────────────────────────────────────────────
   目的から探す — 候補の理由を読み上げる
   ──────────────────────────────────────────────────────────── */

/* 負の数は `0x-60` ではなく `-0x60`。16 進の中に符号を混ぜない。 */
const hex = (v) => {
  if (v == null) return '';
  const n = typeof v === 'bigint' ? v : BigInt(v);
  return (n < 0n ? '-0x' : '0x') + (n < 0n ? -n : n).toString(16).toUpperCase();
};

/**
 * `x29 - 0x60` のように、ずらし幅の符号を演算子として書く。
 *
 * スタックの上（関数の中だけで使う一時的な値）は必ず負になるので、
 * ここを素直に足すと `x29 + 0x-60` という、読めないものが画面に出る。
 */
const atOffset = (base, disp) => {
  if (disp == null) return String(base);
  const n = typeof disp === 'bigint' ? disp : BigInt(disp);
  if (n === 0n) return String(base);
  return base + (n < 0n ? ' - 0x' : ' + 0x') + (n < 0n ? -n : n).toString(16).toUpperCase();
};

/* ── フィールドの言い換え ────────────────────────────────────
 *
 * ここがこのツールでいちばん効く言い換え。
 *   「x0 + 0x20 の値」  →  「BattleManager の hp」
 * Objective-C のクラス表から名前が取れたときだけ使う。取れなければ元のまま。
 */

/** 型を初心者の言葉に。分からなければ null。 */
export function typeWord(type) {
  if (!type) return null;
  switch (type.kind) {
    case 'int':
      return pick((type.bytes || 4) + ' バイトの整数', (type.bytes || 4) + '-byte integer');
    case 'float':
      return pick((type.bytes || 4) + ' バイトの小数', (type.bytes || 4) + '-byte number with decimals');
    case 'bool': return pick('はい／いいえ', 'a yes/no flag');
    case 'object':
      return type.className
        ? pick(type.className + ' のオブジェクト', 'a ' + type.className + ' object')
        : pick('オブジェクト', 'an object');
    case 'cstring': return pick('文字列', 'text');
    case 'class': return pick('クラス', 'a class');
    case 'selector': return pick('メソッド名', 'a method name');
    case 'block': return pick('あとで実行される処理', 'a block of code');
    case 'pointer': return pick('ほかの場所を指す値', 'a pointer to somewhere else');
    case 'struct':
      return type.name
        ? pick(type.name + ' というまとまり', 'a ' + type.name + ' structure')
        : pick('データのまとまり', 'a structure');
    case 'array': return pick('並び', 'an array');
    default: return null;
  }
}

/** フィールド 1 つの呼び名。「BattleManager の hp」 */
export function fieldName(field, withClass = true) {
  if (!field) return null;
  const plain = field.plain || String(field.name || '').replace(/^_+/, '');
  if (!plain) return null;
  if (withClass && field.className) {
    return pick(field.className + ' の ' + plain, plain + ' of ' + field.className);
  }
  return plain;
}

/**
 * 場所の呼び名。フィールド名が分かればそれを、分からなければレジスタ＋ずらし幅を。
 * 分かるふりはしない。
 */
export function placeName(field, base, disp) {
  const named = fieldName(field);
  if (named) return named;
  if (!base) return pick('ある場所', 'somewhere');
  return atOffset(base, disp);
}

/** ★★★★☆ の見た目。 */
export function starsText(n) {
  const k = Math.max(1, Math.min(5, n | 0));
  return '★'.repeat(k) + '☆'.repeat(5 - k);
}

/**
 * 候補の点数の内訳 1 行ぶん。
 * 「+20 「ダメージ」という文字列を参照している」のように、点と理由を並べて出す。
 */
export function reasonText(r) {
  if (!r) return '';
  const d = r.detail || {};
  switch (r.code) {
    case 'string-ref':
      return pick('「' + trim(d.text, 28) + '」という文字列を、この関数が実際に参照している',
        'this function really does reference the text “' + trim(d.text, 28) + '”');
    case 'name-match':
      return pick('関数の名前「' + trim(d.name, 40) + '」が目的の言葉を含んでいる',
        'the function name “' + trim(d.name, 40) + '” contains the word you are looking for');
    case 'callee-name':
      return pick('目的の言葉を含む処理「' + trim(d.name, 32) + '」を呼んでいる',
        'it calls “' + trim(d.name, 32) + '”, whose name matches');
    case 'caller-name':
      return pick('目的の言葉を含む処理「' + trim(d.name, 32) + '」から呼ばれている',
        'it is called by “' + trim(d.name, 32) + '”, whose name matches');
    case 'calls-match':
      return pick('有力候補' + (d.toName ? '「' + trim(d.toName, 24) + '」' : '') + 'を呼んでいる',
        'it calls another strong candidate');
    case 'called-by-match':
      return pick('有力候補' + (d.fromName ? '「' + trim(d.fromName, 24) + '」' : '') + 'から呼ばれている',
        'it is called by another strong candidate');
    case 'numeric': {
      const parts = [];
      if (d.mul) parts.push(pick(d.mul + ' 回の掛け算', d.mul + ' multiplications'));
      if (d.div) parts.push(pick(d.div + ' 回の割り算', d.div + ' divisions'));
      if (d.fmul) parts.push(pick(d.fmul + ' 回の小数の掛け算', d.fmul + ' float multiplications'));
      if (d.farith) parts.push(pick(d.farith + ' 回の小数の足し引き', d.farith + ' float add/subtracts'));
      return pick('中で数値の計算をしている（' + parts.join('・') + '）',
        'it does arithmetic inside (' + parts.join(', ') + ')');
    }
    case 'store':
      return pick('計算した値をメモリへ書き込んでいる（' + d.n + ' か所）',
        'it writes values back into memory (' + d.n + ' places)');
    case 'compare':
      return pick('値を比べている（' + d.n + ' か所）— しきい値の判定がありそう',
        'it compares values (' + d.n + ' places)');
    case 'popular':
      return pick('あちこちから呼ばれている（' + d.n + ' か所）— アプリの本筋に近い',
        'it is called from ' + d.n + ' places — close to the main flow');
    case 'size-penalty':
      return pick('命令が ' + d.n.toLocaleString() + ' 個と大きすぎて、目的の計算そのものとは考えにくい',
        'it is very large (' + d.n.toLocaleString() + ' instructions), so it is unlikely to be the calculation itself');
    case 'vendor': {
      const who = d.vendor || pick('外部のライブラリ', 'a third-party library');
      const proof = d.where === 'string'
        ? pick('参照している文字列「' + trim(d.text, 24) + '」', 'the text it references, “' + trim(d.text, 24) + '”')
        : pick('名前', 'its name');
      return pick(proof + 'から、これはアプリ本体ではなく ' + who + '（組み込んだ SDK）のものです。' +
        'ゲームの数値の答えにはなりません',
      proof + ' shows this belongs to ' + who + ', a bundled SDK — not to the game itself');
    }
    default:
      return '';
  }
}

/** その理由が「事実」か「解釈」か。UI の見た目を変えるための語。 */
export function certaintyWord(kind) {
  if (kind === 'fact') return pick('事実', 'fact');
  if (kind === 'unknown') return pick('不明', 'unknown');
  return pick('推測', 'inference');
}

/* ────────────────────────────────────────────────────────────
   関数レポート — 事実 / 推測 / 不明
   ──────────────────────────────────────────────────────────── */

/** FACT の 1 行。ここに書けるのは、バイナリから直接読めることだけ。 */
export function factText(f) {
  if (!f) return '';
  const d = f.detail || {};
  switch (f.code) {
    case 'instructions':
      return pick('命令が ' + d.n.toLocaleString() + ' 個ある', d.n.toLocaleString() + ' instructions');
    case 'calls':
      return pick('ほかの処理を ' + d.n + ' 回呼んでいる（うち名前が分かるのは ' + d.named + ' 回）',
        'calls other routines ' + d.n + ' times (' + d.named + ' of them have names)');
    case 'call-named':
      return pick('「' + trim(d.name, 40) + '」を呼んでいる', 'calls “' + trim(d.name, 40) + '”');
    case 'selector':
      return pick('「' + d.selector + '」というメソッドを呼んでいる',
        'sends the message “' + d.selector + '”');
    case 'string-ref':
      return pick('文字列「' + trim(d.text, 32) + '」（' + hex(d.addr) + '）を参照している',
        'references the text “' + trim(d.text, 32) + '” at ' + hex(d.addr));
    case 'loops':
      return pick('前へ戻る分岐が ' + d.n + ' か所ある（＝繰り返し）', d.n + ' backward branches — loops');
    case 'conditionals':
      return pick('条件分岐が ' + d.n + ' か所ある', d.n + ' conditional branches');
    case 'memory':
      return pick('メモリの読み出し ' + d.loads + ' 回、書き込み ' + d.stores + ' 回',
        d.loads + ' loads and ' + d.stores + ' stores');
    case 'returns-value':
      return pick('帰る前に x0 を作っている（＝呼び出し元へ値を返している）',
        'writes x0 before returning — it returns a value');
    case 'arguments':
      return pick('自分で書く前に ' + d.regs.map((n) => 'x' + n).join('、') + ' を読んでいる（＝引数を受け取っている）',
        'reads ' + d.regs.map((n) => 'x' + n).join(', ') + ' before writing them — it takes arguments');
    case 'numeric': {
      const parts = [];
      if (d.mul) parts.push(pick('掛け算 ' + d.mul + ' 回', d.mul + ' multiplications'));
      if (d.div) parts.push(pick('割り算 ' + d.div + ' 回', d.div + ' divisions'));
      if (d.fmul) parts.push(pick('小数の掛け算 ' + d.fmul + ' 回', d.fmul + ' float multiplications'));
      if (d.farith) parts.push(pick('小数の足し引き ' + d.farith + ' 回', d.farith + ' float add/subs'));
      return parts.join('・');
    }
    case 'value-update': {
      const op = d.ops && d.ops.length ? d.ops[d.ops.length - 1] : null;
      const where = placeName(d.field, d.base, d.disp);
      if (d.kind === 'read-modify-write') {
        return pick(where + ' を読み、' + (op ? '「' + opWord(op) + '」という計算をして、' : '') + '書き戻している',
          'reads ' + where + (op ? ', ' + opWord(op) : '') + ', and writes it back');
      }
      return pick(where + ' へ値を書き込んでいる', 'writes a value to ' + where);
    }
    case 'compare-const':
      return pick((d.register || pick('ある値', 'a value')) + ' を ' +
        (d.value != null ? d.value.toString() : d.float) + ' と比べている',
      'compares ' + (d.register || 'a value') + ' with ' + (d.value != null ? d.value.toString() : d.float));
    case 'callers':
      return pick('この関数を呼んでいる場所が ' + d.n + ' か所ある', 'called from ' + d.n + ' places');
    case 'no-callers':
      return pick('この関数を呼んでいる場所は、このセクションの中には見つからなかった',
        'nothing in this section calls it');
    case 'indirect-calls':
      return pick('行き先が実行時に決まる呼び出しが ' + d.n + ' か所ある',
        d.n + ' calls whose target is decided at run time');
    default:
      return '';
  }
}

/** 演算 1 つを短い言葉にする。「10 を足す」「2 倍する」。 */
function opWord(op) {
  const name = op && op.op ? op.op : '';
  const n = op && op.imm != null ? op.imm.toString() : null;
  switch (name) {
    case 'add': case 'adds': return n ? pick(n + ' を足す', 'add ' + n) : pick('足し算をする', 'add');
    case 'sub': case 'subs': return n ? pick(n + ' を引く', 'subtract ' + n) : pick('引き算をする', 'subtract');
    case 'mul': case 'madd': case 'msub':
      return n ? pick(n + ' を掛ける', 'multiply by ' + n) : pick('掛け算をする', 'multiply');
    case 'sdiv': case 'udiv': return pick('割り算をする', 'divide');
    case 'fmul': return pick('小数の掛け算をする', 'multiply (float)');
    case 'fdiv': return pick('小数の割り算をする', 'divide (float)');
    case 'fadd': return pick('小数の足し算をする', 'add (float)');
    case 'fsub': return pick('小数の引き算をする', 'subtract (float)');
    case 'and': case 'orr': case 'eor': case 'bic': return pick('ビット単位の演算をする', 'do bit operations');
    case 'lsl': return n ? pick(2 ** Number(n) + ' 倍する', 'multiply by ' + (2 ** Number(n))) : pick('左へずらす', 'shift left');
    case 'lsr': case 'asr': return n ? pick(2 ** Number(n) + ' で割る', 'divide by ' + (2 ** Number(n))) : pick('右へずらす', 'shift right');
    case 'mov': case 'movz': return pick('別の値に入れ替える', 'replace with another value');
    case 'csel': case 'csinc': return pick('条件によって値を選ぶ', 'pick a value depending on a condition');
    default: return pick('計算する', 'compute');
  }
}

/** INFERENCE の 1 行。必ず確度と根拠が付く前提で書く。 */
export function inferenceText(i) {
  if (!i) return '';
  const d = i.detail || {};
  switch (i.code) {
    case 'purpose-feature':
      return pick('この関数は ' + (d.features || []).map(featureLabel).filter(Boolean).join('と') +
        ' に関わる処理をしている可能性が高い',
      'this function is probably involved in ' + (d.features || []).map(featureLabel).filter(Boolean).join(' and '));
    case 'purpose-selector':
      return pick('呼んでいるメソッド名（' + (d.selectors || []).slice(0, 3).join('、') +
        '）から見て、その担当らしい',
      'the method names it sends (' + (d.selectors || []).slice(0, 3).join(', ') + ') suggest what it is for');
    case 'value-holder': {
      const where = placeName(d.field, d.base, d.disp);
      return pick(where + ' が、この関数が扱っている値そのものである可能性が高い',
        where + ' is probably the value this function works on');
    }
    case 'threshold-check':
      return pick('決まった数と比べて処理を分けているので、上限や条件の判定が入っていそう',
        'it compares against fixed numbers, so there is probably a limit or condition check');
    case 'goal-related':
      return pick('探している「' + (d.label || '') + '」に関係している可能性がある',
        'this may be related to “' + (d.label || '') + '”');
    default:
      return '';
  }
}

/** UNKNOWN の 1 行。ここを言わないツールは信用できない。 */
export function unknownText(u) {
  if (!u) return '';
  const d = u.detail || {};
  switch (u.code) {
    case 'indirect-target':
      return pick('行き先が実行時に決まる呼び出しが ' + d.n + ' か所あり、その先はこのツールでは追えません。',
        d.n + ' calls are resolved at run time; this tool cannot follow them.');
    case 'unnamed-calls':
      return pick('名前の残っていない呼び出しが ' + d.n + ' か所あり、それが何をするかは分かりません。',
        d.n + ' calls have no name information, so what they do is unknown.');
    case 'no-strings':
      return pick('読める文字列を参照していないため、言葉からの手がかりはありません。',
        'it references no readable text, so there is no word-level clue.');
    case 'truncated':
      return pick('関数が大きすぎるため、途中までしか解析していません。',
        'the function is too large; only the first part was analysed.');
    case 'stats-partial':
      return pick('セクションが大きいため、命令の統計は一部だけです。',
        'the section is large, so the instruction statistics cover only part of it.');
    case 'goal-unrelated':
      return pick('探しているものとの結びつきは、この関数の中には見つかりませんでした。',
        'no link to what you are looking for was found in this function.');
    case 'runtime-meaning':
      return pick('この値が実行時に何を意味するかは、静的な解析だけでは確定できません。' +
        '最後は実際に動かして確かめる必要があります。',
      'What these values mean at run time cannot be settled by static analysis alone.');
    default:
      return '';
  }
}

/* ────────────────────────────────────────────────────────────
   ひとこと — 説明の一番上の段
   ────────────────────────────────────────────────────────────

   詳しい説明は、詳しすぎると「で、何がしたい処理なの？」が消える。
   だから最初に出すのは必ず 1 行にする。詳細は、降りたい人だけが降りる。

   優先順位は「利用者にとっての価値」の順:
     1. 値を書き換えている（＝改造したい人が探しているもの）
     2. 何のメソッドか（クラス名とメソッド名が分かっている）
     3. 何の機能に関わるか（API から）
     4. 分からない → 分からないと言う                            */

/**
 * 値をどう変えているか、を 1 語で。「10 減らす」「2 倍にする」。
 * 数が分からないときは「計算した値だけ減らす」のように、分かる範囲で言う。
 */
export function changeVerb(step) {
  if (!step) return pick('書き換える', 'change');
  const n = step.imm != null ? step.imm.toString() : null;
  switch (step.op) {
    case 'add': case 'adds':
      return n ? pick(n + ' 増やす', 'add ' + n + ' to') : pick('計算した値だけ増やす', 'increase');
    case 'sub': case 'subs':
      return n ? pick(n + ' 減らす', 'subtract ' + n + ' from') : pick('計算した値だけ減らす', 'decrease');
    case 'mul': case 'madd':
      return n ? pick(n + ' 倍にする', 'multiply by ' + n) : pick('掛け算で書き換える', 'multiply');
    case 'msub': return pick('掛け算した値だけ減らす', 'subtract a product from');
    case 'sdiv': case 'udiv': return pick('割り算で減らす', 'divide');
    case 'fmul': return pick('小数の掛け算で書き換える', 'multiply (float)');
    case 'fadd': return pick('小数の足し算で増やす', 'add (float)');
    case 'fsub': return pick('小数の引き算で減らす', 'subtract (float)');
    case 'lsl': return n ? pick((2 ** Number(n)) + ' 倍にする', 'multiply by ' + (2 ** Number(n))) : pick('倍にする', 'scale up');
    case 'lsr': case 'asr': return n ? pick((2 ** Number(n)) + ' で割る', 'divide by ' + (2 ** Number(n))) : pick('割る', 'scale down');
    case 'and': case 'orr': case 'eor': case 'bic':
      return pick('ビット単位で書き換える', 'change bit by bit');
    case 'mov': case 'movz': return pick('別の値に入れ替える', 'replace');
    case 'csel': case 'csinc': return pick('条件によって入れ替える', 'replace depending on a condition');
    default: return pick('計算した値に書き換える', 'replace with a computed value');
  }
}

/** 関数レポートから、1 行の要約を作る。 */
export function oneLiner(report, name) {
  if (!report) return '';
  const edit = report.editTargets && report.editTargets[0];
  if (edit) {
    const where = placeName(edit.field, edit.location.base, edit.location.disp);
    const step = edit.steps && edit.steps.length ? edit.steps[edit.steps.length - 1] : null;
    const verb = changeVerb(step);
    return pick(where + ' を' + verb + '処理です。', 'It will ' + verb + ' ' + where + '.');
  }

  const owner = report.owner;
  if (owner && owner.sel) {
    return pick(owner.className + ' の「' + owner.sel + '」という処理です。',
      'This is “' + owner.sel + '” on ' + owner.className + '.');
  }

  const sel = report.selectors && report.selectors[0];
  if (sel) {
    return pick('「' + sel + '」というメソッドを呼び出す処理です。',
      'It sends the message “' + sel + '”.');
  }

  const purpose = (report.inferences || []).find((i) => i.code === 'purpose-feature');
  if (purpose && purpose.detail && purpose.detail.features && purpose.detail.features.length) {
    const label = purpose.detail.features.map(featureLabel).filter(Boolean).join('と');
    if (label) return pick(label + ' に関わる処理です。', 'It deals with ' + label + '.');
  }

  const facts = report.facts || [];
  const calls = facts.find((f) => f.code === 'calls');
  if (calls && calls.detail && calls.detail.n) {
    return pick('ほかの処理を ' + calls.detail.n + ' 回呼び出している処理です。',
      'It calls other routines ' + calls.detail.n + ' times.');
  }
  void name;
  return pick('この処理が何をしているかは、特定できませんでした。',
    'What this routine does could not be determined.');
}

/**
 * 「どういうこと」— ひとことの次の段。3 行まで。
 * 入力・出力・変えるもの、という人が知りたい順に並べる。
 */
export function whatItDoes(report) {
  const lines = [];
  if (!report) return lines;
  const facts = report.facts || [];
  const at = (code) => facts.find((f) => f.code === code);

  const args = at('arguments');
  if (args && args.detail.regs.length) {
    lines.push(pick(
      '呼び出し元から ' + args.detail.regs.length + ' 個の値を受け取ります。',
      'It receives ' + args.detail.regs.length + ' value(s) from the caller.'));
  }
  const edit = report.editTargets && report.editTargets[0];
  if (edit) {
    const where = placeName(edit.field, edit.location.base, edit.location.disp);
    const type = edit.field && edit.field.type ? typeWord(edit.field.type) : null;
    lines.push(pick(
      '変えているのは ' + where + (type ? '（' + type + '）' : '') + 'です。',
      'What it changes is ' + where + (type ? ' (' + type + ')' : '') + '.'));
  }
  if (at('returns-value')) {
    lines.push(pick('計算した結果を、呼び出し元へ返します。', 'It returns a value to the caller.'));
  }
  const callers = at('callers');
  if (callers) {
    lines.push(pick(
      'この処理は ' + callers.detail.n + ' か所から呼ばれています。',
      'It is called from ' + callers.detail.n + ' place(s).'));
  }
  return lines.slice(0, 4);
}

/** 「次に何をすればいいか」。初心者がいちばん詰まるところ。 */
export function nextStepText(s) {
  if (!s) return '';
  const d = s.detail || {};
  switch (s.code) {
    case 'check-callers':
      return pick('この関数を呼んでいる ' + d.n + ' か所を見て、どんな場面で使われるか確かめる',
        'look at the ' + d.n + ' places that call it, to see when it is used');
    case 'no-callers-hint':
      return pick('呼び出し元が見つからないので、実行時にだけ呼ばれる形（メソッド呼び出しなど）かもしれない',
        'nothing calls it directly — it may only be reached at run time');
    case 'check-inputs':
      return pick('受け取っている値（' + (d.regs || []).map((n) => 'x' + n).join('、') + '）が何かを、呼び出し元で確かめる',
        'check what the caller passes in (' + (d.regs || []).map((n) => 'x' + n).join(', ') + ')');
    case 'check-return':
      return pick('返している値が、呼び出し元でどう使われるかを追う',
        'follow the returned value into the caller');
    case 'check-updates':
      return pick('値を書き換えている場所（' + hex(d.addr) + '）を開いて、何を増減させているか見る',
        'open the place that changes the value (' + hex(d.addr) + ') and see what it adds or subtracts');
    case 'check-callees':
      return pick('この関数が呼んでいる ' + d.n + ' 個の処理をたどって、本体がどれか探す',
        'follow the ' + d.n + ' routines it calls to find where the real work happens');
    case 'check-thresholds':
      return pick('比べている数（しきい値）を見て、条件が何かを確かめる',
        'look at the constants it compares against to see what the condition is');
    case 'verify-runtime':
      return pick('最後は実際に動かして、狙った値が変わるかどうかを確かめる',
        'finally, run the app and check whether the value really changes');
    default:
      return '';
  }
}

/* ── 値の流れ ─────────────────────────────────────────────── */

/**
 * 「読んで → 計算して → 書き戻す」を 4 行で見せる。
 * 仕様どおり、変更対象・変更前・演算・変更後を分けて言う。
 */
export function updateLines(update) {
  if (!update) return [];
  const where = placeName(update.field, update.location.base, update.location.disp);
  const lines = [];
  lines.push(pick('変更対象: ' + where, 'Target: ' + where));
  if (update.from) {
    lines.push(pick('変更前: ' + where + ' に入っている値', 'Before: the value stored at ' + where));
  } else {
    lines.push(pick('変更前: 不明（読み出しが見つかりませんでした）', 'Before: unknown (no matching load was found)'));
  }
  if (update.steps && update.steps.length) {
    const ops = update.steps.map((s) => opWord(s)).join(pick('、そのあと ', ', then '));
    lines.push(pick('演算: ' + ops, 'Operation: ' + ops));
  } else {
    lines.push(pick('演算: なし（そのまま書き込んでいます）', 'Operation: none — the value is stored as-is'));
  }
  lines.push(pick('変更後: その結果を、同じ ' + where + ' へ書き戻す',
    'After: the result is written back to ' + where));
  return lines;
}

/** ある値が次にどう使われるか、の 1 行。 */
export function useText(u) {
  if (!u) return '';
  const d = u.detail || {};
  switch (u.use) {
    case 'argument':
      return pick('この値を、次の呼び出しに渡している' +
        (d.index != null ? '（' + (d.index + 1) + ' 番目の引数）' : ''),
      'passed to the next call' + (d.index != null ? ' as argument ' + (d.index + 1) : ''));
    case 'store':
      return pick('この値をメモリ（' + atOffset(d.base || '?', d.disp) + '）へ書き込んでいる',
        'stored into memory at ' + atOffset(d.base || '?', d.disp));
    case 'compare':
      return pick('この値を比べて、進む道を決めている', 'compared, to decide which way to go');
    case 'compute':
      return pick('この値を使って計算している（' + (d.op || '') + '）',
        'used in a computation (' + (d.op || '') + ')');
    case 'address':
      return pick('この値を場所として使い、メモリを読み書きしている',
        'used as an address to read or write memory');
    case 'returned':
      return pick('この値を、呼び出し元へ返している', 'returned to the caller');
    case 'overwritten':
      return pick('ここで別の値に書き換えられ、追跡はここで終わり', 'overwritten here — the trail ends');
    case 'join':
      return pick('ここは別の場所から飛んでくる合流点なので、これ以上は追えません',
        'this point can be reached from elsewhere, so the value can no longer be tracked');
    default:
      return pick('この値を読んでいる', 'reads the value');
  }
}

/* ── 制御フロー ───────────────────────────────────────────── */

export function shapeText(shape) {
  if (!shape) return '';
  switch (shape.kind) {
    case 'loop':
      return pick('繰り返し（条件が変わるまで同じ処理に戻ります）', 'a loop — it goes back until a condition changes');
    case 'if':
      return pick('条件に合ったときだけ通る道があります', 'a branch that is only taken when a condition holds');
    case 'if-else':
      return pick('条件で 2 つの道に分かれ、そのあと合流します',
        'the flow splits in two and joins again afterwards');
    case 'early-return':
      return shape.error
        ? pick('条件に合うと、異常として途中で終わります', 'on this condition it bails out as an error')
        : pick('条件に合うと、その場で呼び出し元へ帰ります', 'on this condition it returns early');
    default:
      return '';
  }
}

/* ────────────────────────────────────────────────────────────
   自動解析の読み上げ
   ──────────────────────────────────────────────────────────── */

/** 「気づいたこと」の見出し。 */
export function findingTitle(id) {
  switch (id) {
    case 'endpoint': return pick('通信先（サーバーの住所）', 'Server endpoints');
    case 'anticheat': return pick('解析・改造の検知らしきもの', 'Anti-tamper checks');
    case 'crypto': return pick('暗号やハッシュの計算', 'Cryptography');
    case 'ads': return pick('広告の部品', 'Advertising SDKs');
    case 'purchase': return pick('課金・レシート確認', 'Purchases and receipts');
    case 'debuglog': return pick('開発中の名残（デバッグ用）', 'Left-over debug text');
    case 'path': return pick('ファイルの場所', 'File paths');
    default: return pick('気づいたこと', 'Notes');
  }
}

/** その「気づいたこと」が、なぜ手がかりになるのか。 */
export function findingWhy(id) {
  switch (id) {
    case 'endpoint':
      return pick('アプリが外へ何を送っているかは、ここから辿るのがいちばん早いです。',
        'The quickest way to see what the app sends out.');
    case 'anticheat':
      return pick('改造や解析を見つけて止める処理かもしれません。' +
        'ゲームの動きが途中で止まるときは、この近くを見ます。',
      'These may be checks that detect tampering.');
    case 'crypto':
      return pick('通信や保存データを隠している部分の入口です。',
        'Where communication or saved data gets scrambled.');
    case 'ads':
      return pick('広告の表示に関わる部分です。ゲーム本体の処理ではありません。',
        'Advertising code — not the game logic itself.');
    case 'purchase':
      return pick('購入の確認をしている部分です。', 'Where purchases are verified.');
    case 'debuglog':
      return pick('作った人が残したメモです。処理の名前がそのまま書いてあることがあります。',
        'Notes left by the developers; often name things directly.');
    case 'path':
      return pick('データがどこに置かれるかの手がかりです。', 'Hints at where data is stored.');
    default: return '';
  }
}

/** 「注目すべき関数」に選ばれた理由。 */
export function notableReasonText(r) {
  if (!r) return '';
  const d = r.detail || {};
  switch (r.code) {
    case 'called':
      return pick(d.n + ' か所から呼ばれている', 'called from ' + d.n + ' places');
    case 'numeric': {
      const parts = [];
      if (d.mul) parts.push(pick('掛け算 ' + d.mul + ' 回', d.mul + ' multiplications'));
      if (d.div) parts.push(pick('割り算 ' + d.div + ' 回', d.div + ' divisions'));
      if (d.fmul) parts.push(pick('小数の掛け算 ' + d.fmul + ' 回', d.fmul + ' float multiplications'));
      return pick('数値の計算をしている（' + parts.join('・') + '）',
        'does arithmetic (' + parts.join(', ') + ')');
    }
    case 'readwrite':
      return pick('メモリを読んで書き戻している（読み ' + d.load + ' / 書き ' + d.store + '）',
        'reads and writes memory (' + d.load + ' loads, ' + d.store + ' stores)');
    case 'named':
      return pick('名前が残っている', 'it still has a name');
    case 'compare':
      return pick('値を ' + d.n + ' か所で比べている', 'compares values in ' + d.n + ' places');
    case 'huge':
      return pick('命令が ' + d.n.toLocaleString() + ' 個と大きい', 'very large (' + d.n.toLocaleString() + ' instructions)');
    default: return '';
  }
}

/** 自動解析のあとの「次の一手」。 */
export function autoStepText(s) {
  if (!s) return '';
  const d = s.detail || {};
  switch (s.code) {
    case 'open-pinned':
      return pick('「' + d.label + '」は ' + d.className + ' の ' + d.field + ' で確定しています。' +
        (d.addr ? hex(d.addr) + ' がそれを書き換えている場所なので、まずそこを開く'
          : 'まずその値を開いて、書き換えている場所を確かめる'),
      '“' + d.label + '” resolved to ' + d.className + '.' + d.field +
        (d.addr ? ' — open ' + hex(d.addr) + ', the place that writes it' : ''));
    case 'decide-ambiguous':
      return pick('「' + d.label + '」は ' + d.a + (d.b ? ' と ' + d.b : '') +
        ' のどちらかまで絞れています。両方を開いて、実際に読み書きしている場所を見比べる',
      '“' + d.label + '” narrowed to ' + d.a + (d.b ? ' or ' + d.b : '') + ' — compare where each is used');
    case 'open-update':
      return pick('値を書き換えている場所（' + hex(d.addr) + (d.name ? ' / ' + d.name : '') +
        '）を開いて、何を増減させているか確かめる',
      'open the place that changes a value (' + hex(d.addr) + ') and see what it changes');
    case 'open-goal':
      return pick('「' + d.label + '」の最有力候補を開いて、根拠を確かめる',
        'open the strongest candidate for “' + d.label + '” and check the evidence');
    case 'check-endpoint':
      return pick('通信先を見て、アプリが何を送受信しているか確かめる',
        'look at the endpoints to see what the app talks to');
    case 'check-anticheat':
      return pick('改造検知らしき処理を見て、何を条件にしているか確かめる',
        'look at the tamper checks and see what they test');
    case 'nothing-found':
      return pick('手がかりが見つかりませんでした。文字列が暗号化・難読化されているか、' +
        '処理が別のファイルにある可能性があります。',
      'Nothing was found — the text may be obfuscated, or the logic may live in another file.');
    case 'other-binary':
      return pick('このアプリは別のファイルに本体があるようなので、そちらも開いてみる',
        'the real logic may live in another binary — try opening that too');
    case 'verify-runtime':
      return pick('最後は実際に動かして、狙った値が変わるかどうかを確かめる',
        'finally, run the app and check whether the value really changes');
    default: return '';
  }
}

/* ────────────────────────────────────────────────────────────
   特定の結果 — 「これです」と言えるか、言えないなら何が足りないか
   ──────────────────────────────────────────────────────────── */

/** 決着の言葉。ここを曖昧にすると、ツール全体が信用できなくなる。 */
export function verdictText(v) {
  switch (v) {
    case 'confirmed': return pick('確定', 'confirmed');
    case 'likely': return pick('ほぼ確実', 'very likely');
    case 'ambiguous': return pick('絞りきれていません', 'not narrowed down');
    default: return pick('見つかりませんでした', 'not found');
  }
}

/** 決着の一行説明。 */
export function verdictLead(v) {
  switch (v) {
    case 'confirmed':
      return pick('逆アセンブルまで降りて確かめました。これで間違いありません。',
        'Checked all the way down to the instructions — this is it.');
    case 'likely':
      return pick('根拠はそろっていますが、命令での裏取りが 1 つ足りません。',
        'The evidence lines up, but one instruction-level check is missing.');
    case 'ambiguous':
      return pick('上位の候補が拮抗しているため、1 つに決めていません。' +
        '決めつけるより、両方を見てもらった方が確実です。',
      'The top candidates are too close to call, so nothing is being declared.');
    default:
      return pick('この目的に当てはまる値は見つかりませんでした。',
        'No value matching this goal was found.');
  }
}

/** 確定と言えない理由。何をすれば決まるかまで書く。 */
export function missingText(code) {
  switch (code) {
    case 'need-name-evidence':
      return pick('この目的に結びつく手がかりがありません。' +
        '「ゲームの数値らしい」ことは確かめられましたが、それが探しているものだとは言えません',
      'nothing ties this to the goal you picked — it is a game value, but not provably this one');
    case 'need-verification':
      return pick('命令まで降りた裏取りがまだありません（アクセサが無いか、読めませんでした）',
        'no instruction-level confirmation yet');
    case 'need-independent-evidence':
      return pick('別々の種類の根拠が足りません（名前だけ、型だけ、では確定にしません）',
        'not enough independent kinds of evidence');
    case 'need-more-evidence':
      return pick('根拠の量が足りません', 'not enough evidence overall');
    case 'need-separation':
      return pick('2 番目の候補との差が小さく、どちらとも言えません',
        'the runner-up is too close');
    case 'no-class-table':
      return pick('Objective-C のクラス表がないため、値の名前から特定できません',
        'no Objective-C class table, so fields cannot be named');
    case 'no-match':
      return pick('この目的に当てはまる名前の値がありませんでした',
        'no field name matched this goal');
    case 'no-name':
      return pick('この値の名前がバイナリに残っていません。場所と形までは確かめられましたが、' +
        'それが本当にこの目的の値かどうかは、名前からは裏付けられません',
      'this value has no name in the binary, so the match cannot be confirmed by name');
    case 'no-value-change':
      return pick('読んで計算して書き戻している場所が見つかりませんでした',
        'no read–modify–write of any value was found');
    case 'no-candidate':
      return pick('手がかりが 1 つも見つかりませんでした', 'no clue at all was found');
    default: return '';
  }
}

/** 「×12 倍」。掛け算の効きをそのまま見せる。 */
export function factorText(factor) {
  if (!(factor > 0)) return '';
  if (factor >= 1) {
    const n = factor >= 10 ? Math.round(factor) : Math.round(factor * 10) / 10;
    return '×' + n;
  }
  const n = Math.round((1 / factor) * 10) / 10;
  return pick('÷' + n, '÷' + n);
}

/** 未校正の手設定LRを、頻度の%ではなく確信度として表示する。 */
export function probabilityText(p) {
  if (!(p >= 0)) return '';
  if (p >= 0.99) return pick('非常に高い', 'very high');
  if (p >= 0.85) return pick('高い', 'high');
  if (p >= 0.5) return pick('中程度', 'medium');
  if (p >= 0.15) return pick('低い', 'low');
  return pick('非常に低い', 'very low');
}

/**
 * 証拠 1 行ぶんの日本語。
 * evidence.js のコードだけを受け取り、ここで初めて言葉にする。
 */
export function proofText(item) {
  if (!item) return '';
  const d = item.detail || {};
  switch (item.code) {
    /* 名前 */
    case 'field-name-exact':
      return pick('クラス表に書かれている名前が「' + trim(d.name, 32) + '」そのものである',
        'the class table calls this field exactly “' + trim(d.name, 32) + '”');
    case 'field-name-strong':
      return pick('名前「' + trim(d.name, 32) + '」に、探している言葉が入っている',
        'the name “' + trim(d.name, 32) + '” contains what you are looking for');
    case 'field-name-weak':
      return pick('名前「' + trim(d.name, 32) + '」が、ゆるく当てはまる',
        'the name “' + trim(d.name, 32) + '” loosely matches');
    case 'property-name':
      return pick('プロパティの名前が一致している', 'the declared property name matches');
    case 'accessor-name':
      return pick('この値を読み書きするための専用メソッド（' +
        [d.getter, d.setter].filter(Boolean).join(' / ') + '）がある',
      'dedicated accessors exist (' + [d.getter, d.setter].filter(Boolean).join(' / ') + ')');

    /* 逆アセンブルで確かめたもの — ここが確定の決め手 */
    case 'getter-verified':
      return pick('-[' + d.className + ' ' + d.sel + '] を実際に逆アセンブルしたところ、' +
        '本当にこの位置（' + hexOffset(d.offset) + '）を読んで返していた' +
        (d.exclusive ? '（ほかの位置は触っていない）' : ''),
      '-[' + d.className + ' ' + d.sel + '] really does read offset ' + hexOffset(d.offset));
    case 'setter-verified':
      return pick('-[' + d.className + ' ' + d.sel + '] を逆アセンブルしたところ、' +
        '本当にこの位置（' + hexOffset(d.offset) + '）へ' +
        (d.fromArgument ? '引数の値を' : '') + '書き込んでいた',
      '-[' + d.className + ' ' + d.sel + '] really does write offset ' + hexOffset(d.offset));
    case 'access-verified':
      return pick(d.className + ' 自身のメソッド（' + d.sel + '）が、この位置を' +
        [d.loads ? d.loads + ' 回読み' : '', d.stores ? d.stores + ' 回書いて' : '']
          .filter(Boolean).join('、') + 'いるのを命令で確認した',
      d.className + '’s own method ' + d.sel + ' really touches this offset');
    case 'rmw-verified':
      return pick('この値を読んで、計算して、同じ場所へ書き戻している命令が実在する' +
        (d.address != null ? '（' + hex(d.address) + '）' : ''),
      'a real read–modify–write of this value exists' +
        (d.address != null ? ' at ' + hex(d.address) : ''));
    case 'guard-verified':
      return pick('この値を定数' + (d.value != null ? '（' + d.value + '）' : '') +
        'と比べて分岐している場所がある — しきい値の判定',
      'this value is compared against a constant and branched on');

    /* 型・大きさ */
    case 'type-numeric':
      return pick('型が数値（' + typeWord(d.type) + '）で、探しているものと合う',
        'the declared type is numeric, which fits');
    case 'type-declared':
      return pick('宣言されている型が、探しているものと合う', 'the declared type fits');
    case 'type-conflict':
      return pick('型が ' + typeWord(d.type) + ' で、探しているものとは合わない',
        'the declared type does not fit what you are looking for');
    case 'size-fits':
      return d.measured
        ? pick('命令が読み書きしている大きさ（' + d.size + ' バイト）が、表の記載と一致した',
          'the size the instruction uses matches the table')
        : pick('大きさが ' + d.size + ' バイトで、数を入れる値として自然',
          'the size is ' + d.size + ' bytes, natural for a number');

    /* まわり */
    case 'class-category':
      return pick('持ち主の ' + d.className + ' が、この目的を担当する部品に分類されている',
        d.className + ' is grouped into the part that handles this');
    case 'class-name':
      return pick('持ち主のクラス名「' + trim(d.className, 32) + '」が、探している言葉を含む',
        'the owning class name matches');
    case 'sibling-fields':
      return pick('同じ ' + d.className + ' の中に、関係する値が ' + d.n + ' 個そろっている',
        d.n + ' related fields sit in the same class');
    case 'class-string':
      return pick('このクラスのメソッドが、目的に関係する文言を ' + d.n + ' 本参照している',
        'this class references ' + d.n + ' matching strings');
    case 'third-party-class':
      return pick('このクラスは、アプリが組み込んだ ' + (d.vendor || '外部') +
        ' の SDK のもの — ゲーム自身の値ではない',
      'this class belongs to the bundled ' + (d.vendor || 'third-party') +
        ' SDK, not to the game itself');
    case 'library-prefix-class':
      return pick('同じ 2〜4 文字で始まるクラスが' +
        (d.classes ? ' ' + d.classes + ' 個' : 'いくつも') +
        'ある — 組み込んだライブラリのものらしい',
      (d.classes ? d.classes + ' classes' : 'many classes') +
        ' share this short uppercase prefix — it looks like a bundled library');
    case 'selector-match':
      return pick('このクラスに、目的の言葉を含むメソッドが ' + d.n + ' 個ある',
        d.n + ' methods of this class have matching names');

    /* 使われ方 */
    case 'rmw-observed':
      return pick('読んで計算して書き戻す形が見つかっている', 'a read–modify–write shape was found');
    case 'compare-observed':
      return pick('定数と比べられている', 'it is compared against a constant');
    case 'written-in-class':
      return pick('持ち主のクラス自身が、この値に ' + d.n + ' 回書き込んでいる',
        'the owning class writes it ' + d.n + ' times');
    case 'usage-balanced':
      return pick('読み書きの両方があり、持ち回っている値として自然',
        'both reads and writes exist');
    case 'usage-none':
      return pick('この位置を読み書きしている命令が 1 つも見つからない',
        'nothing reads or writes this offset');

    /* 名前のない「場所」を特定するとき（クラス表のないアプリ） */
    case 'loc-rmw':
      return pick('この場所を読んで、計算して、同じ場所へ書き戻している命令が実在する' +
        (d.address != null ? '（' + hex(d.address) + '）' : ''),
      'a real read–modify–write of this location exists');
    case 'loc-arith':
      return pick('書き戻す前に計算をはさんでいる — 値の増減そのもの',
        'arithmetic happens before the write-back');
    case 'loc-guard':
      return pick('同じ処理の中で、定数' + (d.value != null ? '（' + d.value + '）' : '') +
        'と比べて分岐している', 'the same routine compares against a constant');
    case 'loc-in-goal-fn':
      return pick('目的に関係する文言を参照している処理' +
        (d.name ? '（' + trim(d.name, 28) + '）' : '') + 'の中にある',
      'it sits inside a routine that references matching text');
    case 'loc-shared':
      return pick(d.n + ' 個の処理が、同じこの場所を扱っている',
        d.n + ' routines all use this same location');
    case 'loc-size':
      return pick('大きさが ' + d.size + ' バイトで、数を入れる値として自然',
        'the size is ' + d.size + ' bytes, natural for a number');
    case 'loc-not-stack':
      return pick('スタックの一時置き場ではなく、オブジェクトが持ち続けている場所',
        'not a stack temporary — a value the object keeps');

    /* ふるまいから値を名指しするとき（名前も文言も残っていないアプリ） */
    case 'loc-damage-source':
      return pick('コード全体で ' + (d.usedAsAmount || 0) + ' か所、' +
        '**別のオブジェクトの値を減らすための量**として使われている' +
        (d.scaled ? '（倍率つき）' : ''),
      'used in ' + (d.usedAsAmount || 0) + ' places as the amount subtracted ' +
        'from another object’s value' + (d.scaled ? ', with a multiplier' : ''));
    case 'loc-resource-drain':
      return pick('別のオブジェクトから ' + (d.decreases || 0) + ' か所で減らされ、' +
        (d.increases || 0) + ' か所で増える' + (d.clamped ? '。0 未満にならないよう止めている' : ''),
      'decreased in ' + (d.decreases || 0) + ' places by other objects and increased in ' +
        (d.increases || 0) + (d.clamped ? ', and held at zero' : ''));
    case 'loc-self-resource':
      return pick('同じオブジェクトの中だけで ' + (d.decreases || 0) + ' か所減り、' +
        (d.increases || 0) + ' か所増える — 誰かに減らされる値ではない',
      'goes down in ' + (d.decreases || 0) + ' places and up in ' + (d.increases || 0) +
        ', always within its own object');
    case 'loc-container-head':
      return pick('前寄りの位置で、しかも小さな入れ物の中にしか出てこない — ' +
        'C++ の容器の要素数や参照カウンタである可能性が高い',
      'a low offset that only ever appears in small objects — likely a C++ container header');
    case 'loc-role-conflict':
      return pick('同じ場所が「減らされる側」とも「減らす量の側」とも読めてしまう — ' +
        'どちらか一方だとは言えない',
      'this same location reads both as the value being drained and as the amount doing ' +
        'the draining — neither role can be claimed');

    /* 形から立てた候補を、命令まで降りて確かめたもの */
    case 'loc-drain-verified':
      return pick('実際に開いて確かめた: ' + (d.address != null ? hex(d.address) + ' で' : '') +
        '**別のオブジェクトの' + (d.from && d.from.disp != null ? ' ' + hexOffset(d.from.disp) : '') +
        'の値ぶん**この場所を増減し、同じ場所へ書き戻している' +
        (d.n > 1 ? '（同じ形が ' + d.n + ' 個の処理にある）' : ''),
      'checked in the instructions: another object’s field is what this location is ' +
        'changed by' + (d.n > 1 ? ', in ' + d.n + ' separate routines' : ''));
    case 'loc-amount-verified':
      return pick('実際に開いて確かめた: この場所の値が、ほかの値を減らす量として使われている' +
        (d.address != null ? '（' + hex(d.address) + '）' : ''),
      'checked in the instructions: this value is used as the amount subtracted elsewhere');
    case 'loc-clamp-verified':
      return pick('実際に開いて確かめた: 書き戻す前に下限で止めている' +
        (d.address != null ? '（' + hex(d.address) + '）' : '') + ' — 残量として扱われている',
      'checked in the instructions: the value is held at its floor before being written back');
    case 'loc-capped-by-field':
      return pick('実際に開いて確かめた: 上限が**別の値**（同じオブジェクトの ' +
        hexOffset(d.cap) + '）で決まっている — 「今の値」と「上限」の組になっている。' +
        '所持金やスコアはこの形を持たない',
      'checked in the instructions: the ceiling comes from another field (' + hexOffset(d.cap) +
        ') — a current/maximum pair, which money and score never have');
    case 'loc-counter-verified':
      return pick('開いて確かめた ' + (d.n || 0) + ' か所のうち ' + (d.byOne || 0) +
        ' か所が 1 ずつの増減で、よそから来た量は 1 度も無かった — ' +
        '数える物（残り回数・フレーム数）であって、増やしたい値ではない',
      (d.byOne || 0) + ' of ' + (d.n || 0) + ' checked places move by exactly 1, and none ' +
        'takes its amount from elsewhere — a counter, not a quantity');
    case 'loc-unverified':
      return pick('形からは出たが、' + (d.tried || 0) + ' 個の処理を開いても、' +
        'この場所を書き換えている命令が見つからなかった',
      'the shape suggested it, but opening ' + (d.tried || 0) +
        ' routines found nothing that writes it');

    /* 処理を特定するとき */
    case 'fn-name-exact':
      return pick('処理の名前「' + trim(d.name, 40) + '」が、目的そのものを指している',
        'the function name “' + trim(d.name, 40) + '” names the goal itself');
    case 'fn-name-match':
      return pick('処理の名前が目的の言葉を含む', 'the function name matches');
    case 'fn-selector':
      return pick('メソッド名「' + trim(d.sel, 32) + '」が目的の言葉を含む',
        'the selector “' + trim(d.sel, 32) + '” matches');
    case 'fn-string-ref':
      return pick('目的に関係する文言を、この処理が実際に参照している',
        'this function really references matching text');
    case 'fn-string-exclusive':
      return pick('「' + trim(d.text, 30) + '」を参照しているのは、' +
        (d.of ? d.of.toLocaleString() + ' 個の処理のうち' : '') +
        (d.users === 1 ? 'この処理だけ' : 'この処理を含む ' + d.users + ' 個だけ'),
      'of ' + (d.of ? d.of.toLocaleString() + ' functions, ' : '') +
        (d.users === 1 ? 'only this one' : 'only ' + d.users) +
        ' references “' + trim(d.text, 30) + '”');
    case 'fn-formula-verified':
      return pick('その文言が書いている計算式の ' + d.value +
        ' が、この処理の命令の中に即値として ' + d.count + ' 個ある',
      'the constant ' + d.value + ' from that text appears ' + d.count +
        ' times as an immediate in this function');
    case 'fn-touches-field':
      return pick('特定した値（' + d.className + '.' + d.name + '）を、この処理が実際に読んでいる',
        'this function really reads the field that was identified');
    case 'fn-writes-field':
      return d.className
        ? pick('特定した値（' + d.className + '.' + d.name + '）を、この処理が実際に書き換えている',
          'this function really writes the field that was identified')
        : pick('自分が持っている値へ ' + d.n + ' 回書き込んでいる',
          'it writes its own fields ' + d.n + ' times');
    case 'fn-owner-class':
      return pick('この処理を持っているクラスの名前が目的に合う', 'the owning class name fits');
    case 'fn-numeric':
      return pick('中で ' + d.n + ' 回の掛け算・割り算をしている',
        'it does ' + d.n + ' multiplications or divisions');
    case 'fn-called-often':
      return pick('あちこちから呼ばれている', 'it is called from many places');
    case 'fn-too-large':
      return pick('大きすぎて、目的の計算そのものとは考えにくい',
        'it is too large to be the calculation itself');
    case 'fn-caller-match':
      return pick('目的に合う名前の処理から呼ばれている', 'it is called by a matching function');
    case 'fn-callee-match':
      return pick('目的に合う名前の処理を呼んでいる', 'it calls a matching function');
    default: return '';
  }
}

function hexOffset(v) {
  if (v == null) return '';
  const n = typeof v === 'bigint' ? v : BigInt(v);
  return (n < 0n ? '-0x' : '+0x') + (n < 0n ? -n : n).toString(16).toUpperCase();
}

/* ────────────────────────────────────────────────────────────
   関数の役割を名指しする（role.js → 日本語）
   ────────────────────────────────────────────────────────────

   `sub_100A3C0` と出た瞬間に読む人は止まる。命令の説明をいくら足しても
   「で、これは何の処理なの？」には答えていないため。ここはその 1 行を作る。

       ［機能］を ［動作］する処理
        🎒 アイテム・所持品   1 増やす

   言い切れないところは必ず言い切らない。機能が分からなければ機能を省き、
   値の名前が読めなければ場所で呼ぶ。埋めない。                             */

/** 機能（目的）の呼び名。goals.js の語彙をそのまま使う。 */
export function topicLabel(id) {
  const g = goalById(id);
  return g ? pick(g.ja, g.en) : null;
}

/** 機能の絵文字。一覧で目に留まるように。 */
export function topicIcon(id) {
  const g = goalById(id);
  return g && g.icon ? g.icon : '';
}

/*
 * 機能の名前を「を◯◯する」の目的語に置くための言い換え。
 *
 * 目的の名前は「何を調べたいですか？」の見出し用に付けてあるので、
 * そのまま目的語にすると日本語が壊れる（「ダメージ計算を減らす処理」）。
 * 壊れるものだけ、値としての呼び名を持たせる。書いていないものは元のまま。
 */
const TOPIC_OBJECT = {
  damage: ['ダメージの値', 'the damage value'],
  gacha: ['ガチャの値', 'the gacha value'],
  purchase: ['課金の値', 'the purchase value'],
  login: ['ログインの値', 'the login value'],
  network: ['通信の値', 'the network value'],
  save: ['セーブデータ', 'the save data'],
  anticheat: ['改造検知の値', 'the anti-cheat value'],
};

/** 「を◯◯する」の目的語に置ける形の機能名。 */
function topicObject(id) {
  const o = TOPIC_OBJECT[id];
  return o ? pick(o[0], o[1]) : topicLabel(id);
}

/** 数の言い方。1000000 のような即値は 10 進のままだと読めないので添える。 */
function amountText(amount) {
  if (amount == null) return null;
  const n = typeof amount === 'bigint' ? amount : BigInt(amount);
  const abs = n < 0n ? -n : n;
  if (abs >= 4096n) return n.toString() + '（0x' + abs.toString(16).toUpperCase() + '）';
  return n.toString();
}

/**
 * 動作を、目的語の後ろに置ける形で。
 *   increase + 1  →  「1 増やす」
 *   send          →  「サーバーへ送る」
 */
export function actionPhrase(action, amount) {
  const n = amountText(amount);
  switch (action) {
    case 'increase':
      return n ? pick(n + ' 増やす', 'increase by ' + n) : pick('計算した値だけ増やす', 'increase');
    case 'decrease':
      return n ? pick(n + ' 減らす', 'decrease by ' + n) : pick('計算した値だけ減らす', 'decrease');
    case 'compute':
      /*
       * 命令 1 つではなく、式の連なりから決まる動作。
       * 「計算する」で終わらせると何も言っていないので、
       * 呼ぶ側（fnRoleTitle）が段数と中身を必ず添える。
       */
      return pick('1 つの数に計算しあげる', 'compute into a single number');
    case 'scale':
      return n ? pick(n + ' 倍にする', 'multiply by ' + n) : pick('掛け算で増やす', 'multiply');
    case 'shrink':
      return n ? pick(n + ' で割る', 'divide by ' + n) : pick('割り算で減らす', 'divide');
    case 'set':
      return n ? pick(n + ' にする', 'set to ' + n) : pick('別の値に入れ替える', 'replace');
    case 'get': return pick('読み出して返す', 'read it and return it');
    case 'clear': return pick('0 に戻す', 'reset to zero');
    case 'flag': return pick('印を立て下げする', 'set or clear a flag');
    case 'swap': return pick('条件によって入れ替える', 'swap depending on a condition');
    case 'check': return pick('しきい値と比べて判定する', 'compare against a threshold');
    case 'save': return pick('端末に保存する', 'save to the device');
    case 'load': return pick('端末から読み出す', 'load from the device');
    case 'send': return pick('サーバーとやり取りする', 'talk to a server');
    case 'show': return pick('画面に出す', 'show on screen');
    case 'make': return pick('新しく作る', 'create');
    case 'dispatch': return pick('ほかの処理へ振り分ける', 'hand off to other routines');
    default: return null;
  }
}

/**
 * 動作を名詞で。値を触らない処理（保存・通信・判定…）の言い方に使う。
 *
 * 「セーブ・保存を端末に保存する処理」では日本語として読めない。
 * 目的語のない動作は「〜に関わる処理（保存）」の形にする。
 */
function actionNoun(action) {
  switch (action) {
    case 'check': return pick('判定', 'a check');
    case 'save': return pick('端末への保存', 'saving to the device');
    case 'load': return pick('端末からの読み出し', 'loading from the device');
    case 'send': return pick('サーバーとの通信', 'talking to a server');
    case 'show': return pick('画面への表示', 'showing something on screen');
    case 'make': return pick('オブジェクトの生成', 'creating an object');
    case 'dispatch': return pick('呼び出しの振り分け', 'handing off to other routines');
    default: return null;
  }
}

/** 「±1」のような、一覧に置ける最短の言い方。 */
function actionMark(role) {
  const n = role.amount != null ? amountText(role.amount) : null;
  switch (role.action) {
    case 'increase': return n ? '+' + n : pick('増加', 'up');
    case 'decrease': return n ? '−' + n : pick('減少', 'down');
    case 'scale': return n ? '×' + n : pick('倍増', 'scale');
    case 'shrink': return n ? '÷' + n : pick('縮小', 'shrink');
    case 'clear': return pick('0 化', 'reset');
    case 'set': return n ? '=' + n : pick('代入', 'set');
    default: return actionPhrase(role.action, role.amount) || '';
  }
}

/** 何を触っているか。名前が読めなければ場所で呼ぶ（分かるふりをしない）。 */
export function fnRoleSubject(role, withClass = true) {
  const s = role && role.subject;
  if (!s) return null;
  if (s.kind === 'field' && s.name) {
    return fieldName({ plain: s.plain || s.name, name: s.name, className: s.className }, withClass);
  }
  if (s.kind === 'local') {
    return pick('この関数の中だけで使う一時的な値', 'a temporary value inside this function');
  }
  if (s.kind === 'location') {
    return pick('オブジェクトの ' + hexOffset(s.disp) + ' にある値',
      'the value at ' + hexOffset(s.disp) + ' of the object');
  }
  return null;
}

/**
 * この関数の名前。1 行でこれだけ読めば用が足りる、という形にする。
 *   「🎒 アイテム・所持品を 1 増やす処理」
 *   「ItemManager の count を 1 増やす処理」（機能まで言えないとき）
 */
export function fnRoleTitle(role, { icon = true } = {}) {
  if (!role) return '';
  const verb = actionPhrase(role.action, role.amount);
  if (!verb) {
    return pick('何をする処理かは名指しできませんでした',
      'what this routine is for could not be named');
  }

  /*
   * 計算そのものが主題の関数。
   *
   * 「攻撃力を計算する処理」だけでは、この関数と、攻撃力を 1 回読むだけの
   * 関数の区別が付かない。復元できた段数を必ず添える —
   * 「17 段の倍率を掛けあわせて 1 つの数を出す」は、この関数にしか当てはまらない。
   */
  if (role.subject && role.subject.kind === 'computed') {
    const n = role.subject.steps || 0;
    const topic0 = role.topicSettled !== false ? topicLabel(role.topic) : null;
    const of = topic0 ? pick(topicObject(role.topic) + 'を', topicObject(role.topic) + ' ') : '';
    const mark0 = icon && topic0 ? (topicIcon(role.topic) + ' ') : '';
    return pick(
      mark0 + of + '元の値から ' + n + ' 段の計算で 1 つの数に組み立てる処理',
      mark0 + 'a routine that builds ' + (of || 'a value') + ' through ' + n + ' calculation steps');
  }
  /*
   * 機能が 1 つに決まっていなければ、機能を名乗らない。
   * 「アイテムかスコアか決まっていない」ときに片方だけ書くと、すぐ下に並ぶ根拠と
   * 食い違った見出しになる。動作と場所は決まっているので、そちらで名乗る。
   */
  const settled = role.topicSettled !== false;
  const topic = settled ? topicLabel(role.topic) : null;
  const mark = icon && topic ? (topicIcon(role.topic) + ' ') : '';

  /*
   * 値を触っていない処理は、目的語がない。「セーブ・保存を端末に保存する処理」
   * とは書けないので、機能を主語に立てて、動作は括弧で添える。
   */
  const noun = actionNoun(role.action);
  if ((!role.subject || role.subject.kind === 'none') && noun) {
    if (!topic) return pick(verb + '処理', 'a routine that will ' + verb);
    return pick(mark + topic + 'に関わる処理（' + noun + '）',
      mark + 'a routine for ' + topic + ' (' + noun + ')');
  }

  const head = topic ? topicObject(role.topic) : fnRoleSubject(role);
  if (!head) return pick(verb + '処理', 'a routine that will ' + verb);
  return pick(mark + head + 'を' + verb + '処理',
    mark + 'a routine that will ' + verb + ' ' + head);
}

/** 一覧の行に添える最短の札。「🎒 アイテム +1」 */
export function fnRoleShort(role) {
  if (!role || role.action === 'unknown') return '';
  const topic = topicLabel(role.topic);
  const mark = actionMark(role);
  if (topic) return (topicIcon(role.topic) + ' ' + topic + (mark ? ' ' + mark : '')).trim();
  const subject = fnRoleSubject(role, false);
  if (subject) return (subject + (mark ? ' ' + mark : '')).trim();
  return mark;
}

/**
 * 「変えているのは、この値です」の 1 行。
 * 型と位置まで添える。ここまで出せば、実際に触りにいける。
 */
export function fnRoleTargetLine(role) {
  const s = role && role.subject;
  if (!s || s.kind === 'none') return null;
  const where = fnRoleSubject(role);
  if (!where) return null;
  const type = s.type ? typeWord(s.type) : null;
  /*
   * 名前が読めないときの呼び名は、それ自体が「オブジェクトの +0x20 にある値」。
   * そこへ「先頭から +0x20」を足すと、同じことを 2 回言うことになる。
   */
  const at = (s.disp != null && s.kind === 'field')
    ? pick('先頭から ' + hexOffset(s.disp), hexOffset(s.disp) + ' from the start') : null;
  const tail = [type, at].filter(Boolean).join(pick('・', ', '));
  return pick('変えているのは ' + where + (tail ? '（' + tail + '）' : '') + 'です。',
    'What it changes is ' + where + (tail ? ' (' + tail + ')' : '') + '.');
}

/** 名指しの確からしさを、言い切らない日本語で。 */
export function fnRoleLead(role) {
  if (!role) return '';
  switch (role.verdict) {
    case 'confirmed':
      return pick('この関数が何をする処理かは、命令まで降りて確かめました。',
        'What this routine does was confirmed down at the instruction level.');
    case 'likely':
      return pick('ここまでは言えます。ただし、決め手が 1 つ足りません。',
        'This much can be said, but one decisive piece is missing.');
    case 'ambiguous':
      return pick('読み方が 2 通り以上あり、1 つに決めていません。' +
        '決めつけるより、両方を見てもらった方が確実です。',
      'There is more than one reading, so nothing is being declared.');
    default:
      return pick('この関数が何の処理かは、名指しできませんでした。手がかりが足りません。',
        'This routine could not be named — not enough clues.');
  }
}

/**
 * 機能が決まらなかったときに、何と何で迷っているのかを出す。
 * 「決まりませんでした」だけで終わらせると、次に何を見ればいいか分からない。
 */
export function fnRoleTopicLine(role) {
  if (!role || !role.topic) return null;
  const mine = topicLabel(role.topic);
  if (!mine) return null;
  if (role.topicSettled !== false) {
    return pick('アプリの機能でいうと ' + topicIcon(role.topic) + ' ' + mine + ' の担当です。',
      'In the app, this belongs to ' + mine + '.');
  }
  const rival = topicLabel(role.rivalTopic);
  if (!rival) {
    return pick('アプリのどの機能かは、手がかりが割れていて決めていません（' + mine + ' の可能性）。',
      'Which part of the app this belongs to is not settled (possibly ' + mine + ').');
  }
  return pick('アプリの機能は ' + topicIcon(role.topic) + ' ' + mine + ' か ' +
    topicIcon(role.rivalTopic) + ' ' + rival + ' のどちらかです。手がかりが割れているので、' +
    '1 つには決めていません。',
  'This belongs either to ' + mine + ' or ' + rival + ' — the clues are split, so neither is declared.');
}

/** ほかの読み方（2 番目の候補）。決まらなかったときに必ず出す。 */
export function fnRoleAlternative(role) {
  const r = role && role.runnerUp;
  if (!r) return null;
  const verb = actionPhrase(r.action, r.amount);
  const head = (r.topic ? topicObject(r.topic) : null) || fnRoleSubject({ subject: r.subject });
  if (!verb || !head) return null;
  return pick('もう 1 つの読み方: ' + head + 'を' + verb + '処理（' +
    probabilityText(r.probability) + '）',
  'another reading: a routine that will ' + verb + ' ' + head +
    ' (' + probabilityText(r.probability) + ')');
}

/**
 * 「なぜそう言えるのか」1 行ぶん。
 * role.js の証拠コードだけを受け取り、ここで初めて言葉にする。
 */
export function roleProofText(item) {
  if (!item) return '';
  const d = item.detail || {};
  switch (item.code) {
    case 'role-formula-verified':
      /*
       * このツールでいちばん強い証拠。何が起きたのかを、言葉を惜しまずに書く。
       * 「一致しました」だけでは、読む人は何と何が一致したのか分からない。
       */
      return pick(
        '開発者が書き残した計算式と、命令から復元した計算式が、' + (d.distinct || 0) +
        ' 種類の数まで一致した' +
        (d.texts && d.texts.length ? '（例:「' + trim(d.texts[0], 40) + '」）' : '') +
        '。文言は開発者の書いたもの、式は命令から戻したもので、出どころがまったく違う',
        'the formula written by the developer and the formula recovered from the instructions ' +
        'agree on ' + (d.distinct || 0) + ' distinct numbers');
    case 'role-chain-verified':
      return pick('1 本の値を ' + (d.steps || 0) + ' 段にわたって作り変えている連なりを、' +
        'すべて式まで戻せた（' + (d.reg || '?') + ' が持ち回っている）',
      'a single value is transformed ' + (d.steps || 0) + ' times, and every step was recovered as an expression');
    case 'role-step-labelled':
      return pick('作り変えの ' + (d.n || 0) + ' か所で、その直前に開発者が書いた文言を' +
        '組み立てている' + (d.texts && d.texts.length ? '（例:「' + trim(d.texts[0], 28) + '」）' : ''),
      (d.n || 0) + ' of the steps build a developer-written message right before running');
    case 'role-verb-rmw':
      return pick('この値を読んで、計算して、同じ場所へ書き戻している命令が実在する' +
        (d.address != null ? '（' + hex(d.address) + '）' : '') + ' — 加工しているのはここ',
      'a real read–modify–write exists' + (d.address != null ? ' at ' + hex(d.address) : ''));
    case 'role-verb-imm':
      return pick('増減の量が命令に直接書かれている（' + (d.imm != null ? d.imm.toString() : '?') + '）ので、' +
        'どれだけ変わるかまで読み取れる',
      'the amount is written straight into the instruction (' + (d.imm != null ? d.imm.toString() : '?') + ')');
    case 'role-verb-api':
      return pick(apiShort(d.api) + 'にあたる処理を実際に呼んでいる',
        'it really calls something that does: ' + apiShort(d.api));
    case 'role-verb-shape':
      return pick('命令の形（比べて分岐する・値を移す）が、この動作と合っている',
        'the instruction shape fits this action');
    case 'role-verb-selector':
      return pick(d.kind === 'read'
        ? 'Objective-C のメソッド名「' + trim(d.selector, 36) + '」が、この値を読む getter であることを示している'
        : 'Objective-C のメソッド名「' + trim(d.selector, 36) + '」が、この値へ書く setter であることを示している',
      d.kind === 'read'
        ? 'the Objective-C selector “' + trim(d.selector, 36) + '” declares a getter for this value'
        : 'the Objective-C selector “' + trim(d.selector, 36) + '” declares a setter for this value');
    case 'role-accessor-metadata':
      return pick('Objective-C のクラス表で「' + trim(d.selector, 36) + '」が「' +
        trim(d.field, 32) + '」のアクセサとして宣言されている' +
        (d.className ? '（' + trim(d.className, 30) + '）' : ''),
      'Objective-C metadata declares “' + trim(d.selector, 36) + '” as an accessor for “' +
        trim(d.field, 32) + '”' + (d.className ? ' on ' + trim(d.className, 30) : ''));
    case 'role-verb-accessor':
      return pick(d.kind === 'read'
        ? 'この値を読んで、そのまま返している命令が実在する' +
          (d.address != null ? '（' + hex(d.address) + '）' : '')
        : '渡された値を、この場所へそのまま入れている命令が実在する' +
          (d.address != null ? '（' + hex(d.address) + '）' : ''),
      d.kind === 'read'
        ? 'a real load of this value is returned as-is'
        : 'a real store puts the argument straight into this place');
    case 'role-accessor-match':
      return pick('Objective-C のメソッド名「' + trim(d.selector, 36) + '」が示す対象と、' +
        '実際に読み書きしている self の「' + trim(d.field, 32) + '」が一致している',
      'the Objective-C selector “' + trim(d.selector, 36) + '” names the same self field that the instructions access');
    case 'role-verb-none':
      return pick('値を読んで書き戻している場所が見つからないので、' +
        '「何かを加工する処理」とは言えない',
      'no read–modify–write was found, so this is not a routine that changes a value');
    case 'field-name-asked':
      return pick('打ち込まれた名前と、この値の名前が、そっくりそのまま同じ（' +
        trim(d.name, 40) + '）',
      'the name you typed is exactly this field’s name (' + trim(d.name, 40) + ')');
    case 'field-name-contains':
      return pick('打ち込まれた言葉が、この値の名前にそのままの並びで入っている（' +
        trim(d.name, 40) + '）',
      'what you typed appears verbatim in this field’s name (' + trim(d.name, 40) + ')');
    case 'field-name-words':
      return pick('打ち込まれた複数の言葉が、すべてこの値の名前に入っている（' +
        trim(d.name, 40) + '）',
      'all words you typed are present in this field’s name (' + trim(d.name, 40) + ')');
    case 'role-subject-field':
      return pick('書き換えている値の名前が「' + trim(d.name, 32) + '」で、' +
        '探している機能の言葉（' + trim(d.term, 16) + '）が入っている',
      'the field it writes is called “' + trim(d.name, 32) + '”, which contains “' + trim(d.term, 16) + '”');
    case 'role-subject-prop':
      return pick('宣言されたプロパティの名前も一致している', 'the declared property name matches too');
    case 'role-subject-unnamed':
      return pick('触っている値の名前がバイナリに残っていない（場所までは分かる）',
        'the value it touches has no name left in the binary');
    case 'role-topic-name':
      return pick('関数の名前「' + trim(d.text, 40) + '」そのものが、この機能を指している',
        'the function name “' + trim(d.text, 40) + '” itself points at this feature');
    case 'role-topic-selector':
      return pick('メソッド名「' + trim(d.text, 32) + '」が、この機能を指している' +
        '（メソッド名は人が付けたもの）',
      'the method name “' + trim(d.text, 32) + '” points at this feature');
    case 'role-topic-string':
      return pick('この関数が「' + trim(d.text, 28) + '」という文言を実際に参照している',
        'it really references the text “' + trim(d.text, 28) + '”');
    case 'role-topic-class':
      return pick('持ち主のクラス名「' + trim(d.text, 28) + '」が、この機能の担当であることを示している',
        'the owning class “' + trim(d.text, 28) + '” belongs to this feature');
    case 'role-topic-callee':
      return pick('この機能の言葉を含む処理「' + trim(d.text, 28) + '」を呼んでいる',
        'it calls “' + trim(d.text, 28) + '”, whose name matches this feature');
    case 'role-topic-caller':
      return pick('この機能の言葉を含む処理「' + trim(d.text, 28) + '」から呼ばれている',
        'it is called from “' + trim(d.text, 28) + '”, whose name matches this feature');
    case 'role-topic-agree':
      return pick('別々の手がかり ' + (d.sources || 0) + ' 種類が、そろって同じ機能を指している' +
        '（名前・文言・呼び出し関係は、互いに独立した材料）',
      (d.sources || 0) + ' independent kinds of clue all point at the same feature');
    case 'role-topic-conflict':
      return pick('別の機能を指す手がかりも同じくらいあり、この機能だと言い切れない',
        'clues pointing at other features are just as strong');
    default:
      return proofText(item);
  }
}

/** 名指しできなかった理由。何をすれば決まるかまで書く。 */
export function roleMissingText(code) {
  switch (code) {
    case 'role-no-topic':
      return pick('アプリのどの機能の話かを示す手がかり（文言・メソッド名・クラス名）が' +
        'この関数にありません。何をしているかは言えても、何のためかが言えません',
      'nothing says which part of the app this belongs to');
    case 'role-no-field-name':
      return pick('触っている値の名前がバイナリに残っていません。' +
        '場所（オブジェクトの何バイト目か）までは確かめましたが、その値の呼び名は分かりません',
      'the value it touches has no name in the binary — only its offset is known');
    case 'role-not-disassembled':
      return pick('一覧用の下見なので、まだ命令まで降りていません。' +
        'この関数を開くと、命令で裏を取ったうえで言い直します',
      'this is only a preview from the index — open the function to confirm at instruction level');
    case 'role-topic-unsettled':
      return pick('アプリのどの機能かで、手がかりが割れています。' +
        '大きな関数は文言をいくつも参照するので、こうなることがあります。' +
        '呼び出し元をたどると、どちらの流れで使われているかが分かります',
      'the clues about which part of the app this belongs to are split');
    case 'role-no-clue':
      return pick('手がかりが 1 つも見つかりませんでした', 'no clue at all was found');
    case 'role-no-formula':
      return pick('計算の中身は式まで戻せましたが、それが何の計算かを裏付ける文言が' +
        'この関数にありません。式は読めても、意味の裏取りができていません',
      'the arithmetic was recovered, but nothing in the function says what it is for');
    default:
      return missingText(code);
  }
}

/* ────────────────────────────────────────────────────────────
   復元した計算を、日本語にする（comprehend.js の出力）
   ────────────────────────────────────────────────────────────

   ここで気をつけるのは 1 つだけ。式そのものは訳さない。
   `result = result * (x + 100) / 100` は、言葉に開くと必ず長くなるし、
   読む人が確かめたいのは式の形そのものなので、式は式のまま見せる。
   言葉で補うのは「この式が全体の中でどういう役割か」だけにする。 */

/** 復元した処理の 1 行見出し。 */
export function comprehensionHeadline(c) {
  const h = c && c.headline;
  if (!h) return null;
  switch (h.code) {
    case 'cm-formula':
      return pick(
        '1 本の値を ' + h.steps + ' 段の計算で組み立てています。しかも、' +
        'その計算式を開発者自身が文言として書き残していて（' + h.distinct + ' 種類の数が一致）、' +
        '命令から復元した式と食い違いがありません。',
        'It builds one value through ' + h.steps + ' calculation steps, and the developer’s own ' +
        'written formulas agree with the recovered arithmetic on ' + h.distinct + ' distinct numbers.');
    case 'cm-pipeline':
      return pick(
        '1 本の値（' + h.reg + '）を ' + h.steps + ' 段にわたって作り変えています。' +
        'うち ' + h.scales + ' 段は倍率の掛け合わせです。',
        'It transforms one value (' + h.reg + ') through ' + h.steps + ' steps, ' +
        h.scales + ' of which are scaling.');
    case 'cm-carry':
      return pick('1 本の値（' + h.reg + '）を ' + h.steps + ' 回作り変えて持ち回っています。',
        'It carries one value (' + h.reg + ') and reworks it ' + h.steps + ' times.');
    case 'cm-returns':
      return pick('計算した結果をそのまま呼び出し元へ返しています。',
        'It returns the value it computes.');
    case 'cm-store':
      return pick('計算した結果を 1 か所へ書き込んでいます。', 'It writes the value it computes to one place.');
    default:
      return null;
  }
}

/** 工程 1 つの説明（式そのものは呼び出し側が添える）。 */
export function stepNote(step) {
  const s = step && step.shape;
  if (!s) return null;
  switch (s.kind) {
    case 'scale': {
      const m = s.muls && s.muls.length;
      const d = s.divs && s.divs.length;
      if (m && d) return pick('倍率を掛けてから割り戻しています（百分率の適用）。', 'applies a percentage');
      if (m) return pick('倍率を掛けています。', 'multiplies');
      return pick('割っています。', 'divides');
    }
    case 'offset':
      return s.sign > 0 ? pick('計算した量を足しています。', 'adds a computed amount')
        : pick('計算した量を引いています。', 'subtracts a computed amount');
    case 'clamp':
      return pick('上限か下限で止めています。', 'clamps the value');
    default:
      return pick('この段は式の形が素直ではないため、そのまま出しています。',
        'this step does not reduce to a simple form');
  }
}

/** 積算値の行き先。 */
export function sinkText(sink) {
  if (!sink) return null;
  switch (sink.kind) {
    case 'store':
      return pick('作った値は、そのままメモリへ書き込まれます。', 'the value is written to memory');
    case 'argument':
      return pick('作った値は、' + (sink.name ? '「' + shortName(sink.name) + '」' : 'ほかの処理') +
        ' の ' + (sink.index + 1) + ' 番目の引数として渡されます。',
      'the value is passed as argument ' + (sink.index + 1) +
        (sink.name ? ' to ' + shortName(sink.name) : ''));
    case 'return':
      return pick('作った値が、そのまま戻り値になります。', 'the value becomes the return value');
    case 'clamped':
      return sink.certain
        ? pick('最後に上限・下限で止めています。', 'it is finally clamped')
        : pick('最後に上限・下限で止めているように見えます（分岐の合流をまたぐので、' +
          '同じ値かどうかまでは確かめていません）。',
        'it looks clamped at the end, but the value could not be followed across a join');
    default:
      return null;
  }
}

/* ── ビューア用のオーバーレイ ──────────────────────────────── */

/**
 * 行番号 → 表示情報。ビューアはこれを引くだけで、解析は一切しない。
 * 言語を切り替えたら作り直す（モデル自体は作り直さない）。
 */
export function buildOverlay(model) {
  const map = new Map();
  if (!model) return map;
  for (const b of model.semantic) {
    const title = blockTitle(b);
    const rows = b.instructions.map((i) => i.row);
    for (const row of rows) {
      map.set(row, {
        role: b.role,
        index: b.index,
        title: row === b.startRow ? title : '',
        pos: rows.length === 1 ? 'only' : (row === b.startRow ? 'first' : (row === b.endRow ? 'last' : 'mid')),
        level: b.level,
      });
    }
  }
  return map;
}

/* ── 「で、この処理は何をしているのか」（purpose.js の読み上げ） ──
 *
 * 一覧の 1 行に入る長さで、**命令で確かめられることだけ**を言う。
 * ここでいちばん避けたいのは「数値計算をしています」のような、
 * どの関数にも当てはまる文。それは読む人の手がかりを 1 つも増やさない。 */

/** 「+0x4C（4 バイト）」。名前が分かっているならそちらを優先する。 */
function placeShort(c) {
  if (!c) return '';
  if (c.field && c.field.name) return fieldName(c.field, false);
  const at = c.disp != null ? hexOffset(c.disp) : pick('位置不明', 'unknown offset');
  const size = c.size ? pick('（' + c.size + ' バイト）', ' (' + c.size + ' bytes)') : '';
  return pick('オブジェクトの ' + at + size, 'this object’s ' + at + size);
}

/** 「別のオブジェクトの +0xA18 の値」「1」「呼んだ先が決めた値」。 */
function amountShort(a, base) {
  if (!a) return '';
  switch (a.kind) {
    case 'imm':
      return String(a.value);
    case 'field':
      return a.base && base && a.base !== base
        ? pick('別のオブジェクトの ' + hexOffset(a.disp) + ' の値',
          'another object’s ' + hexOffset(a.disp))
        : pick('同じオブジェクトの ' + hexOffset(a.disp) + ' の値',
          'this object’s own ' + hexOffset(a.disp));
    case 'call':
      return a.name
        ? pick(trim(a.name, 24) + ' が返した値', 'what ' + trim(a.name, 24) + ' returned')
        : pick('呼んだ先が決めた値', 'a value another routine worked out');
    case 'arg':
      return pick('呼び出し元から渡された値', 'a value handed in by the caller');
    case 'stack':
      return pick('その場で計算した値', 'a value worked out on the spot');
    case 'computed':
      return pick('計算した値', 'a computed value');
    default: return '';
  }
}

const WORK_VERB = {
  drain: ['減らす', 'takes away'],
  feed: ['増やす', 'adds to'],
  decrease: ['減らす', 'decreases'],
  increase: ['増やす', 'increases'],
  scale: ['倍率を掛ける', 'scales'],
  set: ['入れる', 'sets'],
  clear: ['0 にする', 'clears'],
  read: ['読み出す', 'reads'],
};

/** 変更 1 件を、そのまま読み上げる。 */
export function changeText(c) {
  if (!c) return '';
  const verb = WORK_VERB[c.work] || WORK_VERB.set;
  const place = placeShort(c);
  const amt = amountShort(c.amount, c.base);
  const tail = [];
  if (c.cappedBy) {
    tail.push(pick('上限は ' + hexOffset(c.cappedBy.disp) + ' の値',
      'capped by ' + hexOffset(c.cappedBy.disp)));
  } else if (c.clamped) {
    tail.push(pick('下限で止める', 'held at its floor'));
  }
  if (c.n > 1) tail.push(pick('同じ形が ' + c.n + ' か所', c.n + ' places'));
  const note = tail.length ? pick('（' + tail.join('・') + '）', ' (' + tail.join(', ') + ')') : '';

  if (c.work === 'read') return pick(place + 'を読み出す' + note, 'reads ' + place + note);
  if (c.work === 'set' || c.work === 'clear') {
    return amt
      ? pick(place + 'に ' + amt + ' を入れる' + note, 'puts ' + amt + ' into ' + place + note)
      : pick(place + 'を書き換える' + note, 'writes ' + place + note);
  }
  if (!amt) return pick(place + 'を' + pick(verb[0], verb[1]) + note, verb[1] + ' ' + place + note);
  return pick(place + 'を、' + amt + ' ぶん' + verb[0] + note,
    verb[1] + ' ' + place + ' by ' + amt + note);
}

/**
 * 関数 1 つを 1 行で。命令から確かめられることが無ければ空文字を返す（埋めない）。
 * @param {object} purpose describePurpose の結果
 */
export function purposeText(purpose) {
  if (!purpose || !purpose.headline) return '';
  const h = purpose.headline;
  switch (h.code) {
    case 'work-change':
      return changeText(h.change);
    case 'work-accessor':
      return pick(placeShort(h.change) + 'を読んで返すだけの処理',
        'just reads ' + placeShort(h.change) + ' and returns it');
    case 'work-format':
      return pick('文言に数値を差し込んで文を組み立てる処理' +
        (h.texts && h.texts.length ? '（「' + trim(h.texts[0].text, 22) + '」など ' + h.n + ' 本）' : ''),
      'builds text by filling numbers into ' + h.n + ' format strings');
    case 'work-fill':
      return pick('並びを最後まで回して、値を詰めていく処理（繰り返し ' + h.loops + ' か所）',
        'walks a list and fills values in (' + h.loops + ' loops)');
    case 'work-dispatch':
      return pick('自分では値を変えず、ほかの処理へ渡すだけ（' + h.calls + ' 回の呼び出し）',
        'changes nothing itself — hands off to other routines (' + h.calls + ' calls)');
    case 'work-too-big':
      return pick('1 つの処理と呼ぶには大きすぎる（' + h.n.toLocaleString() + ' 命令・' +
        h.calls + ' 回の呼び出し）— 複数の処理がまとめて埋め込まれている',
      'too large to be one routine (' + h.n.toLocaleString() + ' instructions) — ' +
        'several routines were inlined together');
    case 'work-check':
      return pick('決まった数と比べて分かれるだけの処理（分岐 ' + h.n + ' 個）',
        'only compares against constants and branches (' + h.n + ' branches)');
    default: return '';
  }
}

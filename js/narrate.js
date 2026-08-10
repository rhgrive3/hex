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
  const who = name ? pick('この関数（' + name + '）', 'this function (' + name + ')') : pick('この処理', 'this routine');
  const Who = pick(who, who.charAt(0).toUpperCase() + who.slice(1));

  if (f.features.length) {
    purpose.push(pick(
      Who + 'は、' + f.features.map(featureLabel).filter(Boolean).join('と') + 'に関わる処理をしています。',
      Who + ' is involved in ' + f.features.map(featureLabel).filter(Boolean).join(' and ') + '.'));
  }
  const sels = uniq((model.calls || []).map((c) => c.selector).filter(Boolean));
  if (sels.length) {
    purpose.push(pick(
      '「' + sels.slice(0, 5).join('」「') + '」' +
        (sels.length > 5 ? ' など ' + sels.length + ' 個' : '') + 'というメソッドを呼んでいます。' +
        'メソッドの名前は人が付けたものなので、この関数が何の担当かを知る手がかりになります。',
      'It calls the methods ' + sels.slice(0, 5).map((x) => '“' + x + '”').join(', ') +
        '. Method names are written by people, so they say a lot about what this is for.'));
  }
  const apiPhrases = f.apis.map((a) => apiShort(a.id)).filter(Boolean);
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

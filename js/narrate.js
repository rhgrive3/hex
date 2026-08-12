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

/* ────────────────────────────────────────────────────────────
   目的から探す — 候補の理由を読み上げる
   ──────────────────────────────────────────────────────────── */

const hex = (v) => (v == null ? '' : '0x' + v.toString(16).toUpperCase());

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
  return base + (disp != null ? ' + ' + hex(disp) : '');
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
      return pick('この値をメモリ（' + (d.base || '?') +
        (d.disp != null ? ' + ' + hex(d.disp) : '') + '）へ書き込んでいる',
      'stored into memory at ' + (d.base || '?') + (d.disp != null ? ' + ' + hex(d.disp) : ''));
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

/** 確率を、言い過ぎない日本語にする。 */
export function probabilityText(p) {
  if (!(p >= 0)) return '';
  if (p >= 0.999) return pick('99.9% 以上', 'over 99.9%');
  if (p >= 0.99) return pick('99% 以上', 'over 99%');
  return Math.round(p * 100) + '%';
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
  return '+0x' + n.toString(16).toUpperCase();
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

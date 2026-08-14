/*
 * 表示言語。既定は日本語。
 *
 * このアプリは「アセンブリを触ったことがない人」が読むことを前提にしているので、
 * 日本語が第一言語で、英語は補助。t('key', {変数}) で文字列を取り出す。
 */

const STRINGS = {
  ja: {
    /* ── アプリの骨格 ── */
    'app.title': 'Hex — ARM64 読み解きツール',
    'app.noFile': 'ファイル未選択',
    'app.noFileSub': 'アプリの中身（Mach-O / 生バイナリ）を開いてください',
    'btn.open': '開く',
    'btn.more': '⋯',
    'btn.done': '閉じる',
    'btn.ok': 'OK',
    'btn.cancel': 'キャンセル',
    'btn.back': '戻る',
    'btn.next': '次へ',
    'btn.prev': '前へ',
    'btn.go': '移動',
    'btn.find': '検索',
    'btn.stop': '停止',
    'mode.asm': 'アセンブリ',
    'mode.hex': '16進',
    'btn.investigate': '調べる',
    'btn.overview': '自動解析',
    'btn.tools': '解析',
    'btn.features': '機能',
    'btn.sections': 'セクション',
    'btn.functions': '関数',
    'btn.overflow': 'その他',
    'btn.strings': '文字列',
    'btn.struct': '構造',
    'btn.jump': 'ジャンプ',
    'btn.search': '検索',
    'btn.select': '選択',
    'btn.explainToggle': '解説',
    'btn.learn': '学習',
    'btn.help': 'ヘルプ',
    'btn.glossary': '用語集',
    'btn.settings': '設定',
    'btn.openFile': 'ファイルを開く…',
    'btn.sample': 'サンプルで練習する',
    'btn.all': '全部',
    'btn.copy': 'コピー',
    'btn.clear': '解除',

    /* ── 空の画面 ── */
    'empty.title': 'アプリの中身を、日本語で読む',
    'empty.text':
      'iPhone / iPad アプリの実行ファイル（Mach-O）や\n' +
      '生のバイナリの中身を、1 行ずつ日本語で説明します。\n' +
      '\n' +
      'ファイルは端末の中だけで解析され、どこにも送信されません。',
    'empty.firstTime': 'はじめての方へ：まずは「サンプルで練習する」がおすすめです。',

    /* ── 列見出し ── */
    'col.address': 'アドレス',
    'col.hex': '16進',
    'col.instruction': '命令',
    'col.ascii': '文字',
    'col.meaning': '意味',

    /* ── 状態表示 ── */
    'status.rows': '{n} 行',
    'status.loading': '読み込み中…',
    'status.reading': '{name} を読み込み中…',
    'status.analyzing': '解析中…',
    'status.rowOf': '{cur} / {total}',
    'status.data': 'データ',

    /* ── ファイル情報 ── */
    'file.title': 'ファイル情報',
    'file.group.file': 'ファイル',
    'file.name': '名前',
    'file.size': 'サイズ',
    'file.format': '形式',
    'file.group.macho': 'Mach-O ヘッダ',
    'file.type': '種類',
    'file.cpu': 'CPU',
    'file.cpuSub': 'CPU 詳細',
    'file.magic': '目印 (magic)',
    'file.flags': 'フラグ',
    'file.platform': '対象 OS',
    'file.uuid': 'UUID',
    'file.loadCommands': 'ロードコマンド',
    'file.dylibs': 'リンクしているライブラリ',
    'file.codeSignature': 'コード署名',
    'file.present': 'あり',
    'file.none': 'なし',
    'file.sliceOffset': 'このスライスの位置',
    'file.entry': 'プログラムの開始地点',
    'file.encryption': '暗号化',
    'file.group.code': 'コードのある場所',
    'file.group.notes': '注意',
    'file.group.symbols': 'シンボル（名前）',
    'file.symbolCount': '見つかった名前',
    'file.functionCount': '関数の数',
    'file.rawOnly':
      'Mach-O のヘッダが見つからなかったので、ファイル全体を生のバイト列として表示しています。' +
      '「ジャンプ」で位置を移動でき、「アセンブリ」タブで ARM64 として逆アセンブルできます。',

    /* ── セクション ── */
    'sections.title': 'セクション（区画）',
    'sections.arch': 'アーキテクチャ（CPU の種類）',
    'sections.raw': '生データ',
    'sections.wholeFile': 'ファイル全体',
    'sections.noSections': '（セクションなし）',
    'sections.zerofill': 'ゼロ埋め',
    'sections.truncated': 'ファイル内で途切れている',
    'sections.tagCode': 'コード',
    'sections.tagData': 'データ',
    'sections.hint':
      'セクションは、実行ファイルの中の「用途ごとの区画」です。__text は機械語、' +
      '__cstring は文字列、__data は書き換わるデータ、というように分かれています。',

    /* ── ジャンプ ── */
    'jump.title': 'アドレスへジャンプ',
    'jump.hint':
      '16進数で入力します（例: 10000C448 または 0x10000C448）。' +
      '今のセクションは {from} 〜 {to} の範囲です。',
    'jump.group': 'よく使う移動先',
    'jump.sectionStart': 'このセクションの先頭',
    'jump.sectionEnd': 'このセクションの末尾',
    'jump.entry': 'プログラムの開始地点',
    'jump.invalid': '16進数のアドレスを入力してください（例: 0x10000C448）。',

    /* ── 検索 ── */
    'search.title': '検索',
    'search.kind.asm': '命令の文字',
    'search.kind.hex': '16進バイト',
    'search.kind.num': '数値',
    'search.kind.addr': 'アドレス',
    'search.kind.text': '文字列',
    'search.ph.asm': '例: str, bl, x19, #0x20',
    'search.ph.hex': '例: FD 7B BF A9 または D1??00',
    'search.ph.num': '100 または 0x64',
    'search.ph.addr': '例: 0x10000C448',
    'search.ph.text': '例: password',
    'search.help.asm': '{region} の中の命令（ニーモニックとオペランド）から探します。',
    'search.help.hex': '{region} の中のバイト列から探します。「?」は任意の値。',
    'search.help.num': 'その数がそのまま書かれている場所を探します。並べ替え（リトルエンディアン）はこちらでやります。',
    'search.help.addr': '{region} の中のアドレスへ直接移動します。',
    'search.help.text': '{region} の中の文字列（ASCII）から探します。',
    'search.searching': '検索中…',
    'search.searchingN': '検索中… {n} 件',
    'search.none': '{region} には見つかりませんでした。',
    'search.count': '{n} 件見つかりました',
    'search.capped': '（最初の {n} 件で打ち切り）',
    'search.stopped': '検索を止めました。ここまで {n} 件。',
    'search.needQuery': '検索する内容を入力してください。',
    'search.badAddr': 'アドレスとして読めません。',
    'search.badHex': '16進バイトを入力してください（例: FD 7B BF A9）。',
    'search.badNum': '数として読めません。100 や 0x64 のように入れてください',
    'search.more': 'さらに表示',
    'search.showMore': 'あと {n} 件を表示',
    'search.failed': '検索に失敗しました',

    /* ── 命令の詳細 ── */
    'detail.title': 'この 1 行の意味',
    'detail.what': 'ひとことで言うと',
    'detail.pseudo': '式で書くと',
    'detail.detail': 'くわしく',
    'detail.operands': '部品の意味',
    'detail.bytes': '実際のバイト',
    'detail.bytesHelp':
      'ARM64 の命令は必ず 4 バイト。ファイルには小さい桁が先（リトルエンディアン）で並ぶので、' +
      '{stored} と書かれていても、CPU から見た 1 つの数は {value} です。',
    'detail.binary': '2 進数で見る',
    'detail.where': '場所',
    'detail.whereText': '{region} の中 / ファイル内の位置 {offset} / {row} 行目',
    'detail.terms': '出てきた用語',
    'detail.target': 'ジャンプ先',
    'detail.targetTap': 'タップでそこへ移動します',
    'detail.string': '指している文字列',
    'detail.context': '前後の流れ',
    'detail.actions': 'できること',
    'detail.copyAddress': 'アドレスをコピー',
    'detail.copyHex': '16進をコピー',
    'detail.copyAsm': '命令をコピー',
    'detail.copyAll': '全部コピー',
    'detail.copyExplain': '解説をコピー',
    'detail.selectRows': 'ここから範囲選択',
    'detail.showFunction': 'この関数の要約を見る',
    'detail.findRefs': 'ここを参照している場所を探す',
    'detail.notLoaded': '（読み込み中）',

    /* ── 関数 ── */
    'functions.title': '関数の一覧',
    'functions.none': '関数が見つかりませんでした。',
    'functions.hintNoSymbols':
      'このファイルには関数名の情報が入っていません（配布用にシンボルが削られています）。' +
      'その代わり、命令の並びから関数の始まりを推測して表示しています。',
    'functions.hintSymbols': '{n} 個の関数が見つかりました。タップするとそこへ移動します。',
    'functions.search': '名前でしぼり込む',
    'functions.summaryTitle': '関数の要約',
    'functions.unnamed': '名前なしの関数',
    'functions.analyzing': '関数を調べています…',

    'fn.range': '範囲',
    'fn.size': '大きさ',
    'fn.instructions': '命令の数',
    'fn.frame': 'スタックの確保量',
    'fn.frameNone': 'スタックを確保していません（とても小さい関数）',
    'fn.savesLr': '戻り先アドレス (lr) を保存している → 中で別の関数を呼びます',
    'fn.leaf': '戻り先アドレスを保存していない → 他の関数を呼ばない末端の関数です',
    'fn.calls': '呼び出している関数',
    'fn.callsNone': '他の関数は呼んでいません',
    'fn.loops': 'ループ',
    'fn.loopsNone': 'ループはありません（上から下へ一直線）',
    'fn.loopsN': '{n} か所で前に戻っています → ループがあります',
    'fn.branches': '条件分岐',
    'fn.branchesN': '{n} か所（if / else のような枝分かれ）',
    'fn.returns': '出口 (ret)',
    'fn.memory': 'メモリの読み書き',
    'fn.memoryN': '読み込み {load} 回 / 書き込み {store} 回',
    'fn.args': '受け取っていそうな引数',
    'fn.argsN': '{regs} を読んでいるので、引数は {n} 個くらいありそうです',
    'fn.argsNone': '引数レジスタ (x0〜x7) を読んでいないので、引数はなさそうです',
    'fn.retval': '戻り値',
    'fn.retvalYes': '最後に x0 / w0 を作っているので、値を返しています',
    'fn.retvalNo': '戻り値は特に設定していません',
    'fn.story': 'ざっくりした流れ',
    'fn.goto': 'この関数の先頭へ移動',

    /* ── 文字列 ── */
    'strings.title': '文字列の一覧',
    'strings.scanning': '文字列を探しています…',
    'strings.none': '読める文字列は見つかりませんでした。',
    'strings.count': '{n} 個の文字列',
    'strings.hint':
      'プログラムの中のメッセージ、URL、ファイル名などはここに集まります。' +
      'アプリが何をしているか推測する一番の手がかりです。',
    'strings.filter': '内容でしぼり込む',
    'strings.capped': '（最初の {n} 個まで）',

    /* ── 構造 ── */
    'struct.title': 'ファイルの構造',
    'struct.hint':
      'このファイルが、先頭からどう組み立てられているかです。タップするとその場所へ移動します。',
    'struct.header': 'ヘッダ（このファイルの身分証）',
    'struct.headerSub': '32 バイト。CPU の種類やロードコマンドの数が書いてあります。',
    'struct.commands': 'ロードコマンド（OS への指示書）',
    'struct.commandsSub': '{n} 個。「このデータをメモリのここに置け」などの命令が並びます。',
    'struct.segments': 'セグメント（メモリに載せる大きな塊）',
    'struct.linkedit': 'リンク情報（名前や署名）',
    'struct.field.magic': '目印。0xFEEDFACF なら 64 ビットの Mach-O。',
    'struct.field.cputype': 'どの CPU 向けか。0x0100000C が ARM64。',
    'struct.field.filetype': 'アプリ本体か、ライブラリか。',
    'struct.field.ncmds': 'ロードコマンドの個数。',
    'struct.field.sizeofcmds': 'ロードコマンド全部の合計バイト数。',
    'struct.field.flags': '細かい設定のスイッチ。',
    'struct.bytes': '{n} バイト',
    'struct.at': '位置 {offset}',

    /* ── 選択 ── */
    'sel.rows': '{n} 行',
    'sel.hint': 'もう 1 行タップすると、そこまでが選択されます。',
    'sel.copyRows': '{n} 行をコピー',
    'sel.copyAddresses': 'アドレスだけコピー',
    'sel.copyHex': '16進だけコピー',
    'sel.copyAsm': '命令だけコピー',
    'sel.copyExplained': '日本語の解説つきでコピー',
    'sel.selectAll': 'セクション全体を選択',
    'sel.clear': '選択を解除',
    'sel.tooLarge': '選択が大きすぎます',
    'sel.tooLargeText':
      '{n} 行は一度にクリップボードへ入れられません。{max} 行（{size}）までにしてください。',
    'sel.copying': '{n} 行をコピー中…',
    'sel.copyingPct': '{n} 行をコピー中… {pct}%',
    'sel.regionChanged': 'コピー中にセクションが切り替わりました。',

    /* ── 設定 ── */
    'settings.title': '設定',
    'settings.group.explain': '解説の表示',
    'settings.explainOn': '各行に意味を表示する',
    'settings.explainOnSub': '命令の下に、日本語の説明をもう 1 行足します',
    'settings.noteStyle': '説明の書き方',
    'settings.note.ja': '日本語',
    'settings.note.jaSub': 'x0 に x1 と 8 を足して入れる',
    'settings.note.pseudo': '式',
    'settings.note.pseudoSub': 'x0 = x1 + 8',
    'settings.note.both': '両方',
    'settings.note.bothSub': 'x0 = x1 + 8 — 足し算',
    'settings.group.appearance': '見た目',
    'settings.theme.system': '端末に合わせる',
    'settings.theme.light': 'ライト',
    'settings.theme.dark': 'ダーク',
    'settings.textSize': '文字の大きさ',
    'settings.size.s': '小',
    'settings.size.m': '中',
    'settings.size.l': '大',
    'settings.size.xl': '特大',
    'settings.group.hex': '16進の表示',
    'settings.hexSpaced': '区切って表示',
    'settings.hexJoined': 'つなげて表示',
    'settings.group.lang': '言語 / Language',
    'settings.lang.ja': '日本語',
    'settings.lang.en': 'English',
    'settings.group.about': 'このアプリについて',
    'settings.about':
      '開いたファイルは、この端末のブラウザの中だけで読み込まれ、変更も送信もされません。' +
      '逆アセンブルは Capstone {version} を WebAssembly にしたものを使っています。',
    'settings.resetGuide': '初回ガイドをもう一度見る',

    /* ── ヘルプ / ガイド ── */
    'help.title': '使い方',
    'help.learn': '学習コース（ゼロから読めるようになる）',
    'help.learnSub': '10 章。2進数の話から、実際のアプリを読むところまで',
    'help.glossary': '用語集',
    'help.glossarySub': '「レジスタって何？」をその場で引く',
    'help.tour': 'この画面の使い方',
    'help.sample': 'サンプルで練習する',
    'help.sampleSub': '練習用の小さなアプリをこの場で作って開きます',
    'help.faq': 'よくある質問',

    'guide.title': 'ようこそ',
    'guide.skip': 'あとで',
    'guide.start': 'はじめる',

    /* ── 学習 ── */
    'learn.title': '学習コース',
    'learn.progress': '{done} / {total} 章',
    'learn.chapter': '第 {n} 章',
    'learn.read': '読んだ',
    'learn.unread': 'まだ',
    'learn.markRead': '読んだことにする',
    'learn.markUnread': '未読に戻す',
    'learn.tryIt': 'やってみる',
    'learn.reset': '進み具合をリセット',

    /* ── 用語集 ── */
    'glossary.title': '用語集',
    'glossary.filter': '用語を探す',
    'glossary.none': '見つかりませんでした。',
    'glossary.related': '関連',

    /* ── エラー・お知らせ ── */
    'err.openTitle': 'このファイルは開けませんでした',
    'err.emptyTitle': '中身が空です',
    'err.emptyText': 'このファイルには 1 バイトも入っていません。',
    'err.engineTitle': '解析エンジンが止まりました',
    'err.engineWasm':
      '逆アセンブルのエンジンを読み込めませんでした。\n\n' +
      'capstone.js と capstone.wasm の両方が index.html と同じ場所に必要です。' +
      'また、ページは http(s) で開く必要があります（ファイルを直接開くと動きません）。',
    'err.notReadable':
      'ファイルを読めませんでした。iCloud Drive にある場合は、' +
      'ファイル App で先にダウンロードしてから開いてください。',
    'err.memory':
      'このファイルを解析している途中でブラウザのメモリが足りなくなりました。' +
      '他のタブを閉じてもう一度お試しください。',
    'err.unknown': '原因不明のエラーです。',
    'err.disasmTitle': '逆アセンブルできません',
    'err.arm64Only':
      '{arch} はこのアプリでは逆アセンブルできません。対応しているのは ARM64 (AArch64) だけです。' +
      '「16進」タブならバイトの中身は見られます。',
    'err.notArm64': '{arch} は ARM64 ではないので、バイト列だけ表示します。',
    'err.nothingTitle': '表示するものがありません',
    'err.nothingText':
      '{name} にはファイル上のデータがありません{zero}。',
    'err.zerofill': '（実行時にゼロで埋められる区画です）',
    'err.outsideTitle': 'ファイルの外です',
    'err.outsideText': '{addr} はこのファイルの終わり ({size}) より後ろです。',
    'err.unmappedTitle': 'そのアドレスはありません',
    'err.unmappedText':
      '{addr} は、このファイルのどのセクションにも含まれていません。\n\n' +
      'セクションがある範囲は {range} です。',
    'err.encryptedTitle': '暗号化されたアプリです',
    'err.encryptedText':
      'この Mach-O は cryptid = 1 のまま、つまり App Store の暗号化がかかった状態です。' +
      'バイトはそのまま表示しますが、意味のある命令にはなりません。' +
      '復号された（実機から取り出した）ものを開く必要があります。',
    'err.copyFailed': 'コピーできませんでした。値を長押しして選択してください。',
    'err.openFirst': '先にファイルを開いてください。',

    'toast.copied': '{what}をコピーしました',
    'toast.copyAddress': 'アドレス',
    'toast.copyHex': '16進',
    'toast.copyAsm': '命令',
    'toast.copyRow': '行',
    'toast.copyExplain': '解説',
    'toast.jumped': '{name} へ移動しました',

    /* ── 相互参照 ── */
    'xref.title': 'ここを使っている場所',
    'xref.scanning': '探しています…',
    'xref.none': 'このセクションの中には見つかりませんでした。',
    'xref.count': '{n} か所から参照されています',
    'xref.hint': 'この場所へ飛んだり、この場所のアドレスを作ったりしている命令です。',
  },

  en: {
    'app.title': 'Hex — ARM64 Reader',
    'app.noFile': 'No file',
    'app.noFileSub': 'Open a Mach-O executable or raw binary',
    'btn.open': 'Open',
    'btn.more': '⋯',
    'btn.done': 'Done',
    'btn.ok': 'OK',
    'btn.cancel': 'Cancel',
    'btn.back': 'Back',
    'btn.next': 'Next',
    'btn.prev': 'Previous',
    'btn.go': 'Go',
    'btn.find': 'Find',
    'btn.stop': 'Stop',
    'mode.asm': 'Assembly',
    'mode.hex': 'Hex',
    'btn.investigate': 'Find',
    'btn.overview': 'Auto analysis',
    'btn.tools': 'Analysis',
    'btn.features': 'Features',
    'btn.sections': 'Sections',
    'btn.functions': 'Functions',
    'btn.overflow': 'More',
    'btn.strings': 'Strings',
    'btn.struct': 'Layout',
    'btn.jump': 'Go to',
    'btn.search': 'Search',
    'btn.select': 'Select',
    'btn.explainToggle': 'Explain',
    'btn.learn': 'Learn',
    'btn.help': 'Help',
    'btn.glossary': 'Glossary',
    'btn.settings': 'Settings',
    'btn.openFile': 'Open File…',
    'btn.sample': 'Try the sample',
    'btn.all': 'All',
    'btn.copy': 'Copy',
    'btn.clear': 'Clear',

    'empty.title': 'Read a binary in plain language',
    'empty.text':
      'Open an iOS/macOS executable (Mach-O) or a raw binary and every\n' +
      'instruction is explained line by line.\n' +
      'Files are parsed on this device and never uploaded.',
    'empty.firstTime': 'New to this? Start with “Try the sample”.',

    'col.address': 'ADDRESS',
    'col.hex': 'HEX',
    'col.instruction': 'INSTRUCTION',
    'col.ascii': 'ASCII',
    'col.meaning': 'MEANING',

    'status.rows': '{n} rows',
    'status.loading': 'Loading…',
    'status.reading': 'Reading {name}…',
    'status.analyzing': 'Analysing…',
    'status.rowOf': '{cur} / {total}',
    'status.data': 'data',

    'file.title': 'File',
    'file.group.file': 'FILE',
    'file.name': 'Name',
    'file.size': 'Size',
    'file.format': 'Format',
    'file.group.macho': 'MACH-O',
    'file.type': 'Type',
    'file.cpu': 'CPU',
    'file.cpuSub': 'CPU subtype',
    'file.magic': 'Magic',
    'file.flags': 'Flags',
    'file.platform': 'Platform',
    'file.uuid': 'UUID',
    'file.loadCommands': 'Load commands',
    'file.dylibs': 'Linked libraries',
    'file.codeSignature': 'Code signature',
    'file.present': 'Present',
    'file.none': 'None',
    'file.sliceOffset': 'Slice offset',
    'file.entry': 'Entry point',
    'file.encryption': 'Encryption',
    'file.group.code': 'CODE',
    'file.group.notes': 'NOTES',
    'file.group.symbols': 'SYMBOLS',
    'file.symbolCount': 'Named symbols',
    'file.functionCount': 'Functions',
    'file.rawOnly':
      'No Mach-O header was found, so the whole file is shown as raw bytes. ' +
      'Use “Go to” to move to an offset and the Assembly tab to disassemble it as ARM64.',

    'sections.title': 'Sections',
    'sections.arch': 'ARCHITECTURE',
    'sections.raw': 'RAW',
    'sections.wholeFile': 'Whole file',
    'sections.noSections': '(no sections)',
    'sections.zerofill': 'zero-filled',
    'sections.truncated': 'truncated in file',
    'sections.tagCode': 'code',
    'sections.tagData': 'data',
    'sections.hint':
      'Sections are the labelled areas of an executable: __text is machine code, ' +
      '__cstring holds strings, __data holds writable values.',

    'jump.title': 'Go to Address',
    'jump.hint': 'Accepts 10000C448 or 0x10000C448. This section covers {from} – {to}.',
    'jump.group': 'JUMP TO',
    'jump.sectionStart': 'Start of section',
    'jump.sectionEnd': 'End of section',
    'jump.entry': 'Entry point',
    'jump.invalid': 'Enter a hexadecimal address, e.g. 0x10000C448.',

    'search.title': 'Search',
    'search.kind.asm': 'Instruction',
    'search.kind.hex': 'Hex bytes',
    'search.kind.num': 'Number',
    'search.kind.addr': 'Address',
    'search.kind.text': 'Text',
    'search.ph.asm': 'e.g. str, bl, x19, #0x20',
    'search.ph.hex': 'e.g. FD 7B BF A9 or D1??00',
    'search.ph.num': 'e.g. 100 or 0x64',
    'search.ph.addr': 'e.g. 0x10000C448',
    'search.ph.text': 'e.g. password',
    'search.help.asm': 'Searches mnemonics and operands in {region}.',
    'search.help.hex': 'Searches raw bytes in {region}. “?” matches any nibble.',
    'search.help.num': 'Finds where that number is stored. Byte order (little-endian) is handled for you.',
    'search.help.addr': 'Jumps straight to an address in {region}.',
    'search.help.text': 'Searches printable ASCII text in {region}.',
    'search.searching': 'Searching…',
    'search.searchingN': 'Searching… {n} matches',
    'search.none': 'No matches in {region}.',
    'search.count': '{n} matches',
    'search.capped': ' (stopped at the first {n})',
    'search.stopped': 'Search stopped. {n} so far.',
    'search.needQuery': 'Enter something to search for.',
    'search.badAddr': 'That is not a valid address.',
    'search.badHex': 'Enter hex bytes such as FD 7B BF A9.',
    'search.badNum': 'Not a number. Try 100 or 0x64.',
    'search.more': 'Show more results',
    'search.showMore': 'Show {n} more',
    'search.failed': 'Search failed',

    'detail.title': 'Instruction',
    'detail.what': 'In one line',
    'detail.pseudo': 'As an expression',
    'detail.detail': 'In detail',
    'detail.operands': 'The parts',
    'detail.bytes': 'The bytes',
    'detail.bytesHelp':
      'Every ARM64 instruction is exactly 4 bytes, stored least-significant byte first ' +
      '(little endian), so {stored} on disk is the single value {value} to the CPU.',
    'detail.binary': 'In binary',
    'detail.where': 'Location',
    'detail.whereText': '{region} · file offset {offset} · row {row}',
    'detail.terms': 'Terms used here',
    'detail.target': 'Jumps to',
    'detail.targetTap': 'Tap to go there',
    'detail.string': 'String it points at',
    'detail.context': 'Surrounding code',
    'detail.actions': 'Actions',
    'detail.copyAddress': 'Copy Address',
    'detail.copyHex': 'Copy Hex',
    'detail.copyAsm': 'Copy Assembly',
    'detail.copyAll': 'Copy All',
    'detail.copyExplain': 'Copy Explanation',
    'detail.selectRows': 'Select Rows…',
    'detail.showFunction': 'Summarise this function',
    'detail.findRefs': 'Find references to here',
    'detail.notLoaded': '(loading)',

    'functions.title': 'Functions',
    'functions.none': 'No functions found.',
    'functions.hintNoSymbols':
      'This file has no function names (the symbols were stripped). ' +
      'Function starts below are inferred from the instruction patterns instead.',
    'functions.hintSymbols': '{n} functions. Tap one to go there.',
    'functions.search': 'Filter by name',
    'functions.summaryTitle': 'Function summary',
    'functions.unnamed': 'unnamed function',
    'functions.analyzing': 'Analysing the function…',

    'fn.range': 'Range',
    'fn.size': 'Size',
    'fn.instructions': 'Instructions',
    'fn.frame': 'Stack reserved',
    'fn.frameNone': 'No stack frame (a very small function)',
    'fn.savesLr': 'Saves the return address (lr) → it calls other functions',
    'fn.leaf': 'Does not save the return address → a leaf function',
    'fn.calls': 'Calls',
    'fn.callsNone': 'Calls nothing',
    'fn.loops': 'Loops',
    'fn.loopsNone': 'No loops — straight through',
    'fn.loopsN': '{n} backward branches → there is a loop',
    'fn.branches': 'Conditional branches',
    'fn.branchesN': '{n} (if / else style forks)',
    'fn.returns': 'Exits (ret)',
    'fn.memory': 'Memory access',
    'fn.memoryN': '{load} loads / {store} stores',
    'fn.args': 'Probable arguments',
    'fn.argsN': 'Reads {regs}, so it probably takes about {n} arguments',
    'fn.argsNone': 'Reads no argument register (x0–x7) — probably takes none',
    'fn.retval': 'Return value',
    'fn.retvalYes': 'Sets x0 / w0 before returning, so it returns a value',
    'fn.retvalNo': 'Does not set a return value',
    'fn.story': 'The shape of it',
    'fn.goto': 'Go to the start of this function',

    'strings.title': 'Strings',
    'strings.scanning': 'Looking for strings…',
    'strings.none': 'No readable strings found.',
    'strings.count': '{n} strings',
    'strings.hint':
      'Messages, URLs and file names live here. They are the fastest way to guess ' +
      'what a program does.',
    'strings.filter': 'Filter',
    'strings.capped': ' (first {n})',

    'struct.title': 'File layout',
    'struct.hint': 'How this file is put together, front to back. Tap to go there.',
    'struct.header': 'Header (the file’s ID card)',
    'struct.headerSub': '32 bytes: which CPU, and how many load commands follow.',
    'struct.commands': 'Load commands (instructions for the OS)',
    'struct.commandsSub': '{n} of them — “map this data to that address”, and so on.',
    'struct.segments': 'Segments (the big blocks mapped into memory)',
    'struct.linkedit': 'Link information (names and signature)',
    'struct.field.magic': 'The marker. 0xFEEDFACF means a 64-bit Mach-O.',
    'struct.field.cputype': 'Which CPU. 0x0100000C is ARM64.',
    'struct.field.filetype': 'An app, or a library.',
    'struct.field.ncmds': 'How many load commands.',
    'struct.field.sizeofcmds': 'Total bytes of all load commands.',
    'struct.field.flags': 'Assorted on/off switches.',
    'struct.bytes': '{n} bytes',
    'struct.at': 'at {offset}',

    'sel.rows': '{n} rows',
    'sel.hint': 'Tap another row to select through it.',
    'sel.copyRows': 'Copy {n} rows',
    'sel.copyAddresses': 'Copy addresses',
    'sel.copyHex': 'Copy hex',
    'sel.copyAsm': 'Copy assembly',
    'sel.copyExplained': 'Copy with explanations',
    'sel.selectAll': 'Select the whole section',
    'sel.clear': 'Clear selection',
    'sel.tooLarge': 'Selection too large',
    'sel.tooLargeText':
      '{n} rows is more than the clipboard will take in one go. Select at most {max} rows ({size}).',
    'sel.copying': 'Copying {n} rows…',
    'sel.copyingPct': 'Copying {n} rows… {pct}%',
    'sel.regionChanged': 'The section changed while copying.',

    'settings.title': 'Settings',
    'settings.group.explain': 'EXPLANATIONS',
    'settings.explainOn': 'Explain every line',
    'settings.explainOnSub': 'Adds a second line under each instruction',
    'settings.noteStyle': 'Style',
    'settings.note.ja': 'Words',
    'settings.note.jaSub': 'add x1 and 8, put it in x0',
    'settings.note.pseudo': 'Expression',
    'settings.note.pseudoSub': 'x0 = x1 + 8',
    'settings.note.both': 'Both',
    'settings.note.bothSub': 'x0 = x1 + 8 — addition',
    'settings.group.appearance': 'APPEARANCE',
    'settings.theme.system': 'System',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.textSize': 'Text size',
    'settings.size.s': 'S',
    'settings.size.m': 'M',
    'settings.size.l': 'L',
    'settings.size.xl': 'XL',
    'settings.group.hex': 'HEX',
    'settings.hexSpaced': 'Spaced bytes',
    'settings.hexJoined': 'Joined bytes',
    'settings.group.lang': 'LANGUAGE / 言語',
    'settings.lang.ja': '日本語',
    'settings.lang.en': 'English',
    'settings.group.about': 'ABOUT',
    'settings.about':
      'The file you open is read in this browser only — never modified, never uploaded. ' +
      'Disassembly is Capstone {version} compiled to WebAssembly.',
    'settings.resetGuide': 'Show the welcome guide again',

    'help.title': 'Help',
    'help.learn': 'Course: from zero to reading code',
    'help.learnSub': '10 chapters, from binary numbers to a real app',
    'help.glossary': 'Glossary',
    'help.glossarySub': 'Look up “what is a register?” on the spot',
    'help.tour': 'How this screen works',
    'help.sample': 'Try the sample',
    'help.sampleSub': 'Builds a small practice binary and opens it',
    'help.faq': 'Common questions',

    'guide.title': 'Welcome',
    'guide.skip': 'Later',
    'guide.start': 'Start',

    'learn.title': 'Course',
    'learn.progress': '{done} / {total} chapters',
    'learn.chapter': 'Chapter {n}',
    'learn.read': 'read',
    'learn.unread': 'unread',
    'learn.markRead': 'Mark as read',
    'learn.markUnread': 'Mark as unread',
    'learn.tryIt': 'Try it',
    'learn.reset': 'Reset progress',

    'glossary.title': 'Glossary',
    'glossary.filter': 'Find a term',
    'glossary.none': 'Nothing matched.',
    'glossary.related': 'Related',

    'err.openTitle': 'Could not open this file',
    'err.emptyTitle': 'Empty file',
    'err.emptyText': 'This file contains no data.',
    'err.engineTitle': 'Analysis engine stopped',
    'err.engineWasm':
      'The disassembler engine could not be loaded.\n\n' +
      'capstone.js and capstone.wasm must both sit next to index.html, and the page must ' +
      'be served over http(s) — opening index.html from the file system will not work.',
    'err.notReadable':
      'The file could not be read. If it came from iCloud Drive, open the Files app and download it first.',
    'err.memory':
      'The browser ran out of memory while analysing this file. Close other tabs and try again.',
    'err.unknown': 'Unknown error.',
    'err.disasmTitle': 'Cannot disassemble',
    'err.arm64Only':
      '{arch} cannot be disassembled here. This viewer decodes ARM64 (AArch64) only; ' +
      'the Hex tab still shows the bytes.',
    'err.notArm64': '{arch} is not ARM64 — showing bytes only.',
    'err.nothingTitle': 'Nothing to show',
    'err.nothingText': '{name} has no bytes in the file{zero}.',
    'err.zerofill': ' (it is zero-filled at load time)',
    'err.outsideTitle': 'Outside the file',
    'err.outsideText': '{addr} is past the end of this file ({size}).',
    'err.unmappedTitle': 'Address not mapped',
    'err.unmappedText':
      '{addr} is not inside any section of this image.\n\nSections cover {range}.',
    'err.encryptedTitle': 'Encrypted binary',
    'err.encryptedText':
      'This Mach-O still has cryptid = 1, so __TEXT is App Store encrypted. The bytes are shown ' +
      'exactly as stored, but they will not disassemble into meaningful code until the image is decrypted.',
    'err.copyFailed': 'Could not copy. Long-press the value to select it.',
    'err.openFirst': 'Open a file first.',

    'toast.copied': '{what} — copied',
    'toast.copyAddress': 'Address',
    'toast.copyHex': 'Bytes',
    'toast.copyAsm': 'Instruction',
    'toast.copyRow': 'Row',
    'toast.copyExplain': 'Explanation',
    'toast.jumped': 'Moved to {name}',

    'xref.title': 'References to here',
    'xref.scanning': 'Looking…',
    'xref.none': 'Nothing in this section refers to it.',
    'xref.count': 'Referenced from {n} places',
    'xref.hint': 'Instructions that branch here, or that build this address.',
  },
};

let current = 'ja';

export function setLang(l) {
  current = STRINGS[l] ? l : 'ja';
  document.documentElement.setAttribute('lang', current);
}

export function lang() { return current; }
export function isJa() { return current === 'ja'; }

/** 既定の言語を端末の設定から推測する（日本語以外は英語）。 */
export function detectLang() {
  const list = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || 'ja'];
  for (const l of list) {
    if (/^ja/i.test(l)) return 'ja';
    if (/^en/i.test(l)) return 'en';
  }
  return 'ja';
}

/** t('key', {n: 3}) → '3 行' */
export function t(key, vars) {
  const table = STRINGS[current] || STRINGS.ja;
  let s = table[key];
  if (s == null) s = STRINGS.ja[key];
  if (s == null) return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
}

/** 言語に応じて片方を返す小道具。長文をテーブルに入れたくないときに使う。 */
export function pick(ja, en) { return current === 'ja' ? ja : (en == null ? ja : en); }

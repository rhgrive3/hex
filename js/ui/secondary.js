import {
  h, uiButton, screen, card, listRow, sectionTitle, emptyState,
} from './primitives.js';
import { pick } from '../i18n.js';
import { CHAPTERS, loadProgress, saveProgress, chapterById } from '../learn.js';
import { GLOSSARY, searchGlossary } from '../glossary.js';
import { toast } from '../ui.js';

function list() { return h('div', 'ui-list'); }

function choiceRow({ title, subtitle, selected, onClick }) {
  const row = listRow({ title, subtitle, meta: selected ? '✓' : '', onClick });
  row.setAttribute('aria-pressed', String(!!selected));
  return row;
}

function renderSettings(app, router) {
  const s = screen(pick('設定', 'Settings'), {
    id: 'settings',
    subtitle: pick('表示・言語・解析の見せ方をここで直接変更します。', 'Adjust appearance, language and analysis presentation here.'),
  });

  const render = () => {
    s.body.replaceChildren();

    const explain = card(pick('解析の説明', 'Analysis explanation'), {
      subtitle: pick('命令の下に初心者向けの説明を表示するかを選びます。', 'Choose whether plain-language explanations appear under instructions.'),
    });
    const explainRows = list();
    explainRows.append(choiceRow({
      title: pick('命令の解説を表示', 'Show instruction explanations'),
      subtitle: pick('専門用語だけでなく、何をしている命令かも表示します。', 'Also show what each instruction does in plain language.'),
      selected: !!app.prefs.explain,
      onClick: () => { app.setExplain(!app.prefs.explain); render(); },
    }));
    if (app.prefs.explain) {
      for (const [key, ja, en] of [
        ['ja', '日本語の説明', 'Plain-language explanation'],
        ['pseudo', '疑似コード', 'Pseudocode'],
        ['both', '日本語 + 疑似コード', 'Explanation + pseudocode'],
      ]) {
        explainRows.append(choiceRow({
          title: pick(ja, en),
          selected: (app.prefs.noteStyle || 'ja') === key,
          onClick: () => { app.setNoteStyle(key); render(); },
        }));
      }
    }
    explain.body.append(explainRows);
    s.body.append(explain.root);

    const appearance = card(pick('見た目', 'Appearance'));
    const themes = list();
    for (const [key, ja, en] of [
      ['system', '端末に合わせる', 'Follow system'],
      ['light', 'ライト', 'Light'],
      ['dark', 'ダーク', 'Dark'],
    ]) {
      themes.append(choiceRow({
        title: pick(ja, en),
        selected: (app.store.get('theme') || app.prefs.theme || 'system') === key,
        onClick: () => { app.setTheme(key); render(); },
      }));
    }
    appearance.body.append(themes, sectionTitle(pick('文字サイズ', 'Text size')));
    const sizes = h('div', 'ui-setting-chips');
    for (const [key, label] of [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]) {
      sizes.append(uiButton(label, {
        cls: 'ui-secondary-action',
        pressed: (app.prefs.textSize || 'm') === key,
        onClick: () => { app.setTextSize(key); render(); },
      }));
    }
    appearance.body.append(sizes);
    s.body.append(appearance.root);

    const hex = card(pick('16進表示', 'Hex display'));
    const hexRows = list();
    hexRows.append(choiceRow({
      title: 'F6 57 BD A9',
      subtitle: pick('1バイトずつ空けて表示', 'Space-separated bytes'),
      selected: !app.store.get('hexJoined'),
      onClick: () => { app.setHexJoined(false); render(); },
    }));
    hexRows.append(choiceRow({
      title: 'F657BDA9',
      subtitle: pick('続けて表示', 'Joined bytes'),
      selected: !!app.store.get('hexJoined'),
      onClick: () => { app.setHexJoined(true); render(); },
    }));
    hex.body.append(hexRows);
    s.body.append(hex.root);

    const language = card(pick('言語', 'Language'), {
      subtitle: pick('変更すると現在の画面もその場で更新されます。', 'The current screen updates immediately.'),
    });
    const languageRows = list();
    for (const [key, label] of [['ja', '日本語'], ['en', 'English']]) {
      languageRows.append(choiceRow({
        title: label,
        selected: (app.prefs.lang || 'ja') === key,
        onClick: () => { app.setLanguage(key); router.navigate('/settings?lang=' + key, { replace: true }); },
      }));
    }
    language.body.append(languageRows);
    s.body.append(language.root);

    const about = card(pick('このアプリについて', 'About'));
    about.body.append(listRow({
      title: 'Hex',
      subtitle: pick('ブラウザ内で解析します。開いたバイナリを解析のために外部へ送信しません。', 'Analysis runs in the browser; opened binaries are not uploaded for analysis.'),
      meta: 'Capstone ' + (app.capstoneVersion || '5'),
    }));
    about.body.append(uiButton(pick('初回ガイドをもう一度表示する', 'Show onboarding again'), {
      cls: 'ui-secondary-action',
      onClick: () => {
        app.prefs.guideSeen = false;
        app.saveSettings?.();
        toast(pick('次にアプリを開いたとき、初回ガイドを表示します。', 'The onboarding guide will appear next time the app is opened.'));
      },
    }));
    s.body.append(about.root);
  };

  render();
  return { root: s.root };
}

const FAQ = [
  [
    ['最初に何をすればいいですか？', 'Where should I start?'],
    ['まず「調べる」に、知りたいことを普通の言葉で入力してください。文字列・関数・値の流れなど、どの探索手段を使うかはHexが選びます。',
      'Start in Investigate and describe what you want to know. Hex chooses whether to use strings, functions, value flow, or another strategy.'],
  ],
  [
    ['命令のところが「…」のままです', 'Rows show “…”'],
    ['その範囲をまだ読み込んでいます。少し待つか、一度スクロールし直してください。', 'That range is still loading. Wait a moment or scroll again.'],
  ],
  [
    ['「.byte」ばかり並んでいます', 'Everything shows “.byte”'],
    ['その場所はコードではなくデータの可能性があります。全体がそうなら、暗号化された実行ファイルや未対応CPUも確認してください。',
      'That area may be data rather than code. If the whole file looks like this, also check for an encrypted executable or unsupported CPU.'],
  ],
  [
    ['関数名が出てきません', 'No function names'],
    ['配布用アプリでは自作関数名が削除されることがあります。Hexは呼び出し関係・データフロー・メタデータ・既知関数の特徴から正体を絞ります。',
      'Release builds often strip application function names. Hex narrows identity from calls, data flow, metadata, and known-function fingerprints.'],
  ],
  [
    ['ファイルはどこかに送られますか？', 'Is my file uploaded?'],
    ['通常のバイナリ解析はこのブラウザ内で行われます。外部AI機能を明示的に使う場合は、その機能が送る解析用情報だけが別扱いです。',
      'Normal binary analysis runs in this browser. If you explicitly use an external AI feature, only the analysis context used by that feature is handled separately.'],
  ],
  [
    ['大きいファイルでも大丈夫ですか？', 'Can it handle large files?'],
    ['表示と解析は範囲読み込み・仮想リスト・遅延解析を使います。巨大バイナリでも全内容を一度にDOMへ展開しません。',
      'Range reads, virtual lists, and lazy analysis avoid expanding the entire binary into the DOM at once.'],
  ],
];

function renderHelp(app, router) {
  const s = screen(pick('ヘルプ', 'Help'), {
    id: 'help',
    subtitle: pick('迷ったときは、目的から始めるのが最短です。', 'When in doubt, start from the question you want answered.'),
  });

  const start = card(pick('すぐ始める', 'Quick start'));
  const actions = list();
  actions.append(listRow({
    title: pick('知りたいことから調べる', 'Investigate a question'),
    subtitle: pick('HP・経験値・通信など、目的を普通の言葉で入力します。', 'Describe a goal such as HP, experience, or network behavior.'),
    onClick: () => router.navigate('/investigate'),
  }));
  actions.append(listRow({
    title: pick('基礎から学ぶ', 'Learn from the basics'),
    subtitle: pick('ARM64やメモリをゼロから学べます。', 'Learn ARM64 and memory concepts from zero.'),
    onClick: () => router.navigate('/learn'),
  }));
  actions.append(listRow({
    title: pick('用語を調べる', 'Open glossary'),
    subtitle: pick('分からない専門用語を検索します。', 'Search unfamiliar reverse-engineering terms.'),
    onClick: () => router.navigate('/learn?mode=glossary'),
  }));
  actions.append(listRow({
    title: pick('練習用サンプルを開く', 'Open practice sample'),
    subtitle: pick('小さなARM64サンプルで操作を試します。', 'Practice on a small ARM64 sample.'),
    onClick: () => app.openSample(),
  }));
  start.body.append(actions);
  s.body.append(start.root, sectionTitle(pick('よくある質問', 'Frequently asked questions')));

  for (const [q, a] of FAQ) {
    const c = card(pick(q[0], q[1]));
    c.body.append(h('p', 'ui-help-answer', pick(a[0], a[1])));
    s.body.append(c.root);
  }
  return { root: s.root };
}

function runTryAction(app, router, action) {
  switch (action) {
    case 'sample': app.openSample(); break;
    case 'strings': router.navigate('/explorer/strings'); break;
    case 'functions': router.navigate('/explorer/functions'); break;
    case 'sections': router.navigate('/explorer/sections'); break;
    case 'struct': router.navigate('/explorer/data'); break;
    case 'explain':
      app.setExplain(true);
      toast(pick('命令の解説をオンにしました。', 'Instruction explanations are now on.'));
      router.navigate('/code');
      break;
    default: break;
  }
}

function chapterBlock(app, router, block) {
  switch (block.t) {
    case 'p': return h('p', 'ui-learn-paragraph', block.text);
    case 'h': return h('h3', 'ui-learn-heading', block.text);
    case 'code': {
      const pre = h('pre', 'ui-learn-code');
      pre.append(h('code', null, Array.isArray(block.lines) ? block.lines.join('\n') : String(block.lines || '')));
      return pre;
    }
    case 'note': return h('aside', 'ui-learn-note', block.text);
    case 'list': {
      const ul = h('ul', 'ui-learn-list');
      for (const item of block.items || []) ul.append(h('li', null, item));
      return ul;
    }
    case 'term': {
      const wrap = h('div', 'ui-setting-chips');
      for (const id of block.ids || []) {
        const entry = GLOSSARY[id];
        if (!entry) continue;
        wrap.append(uiButton(entry.term, { cls: 'ui-secondary-action', onClick: () => router.navigate('/learn?term=' + encodeURIComponent(id)) }));
      }
      return wrap;
    }
    case 'try': return uiButton(block.text, { cls: 'ui-primary-action', onClick: () => runTryAction(app, router, block.action) });
    default: return null;
  }
}

function renderChapter(app, router, chapter) {
  const index = CHAPTERS.indexOf(chapter);
  const s = screen(pick(`第${index + 1}章`, `Chapter ${index + 1}`) + ' — ' + chapter.title, {
    id: 'learn', subtitle: chapter.subtitle,
  });
  const progress = loadProgress();
  const navTop = h('div', 'ui-learning-nav');
  navTop.append(uiButton(pick('← 一覧', '← Chapters'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/learn') }));
  navTop.append(uiButton(progress[chapter.id] ? pick('未読に戻す', 'Mark unread') : pick('読了にする', 'Mark complete'), {
    cls: 'ui-secondary-action',
    pressed: !!progress[chapter.id],
    onClick: () => {
      const next = loadProgress();
      if (next[chapter.id]) delete next[chapter.id]; else next[chapter.id] = true;
      saveProgress(next);
      router.navigate('/learn?chapter=' + chapter.id + '&v=' + Date.now(), { replace: true });
    },
  }));
  s.body.append(navTop);

  const doc = h('article', 'ui-learning-doc');
  for (const block of chapter.blocks || []) {
    const node = chapterBlock(app, router, block);
    if (node) doc.append(node);
  }
  s.body.append(doc);

  const nav = h('div', 'ui-learning-nav');
  if (index > 0) nav.append(uiButton(pick('← 前の章', '← Previous'), {
    cls: 'ui-secondary-action', onClick: () => router.navigate('/learn?chapter=' + CHAPTERS[index - 1].id),
  }));
  if (index < CHAPTERS.length - 1) nav.append(uiButton(pick('次の章 →', 'Next →'), {
    cls: 'ui-primary-action',
    onClick: () => {
      const next = loadProgress(); next[chapter.id] = true; saveProgress(next);
      router.navigate('/learn?chapter=' + CHAPTERS[index + 1].id);
    },
  }));
  s.body.append(nav);
  return { root: s.root };
}

function renderGlossary(router, selectedTerm) {
  const entry = selectedTerm ? GLOSSARY[selectedTerm] : null;
  const s = screen(pick('用語集', 'Glossary'), {
    id: 'learn', subtitle: pick('解析で出てくる言葉を検索できます。', 'Search terms used throughout the analysis UI.'),
  });
  const top = h('div', 'ui-learning-nav');
  top.append(uiButton(pick('← 学習コース', '← Learning'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/learn') }));
  s.body.append(top);

  if (entry) {
    const term = card(entry.term, { subtitle: entry.read && entry.read !== entry.term ? entry.read : '' });
    if (entry.short) term.body.append(h('strong', 'ui-glossary-short', entry.short));
    for (const p of String(entry.body || '').split('\n\n')) term.body.append(h('p', 'ui-learn-paragraph', p));
    if (entry.related?.length) {
      term.body.append(sectionTitle(pick('関連する用語', 'Related terms')));
      const related = h('div', 'ui-setting-chips');
      for (const id of entry.related) {
        if (!GLOSSARY[id]) continue;
        related.append(uiButton(GLOSSARY[id].term, { cls: 'ui-secondary-action', onClick: () => router.navigate('/learn?term=' + encodeURIComponent(id)) }));
      }
      term.body.append(related);
    }
    s.body.append(term.root);
    return { root: s.root };
  }

  const field = h('input', 'ui-search-field');
  field.type = 'search';
  field.placeholder = pick('用語を検索', 'Search terms');
  field.autocomplete = 'off'; field.autocapitalize = 'off'; field.spellcheck = false;
  const results = list();
  const render = () => {
    results.replaceChildren();
    const ids = searchGlossary(field.value);
    if (!ids.length) {
      results.append(emptyState(pick('見つかりません', 'Nothing found'), pick('別の言葉で検索してください。', 'Try another term.')));
      return;
    }
    for (const id of ids) {
      const item = GLOSSARY[id];
      results.append(listRow({ title: item.term, subtitle: item.short, onClick: () => router.navigate('/learn?term=' + encodeURIComponent(id)) }));
    }
  };
  field.addEventListener('input', render);
  s.body.append(field, results);
  render();
  return { root: s.root, focus: () => field.focus() };
}

function renderLearn(app, router, route) {
  const term = route?.query?.get('term');
  if (term) return renderGlossary(router, term);
  if (route?.query?.get('mode') === 'glossary') return renderGlossary(router, null);
  const chapterId = route?.query?.get('chapter');
  const chapter = chapterId ? chapterById(chapterId) : null;
  if (chapter) return renderChapter(app, router, chapter);

  const s = screen(pick('学ぶ', 'Learn'), {
    id: 'learn', subtitle: pick('機械語を初めて見るところから、実際の解析まで段階的に進みます。', 'Progress from first principles to real binary analysis.'),
  });
  const progress = loadProgress();
  const done = CHAPTERS.filter((c) => progress[c.id]).length;
  const progressCard = card(pick('進み具合', 'Progress'), {
    subtitle: pick(`${CHAPTERS.length}章中 ${done}章を読了`, `${done} of ${CHAPTERS.length} chapters complete`),
  });
  progressCard.body.append(uiButton(pick('用語集を開く', 'Open glossary'), { cls: 'ui-secondary-action', onClick: () => router.navigate('/learn?mode=glossary') }));
  if (done) progressCard.body.append(uiButton(pick('進捗をリセット', 'Reset progress'), {
    cls: 'ui-secondary-action', onClick: () => { saveProgress({}); router.navigate('/learn?reset=' + Date.now(), { replace: true }); },
  }));
  s.body.append(progressCard.root);

  const rows = list();
  CHAPTERS.forEach((chapter, index) => rows.append(listRow({
    title: pick(`第${index + 1}章`, `Chapter ${index + 1}`) + '　' + chapter.title,
    subtitle: chapter.subtitle,
    meta: progress[chapter.id] ? '✓' : '',
    onClick: () => router.navigate('/learn?chapter=' + chapter.id),
  })));
  s.body.append(rows);
  return { root: s.root };
}

export function renderSecondaryRoute(app, router, route) {
  switch (route?.route?.id) {
    case 'settings': return renderSettings(app, router);
    case 'help': return renderHelp(app, router);
    case 'learn': return renderLearn(app, router, route);
    default: throw new Error('Unsupported secondary route: ' + String(route?.route?.id));
  }
}

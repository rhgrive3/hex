import { Sheet, el, button, list, tapRow, toast, alertDialog, userError, noteBox, codeBlock } from '../../ui.js';
import { addrHex, sizeText } from '../../format.js';
import { showDecompiler, showCfg, showCallGraphPanel } from '../../tools.js';
import { functionViews, openFunctionView } from '../next-views.js';

const COMPLETENESS_JA = Object.freeze({
  complete:'完全',
  partial:'一部',
  truncated:'上限まで',
  unsupported:'未対応',
});

function functionName(app, address) {
  return app?.symbols?.nameAt?.(address)
    ?? app?.symbols?.label?.(address)
    ?? `sub_${BigInt(address).toString(16).toUpperCase()}`;
}

function stale(error) {
  return error?.name === 'AnalysisSnapshotStaleError'
    || error?.code === 'ANALYSIS_SNAPSHOT_STALE';
}

async function withFreshSnapshot(app, operation, options = {}) {
  const api = app?.analysisQueries;
  if (!api) throw new Error('AnalysisQueryAPI is unavailable');
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await api.snapshot(options);
    try {
      return await operation(api, snapshot);
    } catch (error) {
      last = error;
      if (!stale(error) || attempt > 0) throw error;
    }
  }
  throw last ?? new Error('analysis-query-retry-exhausted');
}

async function analysisBundle(app, functionId) {
  return withFreshSnapshot(app, async (api, snapshot) => {
    const fn = await api.function(snapshot, functionId);
    if (fn?.value == null) return { snapshot, fn, decompile:null, cfg:null };
    const [decompile, cfg] = await Promise.all([
      api.decompile(snapshot, functionId),
      api.cfg(snapshot, functionId),
    ]);
    return { snapshot, fn, decompile, cfg };
  });
}

async function functionPage(app, text, signal) {
  return withFreshSnapshot(app, (api, snapshot) => api.functions(
    snapshot,
    text ? { text } : {},
    { offset:0, limit:600 },
    { signal },
  ), { signal });
}

function productRouter() {
  return (typeof window !== 'undefined' && window.__hexUi?.router) || null;
}

function summaryLegacyOpeners(app) {
  return {
    decompiler:(address) => showDecompiler(app, BigInt(address)),
    cfg:(address) => showCfg(app, BigInt(address)),
    callGraph:(address) => showCallGraphPanel(app, BigInt(address)),
    code:(address) => app.goToFunction(BigInt(address)),
  };
}

function summaryNextViews(app, sheet, address) {
  const views = functionViews({
    address,
    capability:{ canDisassemble:app.store?.get?.('canDisassemble') !== false },
    exclude:['report'],
    primary:'pseudocode',
    ja:true,
  });
  if (!views.length) return null;
  const root = el('section', 'next-views');
  root.append(el('h4', 'sec-title', 'この関数を別の形で見る'));
  const bar = el('div', 'action-bar');
  const legacy = summaryLegacyOpeners(app);
  for (const view of views) {
    const control = button('', 'action-btn' + (view.primary ? ' strong' : ''), () => {
      const opened = openFunctionView(view, { router:productRouter(), legacy });
      if (opened) sheet.close();
      else toast('この形では開けませんでした。');
    });
    control.replaceChildren(
      el('span', 'action-label', view.label),
      el('span', 'action-hint', view.hint),
    );
    if (!view.available) {
      control.disabled = true;
      control.classList.add('is-disabled');
      control.title = view.reason;
      control.querySelector('.action-hint').textContent = view.reason;
    }
    bar.append(control);
  }
  root.append(bar);
  return root;
}

export function showFunctions(app) {
  const region = app.store.get('currentRegion');
  if (!region) { toast('先にファイルを開いてください。'); return; }
  const sheet = new Sheet('関数');
  const status = el('div', 'hint', '関数を確認しています…');
  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.placeholder = '名前またはアドレスで検索';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(input);
  const results = list();
  sheet.body.append(field, status, results);

  let sequence = 0;
  let controller = null;
  const render = async () => {
    const current = ++sequence;
    controller?.abort();
    controller = new AbortController();
    const text = input.value.trim();
    status.textContent = '関数を確認しています…';
    try {
      const page = await functionPage(app, text, controller.signal);
      if (current !== sequence) return;
      results.replaceChildren();
      if (page?.completeness === 'unsupported' || !Array.isArray(page?.value)) {
        const reason = page?.status?.reason ? `（${page.status.reason}）` : '';
        status.textContent = `関数一覧は現在の解析経路では利用できません${reason}。`;
        results.append(tapRow('関数一覧を作れませんでした', { disabled:true }));
        return;
      }
      for (const item of page.value) {
        const address = item.address ?? item.addr ?? null;
        if (address == null) continue;
        const addr = BigInt(address);
        const details = [addrHex(addr)];
        const size = item.size == null ? null : BigInt(item.size);
        if (size != null && size > 0n) details.push(sizeText(size));
        results.append(tapRow(item.name || '名前のない関数', {
          sub:details.join('  ·  '),
          onTap:() => { sheet.close(); app.goToFunction(addr); },
        }));
      }
      if (!page.value.length) results.append(tapRow('見つかりませんでした', { disabled:true }));
      const total = Number(page.page?.total ?? page.value.length);
      const returned = Number(page.page?.returned ?? page.value.length);
      const completeness = COMPLETENESS_JA[page.completeness] ?? page.completeness;
      status.textContent = total > returned
        ? `${total.toLocaleString()} 個中 ${returned.toLocaleString()} 個を表示 · ${completeness}`
        : `${total.toLocaleString()} 個 · ${completeness}`;
    } catch (error) {
      if (error?.name === 'AbortError' || current !== sequence) return;
      status.textContent = '';
      alertDialog('関数を調べられませんでした', userError(error));
    }
  };
  input.addEventListener('input', () => { void render(); });
  void render();
}

export function showFunctionSummary(app, row) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const address = app.viewer?.rowAddress?.(row) ?? null;
  if (address == null) {
    toast('この行のアドレスを取得できませんでした。');
    return;
  }

  const sheet = new Sheet('関数の要約');
  const status = el('div', 'hint', '同じ解析スナップショットから要約を作っています…');
  sheet.body.append(status);

  void (async () => {
    try {
      const known = app.symbols?.functionAt?.(address) ?? null;
      const target = known?.start ?? BigInt(address);
      const bundle = await analysisBundle(app, target);
      status.remove();

      const fn = bundle.fn;
      if (!fn || fn.value == null || fn.completeness === 'unsupported') {
        sheet.body.append(noteBox(`この関数は現在の解析経路では扱えません${fn?.status?.reason ? `（${fn.status.reason}）` : ''}。`));
        return;
      }

      const value = fn.value;
      const architecture = value.architectureId
        ?? app.store.get('architecture')
        ?? app.store.get('capability')?.architecture
        ?? 'unknown';
      const abi = value.abiId ?? null;
      const head = el('div', 'fn-head');
      head.append(el('div', 'fn-name', functionName(app, target)));
      head.append(el('div', 'fn-range mono', addrHex(target)));
      sheet.body.append(head);

      const facts = list();
      facts.append(tapRow('解析状態', {
        sub:`${COMPLETENESS_JA[fn.completeness] ?? fn.completeness} · ${architecture}${abi ? ` · ${abi}` : ''}`,
        disabled:true,
      }));
      if (known?.end != null) {
        facts.append(tapRow('関数の範囲', {
          sub:`${addrHex(known.start)} – ${addrHex(known.end)} · ${sizeText(known.end - known.start)}`,
          disabled:true,
        }));
      }
      if (fn.status?.reason) facts.append(tapRow('解析上の注意', { sub:String(fn.status.reason), disabled:true }));
      sheet.body.append(facts);

      const decompiled = bundle.decompile?.value ?? value.decompiler ?? null;
      if (decompiled) {
        if (decompiled.signature) sheet.body.append(el('div', 'code-sig mono', decompiled.signature));
        if (decompiled.summary) sheet.body.append(el('div', 'hint', decompiled.summary));
        const preview = String(decompiled.pseudocode || '')
          .split('\n').slice(0, 24).join('\n').trim();
        if (preview) sheet.body.append(codeBlock(preview));
      }

      const cfg = bundle.cfg?.value ?? value.pipeline?.cfg ?? null;
      if (Array.isArray(cfg?.blocks)) {
        const edgeCount = cfg.blocks.reduce((sum, block) => sum + (block.successors?.length || 0), 0);
        sheet.body.append(el('div', 'hint', `制御フロー: ${cfg.blocks.length} blocks · ${edgeCount} edges`));
      }

      const views = summaryNextViews(app, sheet, target);
      if (views) sheet.body.append(views);
    } catch (error) {
      status.textContent = '';
      alertDialog('解析できませんでした', userError(error));
    }
  })();
}

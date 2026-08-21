import { Sheet, el, button, list, groupRow, tapRow, toast, alertDialog, userError } from "../../ui.js";
import { addrHex, addrText, parseAddress, parseHexPattern } from "../../format.js";
import { t } from "../../i18n.js";

export function showJump(app) {
  const region = app.store.get("currentRegion");
  if (!region) return;
  const sheet = new Sheet(t("jump.title"));

  const field = el("div", "field");
  const input = el("input");
  input.type = "text";
  input.inputMode = "text";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "0x" + addrText(region.vmAddr);
  field.append(input, button(t("btn.go"), "chip", go));
  sheet.body.append(field);

  sheet.body.append(el("div", "hint", t("jump.hint", {
    from: addrHex(region.vmAddr),
    to: addrHex(region.vmAddr + region.size),
  })));

  const quick = list();
  quick.append(groupRow(t("jump.group")));
  quick.append(tapRow(t("jump.sectionStart"), {
    right: addrHex(region.vmAddr),
    onTap: () => { sheet.close(); app.goToAddress(region.vmAddr); },
  }));
  quick.append(tapRow(t("jump.sectionEnd"), {
    right: addrHex(region.vmAddr + region.size),
    onTap: () => { sheet.close(); app.viewer.goToRow(app.viewer.totalRows - 1, "top"); },
  }));
  const slice = app.currentSlice();
  if (slice && slice.info && slice.info.entry != null) {
    quick.append(tapRow(t("jump.entry"), {
      right: addrHex(slice.info.entry),
      onTap: () => { sheet.close(); app.goToAddress(slice.info.entry, { announce: true }); },
    }));
  }
  sheet.body.append(quick);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  setTimeout(() => input.focus(), 50);

  function go() {
    const v = parseAddress(input.value);
    if (v == null) { toast(t("jump.invalid")); return; }
    sheet.close();
    app.goToAddress(v, { announce: true });
  }
}

export function showSearch(app) {
  const region = app.store.get("currentRegion");
  if (!region) return;
  const sheet = new Sheet(t("search.title"), {
    onClose: () => { app.backend.cancelSearch(); app.backend.onSearchProgress = null; },
  });

  let kind = app.store.get("searchKind") || "asm";

  const chips = el("div", "chips");
  const defs = [
    ["asm", t("search.kind.asm")],
    ["text", t("search.kind.text")],
    ["hex", t("search.kind.hex")],
    ["num", t("search.kind.num")],
    ["addr", t("search.kind.addr")],
  ];
  const chipEls = new Map();
  for (const [k, label] of defs) {
    const c = button(label, "chip", () => setKind(k));
    c.setAttribute("aria-pressed", String(k === kind));
    chipEls.set(k, c);
    chips.append(c);
  }

  const field = el("div", "field");
  const input = el("input");
  input.type = "search";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = app.store.get("searchQuery") || "";
  const goBtn = button(t("btn.find"), "chip", () => (running ? stop() : run()));
  field.append(input, goBtn);

  const bar = el("div", "progress");
  const fill = el("i");
  bar.append(fill);

  const status = el("div", "hint", "");
  const results = list();

  sheet.body.append(chips, field, bar, status, results);
  setKind(kind);
  setTimeout(() => input.focus(), 50);

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  let running = false;

  function setKind(k) {
    kind = k;
    app.store.set({ searchKind: k });
    for (const [key, c] of chipEls) c.setAttribute("aria-pressed", String(key === k));
    input.placeholder = t("search.ph." + k);
    status.textContent = t("search.help." + k, { region: region.name });
  }

  function run() {
    const q = input.value.trim();
    app.store.set({ searchQuery: q });
    if (!q) { toast(t("search.needQuery")); return; }

    if (kind === "addr") {
      const v = parseAddress(q);
      if (v == null) { toast(t("search.badAddr")); return; }
      sheet.close();
      app.goToAddress(v, { announce: true });
      return;
    }
    if (running) app.backend.cancelSearch(running);

    results.replaceChildren();
    fill.style.width = "0%";
    status.textContent = t("search.searching");
    running = true;
    goBtn.textContent = t("btn.stop");

    const params = { regionId: region.id, kind, from: 0 };
    if (kind === "hex") {
      const pat = parseHexPattern(q);
      if (!pat) { toast(t("search.badHex")); running = false; goBtn.textContent = t("btn.find"); return; }
      params.hex = pat;
    } else if (kind === "num") {
      const hexText = numberPattern(q);
      const pat = hexText ? parseHexPattern(hexText) : null;
      if (!pat) { toast(t("search.badNum")); running = false; goBtn.textContent = t("btn.find"); return; }
      params.kind = "hex";
      params.hex = pat;
    } else {
      params.query = q;
    }

    const progress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + "%";
      status.textContent = t("search.searchingN", { n: p.hits });
    };

    const request = app.backend.search(params, progress);
    running = request;
    request.then((res) => {
      running = false;
      goBtn.textContent = t("btn.find");
      fill.style.width = "100%";
      if (res.cancelled) status.textContent = t("search.stopped", { n: res.results.length });
      else if (!res.results.length) status.textContent = t("search.none", { region: region.name });
      else {
        status.textContent = t("search.count", { n: res.results.length }) +
          (res.capped ? t("search.capped", { n: res.results.length }) : "");
      }
      render(res.results);
    }).catch((err) => {
      running = false;
      goBtn.textContent = t("btn.find");
      status.textContent = "";
      alertDialog(t("search.failed"), userError(err));
    });
  }

  function stop() {
    app.backend.cancelSearch(running);
    running = false;
    goBtn.textContent = t("btn.find");
    status.textContent = t("search.stopped", { n: 0 });
  }

  const PAGE = 150;

  function render(items) {
    results.replaceChildren();
    let shown = 0;
    const more = tapRow(t("search.more"), { onTap: () => page() });

    const page = () => {
      more.remove();
      const frag = document.createDocumentFragment();
      const end = Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) {
        const it = items[shown];
        frag.append(tapRow(addrText(it.addr), {
          sub: it.text,
          onTap: () => {
            sheet.close();
            app.viewer.goToRow(it.row, "third");
            app.viewer.mark(it.row);
            app.viewer.select(it.row, false);
            app.store.set({ selectedRow: it.row });
          },
        }));
      }
      results.append(frag);
      if (shown < items.length) {
        more.replaceChildren();
        more.append(el("div", null, t("search.showMore", { n: Math.min(PAGE, items.length - shown) })));
        results.append(more);
      }
    };
    if (items.length) page();
  }
}

function numberPattern(text) {
  const t2 = text.trim().replace(/[_,]/g, "");
  let v;
  try {
    if (/^-?0x[0-9a-f]+$/i.test(t2)) v = BigInt(t2.replace("-0x", "0x")) * (t2[0] === "-" ? -1n : 1n);
    else if (/^-?\d+$/.test(t2)) v = BigInt(t2);
    else return null;
  } catch { return null; }
  const wide = v < -0x80000000n || v > 0xFFFFFFFFn;
  const bytes = wide ? 8 : 4;
  const u = BigInt.asUintN(bytes * 8, v);
  const out = [];
  for (let i = 0; i < bytes; i++) out.push(Number((u >> BigInt(i * 8)) & 0xffn).toString(16).padStart(2, "0"));
  return out.join(" ");
}

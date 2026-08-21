import { Sheet, el, list, groupRow, kvRow, tapRow, noteBox, para, toast } from "../../ui.js";
import { addrHex, sizeText } from "../../format.js";
import { t, isJa, pick } from "../../i18n.js";
import { productDescriptor } from "../../platform/product-descriptor.js";

export function showFileInfo(app) {
  const info = app.store.get("fileInfo");
  if (!info) return;
  const sheet = new Sheet(t("file.title"));
  const ul = list();

  ul.append(groupRow(t("file.group.file")));
  ul.append(kvRow(t("file.name"), info.name));
  ul.append(kvRow(t("file.size"), sizeText(info.size) + " (" + info.size.toString() + " bytes)"));
  ul.append(kvRow(t("file.format"), info.format));

  const slice = app.currentSlice();
  if (slice && slice.info) {
    const m = slice.info;
    const descriptor = productDescriptor(info, slice);
    if (descriptor.formatId === "macho") {
      ul.append(groupRow(t("file.group.macho")));
      ul.append(kvRow(t("file.type"), m.filetypeName + (m.filetypeName === "MH_EXECUTE"
      ? pick("（アプリ本体）", " (an application)")
      : m.filetypeName === "MH_DYLIB" ? pick("（ライブラリ）", " (a library)") : "")));
    ul.append(kvRow(t("file.cpu"), m.cpu));
    ul.append(kvRow(t("file.cpuSub"), m.cpuSub));
    ul.append(kvRow(t("file.magic"), m.magic));
    ul.append(kvRow(t("file.flags"), "0x" + (m.flags >>> 0).toString(16).toUpperCase()));
    if (m.platform) ul.append(kvRow(t("file.platform"), m.platform + (m.minos ? " " + m.minos : ""), m.sdk ? "SDK " + m.sdk : null));
    if (m.uuid) ul.append(kvRow(t("file.uuid"), m.uuid));
    ul.append(kvRow(t("file.loadCommands"), String(m.ncmds) + " (" + sizeText(m.sizeofcmds) + ")"));
      ul.append(kvRow(t("file.codeSignature"), m.hasCodeSignature ? t("file.present") : t("file.none")));
      if (slice.offset > 0n) ul.append(kvRow(t("file.sliceOffset"), addrHex(slice.offset)));
    } else {
      const fm = descriptor.formatMetadata || {};
      ul.append(groupRow(pick("バイナリ形式", "Binary format")));
      if (fm.arch || m.cpu) ul.append(kvRow(t("file.cpu"), String(fm.arch || m.cpu)));
      if (fm.bits != null) ul.append(kvRow(pick("ビット幅", "Bits"), String(fm.bits)));
      if (fm.endian) ul.append(kvRow(pick("エンディアン", "Endianness"), String(fm.endian)));
      if (fm.platform) ul.append(kvRow(t("file.platform"), String(fm.platform)));
    }

    const entry = descriptor.formatMetadata?.entrypoint ?? m.entry;
    if (entry != null) {
      ul.append(tapRow(t("file.entry"), {
        sub: pick("プログラムが最初に実行する場所です", "where execution begins"),
        right: addrHex(entry),
        onTap: () => { sheet.close(); app.goToAddress(entry, { announce: true }); },
      }));
    }
    if (descriptor.formatId === "macho" && m.encryption) {
      ul.append(kvRow(t("file.encryption"),
        m.encrypted ? "cryptid " + m.encryption.cryptid + pick("（暗号化されている）", " (encrypted)") : "cryptid 0"));
      if (m.encrypted) {
        const li = el("li");
        li.append(el("span", "sub warn", pick(
          "この範囲（ファイル内 " + addrHex(m.encryption.cryptoff) + " 〜 " +
            addrHex(m.encryption.cryptoff + m.encryption.cryptsize) + "）は暗号化されたままです。" +
            "復号するまで、意味のある命令にはなりません。",
          "This range is still encrypted and will not disassemble into meaningful code.")));
        ul.append(li);
      }
    }

    /* 名前の情報 */
    const sym = app.symbols;
    ul.append(groupRow(t("file.group.symbols")));
    ul.append(kvRow(t("file.symbolCount"), sym.symbolCount.toLocaleString()));
    ul.append(kvRow(t("file.functionCount"),
      sym.functionCount.toLocaleString() + (sym.guessed ? pick("（推測）", " (inferred)") : "")));
    if (!sym.symbolCount) {
      const li = el("li");
      li.append(el("span", "sub", t("functions.hintNoSymbols")));
      ul.append(li);
    }

    /* リンクしているライブラリ */
    if (descriptor.dependencies.length) {
      ul.append(groupRow(t("file.dylibs") + "  (" + descriptor.dependencies.length + ")"));
      const li0 = el("li");
      li0.append(el("span", "sub", pick(
        "このアプリが借りている外部の部品です。何を使っているか（通信・暗号・位置情報…）の手がかりになります。",
        "The external components this binary borrows.")));
      ul.append(li0);
      for (const d of descriptor.dependencies) {
        const short = d.split("/").pop();
        ul.append(kvRow(short, "", d));
      }
    }

    const codeRegions = app.store.get("regions").filter((r) => r.exec && r.size > 0n);
    if (codeRegions.length) {
      ul.append(groupRow(t("file.group.code")));
      for (const r of codeRegions) {
        ul.append(tapRow(r.name, {
          sub: addrHex(r.vmAddr) + " – " + addrHex(r.vmAddr + r.size) + "  ·  " + sizeText(r.size),
          onTap: () => { sheet.close(); app.selectRegion(r); },
        }));
      }
    }
  } else {
    const li = el("li");
    li.append(el("span", "sub", t("file.rawOnly")));
    ul.append(li);
  }

  if (info.warnings && info.warnings.length) {
    ul.append(groupRow(t("file.group.notes")));
    for (const w of info.warnings) {
      const li = el("li");
      li.append(el("span", "sub warn", w));
      ul.append(li);
    }
  }

  sheet.body.append(ul);
}

export const SECTION_HINTS = {
  __text: ["機械語そのもの。ここが本体です", "the machine code itself"],
  __stubs: ["外部ライブラリの関数へ中継する場所", "jump pads into external libraries"],
  __auth_stubs: ["外部ライブラリへの中継（署名つき）", "authenticated jump pads"],
  __cstring: ["文字列（\"Hello\" など）", "string literals"],
  __const: ["書き換わらない定数", "read-only constants"],
  __data: ["書き換わる変数", "writable variables"],
  __bss: ["0 で始まる変数（ファイルには入っていない）", "zero-initialised variables"],
  __common: ["0 で始まる共有変数", "zero-initialised common variables"],
  __got: ["外部関数のアドレスを入れる箱", "addresses of external functions"],
  __la_symbol_ptr: ["外部関数のアドレス（遅延解決）", "lazily bound external addresses"],
  __nl_symbol_ptr: ["外部関数のアドレス（起動時に解決）", "eagerly bound external addresses"],
  __objc_methname: ["Objective-C のメソッド名", "Objective-C method names"],
  __objc_classname: ["Objective-C のクラス名", "Objective-C class names"],
  __objc_selrefs: ["呼ばれるメソッド名への参照", "references to selectors"],
  __objc_classlist: ["クラスの一覧", "the list of classes"],
  __objc_const: ["Objective-C のクラス定義", "Objective-C class definitions"],
  __swift5_types: ["Swift の型情報", "Swift type metadata"],
  __cfstring: ["NSString / CFString の文字列", "Foundation string objects"],
  __unwind_info: ["例外処理のための表", "exception unwinding tables"],
  __eh_frame: ["例外処理のための表", "exception handling frames"],
};

export function sectionHint(name) {
  const h = SECTION_HINTS[name];
  return h ? pick(h[0], h[1]) : "";
}

export function showSections(app) {
  const info = app.store.get("fileInfo");
  if (!info) return;
  const sheet = new Sheet(t("sections.title"));
  const ul = list();
  const current = app.store.get("currentRegion");

  const hint = el("li");
  hint.append(el("span", "sub", t("sections.hint")));
  ul.append(hint);

  if (info.slices.length > 1) {
    ul.append(groupRow(t("sections.arch")));
    info.slices.forEach((s, i) => {
      ul.append(tapRow(s.name, {
        sub: s.error ? s.error : sizeText(s.size) + " at " + addrHex(s.offset),
        right: i === app.store.get("sliceIndex") ? "✓" : "",
        disabled: !!s.error,
        onTap: () => { sheet.close(); app.selectSlice(i); },
      }));
    });
  }

  const slice = app.currentSlice();
  if (slice) {
    const descriptor = productDescriptor(info, slice);
    const grouped = new Map();
    for (const region of descriptor.regions || []) {
      const key = region.segment || pick("セクション", "Sections");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(region);
    }
    for (const [group, rows] of grouped) {
      ul.append(groupRow(group));
      for (const region of rows) {
        const disabled = !region || region.size === 0n;
        const extra = [addrHex(region.vmAddr) + " – " + addrHex(region.vmAddr + region.size), sizeText(region.size)];
        if (region.zerofill) extra.push(t("sections.zerofill"));
        if (region.truncated) extra.push(t("sections.truncated"));
        const hintText = sectionHint(region.section || region.name);
        ul.append(tapRow(region.section || region.name, {
          indent: true,
          sub: (hintText ? hintText + "\n" : "") + extra.join("  ·  "),
          tag: region.exec ? t("sections.tagCode") : (region.zerofill ? "bss" : ""),
          tagClass: region.exec ? "exec" : "",
          right: current && current.id === region.id ? "✓" : "",
          disabled,
          onTap: () => { sheet.close(); app.selectRegion(region); },
        }));
      }
    }
  }

  ul.append(groupRow(t("sections.raw")));
  ul.append(tapRow(t("sections.wholeFile"), {
    sub: pick("ファイルの先頭から末尾まで、そのままのバイト列", "every byte of the file, unstructured") +
      "\n0 – " + addrHex(info.size) + "  ·  " + sizeText(info.size),
    right: current && current.id === "raw" ? "✓" : "",
    onTap: () => { sheet.close(); app.selectRegion(info.raw); },
  }));

  sheet.body.append(ul);
}

export function showStructure(app) {
  const info = app.store.get("fileInfo");
  if (!info) { toast(t("err.openFirst")); return; }
  const slice = app.currentSlice();
  const sheet = new Sheet(t("struct.title"));
  const body = sheet.body;

  body.append(para(t("struct.hint")));

  if (!slice || !slice.info) {
    body.append(noteBox(t("file.rawOnly")));
    return;
  }
  const m = slice.info;
  const base = slice.offset;
  const ul = list();

  /* ヘッダ */
  ul.append(groupRow("1. " + t("struct.header")));
  const headLi = el("li");
  headLi.append(el("span", "sub", t("struct.headerSub")));
  ul.append(headLi);
  const fields = [
    ["magic", 0, 4, m.magic, t("struct.field.magic")],
    ["cputype", 4, 4, m.cpu, t("struct.field.cputype")],
    ["filetype", 12, 4, m.filetypeName, t("struct.field.filetype")],
    ["ncmds", 16, 4, String(m.ncmds), t("struct.field.ncmds")],
    ["sizeofcmds", 20, 4, sizeText(m.sizeofcmds), t("struct.field.sizeofcmds")],
    ["flags", 24, 4, "0x" + (m.flags >>> 0).toString(16).toUpperCase(), t("struct.field.flags")],
  ];
  for (const [name, off, len, value, note] of fields) {
    ul.append(tapRow(name, {
      indent: true,
      sub: note + "\n" + t("struct.at", { offset: addrHex(base + BigInt(off)) }) +
           "  ·  " + t("struct.bytes", { n: len }),
      right: value,
      onTap: () => { sheet.close(); app.goToFileOffset(base + BigInt(off)); },
    }));
  }

  /* ロードコマンド */
  ul.append(groupRow("2. " + t("struct.commands")));
  const cmdLi = el("li");
  cmdLi.append(el("span", "sub", t("struct.commandsSub", { n: m.ncmds })));
  ul.append(cmdLi);
  const counts = new Map();
  for (const c of m.commands) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  for (const [name, n] of counts) {
    ul.append(kvRow(name, n > 1 ? "× " + n : "1", commandHint(name)));
  }

  /* セグメント */
  ul.append(groupRow("3. " + t("struct.segments")));
  for (const seg of m.segments) {
    const prot = protText(seg.initprot);
    ul.append(tapRow(seg.name, {
      sub: prot + "\n" + addrHex(seg.vmaddr) + " – " + addrHex(seg.vmaddr + seg.vmsize) +
        "  ·  " + sizeText(seg.vmsize) +
        pick("  ·  ファイル内 ", "  ·  file ") + addrHex(base + seg.fileoff),
      right: seg.sections.length ? seg.sections.length + (isJa() ? " 区画" : " sections") : "",
      onTap: () => { sheet.close(); app.goToAddress(seg.vmaddr, { announce: true }); },
    }));
  }

  sheet.body.append(ul);
}

function protText(p) {
  const parts = [];
  if (p & 1) parts.push(pick("読める", "read"));
  if (p & 2) parts.push(pick("書ける", "write"));
  if (p & 4) parts.push(pick("実行できる", "execute"));
  if (!parts.length) return pick("何もできない（わざと空けてある）", "no access (deliberately empty)");
  return parts.join(pick("・", " / "));
}

const CMD_HINTS = {
  LC_SEGMENT_64: ["メモリにこの塊を載せる", "map this block into memory"],
  LC_SYMTAB: ["名前の一覧の場所", "where the symbol table lives"],
  LC_DYSYMTAB: ["外部の名前の管理表", "dynamic symbol bookkeeping"],
  LC_LOAD_DYLIB: ["このライブラリを繋ぐ", "link against this library"],
  LC_LOAD_DYLINKER: ["起動を担当するプログラム", "which program sets everything up"],
  LC_MAIN: ["ここから実行を始める", "start executing here"],
  LC_UUID: ["このビルドを識別する番号", "a unique id for this build"],
  LC_CODE_SIGNATURE: ["改ざんされていないことの証明", "proof the file was not tampered with"],
  LC_FUNCTION_STARTS: ["関数の切れ目の一覧", "where each function begins"],
  LC_BUILD_VERSION: ["どの OS 向けに作られたか", "which OS this was built for"],
  LC_ENCRYPTION_INFO_64: ["暗号化されている範囲", "which part is encrypted"],
  LC_DYLD_CHAINED_FIXUPS: ["起動時に埋めるアドレスの表", "addresses dyld fills in at launch"],
  LC_DYLD_EXPORTS_TRIE: ["外部に公開する名前の表", "names this image exports"],
  LC_RPATH: ["ライブラリを探す場所", "where to look for libraries"],
};
function commandHint(name) {
  const h = CMD_HINTS[name];
  return h ? pick(h[0], h[1]) : null;
}

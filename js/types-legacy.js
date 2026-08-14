/*
 * 型（データの種類）。
 *
 * バイナリの中では、どのバイトも同じ「ただの数」です。0x41 が文字の 'A' なのか、
 * 数の 65 なのか、他の場所を指す矢印なのかは書いてありません。
 * それでも命令の使い方から、かなりの確度で決められます:
 *
 *   ldrb w0, [x1]      … 1 バイトだけ読んでいる  → 8 ビットの値
 *   ldrsw x0, [x1]     … 4 バイトを符号つきで    → int32
 *   ldr  x0, [x1]      … 8 バイト                → 64 ビット、たいていポインタ
 *   その x0 を [x0, #8] のベースに使った → やはりポインタ
 *   fmov / fadd で触った                 → 小数
 *
 * ここは「そう決めた根拠」も一緒に返します。断定できないものは 'unknown'。
 *
 * 構造体（struct）も扱います。IDA でいう Structures ウィンドウで、
 *   1. 命令の使い方から自動で組み立てる  → recoverStruct()
 *   2. 自分で作って名前を付ける          → TypeStore
 * の両方ができます。
 */

/* ── 基本の型 ───────────────────────────────────────────── */

export const BASIC_TYPES = [
  { name: 'int8',    size: 1, signed: true,  ja: '1 バイトの整数（符号あり）' },
  { name: 'uint8',   size: 1, signed: false, ja: '1 バイトの整数（0〜255）' },
  { name: 'int16',   size: 2, signed: true,  ja: '2 バイトの整数' },
  { name: 'uint16',  size: 2, signed: false, ja: '2 バイトの整数（正のみ）' },
  { name: 'int32',   size: 4, signed: true,  ja: '4 バイトの整数（ふつうの int）' },
  { name: 'uint32',  size: 4, signed: false, ja: '4 バイトの整数（正のみ）' },
  { name: 'int64',   size: 8, signed: true,  ja: '8 バイトの整数（long）' },
  { name: 'uint64',  size: 8, signed: false, ja: '8 バイトの整数（正のみ）' },
  { name: 'float',   size: 4, float: true,   ja: '4 バイトの小数' },
  { name: 'double',  size: 8, float: true,   ja: '8 バイトの小数' },
  { name: 'bool',    size: 1, ja: '真偽（0 か 1）' },
  { name: 'char *',  size: 8, pointer: true, ja: '文字列の先頭を指す矢印' },
  { name: 'void *',  size: 8, pointer: true, ja: '何かを指す矢印' },
  { name: 'id',      size: 8, pointer: true, ja: 'Objective-C のオブジェクト' },
  { name: 'SEL',     size: 8, pointer: true, ja: 'Objective-C のメソッド名' },
];

const BY_NAME = new Map(BASIC_TYPES.map((t) => [t.name, t]));

/** 型の名前 → 大きさ（バイト）。分からなければ 8（ポインタ相当）。 */
export function sizeOfType(name) {
  const t = BY_NAME.get(name);
  if (t) return t.size;
  if (/\*$/.test(name || '')) return 8;
  return 8;
}

/** 型の名前を日本語で言い換える。 */
export function typeJa(name) {
  const t = BY_NAME.get(name);
  if (t) return t.ja;
  if (/\*$/.test(name || '')) return (name.replace(/\s*\*$/, '')) + ' を指す矢印';
  return name || '不明';
}

/** 読み書きの幅と符号から、いちばん素直な型を選ぶ。 */
export function typeFromAccess(bytes, { signed = false, float = false, pointer = false } = {}) {
  if (pointer) return 'void *';
  if (float) return bytes === 4 ? 'float' : 'double';
  const n = bytes || 8;
  if (n === 1) return signed ? 'int8' : 'uint8';
  if (n === 2) return signed ? 'int16' : 'uint16';
  if (n === 4) return signed ? 'int32' : 'uint32';
  return signed ? 'int64' : 'uint64';
}

/** ニーモニックから読み書きの幅・符号・小数かどうかを読み取る。 */
export function accessShape(mnemonic) {
  const b = (mnemonic || '').toLowerCase();
  if (/^(ldrsb|ldursb)/.test(b)) return { bytes: 1, signed: true };
  if (/^(ldrsh|ldursh)/.test(b)) return { bytes: 2, signed: true };
  if (/^(ldrsw|ldursw)/.test(b)) return { bytes: 4, signed: true };
  if (/^(ldrb|strb|ldurb|sturb)/.test(b)) return { bytes: 1, signed: false };
  if (/^(ldrh|strh|ldurh|sturh)/.test(b)) return { bytes: 2, signed: false };
  if (!/^(ldr|str|ldur|stur|ldp|stp|ldnp|stnp)/.test(b)) return null;
  return { bytes: 0, signed: false };   // 幅はレジスタ名（w/x/s/d）を見て決める
}

/** レジスタ名から幅を決める。w0 → 4、x0 → 8、s0 → 4(小数)、d0 → 8(小数)。 */
export function widthOfRegisterName(text) {
  const s = (text || '').trim().toLowerCase();
  if (/^w\d+$|^wzr$/.test(s)) return { bytes: 4 };
  if (/^x\d+$|^xzr$|^sp$/.test(s)) return { bytes: 8 };
  if (/^b\d+$/.test(s)) return { bytes: 1 };
  if (/^h\d+$/.test(s)) return { bytes: 2 };
  if (/^s\d+$/.test(s)) return { bytes: 4, float: true };
  if (/^d\d+$/.test(s)) return { bytes: 8, float: true };
  if (/^q\d+$|^v\d+/.test(s)) return { bytes: 16, float: true };
  return null;
}

/* ── 型の推定 ───────────────────────────────────────────── */

/*
 * 1 か所の使われ方 = 1 つの証拠。集めてから多数決する。
 * 「8 バイトで読んで、それをベースにまた読んでいる」が揃えば、
 * 単なる 64 ビット整数ではなくポインタだと言い切れる。
 */
function newEvidence() { return { bytes: new Map(), signed: 0, unsigned: 0, float: 0, pointer: 0, text: 0, objc: 0, notes: [] }; }

function noteSize(evi, bytes) {
  if (!bytes) return;
  evi.bytes.set(bytes, (evi.bytes.get(bytes) || 0) + 1);
}

function decide(evi) {
  let bytes = 0, best = 0;
  for (const [b, n] of evi.bytes) if (n > best) { best = n; bytes = b; }
  if (evi.text >= 1) return { type: 'char *', conf: 0.9 };
  if (evi.objc >= 1) return { type: 'id', conf: 0.85 };
  if (evi.pointer >= 1) return { type: 'void *', conf: bytes === 8 ? 0.8 : 0.6 };
  if (evi.float >= 1) return { type: bytes === 4 ? 'float' : 'double', conf: 0.8 };
  if (!bytes) return { type: 'unknown', conf: 0.2 };
  return { type: typeFromAccess(bytes, { signed: evi.signed > evi.unsigned }), conf: 0.65 };
}

/**
 * 関数 1 つぶんの型推定。
 *
 * @param {object} model  blocks.js の Semantic Model
 * @returns {{args:Array, locals:Array, ret:object}}
 *   args   [{reg:'x0', index:0, type, conf, why:[]}]
 *   locals [{slot:'sp+16', offset, type, conf, why:[]}]
 *   ret    {type, conf, why:[]}
 */
export function inferTypes(model) {
  const args = new Map();     // 'x0' -> evidence
  const locals = new Map();   // 'sp+16' -> evidence
  const retEvi = newEvidence();
  const insns = model && model.instructions ? model.instructions : [];

  const argEvi = (reg) => {
    if (!args.has(reg)) args.set(reg, newEvidence());
    return args.get(reg);
  };
  const localEvi = (slot) => {
    if (!locals.has(slot)) locals.set(slot, newEvidence());
    return locals.get(slot);
  };
  const argRegs = new Set((model && model.argRegs ? model.argRegs : []).map((n) => 'x' + n));

  // 引数レジスタの「同じ値のまま移された先」を追う（x0 → x19 が典型）
  const alias = new Map();          // reg -> 引数の reg
  for (const r of argRegs) alias.set(r, r);

  for (const insn of insns) {
    const base = (insn.mnemonic || '').toLowerCase();

    /* mov でそのまま移されたら、引数の身元を引き継ぐ */
    if ((base === 'mov' || base === 'fmov') && insn.ops.length >= 2 &&
        insn.ops[0] && insn.ops[0].k === 'reg' && insn.ops[1] && insn.ops[1].k === 'reg') {
      const from = 'x' + insn.ops[1].num;
      const to = 'x' + insn.ops[0].num;
      if (alias.has(from)) alias.set(to, alias.get(from));
      else alias.delete(to);
    }

    /* メモリの読み書き。幅と符号がここで分かる */
    if (insn.memory) {
      const m = insn.memory;
      const shape = accessShape(base) || {};
      const wide = insn.ops[0] && insn.ops[0].k === 'reg' ? widthOfRegisterName(insn.ops[0].text) : null;
      const bytes = shape.bytes || m.size || (wide ? wide.bytes : 0);

      if (m.stack && m.disp != null) {
        const slot = m.base + (m.disp < 0n ? '-' : '+') + (m.disp < 0n ? -m.disp : m.disp).toString();
        const e = localEvi(slot);
        noteSize(e, bytes);
        if (shape.signed) e.signed++; else e.unsigned++;
        if (wide && wide.float) e.float++;
        e.notes.push({ row: insn.row, why: (m.kind === 'load' ? '読み出し' : '書き込み') + ' ' + bytes + ' バイト' });
      } else if (m.base) {
        // ベースに使われている = そのレジスタはポインタ
        const owner = alias.get(m.base);
        if (owner) {
          const e = argEvi(owner);
          e.pointer++;
          e.notes.push({ row: insn.row, why: '[' + m.base + ', …] のベースに使っている → 何かを指している' });
        }
      }
      // 読んだ先のレジスタは、幅だけ分かる
      if (m.kind === 'load' && insn.writes.length) {
        const owner = alias.get(insn.writes[0]);
        if (owner) {
          const e = argEvi(owner);
          noteSize(e, bytes);
        }
      }
      continue;
    }

    /* 小数の命令に出てきたら小数 */
    if (/^f/.test(base) || insn.category === 'float') {
      for (const r of insn.reads) {
        const owner = alias.get(r);
        if (owner) argEvi(owner).float++;
      }
    }

    /* 呼び出しの引数。よく知られた API なら型はそこから来る */
    if (insn.isCall) {
      const name = insn.callTarget != null && model.calls
        ? (model.calls.find((c) => c.row === insn.row) || {}).name : null;
      if (name && /objc_msgSend/.test(name)) {
        const owner = alias.get('x0');
        if (owner) {
          const e = argEvi(owner);
          e.objc++;
          e.notes.push({ row: insn.row, why: 'objc_msgSend の第 1 引数 → Objective-C のオブジェクト' });
        }
      }
      if (name && /str(len|cmp|cpy|cat)|printf|puts|NSLog/.test(name)) {
        const owner = alias.get('x0');
        if (owner) {
          const e = argEvi(owner);
          e.text++;
          e.notes.push({ row: insn.row, why: name + ' に渡している → 文字列' });
        }
      }
    }
  }

  /* 戻り値: 最後に x0 / w0 / d0 に何を入れて帰るか */
  for (let i = insns.length - 1; i >= 0; i--) {
    const insn = insns[i];
    if (!insn.writes.includes('x0')) continue;
    const base = (insn.mnemonic || '').toLowerCase();
    if (/^f/.test(base)) { retEvi.float++; noteSize(retEvi, 8); }
    else if (insn.memory) noteSize(retEvi, insn.memory.size || 8);
    else if (insn.ops[0] && insn.ops[0].text) {
      const w = widthOfRegisterName(insn.ops[0].text);
      if (w) { noteSize(retEvi, w.bytes); if (w.float) retEvi.float++; }
    } else noteSize(retEvi, 8);
    if (insn.isCall) retEvi.pointer++;
    retEvi.notes.push({ row: insn.row, why: '帰る直前に x0 を作っている行' });
    break;
  }

  const outArgs = [];
  for (const [reg, e] of args) {
    if (!argRegs.has(reg)) continue;
    const d = decide(e);
    outArgs.push({ reg, index: Number(reg.slice(1)), type: d.type, conf: d.conf, why: e.notes.slice(0, 4) });
  }
  for (const n of (model && model.argRegs ? model.argRegs : [])) {
    if (!outArgs.some((a) => a.index === n)) {
      outArgs.push({ reg: 'x' + n, index: n, type: 'unknown', conf: 0.2, why: [] });
    }
  }
  outArgs.sort((a, b) => a.index - b.index);

  const outLocals = [];
  for (const [slot, e] of locals) {
    const d = decide(e);
    const m = /([-+])(\d+)$/.exec(slot);
    outLocals.push({
      slot,
      offset: m ? (m[1] === '-' ? -Number(m[2]) : Number(m[2])) : 0,
      type: d.type, conf: d.conf, why: e.notes.slice(0, 4),
    });
  }
  outLocals.sort((a, b) => a.offset - b.offset);

  const retDecided = decide(retEvi);
  const hasRet = (model && model.facts ? model.facts.setsReturnValue : false) || retEvi.notes.length > 0;
  return {
    args: outArgs,
    locals: outLocals,
    ret: hasRet ? { type: retDecided.type, conf: retDecided.conf, why: retEvi.notes }
                : { type: 'void', conf: 0.6, why: [{ why: '帰る前に x0 を作っていない' }] },
  };
}

/**
 * 関数のシグネチャ（C 風の 1 行）。
 *   int64 sub_100A3C0(void *a1, int32 a2)
 */
export function signatureOf(name, types, notes, funcAddr) {
  const rt = (notes && notes.typeOf(funcAddr, 'ret')) || (types.ret ? types.ret.type : 'void');
  const args = types.args.map((a) => {
    const t = (notes && notes.typeOf(funcAddr, 'a' + a.index)) || (a.type === 'unknown' ? 'int64' : a.type);
    const n = (notes && notes.varName(funcAddr, 'a' + a.index)) || ('a' + (a.index + 1));
    return t + ' ' + n;
  });
  return (rt === 'unknown' ? 'int64' : rt) + ' ' + (name || 'sub') + '(' + (args.length ? args.join(', ') : 'void') + ')';
}

/* ── 構造体 ─────────────────────────────────────────────── */

/**
 * 命令の使い方から構造体を組み立てる。
 *
 * ある関数の中で `x19` が [x19, #0x10] / [x19, #0x18] のように使われていたら、
 * x19 は「0x10 と 0x18 に何かが入っている箱」を指しています。
 * それを 1 つの型としてまとめたものが struct です。
 *
 * @param {object} model
 * @param {string} reg  たどりたいレジスタ（例 'x19'）。省略時はいちばん使われているもの。
 */
export function recoverStruct(model, reg) {
  const insns = model && model.instructions ? model.instructions : [];
  const counts = new Map();
  for (const insn of insns) {
    if (!insn.memory || insn.memory.stack || !insn.memory.base || insn.memory.disp == null) continue;
    counts.set(insn.memory.base, (counts.get(insn.memory.base) || 0) + 1);
  }
  let target = reg;
  if (!target) {
    let best = 0;
    for (const [r, n] of counts) if (n > best) { best = n; target = r; }
  }
  if (!target) return null;

  const members = new Map();
  for (const insn of insns) {
    const m = insn.memory;
    if (!m || m.base !== target || m.disp == null || m.stack) continue;
    const off = Number(m.disp);
    const size = m.size || 8;
    const cur = members.get(off);
    const shape = accessShape((insn.mnemonic || '').toLowerCase()) || {};
    const entry = cur || { offset: off, size, reads: 0, writes: 0, rows: [], signed: !!shape.signed };
    entry.size = Math.max(entry.size, size);
    if (m.kind === 'load') entry.reads++; else entry.writes++;
    if (entry.rows.length < 6) entry.rows.push(insn.row);
    members.set(off, entry);
  }
  if (!members.size) return null;

  const list = Array.from(members.values()).sort((a, b) => a.offset - b.offset);
  for (const m of list) {
    m.type = typeFromAccess(m.size, { signed: m.signed });
    m.name = 'field_' + m.offset.toString(16).toUpperCase();
  }
  const last = list[list.length - 1];
  return {
    base: target,
    name: 'struct_' + target,
    size: last.offset + last.size,
    members: list,
    generated: true,
  };
}

/**
 * 自分で作る構造体の置き場。NoteStore に保存されるので、開き直しても残る。
 */
export class TypeStore {
  constructor(notes) {
    this.notes = notes || null;
    this.structs = notes && Array.isArray(notes.structs) ? notes.structs : [];
  }

  list() { return this.structs; }

  get(name) { return this.structs.find((s) => s.name === name) || null; }

  add(name, members) {
    const clean = (name || '').replace(/[^\w$]/g, '_').slice(0, 60) || ('struct_' + (this.structs.length + 1));
    if (this.get(clean)) return this.get(clean);
    const s = { name: clean, members: members || [], size: 0 };
    this.recomputeSize(s);
    this.structs.push(s);
    this.persist();
    return s;
  }

  /** 自動で組み立てたものを、名前を付けて取り込む。 */
  adopt(recovered, name) {
    if (!recovered) return null;
    const s = this.add(name || recovered.name,
      recovered.members.map((m) => ({ offset: m.offset, size: m.size, type: m.type, name: m.name })));
    return s;
  }

  setMember(structName, offset, patch) {
    const s = this.get(structName);
    if (!s) return null;
    let m = s.members.find((x) => x.offset === offset);
    if (!m) { m = { offset, size: 8, type: 'int64', name: 'field_' + offset.toString(16) }; s.members.push(m); }
    Object.assign(m, patch || {});
    if (patch && patch.type) m.size = sizeOfType(patch.type);
    s.members.sort((a, b) => a.offset - b.offset);
    this.recomputeSize(s);
    this.persist();
    return m;
  }

  removeMember(structName, offset) {
    const s = this.get(structName);
    if (!s) return;
    s.members = s.members.filter((m) => m.offset !== offset);
    this.recomputeSize(s);
    this.persist();
  }

  remove(name) {
    this.structs = this.structs.filter((s) => s.name !== name);
    this.persist();
  }

  memberAt(structName, offset) {
    const s = this.get(structName);
    if (!s) return null;
    return s.members.find((m) => offset >= m.offset && offset < m.offset + (m.size || 8)) || null;
  }

  recomputeSize(s) {
    let end = 0;
    for (const m of s.members) end = Math.max(end, m.offset + (m.size || 8));
    s.size = end;
  }

  persist() {
    if (!this.notes) return;
    this.notes.structs = this.structs;
    this.notes.save();
  }

  /** C のヘッダとして書き出す。 */
  toC(name) {
    return structToC(this.get(name));
  }
}

/** 構造体 1 つを C のかたちの文字列にする（保存していないものにも使える）。 */
export function structToC(s) {
  {
    const lines = ['struct ' + s.name + ' {'];
    let cursor = 0;
    for (const m of s.members) {
      if (m.offset > cursor) lines.push('    uint8 pad_' + cursor.toString(16) + '[' + (m.offset - cursor) + '];');
      lines.push('    ' + m.type + ' ' + m.name + ';' + '   // +0x' + m.offset.toString(16).toUpperCase());
      cursor = m.offset + (m.size || 8);
    }
    lines.push('};   // 全体で ' + s.size + ' バイト');
    return lines.join('\n');
  }
}

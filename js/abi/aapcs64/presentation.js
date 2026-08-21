// Beginner-facing ABI role hints. This is presentation metadata, not the ABI
// semantic call-classification implementation.

/** 汎用レジスタ番号 → 役割。ARM64 の呼び出し規約 (AAPCS64) より。 */
export function registerRole(num, isSp = false, isZr = false) {
  if (isSp) return { id: "sp", ja: "スタックポインタ。今どこまでスタックを使っているかを指す", en: "stack pointer" };
  if (isZr) return { id: "zr", ja: "常に 0 のレジスタ。書き込んでも捨てられる", en: "always zero" };
  if (num <= 7) return { id: "arg", ja: "関数の引数と戻り値に使うレジスタ（" + (num + 1) + " 番目の引数）", en: "argument / return value register" };
  if (num === 8) return { id: "x8", ja: "大きな戻り値の置き場所を渡すレジスタ", en: "indirect result register" };
  if (num <= 15) return { id: "temp", ja: "自由に使える一時レジスタ。関数を呼ぶと壊れる", en: "caller-saved scratch register" };
  if (num <= 17) return { id: "ip", ja: "リンカや OS が横取りに使う一時レジスタ", en: "linker scratch register (IP0/IP1)" };
  if (num === 18) return { id: "x18", ja: "OS 用に予約されたレジスタ（iOS では触らない）", en: "platform-reserved register" };
  if (num <= 28) return { id: "saved", ja: "関数をまたいでも値が残るレジスタ（使う前に保存する約束）", en: "callee-saved register" };
  if (num === 29) return { id: "fp", ja: "フレームポインタ。今の関数のスタックの基準点", en: "frame pointer" };
  if (num === 30) return { id: "lr", ja: "戻り先アドレス。関数が終わったらここへ帰る", en: "link register — the return address" };
  return { id: "gp", ja: "汎用レジスタ", en: "general-purpose register" };
}

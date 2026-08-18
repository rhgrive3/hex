/*
 * Phase 6 RISC-V64 mandatory compiler-truth corpus.
 *
 * One exported function per frozen mandatory category in
 * tools/validation/phase6/profile.json. Everything here is freestanding C11:
 * the corpus links with -nostdlib so no libc is required on the RV64 target,
 * and the frozen ISA profile is RV64IMC / LP64 (soft float), so no
 * floating-point, atomic, or vector instruction may be emitted.
 */

/*
 * Each mandatory-category function must survive optimization as its own symbol,
 * otherwise a missing tuple would look like a corpus gap rather than what it is
 * (inlining). `noinline` + `used` keeps the symbol and its call sites real
 * without weakening optimization inside the function.
 */
#define P6_FN __attribute__((noinline, used))

typedef unsigned long u64;
typedef long i64;
typedef unsigned int u32;
typedef int i32;
typedef unsigned short u16;
typedef unsigned char u8;

/* --- scalar-integer-arithmetic --- */
P6_FN i64 p6_scalar_integer_arithmetic(i64 a, i64 b) {
  i64 s = a + b;
  i64 d = a - b;
  i64 x = s ^ d;
  i64 o = a | b;
  return x + o;
}

/* --- signed-and-unsigned-comparison ---
 * slt/sltu/slti/sltiu materialise comparisons into a GPR. There is no
 * condition-code register anywhere in this sequence.
 */
P6_FN i64 p6_signed_unsigned_comparison(i64 a, i64 b, u64 c, u64 d) {
  i64 r = 0;
  r += (a < b) ? 1 : 0;
  r += (a >= b) ? 2 : 0;
  r += (c < d) ? 4 : 0;
  r += (c >= d) ? 8 : 0;
  r += (a < 7) ? 16 : 0;
  r += (c < 9u) ? 32 : 0;
  return r;
}

/* --- conditional-branch-without-flags ---
 * beq/bne/blt/bge/bltu/bgeu compare two registers directly and branch. This is
 * the defining Phase 6 shape: the branch predicate is a value relation, not a
 * read of previously computed flag state.
 */
P6_FN i64 p6_conditional_branch_without_flags(i64 a, i64 b, u64 c) {
  if (a == b) return 1;
  if (a < b) return 2;
  if (c >= 100u) return 3;
  return 4;
}

/* --- loops --- */
P6_FN i64 p6_loops(const i64 *p, i64 n) {
  i64 total = 0;
  for (i64 i = 0; i < n; i++) total += p[i];
  while (total > 1000) total -= 1000;
  return total;
}

/* --- switch-like-control-flow --- */
P6_FN i64 p6_switch_like_control_flow(i64 selector, i64 value) {
  switch ((int)selector) {
    case 0: return value + 1;
    case 1: return value - 2;
    case 2: return value * 3;
    case 3: return value ^ 4;
    case 4: return value | 5;
    case 5: return value & 6;
    case 6: return value << 1;
    case 7: return value >> 2;
    default: return value;
  }
}

/* --- stack-locals-and-spills --- */
P6_FN i64 p6_stack_locals_and_spills(i64 a, i64 b, i64 c) {
  volatile i64 slots[10];
  for (int i = 0; i < 10; i++) slots[i] = a + i * b - c;
  i64 total = 0;
  for (int i = 0; i < 10; i++) total += slots[9 - i];
  return total;
}

/* --- pointer-load-and-store --- */
P6_FN i64 p6_pointer_load_and_store(i64 *p, i64 *q, i64 v) {
  *p = v;
  i64 loaded = *q;
  *q = loaded + 1;
  return loaded + *p;
}

/* --- array-indexing --- */
P6_FN i64 p6_array_indexing(const i64 *base, const u32 *words, i64 i, i64 j) {
  return base[i] + base[j] + (i64)words[i] + (i64)words[j];
}

/* --- structure-field-access --- */
struct p6_record { i64 first; u32 second; u16 third; u8 fourth; i64 fifth; };
P6_FN i64 p6_structure_field_access(struct p6_record *r, i64 v) {
  r->second = (u32)v;
  r->third = (u16)v;
  r->fourth = (u8)v;
  r->fifth = r->first + v;
  return r->first + r->second + r->third + r->fourth + r->fifth;
}

/* --- direct-calls --- */
P6_FN i64 p6_callee_leaf(i64 a, i64 b);
P6_FN i64 p6_direct_calls(i64 a, i64 b) {
  i64 x = p6_callee_leaf(a, b);
  i64 y = p6_callee_leaf(x, a);
  return x + y;
}
P6_FN i64 p6_callee_leaf(i64 a, i64 b) { return a * 3 + b; }

/* --- indirect-calls --- */
typedef i64 (*p6_fn)(i64, i64);
/*
 * A global initialised with a code address. In the PIE/ET_DYN corpus target
 * this forces a dynamic relative relocation, so the ELF lane exercises real
 * relocation processing instead of only self-contained PC-relative code.
 */
static p6_fn volatile p6_global_function_pointer = p6_callee_leaf;
P6_FN i64 p6_indirect_calls(p6_fn fn, i64 a, i64 b) {
  i64 first = fn(a, b);
  i64 second = p6_global_function_pointer(first, b);
  return first + second + fn(second, a);
}

/* --- multiple-arguments (a0..a7 then the stack) --- */
P6_FN i64 p6_multiple_arguments(i64 a0, i64 a1, i64 a2, i64 a3, i64 a4, i64 a5, i64 a6, i64 a7) {
  return a0 + a1 * 2 + a2 * 3 + a3 * 4 + a4 * 5 + a5 * 6 + a6 * 7 + a7 * 8;
}

/* --- stack-arguments (arguments 9 and 10 must be passed on the stack) --- */
P6_FN i64 p6_stack_arguments(i64 a0, i64 a1, i64 a2, i64 a3, i64 a4, i64 a5, i64 a6, i64 a7, i64 s0, i64 s1) {
  return a0 + a7 + s0 * 2 + s1 * 3;
}

/* --- return-values --- */
P6_FN i64 p6_return_values(i64 a, i64 b) {
  if (a > b) return a - b;
  if (a < b) return b - a;
  return 0;
}

/* --- rv64-w-suffix-32-bit-operations ---
 * RV64 *W instructions compute a 32-bit result and sign-extend it to XLEN.
 * Getting that sign extension wrong is the classic RV64 lifting bug, so the
 * corpus forces addw/subw/mulw/sllw/srlw/sraw shapes.
 */
P6_FN i32 p6_rv64_w_suffix_operations(i32 a, i32 b, u32 c) {
  i32 s = a + b;
  i32 d = a - b;
  i32 m = a * b;
  i32 l = a << (b & 31);
  u32 r = c >> (b & 31);
  i32 ar = a >> (b & 31);
  return s ^ d ^ m ^ l ^ (i32)r ^ ar;
}

/* --- zero-and-sign-extension --- */
typedef signed char i8;
/*
 * ISA-level width conversion. Zero- and sign-extension are properties of the
 * *load* on RISC-V (lb/lh/lw vs lbu/lhu/lwu), so the corpus loads through typed
 * pointers. Casting a register value instead would let an optimizing compiler
 * lower the conversion to andi/slli+srli, which is exact but never exercises
 * the extension semantics this category exists to prove.
 */
P6_FN i64 p6_zero_and_sign_extension(const i8 *sb, const short *sh, const i32 *sw,
                                     const u8 *zb, const u16 *zh, const u32 *zw) {
  i64 signedByte = (i64)*sb;
  i64 signedHalf = (i64)*sh;
  i64 signedWord = (i64)*sw;
  i64 zeroByte = (i64)*zb;
  i64 zeroHalf = (i64)*zh;
  i64 zeroWord = (i64)*zw;
  return signedByte + signedHalf + signedWord + zeroByte + zeroHalf + zeroWord;
}

/* --- shifts --- */
P6_FN i64 p6_shifts(i64 a, u64 b, i64 amount) {
  i64 l = a << (amount & 63);
  u64 r = b >> (amount & 63);
  i64 ar = a >> (amount & 63);
  i64 lc = a << 5;
  u64 rc = b >> 7;
  i64 arc = a >> 9;
  return l + (i64)r + ar + lc + (i64)rc + arc;
}

/* --- multiplication-and-division (M standard extension) --- */
P6_FN i64 p6_multiplication_and_division(i64 a, i64 b, u64 c, u64 d) {
  i64 m = a * b;
  i64 q = b ? a / b : 0;
  i64 rm = b ? a % b : 0;
  u64 uq = d ? c / d : 0;
  u64 ur = d ? c % d : 0;
  return m + q + rm + (i64)uq + (i64)ur;
}

/* --- pc-relative-global-addressing --- */
static i64 p6_global_counter = 7;
static i64 p6_global_table[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
P6_FN i64 p6_pc_relative_global_addressing(i64 index) {
  p6_global_counter += 1;
  return p6_global_counter + p6_global_table[index & 7];
}

/* --- compressed-instruction-mix ---
 * Short, register-cheap operations on x8..x15 are exactly what the C extension
 * encodes, so this function reliably produces a mixed 2-byte/4-byte stream.
 */
P6_FN i64 p6_compressed_instruction_mix(i64 a, i64 b) {
  i64 t = a + b;
  t += 1;
  t -= 1;
  t = t + t;
  t ^= b;
  t &= 0x7f;
  return t;
}

/* --- hardwired-zero-register ---
 * `return 0`, `x == 0`, and negation all lower through x0. Writes whose
 * destination is x0 must be discarded, and reads of x0 must produce the
 * constant zero, never a mutable register value.
 */
P6_FN i64 p6_hardwired_zero_register(i64 a) {
  if (a == 0) return 0;
  i64 negated = -a;
  i64 isZero = (a == 0) ? 1 : 0;
  i64 nonZero = (a != 0) ? 1 : 0;
  return negated + isZero + nonZero;
}

/* --- riscv-lp64-abi ---
 * Exercises the LP64 integer calling convention end to end: a0..a7 in, a0 out,
 * callee-saved registers preserved across a call.
 */
P6_FN i64 p6_riscv_lp64_abi(i64 a, i64 b, i64 c) {
  i64 preserved = a * 5;
  i64 called = p6_callee_leaf(b, c);
  return preserved + called;
}

/*
 * Freestanding support routines. At -Os/-Oz Clang lowers aggregate initializers
 * to memcpy/memset calls, and the corpus links with -nostdlib, so the build
 * must provide them itself rather than quietly dropping those optimization
 * levels from the mandatory matrix.
 */
void *memcpy(void *destination, const void *source, unsigned long count) {
  unsigned char *out = (unsigned char *)destination;
  const unsigned char *in = (const unsigned char *)source;
  for (unsigned long i = 0; i < count; i++) out[i] = in[i];
  return destination;
}

void *memset(void *destination, int value, unsigned long count) {
  unsigned char *out = (unsigned char *)destination;
  for (unsigned long i = 0; i < count; i++) out[i] = (unsigned char)value;
  return destination;
}

/* Entry point so the image links as a complete executable without libc. */
P6_FN void p6_entry(void) {
  static volatile i64 sink;
  struct p6_record record = { 1, 2, 3, 4, 5 };
  i64 values[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
  u32 words[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
  signed char byte = -3;
  short half = -4;
  i32 word = -5;
  u8 ubyte = 6;
  u16 uhalf = 7;
  u32 uword = 8;
  sink = p6_scalar_integer_arithmetic(1, 2)
    + p6_signed_unsigned_comparison(1, 2, 3, 4)
    + p6_conditional_branch_without_flags(1, 2, 3)
    + p6_loops(values, 8)
    + p6_switch_like_control_flow(3, 4)
    + p6_stack_locals_and_spills(1, 2, 3)
    + p6_pointer_load_and_store(values, values + 1, 5)
    + p6_array_indexing(values, words, 1, 2)
    + p6_structure_field_access(&record, 6)
    + p6_direct_calls(1, 2)
    + p6_indirect_calls(p6_callee_leaf, 1, 2)
    + p6_multiple_arguments(1, 2, 3, 4, 5, 6, 7, 8)
    + p6_stack_arguments(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    + p6_return_values(1, 2)
    + p6_rv64_w_suffix_operations(1, 2, 3)
    + p6_zero_and_sign_extension(&byte, &half, &word, &ubyte, &uhalf, &uword)
    + p6_shifts(1, 2, 3)
    + p6_multiplication_and_division(10, 3, 10, 3)
    + p6_pc_relative_global_addressing(2)
    + p6_compressed_instruction_mix(1, 2)
    + p6_hardwired_zero_register(5)
    + p6_riscv_lp64_abi(1, 2, 3);
  for (;;) { }
}

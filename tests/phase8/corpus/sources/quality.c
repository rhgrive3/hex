/*
 * Phase 8 decompiler-quality corpus.
 *
 * Every function here exists because a specific Phase 8 checkpoint has to be
 * measurable on it. They are compiled by the canonical builder and the resulting
 * assembly is frozen, so the corpus is offline, deterministic and carries its
 * own toolchain identity — a corpus that is recompiled per run is a different
 * question set per run (EP-011, §5 evidence identity).
 *
 * Nothing here is a readability showcase. Each function is the smallest shape
 * that makes one optimizer's positive case and its refusal case distinguishable.
 */

/* No libc headers: the corpus is cross-compiled for AArch64 without a sysroot,
 * so the fixed-width types are declared here against the LP64 target ABI. */
typedef signed char int8_t;
typedef int int32_t;
typedef unsigned int uint32_t;

/* P8-2 SCCP: one branch is provably dead, and the constant is exact-width. */
int32_t sccp_dead_branch(int32_t a) {
  int32_t k = 4;
  if (k > 8) return a * 3;
  return a + k;
}

/* P8-2 range/wrap: unsigned modular arithmetic must not become math integers. */
uint32_t sccp_wraparound(uint32_t a) {
  uint32_t big = 0xFFFFFFF0u;
  return big + a;
}

/* P8-2 width: truncation and sign extension around a narrow value. */
int32_t sccp_narrow_extend(int32_t a) {
  int8_t narrow = (int8_t)a;
  return (int32_t)narrow + 1;
}

/* P8-3 GVN/CSE: the same subexpression computed twice with no memory between. */
int32_t gvn_repeated_expression(int32_t a, int32_t b) {
  int32_t x = a * b + 7;
  int32_t y = a * b + 7;
  return x + y;
}

/* P8-3 load forwarding: two loads of the same slot with a disjoint store between. */
int32_t gvn_load_reuse(int32_t *p, int32_t *q) {
  int32_t first = p[0];
  q[4] = 1;
  int32_t second = p[0];
  return first + second;
}

/* P8-3 barrier: an unknown call between the loads must block reuse. */
extern void opaque(void);
int32_t gvn_call_barrier(int32_t *p) {
  int32_t first = p[0];
  opaque();
  return first + p[0];
}

/* P8-3 DCE refusal: the result is unused but the store is observable. */
void dce_observable_store(int32_t *p, int32_t a) {
  p[0] = a + 1;
}

/* P8-3 DCE refusal: a volatile read may not be deleted for being unused. */
void dce_volatile_read(volatile int32_t *p) {
  (void)*p;
}

/* P8-4 induction: canonical counted loop with a unit step. */
int32_t loop_counted_sum(const int32_t *v, int32_t n) {
  int32_t total = 0;
  for (int32_t i = 0; i < n; i++) total += v[i];
  return total;
}

/* P8-4 induction: decrementing loop with a non-unit step. */
int32_t loop_decrement_step(int32_t n) {
  int32_t total = 0;
  for (int32_t i = n; i > 0; i -= 3) total += i;
  return total;
}

/* P8-4/P8-5: early exit means the trip count is a range, not a constant. */
int32_t loop_early_exit(const int32_t *v, int32_t n, int32_t needle) {
  for (int32_t i = 0; i < n; i++) if (v[i] == needle) return i;
  return -1;
}

/* P8-4/P8-5: nested loops with a derived guard. */
int32_t loop_nested(const int32_t *v, int32_t rows, int32_t cols) {
  int32_t total = 0;
  for (int32_t r = 0; r < rows; r++)
    for (int32_t c = 0; c < cols; c++) total += v[r * cols + c];
  return total;
}

/* P8-5 structuring: a dense switch with fallthrough and a default. */
int32_t structure_switch(int32_t a) {
  switch (a) {
    case 0: return 10;
    case 1: return 20;
    case 2: return 30;
    case 3: return 40;
    default: return -1;
  }
}

/* P8-6 aggregate: fixed non-overlapping fields reached from one base pointer. */
struct point { int32_t x; int32_t y; int32_t tag; };
int32_t aggregate_struct_fields(const struct point *p) {
  return p->x + p->y + p->tag;
}

/* P8-6 aggregate: strided element access, the array/struct ambiguity case. */
int32_t aggregate_array_stride(const struct point *p, int32_t n) {
  int32_t total = 0;
  for (int32_t i = 0; i < n; i++) total += p[i].y;
  return total;
}

typedef signed int i32;
typedef unsigned int u32;

__attribute__((noinline)) i32 abs_i32(i32 x) {
  return x < 0 ? -x : x;
}

__attribute__((noinline)) u32 max_u32(u32 a, u32 b) {
  return a > b ? a : b;
}

__attribute__((noinline)) u32 min_u32(u32 a, u32 b) {
  return a < b ? a : b;
}

__attribute__((noinline)) u32 mask_low8(u32 x) {
  return x & 0xffu;
}

__attribute__((noinline)) u32 clear_low8(u32 x) {
  return x & 0xffffff00u;
}

__attribute__((noinline)) u32 bit_test5(u32 x) {
  return (x & 0x20u) != 0;
}

__attribute__((noinline)) u32 choose_u32(u32 cond, u32 a, u32 b) {
  return cond ? a : b;
}

__attribute__((noinline)) u32 shl3_add(u32 x, u32 y) {
  return (x << 3) + y;
}

__attribute__((noinline)) i32 neg_if(i32 x, i32 flag) {
  return flag ? -x : x;
}

__attribute__((noinline)) u32 inc_if(u32 x, u32 flag) {
  return flag ? x + 1u : x;
}

__attribute__((noinline)) u32 inv_if(u32 x, u32 flag) {
  return flag ? ~x : x;
}

__attribute__((noinline)) u32 extract16(u32 x) {
  return (x >> 8) & 0xffffu;
}

__attribute__((noinline)) i32 clamp_i32(i32 x, i32 lo, i32 hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

__attribute__((noinline)) u32 clamp_u32(u32 x, u32 hi) {
  return x > hi ? hi : x;
}

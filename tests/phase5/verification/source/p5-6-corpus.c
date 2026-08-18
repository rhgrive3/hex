typedef unsigned char u8;
typedef signed char i8;
typedef unsigned short u16;
typedef signed short i16;
typedef unsigned int u32;
typedef signed int i32;
typedef unsigned long long u64;
typedef signed long long i64;
typedef unsigned __int128 u128;
typedef __int128 i128;
typedef i32 v4i32 __attribute__((vector_size(16)));

#define NOINLINE __attribute__((noinline))
#define USED __attribute__((used))
#define SYSV_ABI __attribute__((sysv_abi))
#define MS_ABI __attribute__((ms_abi))

struct P5Pair {
  i32 a;
  i16 b;
  u8 c;
  i64 d;
};

volatile u64 p5_global_u64 = 0x1122334455667788ULL;
volatile i32 p5_global_i32 = -17;
volatile double p5_global_f64 = 1.25;
u64 p5_atomic_word = 9;
volatile v4i32 p5_global_vec = { 1, 2, 3, 4 };

NOINLINE USED u64 p5_scalar_integer_arithmetic(u64 a, u64 b) {
  return ((a + b) ^ (a - b)) + ((a & b) | (a ^ b));
}

NOINLINE USED i32 p5_signed_unsigned_comparison(i64 sa, i64 sb, u64 ua, u64 ub) {
  i32 r = 0;
  r += sa < sb ? 1 : 0;
  r += sa >= sb ? 2 : 0;
  r += ua < ub ? 4 : 0;
  r += ua >= ub ? 8 : 0;
  return r;
}

NOINLINE USED i64 p5_conditional_branch(i64 x) {
  if (x < -3) return x * 3;
  if (x == 7) return x + 99;
  return x - 5;
}

NOINLINE USED i64 p5_loops(i64 n, volatile i64 *sink) {
  i64 sum = 0;
  for (i64 i = 0; i < n; ++i) sum += (i ^ n) + 3;
  while (n > 0) { sum ^= n; --n; }
  *sink = sum;
  return sum;
}

NOINLINE USED i32 p5_switch_like(i32 x) {
  switch (x) {
    case 0: return 11;
    case 1: return 23;
    case 2: return 37;
    case 3: return 41;
    case 4: return 59;
    case 5: return 61;
    case 6: return 73;
    case 7: return 89;
    default: return -101;
  }
}

NOINLINE USED i64 p5_stack_locals_and_spills(i64 a, i64 b, i64 c, i64 d) {
  volatile i64 local[8];
  local[0] = a; local[1] = b; local[2] = c; local[3] = d;
  local[4] = a + c; local[5] = b + d; local[6] = a ^ d; local[7] = b ^ c;
  return local[0] + local[1] + local[2] + local[3] + local[4] + local[5] + local[6] + local[7];
}

NOINLINE USED u64 p5_pointer_load_store(volatile u64 *p, u64 v) {
  u64 old = *p;
  *p = old + v;
  return old;
}

NOINLINE USED i64 p5_array_indexing(const i32 *p, u64 i, i32 v) {
  return (i64)p[i] + (i64)p[i + 3] * v;
}

NOINLINE USED i64 p5_structure_field(struct P5Pair *p, i64 delta) {
  i64 old = p->d;
  p->a += (i32)delta;
  p->b = (i16)(p->b - 1);
  p->d = old + delta;
  return p->a + p->b + p->c + p->d;
}

NOINLINE USED i64 p5_direct_target(i64 x) { return x * 7 + 3; }
NOINLINE USED i64 p5_direct_calls(i64 x) { return p5_direct_target(x) - 1; }
NOINLINE USED i64 p5_indirect_calls(i64 (*fn)(i64), i64 x) { return fn(x) + 5; }

NOINLINE USED i64 p5_multiple_arguments(i64 a, i64 b, i64 c, i64 d, i64 e, i64 f, i64 g, i64 h, i64 i, i64 j) {
  return a + 2*b + 3*c + 4*d + 5*e + 6*f + 7*g + 8*h + 9*i + 10*j;
}

NOINLINE USED u64 p5_return_values(u64 x) { return x ^ 0xa5a55a5af00dcafeULL; }

NOINLINE USED u32 p5_partial_width(u32 x, u16 y, u8 z) {
  u8 lo = (u8)x;
  u16 mid = (u16)(x >> 8);
  return (u32)(u8)(lo + z) | ((u32)(u16)(mid - y) << 8);
}

NOINLINE USED i64 p5_zero_sign_extension(u8 a, i8 b, u16 c, i16 d) {
  return (i64)(u64)a + (i64)b + (i64)(u64)c + (i64)d;
}

NOINLINE USED u64 p5_shifts(u64 x, u32 n) {
  n &= 63;
  return (x << n) ^ (x >> ((64 - n) & 63));
}

NOINLINE USED i64 p5_multiplication_division(i64 a, i64 b, i64 c) {
  i64 q = a / (b | 1);
  i64 r = a % (c | 1);
  return q * 13 + r * 17;
}

NOINLINE USED u128 p5_adc_shape(u128 a, u128 b) { return a + b + 1; }
NOINLINE USED i128 p5_sbb_shape(i128 a, i128 b) { return a - b - 1; }
NOINLINE USED i64 p5_cmov_setcc_shape(i64 a, i64 b) {
  i64 m = a < b ? a : b;
  return m + (a == b);
}

NOINLINE USED u64 p5_rip_relative_global(u64 v) {
  p5_global_u64 += v;
  p5_global_i32 ^= (i32)v;
  return p5_global_u64 + (u32)p5_global_i32;
}

NOINLINE USED double p5_scalar_floating_point(double a, double b) {
  double x = a + b;
  double y = a - b;
  return x * y + p5_global_f64;
}

NOINLINE USED v4i32 p5_baseline_simd(v4i32 a, v4i32 b) {
  v4i32 c = a + b;
  return c ^ (v4i32){ 7, 11, 13, 17 };
}

NOINLINE USED u64 p5_atomic_rmw(u64 v) {
  return __atomic_fetch_add(&p5_atomic_word, v, __ATOMIC_SEQ_CST);
}

NOINLINE USED SYSV_ABI i64 p5_sysv_abi(i64 a, i64 b, i64 c, i64 d, i64 e, i64 f, i64 g, double x) {
  return a + b + c + d + e + f + g + (i64)x;
}

NOINLINE USED MS_ABI i64 p5_microsoft_x64_abi(i64 a, i64 b, i64 c, i64 d, i64 e, i64 f, i64 g, double x) {
  return a + b + c + d + e + f + g + (i64)x;
}

NOINLINE USED i64 p5_cross_abi_bridge(i64 x) {
  return p5_sysv_abi(x,2,3,4,5,6,7,8.0) + p5_microsoft_x64_abi(x,12,13,14,15,16,17,18.0);
}

NOINLINE USED double p5_variadic_abi_edge(i32 count, ...) {
  __builtin_va_list ap;
  __builtin_va_start(ap, count);
  i64 first = __builtin_va_arg(ap, i64);
  double second = __builtin_va_arg(ap, double);
  i64 third = __builtin_va_arg(ap, i64);
  __builtin_va_end(ap);
  return count + (double)first + second + (double)third;
}

NOINLINE USED i64 p5_entry(void) {
  volatile i64 sink = 0;
  struct P5Pair pair = { 1, 2, 3, 4 };
  i32 arr[8] = { 1,2,3,4,5,6,7,8 };
  v4i32 va = p5_global_vec;
  v4i32 vb = { 5, 6, 7, 8 };
  v4i32 vc = p5_baseline_simd(va, vb);
  i64 r = 0;
  r += (i64)p5_scalar_integer_arithmetic(5, 9);
  r += p5_signed_unsigned_comparison(-2, 3, 4, 5);
  r += p5_conditional_branch(r);
  r += p5_loops(7, &sink);
  r += p5_switch_like((i32)(r & 7));
  r += p5_stack_locals_and_spills(1,2,3,4);
  r += (i64)p5_pointer_load_store(&p5_global_u64, 3);
  r += p5_array_indexing(arr, 1, 2);
  r += p5_structure_field(&pair, 9);
  r += p5_direct_calls(4);
  r += p5_indirect_calls(p5_direct_target, 5);
  r += p5_multiple_arguments(1,2,3,4,5,6,7,8,9,10);
  r += (i64)p5_return_values((u64)r);
  r += p5_partial_width((u32)r, 3, 4);
  r += p5_zero_sign_extension(250, -3, 60000, -700);
  r += (i64)p5_shifts((u64)r, 7);
  r += p5_multiplication_division(r | 1, 7, 11);
  r += (i64)p5_rip_relative_global((u64)r);
  r += (i64)p5_scalar_floating_point(1.5, 0.25);
  r += vc[0] + vc[3];
  r += (i64)p5_atomic_rmw(2);
  r += p5_cross_abi_bridge(10);
  r += (i64)p5_variadic_abi_edge(3, (i64)11, 2.5, (i64)33);
  return r + sink;
}

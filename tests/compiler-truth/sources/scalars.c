__attribute__((noinline)) int max_i32(int a, int b) { return a > b ? a : b; }
__attribute__((noinline)) int min_i32(int a, int b) { return a < b ? a : b; }
__attribute__((noinline)) int clamp0_i32(int a) { return a < 0 ? 0 : a; }
__attribute__((noinline)) unsigned extract8(unsigned x) { return (x >> 8) & 0xffu; }
__attribute__((noinline)) int muladd_i32(int a, int b, int c) { return a * b + c; }
__attribute__((noinline)) unsigned bool_i32(int a, int b) { return a == b; }

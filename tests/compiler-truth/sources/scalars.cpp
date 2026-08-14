extern "C" __attribute__((noinline)) int cpp_clamp_i32(int value) {
    return value < 0 ? 0 : value;
}

struct Pair32 {
    int first;
    int second;
};

extern "C" __attribute__((noinline)) int cpp_pair_sum_i32(const Pair32 *pair) {
    return pair->first + pair->second;
}

__attribute__((objc_root_class))
@interface HexTruth
- (int)clamp:(int)value;
@end

@implementation HexTruth
- (int)clamp:(int)value {
    return value < 0 ? 0 : value;
}
@end

__attribute__((noinline)) int objc_clamp_i32(int value) {
    return value < 0 ? 0 : value;
}

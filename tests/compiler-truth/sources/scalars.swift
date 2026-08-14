@inline(never)
public func swiftClampI32(_ value: Int32) -> Int32 {
    return value < 0 ? 0 : value
}

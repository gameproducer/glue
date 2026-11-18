import Foundation

struct PeelSnapshot {
    let width: Int
    let height: Int
    let adhered: [UInt8]
    let released: [UInt8]
    let lifted: [UInt8]
    let revision: UInt64
    let progress: Float
    let grabPoint: SIMD2<Float>?
    let pullPoint: SIMD2<Float>?
    let pullDirection: SIMD2<Float>
    let peelFrontPoint: SIMD2<Float>
    let releasedDepth: Float
    let tension: Float
    let isTorn: Bool
}

struct PullEndResult {
    let snapshot: PeelSnapshot
    let consumedMove: Bool
    let completed: Bool
    let torn: Bool
    let releasedCellCount: Int
}

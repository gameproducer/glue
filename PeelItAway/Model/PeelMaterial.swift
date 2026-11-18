import Foundation

enum CurlProfile: String, CaseIterable {
    case cylinder
    case cone

    var displayName: String { rawValue.uppercased() }
}

struct PeelMaterial: Sendable {
    /// Work supplied per cell-width of pointer travel.
    var peelEnergyPerDistance: Float = 175
    /// Base cost of releasing a cell.
    var adhesion: Float = 1.0
    /// Distance the pull can stall before the sticker tears.
    var tearTension: Float = 17
    /// Radius of the projected curl, in simulation cells.
    var bendRadius: Float = 10
    /// Makes the front slightly organic while remaining deterministic.
    var frontVariation: Float = 0.12

    static let assessment = PeelMaterial()
}


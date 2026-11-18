import XCTest
import UIKit
@testable import PeelItAway

final class PeelSimulationTests: XCTestCase {
    func testMicroPullRollsBackAndDoesNotConsumeMove() {
        let simulation = makeRectangle()
        XCTAssertTrue(simulation.beginPull(at: SIMD2<Float>(27.5, 16.5)))
        _ = simulation.updatePull(to: SIMD2<Float>(28.5, 16.5))

        let result = simulation.endPull()

        XCTAssertFalse(result.consumedMove)
        XCTAssertEqual(result.snapshot.progress, 0, accuracy: 0.0001)
    }

    func testOutwardPullReleasesMaterial() {
        let simulation = makeRectangle()
        XCTAssertTrue(simulation.beginPull(at: SIMD2<Float>(27.5, 16.5)))

        for x in stride(from: Float(30), through: 54, by: 2) {
            _ = simulation.updatePull(to: SIMD2<Float>(x, 16.5))
        }
        let result = simulation.endPull()

        XCTAssertTrue(result.consumedMove)
        XCTAssertGreaterThan(result.snapshot.progress, 0.03)
        XCTAssertFalse(result.torn)
    }

    func testInteriorCannotBeGrabbedInitially() {
        let simulation = makeRectangle()
        XCTAssertFalse(simulation.beginPull(at: SIMD2<Float>(16.5, 16.5), searchRadius: 2))
    }

    func testHoleRemainsAbsent() {
        let size = 32
        var mask = Array(repeating: UInt8(0), count: size * size)
        for y in 3..<29 {
            for x in 3..<29 where !(12..<20).contains(x) || !(12..<20).contains(y) {
                mask[y * size + x] = 255
            }
        }

        let simulation = PeelSimulation(width: size, height: size, alpha: mask)
        let snapshot = simulation.snapshot()
        let hole = 16 * size + 16
        XCTAssertEqual(snapshot.adhered[hole], 0)
        XCTAssertEqual(snapshot.released[hole], 0)
        XCTAssertEqual(snapshot.lifted[hole], 0)
    }

    func testSameGestureIsDeterministic() {
        let first = makeRectangle()
        let second = makeRectangle()
        let gestures = stride(from: Float(29), through: 52, by: 1.5).map { SIMD2<Float>($0, 20) }

        for simulation in [first, second] {
            XCTAssertTrue(simulation.beginPull(at: SIMD2<Float>(27.5, 16.5)))
            for point in gestures { _ = simulation.updatePull(to: point) }
            _ = simulation.endPull()
        }

        let a = first.snapshot()
        let b = second.snapshot()
        XCTAssertEqual(a.adhered, b.adhered)
        XCTAssertEqual(a.released, b.released)
        XCTAssertEqual(a.progress, b.progress)
    }


    func testLevelCatalogRecursesAndKeepsDuplicateNamesDistinct() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        for path in ["first/shared.png", "second/nested/shared.PNG", "second/readme.txt"] {
            let url = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: url)
        }
        let levels = LevelCatalog.images(in: root)
        XCTAssertEqual(levels.map(\.relativePath), ["first/shared.png", "second/nested/shared.PNG"])
        XCTAssertEqual(Set(levels.map(\.id)).count, 2)
    }

    func testPNGMaskUsesBottomLeftCoordinatesAndPreservesHoles() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
            context.cgContext.clear(CGRect(x: 4, y: 4, width: 4, height: 4))
        }
        let artwork = try XCTUnwrap(StickerArtworkFactory.pngSticker(image: image, pixelSize: 32, simulationSize: 32))
        XCTAssertEqual(artwork.simulationAlpha[29 * 32 + 2], 255)
        XCTAssertEqual(artwork.simulationAlpha[2 * 32 + 2], 0)
        XCTAssertEqual(artwork.simulationAlpha[29 * 32 + 29], 0)
        XCTAssertEqual(artwork.simulationAlpha[26 * 32 + 5], 0)
    }

    func testPNGArtworkFitsWithoutStretchingAndRejectsEmptyImages() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 16), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 16))
        }
        let artwork = try XCTUnwrap(StickerArtworkFactory.pngSticker(image: image, pixelSize: 32, simulationSize: 32))
        XCTAssertEqual(artwork.simulationAlpha[16 * 32 + 16], 255)
        XCTAssertEqual(artwork.simulationAlpha[2 * 32 + 16], 0)
        XCTAssertEqual(artwork.simulationAlpha[29 * 32 + 16], 0)
        let empty = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32), format: format).image { _ in }
        XCTAssertNil(StickerArtworkFactory.pngSticker(image: empty, pixelSize: 32, simulationSize: 32))
    }

    private func makeRectangle() -> PeelSimulation {
        let size = 32
        var mask = Array(repeating: UInt8(0), count: size * size)
        for y in 4..<28 {
            for x in 4..<28 {
                mask[y * size + x] = 255
            }
        }
        return PeelSimulation(width: size, height: size, alpha: mask)
    }
}


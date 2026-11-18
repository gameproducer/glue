import Foundation
import SpriteKit

final class MaskTexture {
    let texture: SKMutableTexture
    let width: Int
    let height: Int

    private let stateLock = NSLock()
    private var pendingAlpha: [UInt8]?
    private var updateInFlight = false

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        self.texture = SKMutableTexture(size: CGSize(width: width, height: height))
        self.texture.filteringMode = .linear
    }

    func update(alpha: [UInt8]) {
        precondition(alpha.count == width * height)
        stateLock.lock()
        pendingAlpha = alpha
        let shouldSchedule = !updateInFlight
        if shouldSchedule { updateInFlight = true }
        stateLock.unlock()

        if shouldSchedule { scheduleLatestUpdate() }
    }

    private func scheduleLatestUpdate() {
        stateLock.lock()
        guard let source = pendingAlpha else {
            updateInFlight = false
            stateLock.unlock()
            return
        }
        pendingAlpha = nil
        stateLock.unlock()

        texture.modifyPixelData { pointer, length in
            if let pointer, length >= source.count * 4 {
                let destination = pointer.assumingMemoryBound(to: UInt8.self)
                for index in source.indices {
                    let value = source[index]
                    let offset = index * 4
                    // SKMutableTexture expects premultiplied RGBA.
                    destination[offset] = value
                    destination[offset + 1] = value
                    destination[offset + 2] = value
                    destination[offset + 3] = value
                }
            }

            DispatchQueue.main.async { [weak self] in
                self?.scheduleLatestUpdate()
            }
        }
    }
}

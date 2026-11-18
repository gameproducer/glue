import SpriteKit
import UIKit

enum SurfaceTextureFactory {
    static func make(size: Int = 1_024) -> SKTexture {
        let canvas = CGSize(width: size, height: size)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true

        let image = UIGraphicsImageRenderer(size: canvas, format: format).image { renderer in
            let context = renderer.cgContext
            let colors = [
                UIColor(red: 0.075, green: 0.065, blue: 0.105, alpha: 1).cgColor,
                UIColor(red: 0.12, green: 0.08, blue: 0.15, alpha: 1).cgColor,
                UIColor(red: 0.055, green: 0.075, blue: 0.105, alpha: 1).cgColor
            ] as CFArray
            let gradient = CGGradient(
                colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: colors,
                locations: [0, 0.52, 1]
            )!
            context.drawLinearGradient(
                gradient,
                start: CGPoint(x: 0, y: canvas.height),
                end: CGPoint(x: canvas.width, y: 0),
                options: []
            )

            var seed: UInt32 = 0xC0FFEE
            for _ in 0..<4_000 {
                seed = seed &* 1_664_525 &+ 1_013_904_223
                let x = CGFloat(seed & 0xffff) / 65_535 * canvas.width
                seed = seed &* 1_664_525 &+ 1_013_904_223
                let y = CGFloat(seed & 0xffff) / 65_535 * canvas.height
                let brightness = CGFloat((seed >> 20) & 0x0f) / 15
                context.setFillColor(UIColor.white.withAlphaComponent(0.006 + brightness * 0.008).cgColor)
                context.fill(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }

        let texture = SKTexture(image: image)
        texture.filteringMode = .linear
        return texture
    }
}


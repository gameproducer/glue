import CoreGraphics
import ImageIO
import UIKit

struct StickerArtwork {
    let front: UIImage
    let back: UIImage
    let simulationWidth: Int
    let simulationHeight: Int
    let simulationAlpha: [UInt8]
}

enum StickerArtworkFactory {
    static func assessmentSticker(pixelSize: Int = 1_024, simulationSize: Int = 192) -> StickerArtwork {
        let front = renderArtwork(pixelSize: pixelSize, backside: false)
        let back = renderArtwork(pixelSize: pixelSize, backside: true)
        let alpha = renderSimulationMask(size: simulationSize)
        return StickerArtwork(
            front: front,
            back: back,
            simulationWidth: simulationSize,
            simulationHeight: simulationSize,
            simulationAlpha: alpha
        )
    }

    /// Fit the PNG into the renderer's square canvas without stretching its artwork.
    static func pngSticker(at url: URL, pixelSize: Int = 1_024, simulationSize: Int = 192) -> StickerArtwork? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: pixelSize
              ] as CFDictionary) else { return nil }
        return pngSticker(image: UIImage(cgImage: image), pixelSize: pixelSize, simulationSize: simulationSize)
    }

    static func pngSticker(image: UIImage, pixelSize: Int = 1_024, simulationSize: Int = 192) -> StickerArtwork? {
        guard pixelSize > 0, simulationSize > 0, image.size.width > 0, image.size.height > 0 else { return nil }
        let size = CGSize(width: pixelSize, height: pixelSize)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let scale = min(size.width / image.size.width, size.height / image.size.height)
        let fitted = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let front = renderer.image { _ in
            image.draw(in: CGRect(x: (size.width - fitted.width) / 2, y: (size.height - fitted.height) / 2,
                                  width: fitted.width, height: fitted.height))
        }
        let back = renderer.image { context in
            front.draw(at: .zero)
            context.cgContext.setBlendMode(.sourceIn)
            UIColor(red: 0.94, green: 0.90, blue: 0.81, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        guard let cgImage = front.cgImage else { return nil }
        var rgba = [UInt8](repeating: 0, count: simulationSize * simulationSize * 4)
        let rendered = rgba.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: simulationSize, height: simulationSize,
                bitsPerComponent: 8, bytesPerRow: simulationSize * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.interpolationQuality = .high
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: simulationSize, height: simulationSize))
            return true
        }
        guard rendered else { return nil }
        var alpha = [UInt8](repeating: 0, count: simulationSize * simulationSize)
        for y in 0..<simulationSize {
            for x in 0..<simulationSize {
                // CGImage rows start at the top; simulation and texture coordinates start at the bottom.
                alpha[y * simulationSize + x] = rgba[((simulationSize - 1 - y) * simulationSize + x) * 4 + 3]
            }
        }
        guard alpha.contains(where: { $0 > 20 }) else { return nil }
        return StickerArtwork(front: front, back: back, simulationWidth: simulationSize,
                              simulationHeight: simulationSize, simulationAlpha: alpha)
    }

    /// A deliberately demanding silhouette: broad lobes, concavities, narrow bridges, and holes.
    private static func stickerPath(size: CGSize) -> CGPath {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: x * size.width, y: y * size.height)
        }

        let path = CGMutablePath()
        path.move(to: point(0.50, 0.08))
        path.addCurve(to: point(0.18, 0.11), control1: point(0.42, 0.02), control2: point(0.25, 0.02))
        path.addCurve(to: point(0.10, 0.34), control1: point(0.08, 0.17), control2: point(0.04, 0.27))
        path.addCurve(to: point(0.18, 0.48), control1: point(0.12, 0.41), control2: point(0.15, 0.45))
        path.addCurve(to: point(0.07, 0.76), control1: point(0.02, 0.57), control2: point(0.00, 0.70))
        path.addCurve(to: point(0.29, 0.94), control1: point(0.12, 0.91), control2: point(0.21, 0.98))
        path.addCurve(to: point(0.48, 0.68), control1: point(0.42, 0.93), control2: point(0.43, 0.77))
        path.addCurve(to: point(0.52, 0.68), control1: point(0.49, 0.64), control2: point(0.51, 0.64))
        path.addCurve(to: point(0.71, 0.94), control1: point(0.57, 0.77), control2: point(0.58, 0.93))
        path.addCurve(to: point(0.93, 0.76), control1: point(0.79, 0.98), control2: point(0.88, 0.91))
        path.addCurve(to: point(0.82, 0.48), control1: point(1.00, 0.70), control2: point(0.98, 0.57))
        path.addCurve(to: point(0.90, 0.34), control1: point(0.85, 0.45), control2: point(0.88, 0.41))
        path.addCurve(to: point(0.82, 0.11), control1: point(0.96, 0.27), control2: point(0.92, 0.17))
        path.addCurve(to: point(0.50, 0.08), control1: point(0.75, 0.02), control2: point(0.58, 0.02))
        path.closeSubpath()

        path.addEllipse(in: CGRect(x: size.width * 0.19, y: size.height * 0.57, width: size.width * 0.14, height: size.height * 0.18))
        path.addEllipse(in: CGRect(x: size.width * 0.67, y: size.height * 0.57, width: size.width * 0.14, height: size.height * 0.18))
        return path
    }

    private static func renderArtwork(pixelSize: Int, backside: Bool) -> UIImage {
        let size = CGSize(width: pixelSize, height: pixelSize)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false

        return UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let context = renderer.cgContext
            context.translateBy(x: 0, y: size.height)
            context.scaleBy(x: 1, y: -1)

            let path = stickerPath(size: size)
            context.addPath(path)
            context.clip(using: .evenOdd)

            let colors: [CGColor]
            if backside {
                colors = [
                    UIColor(red: 0.96, green: 0.91, blue: 0.82, alpha: 1).cgColor,
                    UIColor(red: 0.82, green: 0.75, blue: 0.67, alpha: 1).cgColor,
                    UIColor(red: 0.98, green: 0.95, blue: 0.89, alpha: 1).cgColor
                ]
            } else {
                colors = [
                    UIColor(red: 0.98, green: 0.25, blue: 0.45, alpha: 1).cgColor,
                    UIColor(red: 0.55, green: 0.18, blue: 0.92, alpha: 1).cgColor,
                    UIColor(red: 0.04, green: 0.70, blue: 0.89, alpha: 1).cgColor,
                    UIColor(red: 0.98, green: 0.72, blue: 0.16, alpha: 1).cgColor
                ]
            }

            let locations = colors.indices.map { CGFloat($0) / CGFloat(colors.count - 1) }
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: locations)!
            context.drawLinearGradient(
                gradient,
                start: CGPoint(x: size.width * 0.08, y: size.height * 0.90),
                end: CGPoint(x: size.width * 0.92, y: size.height * 0.10),
                options: []
            )

            context.setBlendMode(backside ? .multiply : .softLight)
            context.setLineWidth(size.width * 0.018)
            context.setStrokeColor(UIColor.white.withAlphaComponent(backside ? 0.16 : 0.38).cgColor)
            for offset in stride(from: -pixelSize, through: pixelSize * 2, by: max(1, pixelSize / 11)) {
                context.move(to: CGPoint(x: CGFloat(offset), y: 0))
                context.addLine(to: CGPoint(x: CGFloat(offset + pixelSize), y: CGFloat(pixelSize)))
            }
            context.strokePath()

            if !backside {
                context.setBlendMode(.screen)
                for i in 0..<18 {
                    let x = CGFloat((i * 83) % 760 + 130) / 1_024 * size.width
                    let y = CGFloat((i * 137) % 710 + 150) / 1_024 * size.height
                    let radius = size.width * CGFloat(0.010 + Double(i % 4) * 0.004)
                    context.setFillColor(UIColor.white.withAlphaComponent(0.34).cgColor)
                    context.fillEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
                }
            }

            context.resetClip()
            context.setBlendMode(.normal)
            context.addPath(path)
            context.setStrokeColor(UIColor.white.withAlphaComponent(backside ? 0.48 : 0.82).cgColor)
            context.setLineWidth(size.width * 0.012)
            context.strokePath()
        }
    }

    private static func renderSimulationMask(size: Int) -> [UInt8] {
        var pixels = Array(repeating: UInt8(0), count: size * size)
        pixels.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(
                data: bytes.baseAddress,
                width: size,
                height: size,
                bitsPerComponent: 8,
                bytesPerRow: size,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return }

            context.setAllowsAntialiasing(true)
            context.setShouldAntialias(true)
            context.setFillColor(gray: 1, alpha: 1)
            context.addPath(stickerPath(size: CGSize(width: size, height: size)))
            context.fillPath(using: .evenOdd)
        }
        return pixels
    }
}


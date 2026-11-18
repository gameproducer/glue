import SpriteKit
import simd
import UIKit

final class StickerNode: SKNode {
    let displaySize: CGSize

    private let simulationWidth: Int
    private let simulationHeight: Int
    private let material: PeelMaterial

    private let adheredMask: MaskTexture
    private let releasedMask: MaskTexture
    private let liftedMask: MaskTexture

    private let baseShadow: SKSpriteNode
    private let adheredSprite: SKSpriteNode
    private let releasedShadow: SKSpriteNode
    private let releasedSprite: SKSpriteNode
    private let liftedShadow: SKSpriteNode
    private let liftedSprite: SKSpriteNode

    private let frontLine = SKShapeNode()
    private let grabMarker = SKShapeNode(circleOfRadius: 5)
    private var lastMaskRevision: UInt64 = 0
    private var debugVisible = false
    private let warpColumns = 22
    private let warpRows = 22

    init(artwork: StickerArtwork, displaySize: CGSize, material: PeelMaterial) {
        self.displaySize = displaySize
        self.simulationWidth = artwork.simulationWidth
        self.simulationHeight = artwork.simulationHeight
        self.material = material

        let frontTexture = SKTexture(image: artwork.front)
        let backTexture = SKTexture(image: artwork.back)
        frontTexture.filteringMode = .linear
        backTexture.filteringMode = .linear

        adheredMask = MaskTexture(width: simulationWidth, height: simulationHeight)
        releasedMask = MaskTexture(width: simulationWidth, height: simulationHeight)
        liftedMask = MaskTexture(width: simulationWidth, height: simulationHeight)

        baseShadow = SKSpriteNode(texture: frontTexture, size: displaySize)
        adheredSprite = SKSpriteNode(texture: frontTexture, size: displaySize)
        releasedShadow = SKSpriteNode(texture: frontTexture, size: displaySize)
        releasedSprite = SKSpriteNode(texture: frontTexture, size: displaySize)
        liftedShadow = SKSpriteNode(texture: frontTexture, size: displaySize)
        liftedSprite = SKSpriteNode(texture: frontTexture, size: displaySize)

        super.init()

        baseShadow.color = UIColor(red: 0.13, green: 0.07, blue: 0.18, alpha: 1)
        baseShadow.colorBlendFactor = 1
        baseShadow.alpha = 0.13
        baseShadow.position = CGPoint(x: 0, y: -4)
        baseShadow.setScale(1.008)
        baseShadow.zPosition = 0

        adheredSprite.shader = Self.maskShader(named: "MaskedSticker.fsh", mask: adheredMask.texture)
        adheredSprite.zPosition = 1

        releasedShadow.shader = Self.maskShader(named: "MaskShadow.fsh", mask: releasedMask.texture)
        releasedShadow.position = CGPoint(x: 1.5, y: -3)
        releasedShadow.zPosition = 2

        releasedSprite.shader = Self.maskShader(named: "ReleasedSticker.fsh", mask: releasedMask.texture)
        releasedSprite.position = CGPoint(x: 0, y: 1.0)
        releasedSprite.zPosition = 3

        liftedShadow.shader = Self.maskShader(named: "MaskShadow.fsh", mask: liftedMask.texture)
        liftedShadow.position = CGPoint(x: 5, y: -8)
        liftedShadow.alpha = 0.72
        liftedShadow.zPosition = 4

        let liftedShader = SKShader(fileNamed: "LiftedSticker.fsh")
        liftedShader.uniforms = [
            SKUniform(name: "u_mask", texture: liftedMask.texture),
            SKUniform(name: "u_back_texture", texture: backTexture),
            SKUniform(name: "u_front", vectorFloat2: SIMD2<Float>.zero),
            SKUniform(name: "u_pull_direction", vectorFloat2: SIMD2<Float>(0, 1)),
            SKUniform(name: "u_radius", float: material.bendRadius / Float(max(simulationWidth, simulationHeight))),
            SKUniform(name: "u_tension", float: 0),
            SKUniform(name: "u_cone", float: 0)
        ]
        liftedSprite.shader = liftedShader
        liftedSprite.zPosition = 5

        for sprite in [baseShadow, adheredSprite, releasedShadow, releasedSprite, liftedShadow, liftedSprite] {
            sprite.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            addChild(sprite)
        }

        frontLine.strokeColor = UIColor.white.withAlphaComponent(0.9)
        frontLine.lineWidth = 1.5
        frontLine.glowWidth = 1
        frontLine.zPosition = 20
        frontLine.isHidden = true
        addChild(frontLine)

        grabMarker.fillColor = UIColor.white
        grabMarker.strokeColor = UIColor.black.withAlphaComponent(0.5)
        grabMarker.lineWidth = 1
        grabMarker.zPosition = 21
        grabMarker.isHidden = true
        addChild(grabMarker)
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func simulationPoint(fromLocalPoint point: CGPoint) -> SIMD2<Float> {
        let u = Float(point.x / displaySize.width + 0.5)
        let v = Float(point.y / displaySize.height + 0.5)
        return SIMD2<Float>(u * Float(simulationWidth), v * Float(simulationHeight))
    }

    func render(snapshot: PeelSnapshot, curlProfile: CurlProfile) {
        if snapshot.revision != lastMaskRevision {
            adheredMask.update(alpha: snapshot.adhered)
            releasedMask.update(alpha: snapshot.released)
            liftedMask.update(alpha: snapshot.lifted)
            lastMaskRevision = snapshot.revision
        }

        let pulling = snapshot.grabPoint != nil
        liftedSprite.isHidden = !pulling
        liftedShadow.isHidden = !pulling
        updateWarp(snapshot: snapshot, profile: curlProfile)
        updateLiftedShader(snapshot: snapshot, profile: curlProfile)
        updateDebug(snapshot: snapshot)
    }

    func setDebugVisible(_ visible: Bool) {
        debugVisible = visible
        frontLine.isHidden = !visible
        grabMarker.isHidden = !visible
    }

    func animateCleanRelease(direction: SIMD2<Float>) {
        removeAllActions()
        let normalized = simd_length_squared(direction) > 0.001 ? simd_normalize(direction) : SIMD2<Float>(0, 1)
        let travel = CGVector(dx: CGFloat(normalized.x) * 150, dy: CGFloat(normalized.y) * 150)
        let rotation = CGFloat(-normalized.x) * 0.16
        run(.group([
            .move(by: travel, duration: 0.62),
            .rotate(byAngle: rotation, duration: 0.62),
            .scale(to: 0.92, duration: 0.62),
            .fadeOut(withDuration: 0.62)
        ]))
    }

    func animateTear(direction: SIMD2<Float>) {
        removeAllActions()
        let tangent = SIMD2<Float>(-direction.y, direction.x)
        let displacement = CGVector(dx: CGFloat(tangent.x) * 8, dy: CGFloat(tangent.y) * 8)
        run(.sequence([
            .move(by: displacement, duration: 0.045),
            .move(by: CGVector(dx: -displacement.dx * 1.7, dy: -displacement.dy * 1.7), duration: 0.07),
            .move(by: CGVector(dx: displacement.dx * 0.7, dy: displacement.dy * 0.7), duration: 0.09)
        ]))
    }

    private func updateWarp(snapshot: PeelSnapshot, profile: CurlProfile) {
        guard let grab = snapshot.grabPoint else {
            liftedSprite.warpGeometry = nil
            liftedShadow.warpGeometry = nil
            return
        }

        let width = Float(simulationWidth)
        let height = Float(simulationHeight)
        let front = snapshot.peelFrontPoint / SIMD2<Float>(width, height)
        let direction = simd_normalize(snapshot.pullDirection)
        let tangent = SIMD2<Float>(-direction.y, direction.x)
        let baseRadius = material.bendRadius / Float(max(simulationWidth, simulationHeight))
        let grabUV = grab / SIMD2<Float>(width, height)
        let maxArc = max(0.001, simd_dot(grabUV - front, direction))
        let coneAmount: Float = profile == .cone ? 0.72 : 0

        var source: [SIMD2<Float>] = []
        var destination: [SIMD2<Float>] = []
        source.reserveCapacity((warpColumns + 1) * (warpRows + 1))
        destination.reserveCapacity((warpColumns + 1) * (warpRows + 1))

        for row in 0...warpRows {
            for column in 0...warpColumns {
                let point = SIMD2<Float>(
                    Float(column) / Float(warpColumns),
                    Float(row) / Float(warpRows)
                )
                source.append(point)

                let relative = point - front
                let arc = simd_dot(relative, direction)
                guard arc > 0 else {
                    destination.append(point)
                    continue
                }

                let lateral = simd_dot(relative, tangent)
                let normalizedLateral = max(-1, min(1, lateral * 2.2))
                let localRadius = max(baseRadius * 0.38, baseRadius * (1 + coneAmount * normalizedLateral))
                let curlArc = min(arc, localRadius * Float.pi * 0.5)
                var projected = localRadius * sin(curlArc / localRadius)
                if arc > curlArc {
                    let remaining = arc - curlArc
                    let stretch = 0.82 + min(0.13, snapshot.tension * 0.006)
                    projected += remaining * stretch
                }

                // Keep the grabbed material responsive even as the curl consumes arc length.
                let endCorrection = max(0, maxArc - projected) * min(1, arc / maxArc) * 0.08
                let coneTwist = tangent * (coneAmount * normalizedLateral * sin(min(1, arc / maxArc) * .pi) * baseRadius * 0.18)
                destination.append(point + direction * (projected - arc + endCorrection) + coneTwist)
            }
        }

        let geometry = SKWarpGeometryGrid(
            columns: warpColumns,
            rows: warpRows,
            sourcePositions: source,
            destinationPositions: destination
        )
        liftedSprite.warpGeometry = geometry
        liftedShadow.warpGeometry = geometry
    }

    private func updateLiftedShader(snapshot: PeelSnapshot, profile: CurlProfile) {
        guard let shader = liftedSprite.shader else { return }
        let size = SIMD2<Float>(Float(simulationWidth), Float(simulationHeight))
        let front = snapshot.peelFrontPoint / size
        shader.uniformNamed("u_front")?.vectorFloat2Value = front
        shader.uniformNamed("u_pull_direction")?.vectorFloat2Value = snapshot.pullDirection
        shader.uniformNamed("u_tension")?.floatValue = snapshot.tension
        shader.uniformNamed("u_cone")?.floatValue = profile == .cone ? 0.72 : 0
    }

    private func updateDebug(snapshot: PeelSnapshot) {
        guard debugVisible, let grab = snapshot.grabPoint else {
            frontLine.isHidden = true
            grabMarker.isHidden = true
            return
        }

        let front = localPoint(fromSimulationPoint: snapshot.peelFrontPoint)
        let direction = snapshot.pullDirection
        let tangent = SIMD2<Float>(-direction.y, direction.x)
        let span = Float(max(displaySize.width, displaySize.height))
        let a = CGPoint(x: front.x - CGFloat(tangent.x * span), y: front.y - CGFloat(tangent.y * span))
        let b = CGPoint(x: front.x + CGFloat(tangent.x * span), y: front.y + CGFloat(tangent.y * span))
        let path = CGMutablePath()
        path.move(to: a)
        path.addLine(to: b)
        frontLine.path = path
        frontLine.isHidden = false
        grabMarker.position = localPoint(fromSimulationPoint: grab)
        grabMarker.isHidden = false
    }

    private func localPoint(fromSimulationPoint point: SIMD2<Float>) -> CGPoint {
        CGPoint(
            x: (CGFloat(point.x) / CGFloat(simulationWidth) - 0.5) * displaySize.width,
            y: (CGFloat(point.y) / CGFloat(simulationHeight) - 0.5) * displaySize.height
        )
    }

    private static func maskShader(named filename: String, mask: SKTexture) -> SKShader {
        let shader = SKShader(fileNamed: filename)
        shader.uniforms = [SKUniform(name: "u_mask", texture: mask)]
        return shader
    }
}

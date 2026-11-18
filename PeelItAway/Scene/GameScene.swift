import QuartzCore
import SpriteKit
import UIKit

final class GameScene: SKScene {
    private struct StableInput {
        var lastViewPoint: CGPoint
        var simulationPoint: SIMD2<Float>
    }

    private let cameraNode = SKCameraNode()
    private let worldNode = SKNode()
    private let hudNode = SKNode()
    private let material = PeelMaterial.assessment

    private var artwork: StickerArtwork?
    private var simulation: PeelSimulation?
    private var stickerNode: StickerNode?
    private var surfaceNode: SKSpriteNode?
    private var stableInput: StableInput?

    private let titleLabel = SKLabelNode(fontNamed: "AvenirNext-Bold")
    private let movesLabel = SKLabelNode(fontNamed: "AvenirNext-DemiBold")
    private let progressLabel = SKLabelNode(fontNamed: "AvenirNext-Regular")
    private let instructionLabel = SKLabelNode(fontNamed: "AvenirNext-Regular")
    private let messageLabel = SKLabelNode(fontNamed: "AvenirNext-Bold")
    private let performanceLabel = SKLabelNode(fontNamed: "Menlo-Regular")
    private let curlButton = ControlButtonNode(title: "CURL · CYLINDER", actionName: "curl")
    private let debugButton = ControlButtonNode(title: "DEBUG · OFF", actionName: "debug", width: 112)
    private let resetButton = ControlButtonNode(title: "RESET", actionName: "reset", width: 82)

    private var curlProfile: CurlProfile = .cylinder
    private var debugEnabled = false
    private var moves = 0
    private let maximumMoves = 4
    private var interactionLocked = false
    private var simulationMilliseconds: Double = 0
    private var smoothedFPS: Double = 60
    private var previousFrameTime: TimeInterval = 0
    private var isConfigured = false

    override convenience init() {
        self.init(size: UIScreen.main.bounds.size)
    }

    override init(size: CGSize) {
        super.init(size: size)
        scaleMode = .resizeFill
        anchorPoint = CGPoint(x: 0.5, y: 0.5)
        backgroundColor = UIColor(red: 0.06, green: 0.05, blue: 0.085, alpha: 1)
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMove(to view: SKView) {
        guard !isConfigured else { return }
        isConfigured = true
        view.isMultipleTouchEnabled = false
        view.preferredFramesPerSecond = 60
        configureScene()
    }

    override func didChangeSize(_ oldSize: CGSize) {
        guard isConfigured else { return }
        layoutScene()
    }

    private func configureScene() {
        camera = cameraNode
        cameraNode.position = .zero
        addChild(worldNode)
        addChild(cameraNode)
        cameraNode.addChild(hudNode)

        let surface = SKSpriteNode(texture: SurfaceTextureFactory.make())
        surface.zPosition = -100
        worldNode.addChild(surface)
        surfaceNode = surface

        configureLabel(titleLabel, size: 19, color: .white)
        titleLabel.text = "PEEL · MATERIAL STUDY"
        titleLabel.horizontalAlignmentMode = .left

        configureLabel(movesLabel, size: 15, color: UIColor.white.withAlphaComponent(0.90))
        movesLabel.horizontalAlignmentMode = .left

        configureLabel(progressLabel, size: 13, color: UIColor.white.withAlphaComponent(0.62))
        progressLabel.horizontalAlignmentMode = .left

        configureLabel(instructionLabel, size: 14, color: UIColor.white.withAlphaComponent(0.70))
        instructionLabel.text = "Catch an exposed edge, then pull. Direction changes the release front."

        configureLabel(messageLabel, size: 22, color: .white)
        messageLabel.alpha = 0

        configureLabel(performanceLabel, size: 10, color: UIColor.white.withAlphaComponent(0.45))
        performanceLabel.horizontalAlignmentMode = .right

        for node in [titleLabel, movesLabel, progressLabel, instructionLabel, messageLabel, performanceLabel, curlButton, debugButton, resetButton] {
            hudNode.addChild(node)
        }

        if artwork == nil { artwork = StickerArtworkFactory.assessmentSticker() }
        resetLevel()
        layoutScene()
    }

    private func configureLabel(_ label: SKLabelNode, size: CGFloat, color: UIColor) {
        label.fontSize = size
        label.fontColor = color
        label.verticalAlignmentMode = .center
        label.zPosition = 200
    }

    func setArtwork(_ artwork: StickerArtwork) {
        self.artwork = artwork
        if isConfigured { resetLevel() }
    }

    private func resetLevel() {
        guard let artwork else { return }
        stableInput = nil
        simulation = PeelSimulation(
            width: artwork.simulationWidth,
            height: artwork.simulationHeight,
            alpha: artwork.simulationAlpha,
            material: material
        )

        stickerNode?.removeFromParent()
        let displayEdge = min(max(380, min(size.width, size.height) * 0.72), 690)
        let sticker = StickerNode(
            artwork: artwork,
            displaySize: CGSize(width: displayEdge, height: displayEdge),
            material: material
        )
        sticker.zPosition = 10
        sticker.setDebugVisible(debugEnabled)
        worldNode.addChild(sticker)
        stickerNode = sticker

        moves = 0
        interactionLocked = false
        messageLabel.removeAllActions()
        messageLabel.alpha = 0
        cameraNode.position = .zero
        cameraNode.setScale(1)
        renderCurrentState()
        layoutScene()
    }

    private func layoutScene() {
        surfaceNode?.size = CGSize(width: size.width * 3.2, height: size.height * 3.2)

        let horizontal = size.width / 2 - 24
        let top = size.height / 2 - 38
        titleLabel.position = CGPoint(x: -horizontal, y: top)
        movesLabel.position = CGPoint(x: -horizontal, y: top - 30)
        progressLabel.position = CGPoint(x: -horizontal, y: top - 52)
        performanceLabel.position = CGPoint(x: horizontal, y: top)

        let bottom = -size.height / 2 + 42
        instructionLabel.position = CGPoint(x: 0, y: bottom + 2)
        curlButton.position = CGPoint(x: -126, y: bottom + 48)
        debugButton.position = CGPoint(x: 18, y: bottom + 48)
        resetButton.position = CGPoint(x: 128, y: bottom + 48)
        messageLabel.position = CGPoint(x: 0, y: size.height * 0.34)

        guard let stickerNode else { return }
        let availableWidth = max(280, size.width - 42)
        let availableHeight = max(280, size.height - 210)
        let fit = min(1, availableWidth / stickerNode.displaySize.width, availableHeight / stickerNode.displaySize.height)
        stickerNode.setScale(fit)
        stickerNode.position = CGPoint(x: 0, y: max(-20, -size.height * 0.015))
    }

    // MARK: - Touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let scenePoint = touch.location(in: self)
        if let action = controlAction(at: scenePoint) {
            performControl(action)
            return
        }

        guard !interactionLocked, let simulation, let stickerNode, let view else { return }
        let local = stickerNode.convert(scenePoint, from: self)
        let simulationPoint = stickerNode.simulationPoint(fromLocalPoint: local)
        guard simulation.beginPull(at: simulationPoint) else {
            showTransientMessage("GRAB AN EXPOSED EDGE", color: UIColor.white.withAlphaComponent(0.72))
            return
        }

        stableInput = StableInput(lastViewPoint: touch.location(in: view), simulationPoint: simulationPoint)
        renderCurrentState()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first,
              var input = stableInput,
              let simulation,
              let stickerNode,
              let view else { return }

        let viewPoint = touch.location(in: view)
        let delta = CGPoint(x: viewPoint.x - input.lastViewPoint.x, y: viewPoint.y - input.lastViewPoint.y)
        let visibleStickerWidth = stickerNode.displaySize.width * stickerNode.xScale / cameraNode.xScale
        let visibleStickerHeight = stickerNode.displaySize.height * stickerNode.yScale / cameraNode.yScale
        input.simulationPoint.x += Float(delta.x / visibleStickerWidth) * Float(simulation.width)
        input.simulationPoint.y -= Float(delta.y / visibleStickerHeight) * Float(simulation.height)
        input.lastViewPoint = viewPoint
        stableInput = input

        let start = CACurrentMediaTime()
        let snapshot = simulation.updatePull(to: input.simulationPoint)
        simulationMilliseconds = (CACurrentMediaTime() - start) * 1_000
        stickerNode.render(snapshot: snapshot, curlProfile: curlProfile)
        updateHUD(snapshot: snapshot)

        if snapshot.isTorn {
            showPersistentMessage("MATERIAL FAILURE · TORN", color: UIColor(red: 1, green: 0.35, blue: 0.42, alpha: 1))
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        finishPull()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        simulation?.cancelPull()
        stableInput = nil
        renderCurrentState()
    }

    private func finishPull() {
        guard stableInput != nil, let simulation else { return }
        stableInput = nil
        let liveSnapshot = simulation.snapshot()
        let result = simulation.endPull()

        if result.consumedMove { moves += 1 }
        updateHUD(snapshot: result.snapshot)

        if result.torn {
            stickerNode?.render(snapshot: result.snapshot, curlProfile: curlProfile)
            stickerNode?.animateTear(direction: liveSnapshot.pullDirection)
            interactionLocked = true
            showPersistentMessage("MATERIAL FAILURE · TORN", color: UIColor(red: 1, green: 0.35, blue: 0.42, alpha: 1))
        } else if result.completed {
            // Preserve the final lifted pose while the complete sticker leaves the surface.
            stickerNode?.render(snapshot: liveSnapshot, curlProfile: curlProfile)
            stickerNode?.animateCleanRelease(direction: liveSnapshot.pullDirection)
            interactionLocked = true
            showPersistentMessage("CLEAN RELEASE", color: UIColor(red: 0.40, green: 1, blue: 0.74, alpha: 1))
        } else if moves >= maximumMoves {
            stickerNode?.render(snapshot: result.snapshot, curlProfile: curlProfile)
            interactionLocked = true
            showPersistentMessage("OUT OF MOVES", color: UIColor(red: 1, green: 0.72, blue: 0.28, alpha: 1))
        } else {
            stickerNode?.render(snapshot: result.snapshot, curlProfile: curlProfile)
        }
    }

    // MARK: - Controls

    private func controlAction(at scenePoint: CGPoint) -> String? {
        var node: SKNode? = atPoint(scenePoint)
        while let current = node {
            if ["curl", "debug", "reset"].contains(current.name ?? "") { return current.name }
            node = current.parent
        }
        return nil
    }

    private func performControl(_ action: String) {
        switch action {
        case "curl":
            curlProfile = curlProfile == .cylinder ? .cone : .cylinder
            curlButton.setTitle("CURL · \(curlProfile.displayName)")
            renderCurrentState()
        case "debug":
            debugEnabled.toggle()
            debugButton.setTitle(debugEnabled ? "DEBUG · ON" : "DEBUG · OFF")
            stickerNode?.setDebugVisible(debugEnabled)
            renderCurrentState()
        case "reset":
            resetLevel()
        default:
            break
        }
    }

    // MARK: - Frame update

    override func update(_ currentTime: TimeInterval) {
        if previousFrameTime > 0 {
            let instantaneous = 1 / max(0.001, currentTime - previousFrameTime)
            smoothedFPS += (instantaneous - smoothedFPS) * 0.08
        }
        previousFrameTime = currentTime

        updateCamera()
        performanceLabel.text = String(format: "%.0f FPS  ·  SIM %.2f ms", smoothedFPS, simulationMilliseconds)
    }

    private func updateCamera() {
        var targetScale: CGFloat = 1
        var targetPosition = CGPoint.zero

        if let state = stableInput, let simulation, let stickerNode {
            let normalized = SIMD2<Float>(state.simulationPoint.x / Float(simulation.width), state.simulationPoint.y / Float(simulation.height))
            let local = CGPoint(
                x: (CGFloat(normalized.x) - 0.5) * stickerNode.displaySize.width,
                y: (CGFloat(normalized.y) - 0.5) * stickerNode.displaySize.height
            )
            let world = stickerNode.convert(local, to: self)
            let extentX = max(stickerNode.frame.width / 2, abs(world.x)) + 54
            let extentY = max(stickerNode.frame.height / 2, abs(world.y)) + 84
            targetScale = max(1, max(extentX * 2 / max(1, size.width), extentY * 2 / max(1, size.height)))
            targetScale = min(1.42, targetScale)
            targetPosition = CGPoint(x: world.x * 0.12, y: world.y * 0.10)
        }

        cameraNode.xScale += (targetScale - cameraNode.xScale) * 0.055
        cameraNode.yScale = cameraNode.xScale
        cameraNode.position.x += (targetPosition.x - cameraNode.position.x) * 0.045
        cameraNode.position.y += (targetPosition.y - cameraNode.position.y) * 0.045
    }

    private func renderCurrentState() {
        guard let snapshot = simulation?.snapshot() else { return }
        stickerNode?.render(snapshot: snapshot, curlProfile: curlProfile)
        updateHUD(snapshot: snapshot)
    }

    private func updateHUD(snapshot: PeelSnapshot) {
        movesLabel.text = "MOVES  \(moves) / \(maximumMoves)"
        progressLabel.text = String(format: "RELEASED  %02.0f%%  ·  TENSION  %.1f", snapshot.progress * 100, snapshot.tension)
    }

    private func showPersistentMessage(_ text: String, color: UIColor) {
        messageLabel.removeAllActions()
        messageLabel.text = text
        messageLabel.fontColor = color
        messageLabel.alpha = 1
        messageLabel.setScale(0.94)
        messageLabel.run(.scale(to: 1, duration: 0.16))
    }

    private func showTransientMessage(_ text: String, color: UIColor) {
        messageLabel.removeAllActions()
        messageLabel.text = text
        messageLabel.fontColor = color
        messageLabel.alpha = 0
        messageLabel.run(.sequence([
            .fadeIn(withDuration: 0.12),
            .wait(forDuration: 0.7),
            .fadeOut(withDuration: 0.22)
        ]))
    }
}

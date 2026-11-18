import SpriteKit

final class ControlButtonNode: SKShapeNode {
    let actionName: String
    private let label = SKLabelNode(fontNamed: "AvenirNext-DemiBold")

    init(title: String, actionName: String, width: CGFloat = 132) {
        self.actionName = actionName
        super.init()

        let rect = CGRect(x: -width / 2, y: -20, width: width, height: 40)
        path = CGPath(roundedRect: rect, cornerWidth: 12, cornerHeight: 12, transform: nil)
        fillColor = UIColor(white: 0.08, alpha: 0.72)
        strokeColor = UIColor.white.withAlphaComponent(0.20)
        lineWidth = 1
        name = actionName

        label.text = title
        label.fontSize = 12
        label.fontColor = UIColor.white
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        label.name = actionName
        addChild(label)
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setTitle(_ title: String) {
        label.text = title
    }
}


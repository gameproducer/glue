import SpriteKit
import SwiftUI

struct GameView: View {
    @State private var scene = GameScene()
    @State private var levels = LevelCatalog.bundled()
    @State private var showingLevels = false
    @State private var loadError: String?
    @State private var restoredLevel = false
    @AppStorage("selectedLevelPath") private var selectedLevelPath = ""

    var body: some View {
        GeometryReader { proxy in
            SpriteView(scene: scene, preferredFramesPerSecond: 60, options: [.ignoresSiblingOrder])
                .ignoresSafeArea()
                .onAppear {
                    scene.size = proxy.size
                    scene.scaleMode = .resizeFill
                    guard !restoredLevel else { return }
                    restoredLevel = true
                    if let level = levels.first(where: { $0.relativePath == selectedLevelPath }) {
                        select(level)
                    } else {
                        selectedLevelPath = ""
                    }
                }
                .onChange(of: proxy.size) { newSize in
                    scene.size = newSize
                }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                showingLevels = true
            } label: {
                Label("Levels", systemImage: "square.grid.2x2")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
            }
            .tint(.white)
            .padding(.trailing, 20)
            .padding(.top, 88)
            .accessibilityValue(selectedLevelPath.isEmpty ? "Assessment sticker" : selectedLevelPath)
        }
        .sheet(isPresented: $showingLevels) {
            LevelPickerView(levels: levels, selectedPath: selectedLevelPath, onSelect: select)
        }
        .alert("Couldn’t load level", isPresented: Binding(
            get: { loadError != nil },
            set: { if !$0 { loadError = nil } }
        )) {
            Button("OK", role: .cancel) { loadError = nil }
        } message: {
            Text(loadError ?? "")
        }
        .background(Color.black)
        .persistentSystemOverlays(.hidden)
    }

    private func select(_ level: LevelImage?) {
        if let level {
            guard let artwork = StickerArtworkFactory.pngSticker(at: level.url) else {
                loadError = "\(level.relativePath) could not be read or has no peelable pixels. Choose another PNG."
                return
            }
            scene.setArtwork(artwork)
            selectedLevelPath = level.relativePath
        } else {
            scene.setArtwork(StickerArtworkFactory.assessmentSticker())
            selectedLevelPath = ""
        }
        showingLevels = false
    }
}

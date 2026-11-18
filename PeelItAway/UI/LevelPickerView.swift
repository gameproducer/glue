import ImageIO
import SwiftUI

struct LevelPickerView: View {
    let levels: [LevelImage]
    let selectedPath: String
    let onSelect: (LevelImage?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var filtered: [LevelImage] {
        levels.filter { search.isEmpty || $0.relativePath.localizedCaseInsensitiveContains(search) }
    }

    private var folders: [String] {
        Set(filtered.map(\.folder)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                if search.isEmpty {
                    Section {
                        Button {
                            onSelect(nil)
                        } label: {
                            HStack {
                                Label("Assessment sticker", systemImage: "sparkles")
                                Spacer()
                                if selectedPath.isEmpty { Image(systemName: "checkmark.circle.fill") }
                            }
                        }
                    }
                }
                ForEach(folders, id: \.self) { folder in
                    Section(folder) {
                        ForEach(filtered.filter { $0.folder == folder }) { level in
                            Button {
                                onSelect(level)
                            } label: {
                                HStack(spacing: 14) {
                                    LevelThumbnail(url: level.url)
                                    Text(level.name).foregroundStyle(.primary)
                                    Spacer()
                                    if selectedPath == level.relativePath {
                                        Image(systemName: "checkmark.circle.fill")
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .accessibilityLabel("\(level.name), \(level.folder)")
                            .accessibilityAddTraits(selectedPath == level.relativePath ? .isSelected : [])
                        }
                    }
                }
            }
            .overlay {
                if filtered.isEmpty {
                    ContentUnavailableView(
                        levels.isEmpty ? "No levels found" : "No matching levels",
                        systemImage: "photo.on.rectangle.angled",
                        description: Text(levels.isEmpty ? "Add PNG images to the Levels folder and rebuild the app." : "Try another file or folder name.")
                    )
                }
            }
            .navigationTitle("Choose level")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "Search files or folders")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct LevelThumbnail: View {
    let url: URL
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.12))
            if let image {
                Image(uiImage: image).resizable().scaledToFit().padding(5)
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .frame(width: 56, height: 56)
        .task(id: url) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 112
                  ] as CFDictionary) else { return }
            image = UIImage(cgImage: thumbnail)
        }
    }
}

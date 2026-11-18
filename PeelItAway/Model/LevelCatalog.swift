import Foundation

struct LevelImage: Identifiable {
    let url: URL
    let relativePath: String

    var id: String { relativePath }
    var name: String { url.deletingPathExtension().lastPathComponent }
    var folder: String {
        let parent = (relativePath as NSString).deletingLastPathComponent
        return parent.isEmpty ? "Levels" : parent
    }
}

enum LevelCatalog {
    static func bundled() -> [LevelImage] {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Levels", isDirectory: true) else { return [] }
        return images(in: root)
    }

    static func images(in root: URL) -> [LevelImage] {
        guard let files = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        let prefix = root.standardizedFileURL.path + "/"
        return files.compactMap { item -> LevelImage? in
            guard let url = item as? URL,
                  url.pathExtension.lowercased() == "png",
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
            let path = url.standardizedFileURL.path
            guard path.hasPrefix(prefix) else { return nil }
            return LevelImage(url: url, relativePath: String(path.dropFirst(prefix.count)))
        }.sorted { $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending }
    }
}

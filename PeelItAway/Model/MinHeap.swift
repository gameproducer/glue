import Foundation

struct MinHeap<Element> {
    private var storage: [Element] = []
    private let areSorted: (Element, Element) -> Bool

    init(sort: @escaping (Element, Element) -> Bool) {
        self.areSorted = sort
    }

    var isEmpty: Bool { storage.isEmpty }
    var peek: Element? { storage.first }

    mutating func removeAll(keepingCapacity: Bool = true) {
        storage.removeAll(keepingCapacity: keepingCapacity)
    }

    mutating func insert(_ value: Element) {
        storage.append(value)
        var child = storage.count - 1
        while child > 0 {
            let parent = (child - 1) / 2
            guard areSorted(storage[child], storage[parent]) else { break }
            storage.swapAt(child, parent)
            child = parent
        }
    }

    mutating func removeMin() -> Element? {
        guard !storage.isEmpty else { return nil }
        if storage.count == 1 { return storage.removeLast() }

        let value = storage[0]
        storage[0] = storage.removeLast()
        var parent = 0

        while true {
            let left = parent * 2 + 1
            let right = left + 1
            var candidate = parent

            if left < storage.count, areSorted(storage[left], storage[candidate]) {
                candidate = left
            }
            if right < storage.count, areSorted(storage[right], storage[candidate]) {
                candidate = right
            }
            guard candidate != parent else { break }
            storage.swapAt(parent, candidate)
            parent = candidate
        }

        return value
    }
}


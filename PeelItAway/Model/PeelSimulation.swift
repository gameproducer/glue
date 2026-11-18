import Foundation
import simd

/// Deterministic, allocation-conscious peel-front simulation.
/// Coordinates use a bottom-left origin and simulation-cell units.
final class PeelSimulation {
    private enum Flag {
        static let present: UInt8 = 1 << 0
        static let detached: UInt8 = 1 << 1
        static let bent: UInt8 = 1 << 2
    }

    private struct PullState {
        let grabIndex: Int
        let grabPoint: SIMD2<Float>
        var point: SIMD2<Float>
        var direction: SIMD2<Float>
        var previousDistance: Float
        var lastReleaseDistance: Float
        var workReserve: Float
        var releasedDepth: Float
        var newlyDetached: [Int]
        var torn: Bool
    }

    private struct Candidate {
        let index: Int
        let cost: Float
        let depth: Float
    }

    let width: Int
    let height: Int
    let material: PeelMaterial

    private var flags: [UInt8]
    private var localAdhesion: [UInt8]
    private var visitGeneration: [UInt32]
    private var candidateGeneration: [UInt32]
    private var generation: UInt32 = 1
    private var revision: UInt64 = 1
    private var cachedMaskRevision: UInt64 = 0
    private var cachedAdhered: [UInt8]
    private var cachedReleased: [UInt8]
    private var cachedLifted: [UInt8]
    private var pull: PullState?
    private var presentCount = 0
    private var detachedCount = 0

    private var queue: [Int] = []
    private var heap = MinHeap<Candidate> {
        if abs($0.cost - $1.cost) > 0.0001 { return $0.cost < $1.cost }
        if abs($0.depth - $1.depth) > 0.0001 { return $0.depth < $1.depth }
        return $0.index < $1.index
    }

    private static let cardinal = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    init(width: Int, height: Int, alpha: [UInt8], material: PeelMaterial = .assessment) {
        precondition(alpha.count == width * height)
        self.width = width
        self.height = height
        self.material = material
        self.flags = Array(repeating: 0, count: alpha.count)
        self.localAdhesion = Array(repeating: 255, count: alpha.count)
        self.visitGeneration = Array(repeating: 0, count: alpha.count)
        self.candidateGeneration = Array(repeating: 0, count: alpha.count)
        self.cachedAdhered = Array(repeating: 0, count: alpha.count)
        self.cachedReleased = Array(repeating: 0, count: alpha.count)
        self.cachedLifted = Array(repeating: 0, count: alpha.count)
        self.queue.reserveCapacity(alpha.count / 3)

        for index in alpha.indices where alpha[index] > 20 {
            flags[index] = Flag.present
            presentCount += 1

            // Soft alpha edges release first. Interior adhesion remains stable.
            let coverage = Float(alpha[index]) / 255
            let noise = Self.stableNoise(index: index, width: width)
            let value = (0.82 + 0.18 * coverage) * (1 + material.frontVariation * noise)
            localAdhesion[index] = UInt8(clamping: Int(value * 255))
        }
    }

    var isPulling: Bool { pull != nil }
    var isComplete: Bool { presentCount > 0 && detachedCount == presentCount }

    func beginPull(at point: SIMD2<Float>, searchRadius: Int = 5) -> Bool {
        guard pull == nil, let index = accessibleCell(near: point, radius: searchRadius) else {
            return false
        }

        clearBentCells()
        let center = cellCenter(index)
        pull = PullState(
            grabIndex: index,
            grabPoint: center,
            point: center,
            direction: SIMD2<Float>(0, 1),
            previousDistance: 0,
            lastReleaseDistance: 0,
            workReserve: 0,
            releasedDepth: 0,
            newlyDetached: [],
            torn: false
        )
        markDetachedComponentBent(from: index)
        revision &+= 1
        return true
    }

    @discardableResult
    func updatePull(to point: SIMD2<Float>) -> PeelSnapshot {
        guard var state = pull, !state.torn else { return snapshot() }

        let vector = point - state.grabPoint
        let distance = simd_length(vector)
        guard distance > 0.01 else { return snapshot() }

        state.point = point
        state.direction = vector / distance
        let distanceDelta = max(0, distance - state.previousDistance)
        state.workReserve = min(
            state.workReserve + distanceDelta * material.peelEnergyPerDistance,
            material.peelEnergyPerDistance * 3.5
        )
        state.previousDistance = distance

        let curlAllowance = material.bendRadius * 0.35
        let targetDepth = max(0, distance * 0.92 - curlAllowance)
        let detachedBefore = state.newlyDetached.count
        propagateFront(state: &state, targetDepth: targetDepth)

        if state.newlyDetached.count > detachedBefore {
            state.lastReleaseDistance = distance
        }

        let tension = max(0, distance - state.lastReleaseDistance)
        let minimumLiftedForTear = max(10, presentCount / 2_500)
        if tension > material.tearTension, bentCount() >= minimumLiftedForTear {
            state.torn = true
        }

        pull = state
        return snapshot()
    }

    func endPull() -> PullEndResult {
        guard let state = pull else {
            return PullEndResult(snapshot: snapshot(), consumedMove: false, completed: isComplete, torn: false, releasedCellCount: 0)
        }

        let meaningfulThreshold = max(8, presentCount / 1_500)
        let meaningful = state.newlyDetached.count >= meaningfulThreshold

        if !meaningful, !state.torn {
            for index in state.newlyDetached {
                flags[index] &= ~Flag.detached
                flags[index] &= ~Flag.bent
            }
            detachedCount -= state.newlyDetached.count
        }

        clearBentCells()
        pull = nil
        revision &+= 1

        return PullEndResult(
            snapshot: snapshot(),
            consumedMove: meaningful || state.torn,
            completed: isComplete && meaningful && !state.torn,
            torn: state.torn,
            releasedCellCount: state.newlyDetached.count
        )
    }

    func cancelPull() {
        guard let state = pull else { return }
        for index in state.newlyDetached {
            flags[index] &= ~Flag.detached
            flags[index] &= ~Flag.bent
        }
        detachedCount -= state.newlyDetached.count
        clearBentCells()
        pull = nil
        revision &+= 1
    }

    func snapshot() -> PeelSnapshot {
        if cachedMaskRevision != revision {
            for index in flags.indices {
                cachedAdhered[index] = 0
                cachedReleased[index] = 0
                cachedLifted[index] = 0
            }

            for index in flags.indices where has(index, Flag.present) {
                if has(index, Flag.bent) {
                    cachedLifted[index] = 255
                } else if has(index, Flag.detached) {
                    cachedReleased[index] = 238
                } else {
                    cachedAdhered[index] = 255
                }
            }
            cachedMaskRevision = revision
        }

        let state = pull
        let direction = state?.direction ?? SIMD2<Float>(0, 1)
        let depth = state?.releasedDepth ?? 0
        let grab = state?.grabPoint
        let front = grab.map { $0 - direction * depth } ?? .zero
        let tension: Float
        if let state {
            tension = max(0, simd_distance(state.grabPoint, state.point) - state.lastReleaseDistance)
        } else {
            tension = 0
        }

        return PeelSnapshot(
            width: width,
            height: height,
            adhered: cachedAdhered,
            released: cachedReleased,
            lifted: cachedLifted,
            revision: revision,
            progress: presentCount == 0 ? 0 : Float(detachedCount) / Float(presentCount),
            grabPoint: grab,
            pullPoint: state?.point,
            pullDirection: direction,
            peelFrontPoint: front,
            releasedDepth: depth,
            tension: tension,
            isTorn: state?.torn ?? false
        )
    }

    // MARK: - Propagation

    private func propagateFront(state: inout PullState, targetDepth: Float) {
        advanceGeneration()
        heap.removeAll()

        // Existing detached material connected to the grab is the active lifted sheet.
        queue.removeAll(keepingCapacity: true)
        if has(state.grabIndex, Flag.detached) {
            enqueueVisited(state.grabIndex)
            queue.append(state.grabIndex)
        } else {
            insertCandidate(state.grabIndex, state: state, targetDepth: targetDepth)
        }

        var cursor = 0
        while cursor < queue.count {
            let index = queue[cursor]
            cursor += 1
            flags[index] |= Flag.bent

            forEachNeighbor(of: index) { neighbor in
                if has(neighbor, Flag.detached) {
                    if visitGeneration[neighbor] != generation {
                        enqueueVisited(neighbor)
                        queue.append(neighbor)
                    }
                } else if has(neighbor, Flag.present) {
                    insertCandidate(neighbor, state: state, targetDepth: targetDepth)
                }
            }
        }

        var changed = false
        while let next = heap.peek, next.cost <= state.workReserve {
            _ = heap.removeMin()
            guard !has(next.index, Flag.detached) else { continue }

            state.workReserve -= next.cost
            flags[next.index] |= Flag.detached | Flag.bent
            detachedCount += 1
            state.newlyDetached.append(next.index)
            state.releasedDepth = max(state.releasedDepth, max(0, next.depth))
            changed = true

            forEachNeighbor(of: next.index) { neighbor in
                if has(neighbor, Flag.present), !has(neighbor, Flag.detached) {
                    insertCandidate(neighbor, state: state, targetDepth: targetDepth)
                }
            }
        }

        if changed { revision &+= 1 }
    }

    private func insertCandidate(_ index: Int, state: PullState, targetDepth: Float) {
        guard candidateGeneration[index] != generation else { return }
        candidateGeneration[index] = generation

        let point = cellCenter(index)
        let depth = simd_dot(state.grabPoint - point, state.direction)
        guard depth >= -1.25, depth <= targetDepth else { return }

        var freeNormal = SIMD2<Float>.zero
        var attachedNeighbors = 0
        let x = index % width
        let y = index / width

        for (dx, dy) in Self.cardinal {
            let nx = x + dx
            let ny = y + dy
            guard nx >= 0, nx < width, ny >= 0, ny < height else {
                freeNormal += SIMD2<Float>(Float(dx), Float(dy))
                continue
            }
            let neighbor = ny * width + nx
            if !has(neighbor, Flag.present) || has(neighbor, Flag.detached) {
                freeNormal += SIMD2<Float>(Float(dx), Float(dy))
            } else {
                attachedNeighbors += 1
            }
        }

        let normalLength = simd_length(freeNormal)
        let alignment: Float
        if normalLength > 0.01 {
            alignment = max(0.16, simd_dot(freeNormal / normalLength, state.direction))
        } else {
            alignment = 0.16
        }

        let coverageAdhesion = Float(localAdhesion[index]) / 255
        let support = Float(attachedNeighbors) / 4
        let lateral = abs(Self.cross(point - state.grabPoint, state.direction))
        let lateralLoad = 1 + min(0.22, lateral / Float(max(width, height)) * 0.35)
        let cost = material.adhesion * coverageAdhesion * (0.55 + support * 1.45) * lateralLoad / alignment
        heap.insert(Candidate(index: index, cost: cost, depth: depth))
    }

    // MARK: - Grid helpers

    private func accessibleCell(near point: SIMD2<Float>, radius: Int) -> Int? {
        let cx = Int(point.x.rounded())
        let cy = Int(point.y.rounded())
        var best: (index: Int, distance: Float)?

        for y in (cy - radius)...(cy + radius) {
            for x in (cx - radius)...(cx + radius) {
                guard let index = index(x: x, y: y), has(index, Flag.present) else { continue }
                guard has(index, Flag.detached) || isGeometryBoundary(index) else { continue }
                let distance = simd_distance_squared(cellCenter(index), point)
                if best == nil || distance < best!.distance {
                    best = (index, distance)
                }
            }
        }
        return best?.index
    }

    private func isGeometryBoundary(_ index: Int) -> Bool {
        let x = index % width
        let y = index / width
        for (dx, dy) in Self.cardinal {
            guard let neighbor = self.index(x: x + dx, y: y + dy) else { return true }
            if !has(neighbor, Flag.present) { return true }
        }
        return false
    }

    private func markDetachedComponentBent(from seed: Int) {
        guard has(seed, Flag.detached) else { return }
        advanceGeneration()
        queue.removeAll(keepingCapacity: true)
        enqueueVisited(seed)
        queue.append(seed)
        var cursor = 0

        while cursor < queue.count {
            let index = queue[cursor]
            cursor += 1
            flags[index] |= Flag.bent
            forEachNeighbor(of: index) { neighbor in
                if has(neighbor, Flag.detached), visitGeneration[neighbor] != generation {
                    enqueueVisited(neighbor)
                    queue.append(neighbor)
                }
            }
        }
    }

    private func clearBentCells() {
        for index in flags.indices where has(index, Flag.bent) {
            flags[index] &= ~Flag.bent
        }
    }

    private func bentCount() -> Int {
        flags.reduce(into: 0) { count, flag in
            if flag & Flag.bent != 0 { count += 1 }
        }
    }

    @inline(__always)
    private func forEachNeighbor(of index: Int, _ body: (Int) -> Void) {
        let x = index % width
        let y = index / width
        for (dx, dy) in Self.cardinal {
            if let neighbor = self.index(x: x + dx, y: y + dy) { body(neighbor) }
        }
    }

    private func index(x: Int, y: Int) -> Int? {
        guard x >= 0, x < width, y >= 0, y < height else { return nil }
        return y * width + x
    }

    private func cellCenter(_ index: Int) -> SIMD2<Float> {
        SIMD2<Float>(Float(index % width) + 0.5, Float(index / width) + 0.5)
    }

    private func has(_ index: Int, _ flag: UInt8) -> Bool {
        flags[index] & flag != 0
    }

    private func enqueueVisited(_ index: Int) {
        visitGeneration[index] = generation
    }

    private func advanceGeneration() {
        generation &+= 1
        if generation == 0 {
            visitGeneration = Array(repeating: 0, count: visitGeneration.count)
            candidateGeneration = Array(repeating: 0, count: candidateGeneration.count)
            generation = 1
        }
    }

    private static func stableNoise(index: Int, width: Int) -> Float {
        var value = UInt32(truncatingIfNeeded: index &* 747_796_405 &+ width &* 2_891_336_453)
        value = (value >> ((value >> 28) + 4)) ^ value
        value &*= 277_803_737
        value = (value >> 22) ^ value
        return Float(value & 0xffff) / Float(0xffff) * 2 - 1
    }

    private static func cross(_ lhs: SIMD2<Float>, _ rhs: SIMD2<Float>) -> Float {
        lhs.x * rhs.y - lhs.y * rhs.x
    }
}

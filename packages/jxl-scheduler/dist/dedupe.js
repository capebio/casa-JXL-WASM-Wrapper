// jxl-scheduler/src/dedupe.ts
// Source-identity dedupe and fan-out subscription management.
// Spec: Section 12.4.
//
// When two callers request the same source (URL hash or content hash),
// the second returns a fan-out subscription to the existing session.
// Cancellation by one subscriber does NOT cancel the underlying session
// unless ALL subscribers cancel.
export class DedupeRegistry {
    // sourceKey → primary sessionId
    keyToSession = new Map();
    // primary sessionId → sourceKey (reverse of keyToSession, avoids O(n) scan)
    sessionToKey = new Map();
    // primary sessionId → Set of subscriber session IDs
    sessionToSubscribers = new Map();
    // subscriber sessionId → primary sessionId (for reverse lookup)
    subscriberToPrimary = new Map();
    // Register a new primary session for a source key.
    register(sessionId, sourceKey) {
        this.keyToSession.set(sourceKey, sessionId);
        this.sessionToKey.set(sessionId, sourceKey);
        this.sessionToSubscribers.set(sessionId, new Set([sessionId]));
    }
    // Look up whether a source key already has an active primary session.
    findPrimary(sourceKey) {
        return this.keyToSession.get(sourceKey) ?? null;
    }
    // Subscribe a new session to an existing primary.
    // Returns a Subscription describing the relationship.
    subscribe(subscriberId, primarySessionId) {
        const subs = this.sessionToSubscribers.get(primarySessionId);
        if (subs === undefined) {
            throw new Error(`[jxl-scheduler] DedupeRegistry: primary session ${primarySessionId} not found`);
        }
        subs.add(subscriberId);
        this.subscriberToPrimary.set(subscriberId, primarySessionId);
        return { subscriberId, primarySessionId };
    }
    // Cancel a subscriber. Returns { cancelWorker, promotedTo }.
    // If the primary itself is cancelled but subscribers remain, one subscriber
    // is PROMOTED to be the new primary. The underlying worker is NOT cancelled.
    cancelSubscriber(subscriberId, pickPromoted) {
        const primaryId = this.subscriberToPrimary.get(subscriberId) ?? subscriberId;
        const isPrimary = primaryId === subscriberId;
        const subs = this.sessionToSubscribers.get(primaryId);
        if (subs === undefined)
            return { cancelWorker: true }; // already cleaned up
        subs.delete(subscriberId);
        this.subscriberToPrimary.delete(subscriberId);
        if (subs.size === 0) {
            // All subscribers gone: finish cleanup and signal caller to cancel primary.
            this.sessionToSubscribers.delete(primaryId);
            const key = this.sessionToKey.get(primaryId);
            if (key !== undefined)
                this.keyToSession.delete(key);
            this.sessionToKey.delete(primaryId);
            return { cancelWorker: true };
        }
        if (isPrimary) {
            // Fan-out subscribers still alive. Promote the subscriber chosen by the callback, or the first remaining.
            // Guard: if no real candidate is available (pickPromoted returned undefined and the iterator
            // also produced undefined — possible per TypeScript's IteratorResult typing), treat it as
            // all-cancelled and clean up rather than registering undefined as a primary.
            const newPrimaryId = pickPromoted?.(subs) ?? subs.values().next().value;
            if (newPrimaryId === undefined) {
                // No promotable subscriber; clear the entry entirely.
                this.sessionToSubscribers.delete(primaryId);
                const key = this.sessionToKey.get(primaryId);
                if (key !== undefined)
                    this.keyToSession.delete(key);
                this.sessionToKey.delete(primaryId);
                for (const sub of subs)
                    this.subscriberToPrimary.delete(sub);
                return { cancelWorker: true };
            }
            const key = this.sessionToKey.get(primaryId);
            if (key !== undefined) {
                this.keyToSession.set(key, newPrimaryId);
                this.sessionToKey.set(newPrimaryId, key);
            }
            this.sessionToKey.delete(primaryId);
            this.sessionToSubscribers.set(newPrimaryId, subs);
            this.sessionToSubscribers.delete(primaryId);
            for (const sub of subs) {
                if (sub !== newPrimaryId) {
                    this.subscriberToPrimary.set(sub, newPrimaryId);
                }
                else {
                    this.subscriberToPrimary.delete(sub);
                }
            }
            return { cancelWorker: false, promotedTo: newPrimaryId };
        }
        return { cancelWorker: false };
    }
    // Clean up a completed or errored primary session.
    complete(sessionId) {
        const primary = this.subscriberToPrimary.get(sessionId);
        if (primary !== undefined) {
            // Subscriber completing independently of its primary: detach only.
            this.subscriberToPrimary.delete(sessionId);
            this.sessionToSubscribers.get(primary)?.delete(sessionId);
            return;
        }
        const key = this.sessionToKey.get(sessionId);
        if (key !== undefined)
            this.keyToSession.delete(key);
        this.sessionToKey.delete(sessionId);
        const subs = this.sessionToSubscribers.get(sessionId);
        if (subs !== undefined) {
            for (const sub of subs) {
                if (sub !== sessionId)
                    this.subscriberToPrimary.delete(sub);
            }
            this.sessionToSubscribers.delete(sessionId);
        }
    }
    /** @internal — prefer forEachSubscriber for bounded-allocation iteration */
    // Returns all subscriber IDs for a primary (including itself).
    // Note: The primary session registers itself as a subscriber, so the primary's ID is included in this list.
    subscribers(primaryId) {
        return [...(this.sessionToSubscribers.get(primaryId) ?? [])];
    }
    // Iterates subscriber IDs, snapshotting the Set before iteration.
    // Snapshot cost is one array of N subscriber IDs (typically 0–3 entries).
    // Required for correctness: fn may call cancelSubscriber, which deletes from the
    // live Set mid-iteration — without a snapshot, JS Set's forward-iterator spec
    // causes unvisited-but-deleted entries to be silently skipped (a message-loss bug
    // when a subscriber's handler synchronously cancels another subscriber).
    // Note: The primary session registers itself as a subscriber, so the callback is invoked for the primary's ID as well.
    forEachSubscriber(primaryId, fn) {
        const subs = this.sessionToSubscribers.get(primaryId);
        if (subs === undefined)
            return;
        // Hot-path fast paths. register() seeds the Set with the primary's own id, so a
        // non-deduped session always has size 1 — the common case on the per-message
        // dispatch path (handleWorkerMessage calls this for every worker→main message).
        // Avoid the throwaway snapshot array there.
        if (subs.size === 0)
            return;
        if (subs.size === 1) {
            // Extract the single id, then call fn after iteration has ended, so any
            // add/delete fn performs on the Set cannot affect this invocation — fully
            // equivalent to the snapshot semantics below, with no array allocation.
            let only;
            for (const s of subs) {
                only = s;
                break;
            }
            if (only !== undefined)
                fn(only);
            return;
        }
        // Spread into a local array so mutations to the Set during fn() don't skip entries.
        for (const sub of [...subs])
            fn(sub);
    }
}
//# sourceMappingURL=dedupe.js.map
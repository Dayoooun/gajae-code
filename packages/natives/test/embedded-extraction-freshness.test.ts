import { describe, expect, it } from "bun:test";

import {
	cachedEmbeddedExtractionIsFresh,
	getImmutableEmbeddedCachePath,
	loadFromCandidates,
	resolveRuntimeCandidates,
} from "../native/loader-state.js";

const hashes = (map: Record<string, string | null>) => (p: string) => (p in map ? map[p] : null);

const cachedPath = "/cache/pi_natives.node";
const embeddedPath = "/embedded/pi_natives.node";

describe("cachedEmbeddedExtractionIsFresh", () => {
	it("reuses a cached extraction with the same content identity as the embedded payload", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: cachedPath,
				embeddedPath,
				contentHash: hashes({ [cachedPath]: "sha256:current", [embeddedPath]: "sha256:current" }),
			}),
		).toBe(true);
	});

	it("re-extracts same-size cached content with a different identity", () => {
		// A same-version build can change exports without changing the .node byte length.
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: cachedPath,
				embeddedPath,
				contentHash: hashes({ [cachedPath]: "sha256:stale", [embeddedPath]: "sha256:current" }),
			}),
		).toBe(false);
	});

	it("re-extracts when the cached file cannot be hashed", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: "/cache/missing.node",
				embeddedPath,
				contentHash: hashes({ [embeddedPath]: "sha256:current" }),
			}),
		).toBe(false);
	});

	it("re-extracts when the embedded payload cannot be hashed", () => {
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: cachedPath,
				embeddedPath: "/embedded/missing.node",
				contentHash: hashes({ [cachedPath]: "sha256:current" }),
			}),
		).toBe(false);
	});
});

const currentHash = "a".repeat(64);
const staleHash = "b".repeat(64);

describe("getImmutableEmbeddedCachePath", () => {
	it("binds each cache pathname to one payload identity and rejects unsafe identities", () => {
		expect(
			getImmutableEmbeddedCachePath({
				cacheDir: "/cache",
				filename: "pi_natives.linux-x64-modern.node",
				contentHash: currentHash,
			}),
		).toBe(`/cache/pi_natives.linux-x64-modern.${currentHash}.node`);
		expect(
			getImmutableEmbeddedCachePath({
				cacheDir: "/cache",
				filename: "../pi_natives.node",
				contentHash: currentHash,
			}),
		).toBeNull();
		expect(
			getImmutableEmbeddedCachePath({
				cacheDir: "/cache",
				filename: "pi_natives.node",
				contentHash: "not-a-sha256",
			}),
		).toBeNull();
	});
});

describe("resolveRuntimeCandidates", () => {
	it("excludes stale, sibling-variant, and legacy mutable candidates in compiled mode", () => {
		const modernPath = getImmutableEmbeddedCachePath({
			cacheDir: "/cache",
			filename: "pi_natives.linux-x64-modern.node",
			contentHash: currentHash,
		});
		const stalePath = getImmutableEmbeddedCachePath({
			cacheDir: "/cache",
			filename: "pi_natives.linux-x64-modern.node",
			contentHash: staleHash,
		});
		const baselinePath = getImmutableEmbeddedCachePath({
			cacheDir: "/cache",
			filename: "pi_natives.linux-x64-baseline.node",
			contentHash: currentHash,
		});
		expect(modernPath).not.toBeNull();
		expect(stalePath).not.toBeNull();
		expect(baselinePath).not.toBeNull();

		expect(
			resolveRuntimeCandidates({
				candidates: [
					stalePath!,
					baselinePath!,
					"/cache/pi_natives.linux-x64-modern.node",
					"/legacy/pi_natives.node",
				],
				embeddedCandidate: modernPath,
				validatedCandidates: [modernPath!],
			}),
		).toEqual([modernPath]);
	});

	it("fails closed when a replacement race invalidates the immutable target", () => {
		const immutablePath = getImmutableEmbeddedCachePath({
			cacheDir: "/cache",
			filename: "pi_natives.linux-x64-modern.node",
			contentHash: currentHash,
		});
		expect(immutablePath).not.toBeNull();
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: immutablePath!,
				embeddedPath,
				contentHash: hashes({ [immutablePath!]: staleHash, [embeddedPath]: currentHash }),
			}),
		).toBe(false);
		expect(
			resolveRuntimeCandidates({
				candidates: [immutablePath!, "/cache/pi_natives.linux-x64-modern.node", "/legacy/pi_natives.node"],
				validatedCandidates: [],
			}),
		).toEqual([]);
	});
});

describe("load-time cache attestation", () => {
	it("loads a validated private copy when the cache target is substituted at the load boundary", () => {
		const immutablePath = getImmutableEmbeddedCachePath({
			cacheDir: "/cache",
			filename: "pi_natives.linux-x64-modern.node",
			contentHash: currentHash,
		});
		expect(immutablePath).not.toBeNull();

		let targetHash = currentHash;
		expect(
			cachedEmbeddedExtractionIsFresh({
				targetPath: immutablePath!,
				embeddedPath,
				contentHash: hashes({ [embeddedPath]: currentHash, [immutablePath!]: targetHash }),
			}),
		).toBe(true);

		const privateLoadPath = "/private/pi-natives-load-123/pi_natives.linux-x64-modern.node";
		let requiredPath: string | null = null;
		const loaded = loadFromCandidates({
			candidates: [immutablePath!],
			bindCandidate: candidate => {
				expect(candidate).toBe(immutablePath);
				return privateLoadPath;
			},
			requireCandidate: candidate => {
				// Simulate a concurrent replacement precisely as loading begins.
				targetHash = staleHash;
				requiredPath = candidate;
				return { __piNativesVCurrent: () => undefined };
			},
			validateCandidate: () => undefined,
			describeCandidate: candidate => candidate,
		});

		expect(targetHash).toBe(staleHash);
		expect(requiredPath).toBe(privateLoadPath);
		expect(loaded.errors).toEqual([]);
		expect(loaded.bindings).not.toBeNull();
	});
});

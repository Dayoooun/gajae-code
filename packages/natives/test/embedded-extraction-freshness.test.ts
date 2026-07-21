import { describe, expect, it } from "bun:test";

import { cachedEmbeddedExtractionIsFresh, resolveRuntimeCandidates } from "../native/loader-state.js";

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

describe("resolveRuntimeCandidates", () => {
	it("excludes every unvalidated versioned sibling when replacement fails", () => {
		const modernPath = "/cache/pi_natives.linux-x64-modern.node";
		const baselinePath = "/cache/pi_natives.linux-x64-baseline.node";
		expect(
			resolveRuntimeCandidates({
				candidates: [modernPath, baselinePath, "/legacy/pi_natives.node"],
				versionedDir: "/cache",
				validatedVersionedCandidates: [],
			}),
		).toEqual(["/legacy/pi_natives.node"]);
	});

	it("permits only the content-validated versioned candidate", () => {
		const modernPath = "/cache/pi_natives.linux-x64-modern.node";
		const baselinePath = "/cache/pi_natives.linux-x64-baseline.node";
		expect(
			resolveRuntimeCandidates({
				candidates: [modernPath, baselinePath, "/legacy/pi_natives.node"],
				embeddedCandidate: modernPath,
				versionedDir: "/cache",
				validatedVersionedCandidates: [modernPath],
			}),
		).toEqual([modernPath, "/legacy/pi_natives.node"]);
	});
});

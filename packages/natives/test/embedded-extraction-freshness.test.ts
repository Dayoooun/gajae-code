import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import {
	cachedEmbeddedExtractionIsFresh,
	cleanupPrivateLoadDirectory,
	getImmutableEmbeddedCachePath,
	loadFromCandidates,
	prunePrivateLoadDirectories,
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
		const cleanedPaths: string[] = [];
		const loaded = loadFromCandidates({
			candidates: [immutablePath!],
			bindCandidate: candidate => {
				expect(candidate).toBe(immutablePath);
				return privateLoadPath;
			},
			cleanupCandidate: candidate => cleanedPaths.push(candidate),
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
		expect(cleanedPaths).toEqual([privateLoadPath]);
		expect(loaded.errors).toEqual([]);
		expect(loaded.bindings).not.toBeNull();
	});

	it("cleans a private copy after a failed load attempt", () => {
		const privateLoadPath = "/private/pi-natives-load-456/pi_natives.linux-x64-modern.node";
		const cleanedPaths: string[] = [];
		const loaded = loadFromCandidates({
			candidates: ["/cache/pi_natives.linux-x64-modern.node"],
			bindCandidate: () => privateLoadPath,
			cleanupCandidate: candidate => cleanedPaths.push(candidate),
			requireCandidate: () => {
				throw new Error("native load failed");
			},
			validateCandidate: () => undefined,
			describeCandidate: candidate => candidate,
		});

		expect(loaded.bindings).toBeNull();
		expect(cleanedPaths).toEqual([privateLoadPath]);
	});

	it("keeps a concurrently loading process's private directory and reaps only a proven-dead owner", () => {
		const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-natives-private-load-"));
		const activeDir = path.join(cacheDir, ".pi-natives-load-active");
		const staleDir = path.join(cacheDir, ".pi-natives-load-stale");
		const unownedDir = path.join(cacheDir, ".pi-natives-load-unowned");
		const unrelatedDir = path.join(cacheDir, "keep-me");
		try {
			fs.mkdirSync(activeDir);
			fs.mkdirSync(staleDir);
			fs.mkdirSync(unownedDir);
			fs.mkdirSync(unrelatedDir);
			fs.writeFileSync(path.join(activeDir, ".owner.json"), JSON.stringify({ pid: 101 }));
			fs.writeFileSync(path.join(staleDir, ".owner.json"), JSON.stringify({ pid: 202 }));

			// Model a second loader starting while the first has already bound its
			// private copy. The probe is injected so this cross-process race is
			// deterministic on every platform, including Windows.
			expect(
				prunePrivateLoadDirectories({
					cacheDir,
					isProcessAlive: pid => pid === 101,
				}),
			).toBe(1);
			expect(fs.existsSync(activeDir)).toBe(true);
			expect(fs.existsSync(staleDir)).toBe(false);
			expect(fs.existsSync(unownedDir)).toBe(true);
			expect(fs.existsSync(unrelatedDir)).toBe(true);
		} finally {
			fs.rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("defers every private copy's cleanup until its owner exits", () => {
		const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-natives-private-load-"));
		const deferredDir = path.join(cacheDir, ".pi-natives-load-deferred");
		try {
			fs.mkdirSync(deferredDir);
			cleanupPrivateLoadDirectory({ loadDir: deferredDir });
			expect(fs.existsSync(deferredDir)).toBe(true);
		} finally {
			fs.rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});

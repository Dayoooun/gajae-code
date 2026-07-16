import { bench } from "bun:test";
import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";

const corpus = [
	{ role: "user" as const, content: [{ type: "text" as const, text: "Small prompt for estimator calibration." }] },
	{ role: "user" as const, content: [{ type: "text" as const, text: JSON.stringify({ files: Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`) }) }] },
];

bench("message display-token heuristic cost and corpus accuracy baseline", () => {
	// Keep the corpus stable so benchmark output is comparable between estimator changes.
	for (const message of corpus) estimateMessageTokensHeuristic(message);
});

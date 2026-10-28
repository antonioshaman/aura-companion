// Moved to web/eval-schema/eval-artifact.ts: the server imports it at run time, and evals/ never
// ships in the npm package (evals/supply-chain.test.ts). Re-exported for the eval harness.
export * from "../../eval-schema/eval-artifact.js";

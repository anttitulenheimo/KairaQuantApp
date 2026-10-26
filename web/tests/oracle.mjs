import { readFileSync } from "node:fs";
import { simulate, snapshot } from "../public/engine.mjs";
const result = simulate(JSON.parse(readFileSync(0, "utf8")));
process.stdout.write(
  JSON.stringify({ result, end: snapshot(result, result.valuation.length) }),
);

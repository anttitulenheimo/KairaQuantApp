import { SCENARIOS, MAX_STEP } from "./engine.mjs";
export const STORAGE_KEY = "kaira.v13.session";
export const freshSession = () => ({
  version: 1,
  engine: "v13.0",
  scenario: "waves",
  step: 0,
});
export function validateSession(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "engine,scenario,step,version" ||
    value.version !== 1 ||
    value.engine !== "v13.0" ||
    !Object.hasOwn(SCENARIOS, value.scenario) ||
    typeof value.scenario !== "string" ||
    !Number.isInteger(value.step) ||
    value.step < 0 ||
    value.step > MAX_STEP
  )
    throw Error(
      "Tiedosto ei ole tämän version kelvollinen simulaatiotallennus.",
    );
  return {
    version: 1,
    engine: "v13.0",
    scenario: value.scenario,
    step: value.step,
  };
}
export function parseSession(text) {
  if (typeof text !== "string" || text.length > 4096)
    throw Error("Tallennus on liian suuri tai virheellinen.");
  return validateSession(JSON.parse(text));
}
/** Compare the last read storage value before saving, so stale tabs cannot overwrite it. */
export function saveSession(storage, session, expected) {
  const clean = validateSession(session);
  if (storage.getItem(STORAGE_KEY) !== expected)
    throw Error(
      "Simulaatio muuttui toisessa välilehdessä. Lataa sivu uudelleen ennen jatkamista.",
    );
  const text = JSON.stringify(clean);
  storage.setItem(STORAGE_KEY, text);
  return text;
}

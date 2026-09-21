import { createRequire } from "module";

const require = createRequire(import.meta.url);
const api = require("./engine.js");

export const sample = api.sample;
export const toSVG = api.toSVG;
export const drawCanvas = api.drawCanvas;
export const createEngine = api.createEngine;
export const catalogueWorld = api.catalogueWorld;
export const heroWorld = api.heroWorld;
export const COLORWAYS = api.COLORWAYS;
export const COLORWAY_BY_ID = api.COLORWAY_BY_ID;
export const STATES = api.STATES;
export const SEQUENCE = api.SEQUENCE;
export const SEQUENCE_DUR = api.SEQUENCE_DUR;
export const STATE_DEFS = api.STATE_DEFS;
export const LAUGH_MORPH_DUR = api.LAUGH_MORPH_DUR;
export const IDLE_ORBIT_PERIOD = api.IDLE_ORBIT_PERIOD;
export const resolveColorway = api.resolveColorway;
export const resolveState = api.resolveState;
export const blinkAmount = api.blinkAmount;
export const mouthOpenAmount = api.mouthOpenAmount;

export default api;

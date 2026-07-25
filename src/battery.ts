export type Mode = "charge" | "discharge" | "idle";
export type CellParams = { capacityAh: number; r: number };
export type PackState = { cellSoc: number[]; temp: number; time: number };

export const CELL_COUNT = 4;
export const THERMAL_MASS = 4000; // J/°C, lumped pack thermal mass
export const COOLING_COEF = 3; // W/°C, heat exchange with ambient
export const BLEED_RATE = 0.00003; // SoC fraction/sec bled from a cell during passive balancing
export const BALANCE_THRESHOLD = 0.005; // SoC gap above min before a cell is bled
export const BMS_TRIP_TEMP = 70; // °C — BMS forces the pack to idle above this

// Piecewise-linear OCV curve approximating a typical NMC Li-ion cell's open-circuit voltage vs SoC.
const OCV_POINTS: [number, number][] = [
  [0.00, 3.00], [0.05, 3.30], [0.10, 3.45], [0.20, 3.55],
  [0.30, 3.62], [0.40, 3.68], [0.50, 3.72], [0.60, 3.77],
  [0.70, 3.82], [0.80, 3.90], [0.90, 4.02], [1.00, 4.20],
];

export function ocv(soc: number): number {
  const s = Math.min(1, Math.max(0, soc));
  for (let i = 0; i < OCV_POINTS.length - 1; i++) {
    const [s0, v0] = OCV_POINTS[i];
    const [s1, v1] = OCV_POINTS[i + 1];
    if (s >= s0 && s <= s1) {
      const t = (s1 === s0) ? 0 : (s - s0) / (s1 - s0);
      return v0 + t * (v1 - v0);
    }
  }
  return OCV_POINTS[OCV_POINTS.length - 1][1];
}

// Terminal voltage = open-circuit voltage minus/plus the I*R drop caused by internal resistance.
export function cellVoltage(soc: number, current: number, r: number, mode: Mode): number {
  if (mode === "discharge") return ocv(soc) - current * r;
  if (mode === "charge") return ocv(soc) + current * r;
  return ocv(soc);
}

// Real chargers taper current as cells approach full (CC→CV transition) to avoid overvoltage.
// Model it as a linear current taper starting at 90% SoC on whichever cell is furthest along.
function chargeTaper(maxSoc: number): number {
  if (maxSoc <= 0.9) return 1;
  return Math.max(0.03, (1 - maxSoc) / 0.1);
}

export function packCurrent(cells: CellParams[], mode: Mode, cRate: number, cellSoc?: number[]): number {
  if (mode === "idle") return 0;
  const avgCapacity = cells.reduce((s, c) => s + c.capacityAh, 0) / cells.length;
  const base = cRate * avgCapacity;
  if (mode === "charge" && cellSoc && cellSoc.length > 0) {
    return base * chargeTaper(Math.max(...cellSoc));
  }
  return base;
}

export function packVoltage(cellSoc: number[], cells: CellParams[], mode: Mode, cRate: number): number {
  const current = packCurrent(cells, mode, cRate, cellSoc);
  return cellSoc.reduce((sum, soc, i) => sum + cellVoltage(soc, current, cells[i].r, mode), 0);
}

export function initPack(initialSoc: number[], ambientTemp: number): PackState {
  return { cellSoc: [...initialSoc], temp: ambientTemp, time: 0 };
}

// Advance the pack by dtSeconds of simulated time: coulomb-count each cell's SoC, run passive
// balancing while idle, and integrate a lumped thermal model (resistive heating in, convective
// cooling to ambient out).
export function stepPack(
  state: PackState,
  cells: CellParams[],
  mode: Mode,
  cRate: number,
  ambientTemp: number,
  dtSeconds: number,
): PackState {
  const current = packCurrent(cells, mode, cRate, state.cellSoc);
  const sign = mode === "charge" ? 1 : mode === "discharge" ? -1 : 0;

  const nextSoc = state.cellSoc.map((soc, i) => {
    const c = cells[i];
    const dSoc = (sign * current * dtSeconds) / (c.capacityAh * 3600);
    return Math.min(1, Math.max(0, soc + dSoc));
  });

  if (mode === "idle") {
    const minSoc = Math.min(...nextSoc);
    for (let i = 0; i < nextSoc.length; i++) {
      if (nextSoc[i] - minSoc > BALANCE_THRESHOLD) {
        nextSoc[i] = Math.max(minSoc, nextSoc[i] - BLEED_RATE * dtSeconds);
      }
    }
  }

  const rTotal = cells.reduce((s, c) => s + c.r, 0);
  const heatIn = current * current * rTotal; // Watts, I²R heating
  const heatOut = COOLING_COEF * (state.temp - ambientTemp);
  const dTemp = ((heatIn - heatOut) / THERMAL_MASS) * dtSeconds;

  return { cellSoc: nextSoc, temp: state.temp + dTemp, time: state.time + dtSeconds };
}

export function isBalancing(cellSoc: number[], mode: Mode, i: number): boolean {
  if (mode !== "idle") return false;
  const minSoc = Math.min(...cellSoc);
  return cellSoc[i] - minSoc > BALANCE_THRESHOLD;
}

export type PresetId = "healthy" | "imbalanced" | "fastcharge" | "cold";

export type Preset = {
  id: PresetId;
  name: string;
  description: string;
  cells: CellParams[];
  initialSoc: number[];
  ambientTemp: number;
};

export const PRESETS: Preset[] = [
  {
    id: "healthy",
    name: "Healthy Pack",
    description: "4 matched cells at room temperature — baseline behavior with no imbalance.",
    cells: [
      { capacityAh: 50, r: 0.0050 },
      { capacityAh: 50.5, r: 0.0051 },
      { capacityAh: 49.7, r: 0.0049 },
      { capacityAh: 50.2, r: 0.0052 },
    ],
    initialSoc: [0.6, 0.6, 0.6, 0.6],
    ambientTemp: 25,
  },
  {
    id: "imbalanced",
    name: "Imbalanced Pack",
    description: "Cell 3 is a weaker, aged cell — lower capacity, higher resistance, higher starting SoC. Switch to Idle and watch passive balancing bleed it back down toward the pack.",
    cells: [
      { capacityAh: 50, r: 0.0050 },
      { capacityAh: 50, r: 0.0050 },
      { capacityAh: 38, r: 0.0110 },
      { capacityAh: 50, r: 0.0050 },
    ],
    initialSoc: [0.60, 0.60, 0.75, 0.60],
    ambientTemp: 25,
  },
  {
    id: "fastcharge",
    name: "Fast DC Charging",
    description: "Pack starts nearly empty. Push a high charge C-rate and watch pack temperature climb toward the BMS thermal cutoff.",
    cells: [
      { capacityAh: 50, r: 0.0060 },
      { capacityAh: 50, r: 0.0060 },
      { capacityAh: 50, r: 0.0060 },
      { capacityAh: 50, r: 0.0060 },
    ],
    initialSoc: [0.10, 0.10, 0.10, 0.10],
    ambientTemp: 30,
  },
  {
    id: "cold",
    name: "Cold Weather",
    description: "Sub-zero ambient roughly doubles internal resistance — voltage sags harder under the same load.",
    cells: [
      { capacityAh: 48, r: 0.0120 },
      { capacityAh: 48, r: 0.0120 },
      { capacityAh: 48, r: 0.0120 },
      { capacityAh: 48, r: 0.0120 },
    ],
    initialSoc: [0.5, 0.5, 0.5, 0.5],
    ambientTemp: -5,
  },
];

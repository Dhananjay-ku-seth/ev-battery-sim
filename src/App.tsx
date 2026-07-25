import { useEffect, useMemo, useRef, useState } from "react";
import {
  PRESETS, BMS_TRIP_TEMP,
  initPack, stepPack, cellVoltage, packCurrent, isBalancing,
  type CellParams, type Mode, type PackState, type PresetId,
} from "./battery";
import AuthPanel from "./AuthPanel";
import SavePreset, { type EvConfig } from "./SavePreset";
import { useProfile } from "./useProfile";

const SPEEDS = [1, 10, 60, 300];

function tempColor(t: number): string {
  if (t > BMS_TRIP_TEMP) return "#f43f5e";
  if (t > 60) return "#fb923c";
  if (t > 45) return "#eab308";
  if (t < 0) return "#38bdf8";
  return "#84cc16";
}

function cellColor(v: number): string {
  if (v < 2.9 || v > 4.25) return "#f43f5e";
  if (v < 3.0 || v > 4.18) return "#eab308";
  return "#84cc16";
}

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

type Sample = { soc: number; temp: number };

function drawChart(
  canvas: HTMLCanvasElement | null,
  samples: Sample[],
  key: "soc" | "temp",
  min: number,
  max: number,
  color: string,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#211d18";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  if (samples.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  samples.forEach((s, i) => {
    const v = key === "soc" ? s.soc * 100 : s.temp;
    const x = (i / (samples.length - 1)) * w;
    const t = Math.min(1, Math.max(0, (v - min) / (max - min)));
    const y = h - t * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

export default function App() {
  const { isPro } = useProfile();
  const [presetId, setPresetId] = useState<PresetId>("healthy");
  const [cells, setCells] = useState<CellParams[]>(() => PRESETS[0].cells.map((c) => ({ ...c })));
  const [pack, setPack] = useState<PackState>(() => initPack(PRESETS[0].initialSoc, PRESETS[0].ambientTemp));
  const [mode, setMode] = useState<Mode>("idle");
  const [cRate, setCRate] = useState(0.5);
  const [ambientTemp, setAmbientTemp] = useState(PRESETS[0].ambientTemp);
  const [speed, setSpeed] = useState(60);
  const [running, setRunning] = useState(false);
  const [bmsTripped, setBmsTripped] = useState(false);

  const historyRef = useRef<Sample[]>([]);
  const [, forceTick] = useState(0);
  const lastFrameRef = useRef<number | null>(null);
  const lastSampleRef = useRef(0);
  const socCanvasRef = useRef<HTMLCanvasElement>(null);
  const tempCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!running) { lastFrameRef.current = null; return; }
    let raf = 0;
    const loop = (now: number) => {
      if (lastFrameRef.current === null) lastFrameRef.current = now;
      const realDeltaMs = Math.min(250, now - lastFrameRef.current);
      lastFrameRef.current = now;
      const dt = (realDeltaMs / 1000) * speed;

      setPack((prev) => {
        const effectiveMode: Mode = bmsTripped ? "idle" : mode;
        const next = stepPack(prev, cells, effectiveMode, cRate, ambientTemp, dt);
        if (next.temp > BMS_TRIP_TEMP && !bmsTripped) setBmsTripped(true);
        else if (bmsTripped && next.temp < 55) setBmsTripped(false);

        if (now - lastSampleRef.current > 150) {
          lastSampleRef.current = now;
          const avgSoc = next.cellSoc.reduce((s, x) => s + x, 0) / next.cellSoc.length;
          historyRef.current = [...historyRef.current, { soc: avgSoc, temp: next.temp }].slice(-400);
        }
        return next;
      });
      forceTick((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, cells, mode, cRate, ambientTemp, speed, bmsTripped]);

  useEffect(() => {
    drawChart(socCanvasRef.current, historyRef.current, "soc", 0, 100, "#84cc16");
    drawChart(tempCanvasRef.current, historyRef.current, "temp", -10, 90, tempColor(pack.temp));
  });

  function selectPreset(id: PresetId) {
    const preset = PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    setCells(preset.cells.map((c) => ({ ...c })));
    setPack(initPack(preset.initialSoc, preset.ambientTemp));
    setAmbientTemp(preset.ambientTemp);
    setMode("idle");
    setBmsTripped(false);
    historyRef.current = [];
  }

  function reset() {
    const preset = PRESETS.find((p) => p.id === presetId)!;
    setPack(initPack(preset.initialSoc, preset.ambientTemp));
    setBmsTripped(false);
    historyRef.current = [];
  }

  function injectFault() {
    setCells((cs) => {
      const i = Math.floor(Math.random() * cs.length);
      const next = cs.map((c, idx) => idx === i ? { capacityAh: c.capacityAh * 0.7, r: c.r * 2 } : c);
      return next;
    });
    setPack((p) => {
      const i = Math.floor(Math.random() * p.cellSoc.length);
      const nextSoc = p.cellSoc.map((s, idx) => idx === i ? Math.min(1, s + 0.12) : s);
      return { ...p, cellSoc: nextSoc };
    });
  }

  const current = packCurrent(cells, bmsTripped ? "idle" : mode, cRate, pack.cellSoc);
  const cellVoltages = pack.cellSoc.map((soc, i) => cellVoltage(soc, current, cells[i].r, bmsTripped ? "idle" : mode));
  const packV = cellVoltages.reduce((s, v) => s + v, 0);
  const avgSoc = pack.cellSoc.reduce((s, v) => s + v, 0) / pack.cellSoc.length;
  const spreadMv = (Math.max(...cellVoltages) - Math.min(...cellVoltages)) * 1000;

  const alerts: { text: string; level: "warn" | "critical" }[] = [];
  if (bmsTripped) alerts.push({ text: "THERMAL RUNAWAY RISK — BMS cut current, pack forced to Idle until it cools", level: "critical" });
  else if (pack.temp > 60) alerts.push({ text: "Over-temperature — approaching the BMS thermal cutoff", level: "warn" });
  if (avgSoc < 0.05) alerts.push({ text: "Low SoC — pack nearly empty", level: "warn" });
  if (avgSoc > 0.98 && mode === "charge") alerts.push({ text: "Pack full — stop charging", level: "warn" });
  if (spreadMv > 40) alerts.push({ text: `Cell imbalance detected (${spreadMv.toFixed(0)} mV spread) — switch to Idle to balance`, level: "warn" });
  if (Math.max(...cellVoltages) > 4.25) alerts.push({ text: "Cell overvoltage — charge current tapering (CC→CV)", level: "warn" });

  const preset = PRESETS.find((p) => p.id === presetId)!;

  const config: EvConfig = useMemo(() => ({
    presetId, cells, cellSoc: pack.cellSoc, temp: pack.temp, mode, cRate, ambientTemp, speed,
  }), [presetId, cells, pack.cellSoc, pack.temp, mode, cRate, ambientTemp, speed]);

  function loadConfig(c: EvConfig) {
    setPresetId(c.presetId);
    setCells(c.cells);
    setPack({ cellSoc: c.cellSoc, temp: c.temp, time: 0 });
    setMode(c.mode);
    setCRate(c.cRate);
    setAmbientTemp(c.ambientTemp);
    setSpeed(c.speed);
    setBmsTripped(false);
    historyRef.current = [];
  }

  return (
    <div className="app">
      <header>
        <div className="mark">🔋</div>
        <div>
          <h1>EV BATTERY MANAGEMENT SIMULATOR</h1>
          <p>Coulomb-counted SoC · OCV + IR-drop cell voltage · lumped thermal model · passive cell balancing</p>
        </div>
        <div className="badges">
          <AuthPanel />
          <div className="badge-links">
            <a className="labbench-badge" href="https://labbench-hub.vercel.app/" target="_blank" rel="noopener noreferrer">⚡ LabBench</a>
            <a className="src" href="https://dhananjay-kumar-seth.vercel.app/" target="_blank" rel="noopener noreferrer">ECE Portfolio · Dhananjay Seth</a>
          </div>
        </div>
      </header>

      <div className="savebar">
        <SavePreset config={config} onLoad={loadConfig} />
      </div>

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a, i) => (
            <div key={i} className={"alert " + a.level}>{a.level === "critical" ? "⛔" : "⚠️"} {a.text}</div>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.id} className={p.id === presetId ? "on" : ""} onClick={() => selectPreset(p.id)}>{p.name}</button>
          ))}
        </div>
        <p className="desc">{preset.description}</p>

        <div className="row">
          <button className={"ghost" + (running ? " on" : "")} onClick={() => setRunning((r) => !r)}>
            {running ? "⏸ Pause" : "▶ Run"}
          </button>
          <div className="seg small">
            {(["charge", "discharge", "idle"] as Mode[]).map((m) => (
              <button key={m} className={mode === m ? "on" : ""} disabled={bmsTripped && m !== "idle"} onClick={() => setMode(m)}>
                {m === "charge" ? "Charge" : m === "discharge" ? "Discharge" : "Idle"}
              </button>
            ))}
          </div>
          <div className="seg small">
            {SPEEDS.map((s) => (
              <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}x</button>
            ))}
          </div>
          <button className="ghost" onClick={reset}>↺ Reset</button>
          <button className="ghost" onClick={injectFault}>⚡ Inject Fault</button>
        </div>

        <div className="row">
          <label className="cycles">
            C-rate
            <input type="range" min={0} max={2} step={0.05} value={cRate} disabled={mode === "idle"}
              onChange={(e) => setCRate(parseFloat(e.target.value))} />
            <span>{cRate.toFixed(2)}C</span>
          </label>
          <label className="cycles">
            Ambient °C
            <input type="range" min={-10} max={45} step={1} value={ambientTemp}
              onChange={(e) => setAmbientTemp(parseFloat(e.target.value))} />
            <span>{ambientTemp}°C</span>
          </label>
          <span className="hint-line" style={{ margin: 0 }}>Sim time: {fmtTime(pack.time)}</span>
        </div>

        <div className="stats-row">
          <div className="stat">
            <span className="stat-label">Pack SoC</span>
            <span className="stat-val" style={{ color: "#84cc16" }}>{(avgSoc * 100).toFixed(1)}%</span>
          </div>
          <div className="stat">
            <span className="stat-label">Pack Voltage</span>
            <span className="stat-val" style={{ color: "#38bdf8" }}>{packV.toFixed(2)} V</span>
          </div>
          <div className="stat">
            <span className="stat-label">Current</span>
            <span className="stat-val">{(mode === "idle" || bmsTripped) ? "0.00" : current.toFixed(1)} A</span>
          </div>
          <div className="stat">
            <span className="stat-label">Pack Temp</span>
            <span className="stat-val" style={{ color: tempColor(pack.temp) }}>{pack.temp.toFixed(1)}°C</span>
          </div>
          <div className="stat">
            <span className="stat-label">Cell Spread</span>
            <span className="stat-val" style={{ color: spreadMv > 40 ? "#f43f5e" : "#e2ddd6" }}>{spreadMv.toFixed(0)} mV</span>
          </div>
        </div>

        <div className="cells-grid">
          {cellVoltages.map((v, i) => (
            <div key={i} className="cell-card">
              <span className="cell-idx">Cell {i + 1}{isBalancing(pack.cellSoc, mode, i) ? " ⚡" : ""}</span>
              <div className="cell-bar-track">
                <div className="cell-bar-fill" style={{ height: `${pack.cellSoc[i] * 100}%`, background: cellColor(v) }} />
              </div>
              <span className="cell-v" style={{ color: cellColor(v) }}>{v.toFixed(3)} V</span>
              <span className="cell-soc">{(pack.cellSoc[i] * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>

        <div className="charts-grid">
          <div className="chart-box">
            <span className="chart-label">State of Charge (0–100%)</span>
            <canvas ref={socCanvasRef} width={460} height={110} />
          </div>
          <div className="chart-box">
            <span className="chart-label">Pack Temperature (−10 to 90°C)</span>
            <canvas ref={tempCanvasRef} width={460} height={110} />
          </div>
        </div>
      </div>

      {isPro ? (
        <div className="pro-strip pro-tools">
          <span>Pro: save/load full scenarios (cell params, SoC, thermal state) via 💾 above.</span>
        </div>
      ) : (
        <div className="pro-strip">
          <span>🔒 Save/load battery scenarios — <b>LabBench Pro</b> feature.</span>
          <a href="https://logic-circuit-sim.vercel.app/" target="_blank" rel="noopener noreferrer">Upgrade to Pro →</a>
        </div>
      )}

      <footer>Coulomb counting + OCV/IR-drop + lumped thermal model + passive balancing, computed from scratch — no Simulink/BMS libraries.</footer>
    </div>
  );
}

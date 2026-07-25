# EV Battery Management Simulator

**Coulomb-counted SoC, OCV/IR-drop cell voltage, a lumped thermal model, and live passive cell balancing.**

Part of the [LabBench](https://labbench-hub.vercel.app/) suite of interactive engineering tools.

**Live demo:** _add your Vercel URL here_

## What it does

Simulates a 4-cell series EV battery pack under Charge / Discharge / Idle modes:

- **State of Charge** — tracked per cell via coulomb counting (`dSoC = I·dt / (capacity·3600)`), not a single pack-wide number, so cells can genuinely drift apart.
- **Cell voltage** — a piecewise-linear open-circuit-voltage (OCV) curve shaped like a real NMC Li-ion cell, minus/plus the I·R drop from each cell's own internal resistance.
- **Thermal model** — a lumped pack thermal mass heated by I²R losses and cooled convectively toward ambient; cross 70°C and the simulated BMS trips, forcing the pack to Idle until it cools back down (a genuine thermal-runaway protection behavior).
- **Passive cell balancing** — while Idle, any cell sitting above the pack's minimum SoC is slowly bled down, exactly like a real passive-balancing BMS.

4 presets: Healthy Pack, Imbalanced Pack (a weak/aged cell — switch to Idle to watch it balance out), Fast DC Charging (push the C-rate and watch temperature climb), Cold Weather (higher effective resistance from low ambient temp). An **⚡ Inject Fault** button randomly weakens one cell live, so you can force an imbalance in any preset.

## LabBench Pro

Sign in to save and reload full battery scenarios — cell parameters, per-cell SoC, and thermal state — part of the same optional ₹29/mo LabBench Pro subscription as the rest of the suite. Upgrade from [Logic Circuit Simulator](https://logic-circuit-sim.vercel.app/), which hosts the checkout for all tools.

## Tech

React + TypeScript + Vite. The coulomb-counting SoC model, OCV curve, thermal model, and balancing logic are all written from scratch (`src/battery.ts`) — no Simulink or BMS libraries. Auth/save-load via Supabase (Postgres + RLS).

## Run locally
```sh
npm install
npm run dev
```

_Built by Dhananjay Kumar Seth — part of [LabBench](https://labbench-hub.vercel.app/)._

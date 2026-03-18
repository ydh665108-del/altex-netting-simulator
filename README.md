# Altex Threshold-Netting Simulator v0.3

Research prototype for a multilateral netting coordination mechanism 
designed to reduce correspondent banking capital requirements.

## What this is

A browser-based interactive simulator implementing:
- Multi-currency (USD/EUR/SGD) independent netting and thresholds
- Six-level threshold ladder with graduated responses
- FIFO payment queue with timeout rejection
- Four-stage default waterfall: rolling settlement → self-cure → forced dispatch → haircut
- Dynamic capacity from simulated custodial assets (unencumbered × 80% safety factor)
- RTGS clock with weekend mode and Friday pre-close
- Global stress mode (automatic entry, manual exit)
- System Stability Reserve (SSR)

## Companion paper

This simulator accompanies the working paper:
"Reducing Correspondent Banking Capital Requirements Through Multilateral Netting 
with Threshold-Triggered Settlement"

Available on SSRN: [link to be added after upload]

## How to run

This is a single-file React component. It can be run in any React environment 
or viewed through compatible artifact viewers.

## Status

Research prototype. Not a production system. Not financial advice.

## License

MIT

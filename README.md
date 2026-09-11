# Looksmaxx Dibya

Mobile-first browser face-scan lab created by Dibya.

## Current build
The `main` branch contains the active scanner. It uses the device camera and browser-side facial landmarks to guide front/left/right capture, retain stable usable frames, normalize roll-sensitive geometry, reject weak poses, aggregate measurements robustly, and produce a transparent 0–8 appearance heuristic with visible trait feedback.

The scan normally uses 5 seconds per angle and can extend a phase briefly when too few valid frames were captured. Camera quality is used for measurement reliability rather than attractiveness points.

## Important scoring note
The 0–8 result is a **Looksmaxx heuristic**, not a scientifically validated or objectively calibrated measure of attractiveness. The reference ranges and weights are explicit application heuristics. A genuinely calibrated attractiveness model would require a validated reference dataset and external calibration/testing.

## Privacy
Camera frames are processed in the browser by default and are not uploaded by this project. Saved results use local browser storage. No LLM/API secret is required by the client-side scanner.

## Development
Camera access requires a secure context such as HTTPS or `localhost`; a plain `file://` page cannot access the camera in normal browser security settings.

The facial-landmark runtime is loaded from the MediaPipe Face Mesh CDN, so the first scan requires network access to load the model assets.

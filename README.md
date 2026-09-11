# Looksmaxx

Mobile-first browser face-scan lab.

## Current build
The `main` branch contains the active rebuild. It uses the device camera and browser-side facial landmarks to guide a 15-second front/left/right scan, select strong frames, calculate a heuristic appearance estimate, and generate visible facial-trait and improvement guidance.

## Privacy
Camera frames are processed in the browser by default and are not uploaded by this project. Saved results use local browser storage.

## Development
Camera access requires a secure context such as HTTPS or `localhost`; a plain `file://` page cannot access the camera in normal browser security settings.

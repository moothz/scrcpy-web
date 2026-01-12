# Scrcpy Web Project

## Objective
To provide a robust, web-based interface for controlling multiple Android devices connected via USB. The system is designed for high performance and low latency, utilizing a local build of `scrcpy` and efficient stream processing.

## Architecture

- **Backend (Node.js):**
  - **Server:** Express.js + Socket.io.
  - **Streaming Pipeline:**
    1.  **Scrcpy:** Spawns a local `scrcpy` process (v3.x) for each session.
        -   Records to a unique **Named Pipe (FIFO)** (`/tmp/scrcpy_SERIAL_ID.mkv`) to strictly isolate video data from stdout logs.
        -   Forces **H.264 Baseline Profile** (`profile=1`) for maximum browser compatibility.
    2.  **FFmpeg:** Reads from the FIFO.
        -   Demuxes the MKV container.
        -   Applies the `h264_mp4toannexb` bitstream filter to add Start Codes (Annex B format) required by the frontend decoder.
        -   Outputs raw H.264 stream to stdout.
    3.  **Socket.io:** Pipes the raw H.264 stream from FFmpeg stdout to the connected client via WebSocket.
  - **Control:** Sends input events (key codes, taps, swipes) using `adb shell input`.

- **Frontend (Vanilla JS):**
  - **Decoding:** Uses `jmuxer` to decode the raw H.264 stream in the browser (using MSE).
  - **UI:** 
    -   Responsive video player (scales to 80% container height).
    -   Stream controls (Bitrate, Resolution).
    -   Input controls (Buttons, D-Pad, Mouse interaction).

## File Structure

- **`/server.js`**: Core logic. Handles authentication, ADB detection, and the Streaming Pipeline (scrcpy -> FIFO -> ffmpeg).
- **`/public/`**:
  - **`index.html`**: Dashboard UI.
  - **`js/app.js`**: Client-side logic for Socket.io and JMuxer.
  - **`css/style.css`**: Styling.
- **`/scrcpy/`**: Submodule containing the `scrcpy` source code and built artifacts (`build-auto/`).
- **`/phones.json`**: Persistence for detected devices.

## Key Configuration

- **Scrcpy Binary:** Located at `scrcpy/build-auto/app/scrcpy`.
- **Scrcpy Server:** Located at `scrcpy/build-auto/server/scrcpy-server`.
- **Environment:** `XDG_RUNTIME_DIR` is mocked to `/tmp` to satisfy SDL requirements in headless environments.
- **Stream Profile:** H.264 Baseline (Level auto), variable bitrate.
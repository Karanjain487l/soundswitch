# SoundSwitch

**Reduce the sounds you don't want to hear, while keeping speech and other sounds audible.**

Imagine someone is talking while a keyboard clicks in the background. You want to hear the person, but the typing bothers you. SoundSwitch lets you select **typing** and reduce that sound while keeping the conversation audible.

The same idea applies to sounds such as chewing, sniffing, coughing, breathing, throat clearing, and a ticking clock. You choose which sounds to filter and how strongly to reduce them.

This project explores a tool for people who find particular everyday sounds distracting or uncomfortable, including people with misophonia.

## A quick demonstration

**Illustrative example: a conversation with keyboard typing**

| Step | What happens |
| --- | --- |
| 1. Original sound | Someone speaks while a keyboard clicks nearby. |
| 2. Your selection | Select **Typing** as the sound to reduce. |
| 3. SoundSwitch processing | The detector looks for typing, and the separator reduces the selected sound. |
| 4. Intended result | The keyboard clicks become quieter while the person's speech remains audible. |

```text
BEFORE:  Person speaking + keyboard clicking + other room sounds
                              |
                     Select: reduce typing
                              |
AFTER:   Person speaking + quieter keyboard + other room sounds
```

The goal is selective filtering: choosing one unwanted sound to reduce rather than turning down the whole recording. Results depend on the audio and model performance.

### Try it yourself

1. Follow the setup instructions below and load both models.
2. Use headphones, choose your microphone, and select **Typing** in the trigger controls.
3. Click **Start listening**, then speak while typing nearby.
4. Toggle **A/B** to compare the processed sound with **A/B: ORIGINAL**.
5. Adjust the suppression strength and listen for how much typing is reduced and how well speech is preserved.

## How it works

The app combines two AI models with a browser audio pipeline:

- **Detector:** identifies the supported trigger sounds in incoming audio.
- **Separator:** uses those detections to reduce the sounds selected by the user.
- **Browser audio engine:** captures microphone audio, runs the ONNX models, and plays the processed output using JavaScript and the Web Audio API.
- **Local backend:** Python and Flask serve the app and models. SQLite saves session history, preferences, and detection metadata.

The model work uses PyTorch, with the exported models run through ONNX Runtime Web. Audio processing and inference happen in the browser.

## Included

- Live microphone console with device selection, trigger-class controls, suppression strength, and bypass.
- ONNX detector and conditioned separator integration through ONNX Runtime Web.
- FFT/STFT/ISTFT helpers and an AudioWorklet audio path.
- Session history, class breakdowns, self-test logging, and CSV export.
- [Research paper](docs/research/SoundSwitch_IRIS_Research_Paper_v3.pdf), supplied with this project (15 pages).
- [Downloadable model files](https://github.com/Karanjain487l/soundswitch/releases/tag/v1.0.0-preview.1), with sizes and SHA-256 checksums in [models/manifest.json](models/manifest.json).

Supported trigger classes in the supplied app: breathing, clock ticking, coughing, eating, sniffing, throat clearing, and typing.

## Run locally

Use Python 3.10 or newer and a current browser with microphone and Web Audio support. Headphones are recommended to avoid feeding speaker output back into the microphone.

```sh
git clone https://github.com/Karanjain487l/soundswitch.git
cd soundswitch
python -m venv .venv
```

Activate the environment on Windows:

```powershell
.venv\Scripts\Activate.ps1
```

Or on macOS/Linux:

```sh
source .venv/bin/activate
```

Install dependencies and start a local server:

```sh
python -m pip install -r requirements.txt
python -m flask --app server run --host 127.0.0.1 --port 7860
```

Open **http://localhost:7860**. Microphone access requires localhost or HTTPS; a plain HTTP LAN IP will generally not work.

The supplied `run.bat`, `run.sh`, and `python server.py` launchers are also included. They use the original server entry point, which binds to all network interfaces. This prototype has no authentication and is intended for local development.

## Download the models

Get both files from the [model release](https://github.com/Karanjain487l/soundswitch/releases/tag/v1.0.0-preview.1):

| File | Size |
| --- | ---: |
| `detector.onnx` | 310,442,379 bytes (about 310 MB) |
| `separator_int8.onnx` | 3,063,017 bytes (about 3 MB) |

Put them into `models/` without changing their names, then refresh the app. Alternatively, use the model pickers in the app; the server stores the files for later visits. The server recognizes the supplied `separator_int8.onnx` filename.

```text
models/
  detector.onnx
  separator_int8.onnx
  manifest.json
  SHA256SUMS
```

Model binaries are release assets rather than Git files. Their sizes and checksums describe the exact supplied files; they do not independently establish model provenance, accuracy, or correspondence to the paper's experiments.

After models load, run the app's **Self-test**, then use **Start listening**. ONNX Runtime Web is loaded from a CDN, so this snapshot is not fully offline on a first visit.

## Project layout

| Path | Purpose |
| --- | --- |
| `server.py` | Flask routes, model serving/upload, SQLite metadata and CSV export |
| `templates/index.html` | Live console |
| `templates/history.html` | Session history |
| `static/app.js` | Browser inference, audio routing and session recording |
| `static/engine.js` | DSP helpers and AudioWorklet implementation |
| `static/style.css` | Interface styles |
| `models/` | Model manifest and local model location |
| `data/` | Runtime database directory |
| `docs/research/` | Supplied research PDF |

## Data and privacy

The provided audio pipeline performs inference in the browser. Session and detection metadata is sent to the local Flask server, whose database is created at `data/soundswitch.db`. Uploaded ONNX models are also stored on that server. The owner's existing database and preferences are excluded from Git; a fresh checkout starts without that history.

## Validation and limitations

Publication checks cover Python and JavaScript syntax and basic Flask HTTP/session behavior using a disposable database. They do not establish real-time audio quality, browser compatibility, inference performance, clinical benefit, or reproduction of the paper's results. The app includes an interactive self-test for local checks; no automated test suite was supplied with this folder. The original README's claim of 14 passing DSP tests is not treated as a verified result here.

SoundSwitch is a research prototype. Its trigger suppression and preservation of other sounds should be evaluated with the intended models, browser, hardware, and audio before relying on its behavior.

#!/usr/bin/env python3
"""WASAPI loopback -> raw s16le PCM on stdout.

Used by the LAN cabinet to mux the native game's audio into the browser stream
without installing a virtual audio cable. The default speaker's loopback is the
same signal the host hears.
"""
import argparse
import sys

try:
    import numpy as np
    import soundcard as sc
except Exception as exc:  # pragma: no cover - reported to the node parent
    print(f"AUDIO_IMPORT_FAILED {exc}", file=sys.stderr, flush=True)
    sys.exit(2)

RATE = 48000
CHANNELS = 2
BLOCK = 960  # 20 ms


def pick_microphone(device_name=None):
    speakers = sc.all_speakers()
    default = sc.default_speaker()
    mics = sc.all_microphones(include_loopback=True)
    if device_name:
        for m in mics:
            if device_name.lower() in m.name.lower():
                return m
    if default:
        for m in mics:
            if m.name == default.name:
                return m
    for m in mics:
        if "loopback" in m.name.lower() or m.isloopback:
            return m
    return mics[0] if mics else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default=None)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for m in sc.all_microphones(include_loopback=True):
            print(m.name)
        return

    mic = pick_microphone(args.device)
    if mic is None:
        print("AUDIO_NO_LOOPBACK", file=sys.stderr, flush=True)
        sys.exit(3)

    print(f"AUDIO_READY {mic.name}", file=sys.stderr, flush=True)
    out = sys.stdout.buffer
    try:
        with mic.recorder(samplerate=RATE, channels=CHANNELS, blocksize=BLOCK) as rec:
            while True:
                data = rec.record(numframes=BLOCK)
                if data is None:
                    continue
                # soundcard returns float32 in [-1, 1].
                pcm = np.clip(data, -1.0, 1.0)
                pcm = (pcm * 32767.0).astype("<i2", copy=False)
                out.write(pcm.tobytes())
                out.flush()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception as exc:
        print(f"AUDIO_ERROR {exc}", file=sys.stderr, flush=True)
        sys.exit(4)


if __name__ == "__main__":
    main()

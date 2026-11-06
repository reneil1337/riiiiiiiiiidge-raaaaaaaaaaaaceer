@echo off
rem Launch Ridge Racer Type 4 Recomp directly (skip the built-in launcher).
rem Player 1 is configured as the connected Xbox One Controller in analog mode.
cd /d "%~dp0"
start "" "%~dp0RidgeRacer4Recomp\Ridge_Racer_4_Recompiled.exe" --no-launcher --bios "%~dp0RidgeRacer4Recomp\bios\openbios.bin" --disc "%~dp0disc\R4 - Ridge Racer Type 4 (USA).cue"

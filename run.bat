@echo off
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
echo Open http://localhost:7860
python server.py
pause

#!/usr/bin/env bash
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt
echo "Open http://localhost:7860"
python3 server.py

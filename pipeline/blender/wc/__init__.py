"""Whiskercam world-building library for Blender (run headless through run.py).

Conventions shared by every builder:
  * 1 Blender unit = 1 metre, +Z is up, everything is modelled at its real size.
  * Tiling surfaces carry UVs in metres (layer "uv0"); the material decides how many
    metres one texture repeat covers.
  * Static objects get their light worked out ahead of time (see wc.bake).
"""

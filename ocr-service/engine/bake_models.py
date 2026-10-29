"""Only invoked during image construction or an explicit local smoke setup."""

import argparse
from pathlib import Path

from model_assets import bake_models

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    parser.add_argument("--local-archives", type=Path)
    args = parser.parse_args()
    bake_models(args.destination, args.local_archives)


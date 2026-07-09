from __future__ import annotations

import os
import sys


def main() -> int:
    workspace = os.environ.get("WORKSPACE", os.getcwd())
    print(f"Python demo is running from workspace: {workspace}")
    print(f"Python executable: {sys.executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Run Hermes native Qt UI: ``python -m desktop_app`` or ``hermes-gui``."""

from __future__ import annotations

import os
import sys


def main() -> None:
    # Hermes desktop is interactive; unbuffered stderr helps diagnose import issues.
    os.environ.setdefault("PYTHONUNBUFFERED", "1")

    from PySide6.QtWidgets import QApplication

    from desktop_app.main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("Hermes")
    app.setOrganizationName("Hermes")

    win = MainWindow()
    win.show()
    raise SystemExit(app.exec())


if __name__ == "__main__":
    main()

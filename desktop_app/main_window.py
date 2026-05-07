"""
Main Qt window: in-process tui_gateway (no localhost HTTP, no browser).

Drives :func:`tui_gateway.server.dispatch` with a :class:`QueueTransport` so
streaming events, tools, and approvals reach the GUI via a polled queue.
"""

from __future__ import annotations

import queue
import webbrowser
from functools import partial
from typing import Any

from PySide6.QtCore import QTimer, Qt, QUrl
from PySide6.QtGui import QAction, QDesktopServices, QFont
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from desktop_app.queue_transport import QueueTransport

import tui_gateway.server as gw_server


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Hermes — 本地助手")
        self.resize(1100, 720)

        self._event_q: queue.Queue[dict[str, Any]] = queue.Queue()
        self._transport = QueueTransport(self._event_q)
        self._session_id: str | None = None
        self._committed = ""
        self._assistant_buffer = ""
        self._assistant_open = False
        self._busy = False
        self._tools: dict[str, QListWidgetItem] = {}
        self._req_counter = 0

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        hero = QLabel(
            "<h2 style='margin:0'>连接一切，无所不能</h2>"
            "<p style='margin:8px 0 0 0;color:#666'>本地图形界面 · 与终端版共用同一套 Agent 与配置</p>"
        )
        hero.setTextFormat(Qt.RichText)
        root.addWidget(hero)

        split = QSplitter(Qt.Horizontal)
        root.addWidget(split, stretch=1)

        chat_col = QWidget()
        chat_lay = QVBoxLayout(chat_col)
        self._transcript = QPlainTextEdit()
        self._transcript.setReadOnly(True)
        self._transcript.setFont(QFont("Segoe UI", 10))
        chat_lay.addWidget(self._transcript)

        quick = QHBoxLayout()
        for label, hint in (
            ("日常办公", "帮我整理今天的工作要点和待办。"),
            ("代码开发", "请说明本项目的入口、依赖与如何运行测试。"),
            ("深度研究", "请分步骤调研并列出需核实的要点。"),
        ):
            b = QPushButton(label)
            b.setFlat(True)
            b.clicked.connect(lambda _, h=hint: self._composer.setPlainText(h))
            quick.addWidget(b)
        quick.addStretch()
        chat_lay.addLayout(quick)

        row = QHBoxLayout()
        self._composer = QPlainTextEdit()
        self._composer.setPlaceholderText("输入消息…（Enter 发送，Shift+Enter 换行）")
        self._composer.setFixedHeight(88)
        row.addWidget(self._composer, stretch=1)

        self._send_btn = QPushButton("发送")
        self._send_btn.clicked.connect(self._on_send)
        row.addWidget(self._send_btn, alignment=Qt.AlignTop)

        self._stop_btn = QPushButton("停止")
        self._stop_btn.setEnabled(False)
        self._stop_btn.clicked.connect(self._on_stop)
        row.addWidget(self._stop_btn, alignment=Qt.AlignTop)

        chat_lay.addLayout(row)

        disclaimer = QLabel("内容由 AI 生成，请核实重要信息。")
        disclaimer.setStyleSheet("color:#888;font-size:11px;")
        disclaimer.setAlignment(Qt.AlignCenter)
        chat_lay.addWidget(disclaimer)

        split.addWidget(chat_col)

        side = QWidget()
        side_lay = QVBoxLayout(side)
        self._status = QLabel("状态：启动中…")
        self._status.setWordWrap(True)
        side_lay.addWidget(self._status)

        self._tool_list = QListWidget()
        self._tool_list.setAlternatingRowColors(True)
        side_lay.addWidget(self._tool_list, stretch=1)

        split.setSizes([780, 300])
        split.addWidget(side)

        self._build_menu()

        self._poll = QTimer(self)
        self._poll.timeout.connect(self._drain_queue)
        self._poll.start(40)

        self._composer.installEventFilter(self)
        QTimer.singleShot(0, self._bootstrap_session)

    def eventFilter(self, obj, event):  # noqa: ANN001
        from PySide6.QtCore import QEvent
        from PySide6.QtGui import QKeyEvent

        if obj is self._composer and event.type() == QEvent.Type.KeyPress:
            ke = event
            if isinstance(ke, QKeyEvent):
                if ke.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                    if ke.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                        return False
                    self._on_send()
                    return True
        return super().eventFilter(obj, event)

    def _build_menu(self) -> None:
        bar = self.menuBar()
        file_m = bar.addMenu("文件")

        act_new = QAction("新对话", self)
        act_new.triggered.connect(self._new_session)
        file_m.addAction(act_new)

        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.close)
        file_m.addAction(act_quit)

        help_m = bar.addMenu("帮助")

        act_home = QAction("打开 Hermes 配置目录", self)
        act_home.triggered.connect(self._open_hermes_home)
        help_m.addAction(act_home)

        act_docs = QAction("项目主页", self)
        act_docs.triggered.connect(
            lambda: webbrowser.open("https://github.com/NousResearch/hermes-agent")
        )
        help_m.addAction(act_docs)

    def _open_hermes_home(self) -> None:
        from hermes_constants import get_hermes_home

        QDesktopServices.openUrl(QUrl.fromLocalFile(str(get_hermes_home())))

    def _render_transcript(self) -> None:
        tail = ""
        if self._assistant_open:
            tail = f"\n── 助手 ──\n{self._assistant_buffer}"
        self._transcript.setPlainText(f"{self._committed}{tail}")
        self._transcript.moveCursor(self._transcript.textCursor().End)

    def _bootstrap_session(self) -> None:
        try:
            rid = self._next_id()
            resp = gw_server.dispatch(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "method": "session.create",
                    "params": {"cols": 100},
                },
                self._transport,
            )
            if resp and resp.get("result"):
                self._session_id = resp["result"].get("session_id")
                self._status.setText(f"状态：已连接 · 会话 {self._session_id}")
            else:
                self._status.setText("状态：session.create 无返回")
        except Exception as e:
            QMessageBox.critical(self, "启动失败", str(e))
            self._status.setText(f"状态：错误 — {e}")

    def _new_session(self) -> None:
        self._transcript.clear()
        self._committed = ""
        self._assistant_buffer = ""
        self._assistant_open = False
        self._tool_list.clear()
        self._tools.clear()
        self._busy = False
        self._send_btn.setEnabled(True)
        self._stop_btn.setEnabled(False)
        self._bootstrap_session()

    def _next_id(self) -> str:
        self._req_counter += 1
        return f"gui{self._req_counter}"

    def _dispatch(self, method: str, params: dict) -> dict | None:
        return gw_server.dispatch(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": method,
                "params": params,
            },
            self._transport,
        )

    def _on_send(self) -> None:
        text = self._composer.toPlainText().strip()
        if not text or not self._session_id or self._busy:
            return
        self._composer.clear()
        self._committed += f"\n── 你 ──\n{text}\n"
        self._render_transcript()
        self._busy = True
        self._send_btn.setEnabled(False)
        self._stop_btn.setEnabled(True)
        try:
            resp = self._dispatch(
                "prompt.submit",
                {"session_id": self._session_id, "text": text},
            )
            if resp is None:
                return
            err = resp.get("error")
            if err:
                msg = str(err.get("message", err))
                self._committed += f"\n── 系统 ──\n错误: {msg}\n"
                self._render_transcript()
                self._busy = False
                self._send_btn.setEnabled(True)
                self._stop_btn.setEnabled(False)
        except Exception as e:
            QMessageBox.warning(self, "发送失败", str(e))
            self._busy = False
            self._send_btn.setEnabled(True)
            self._stop_btn.setEnabled(False)

    def _on_stop(self) -> None:
        if not self._session_id:
            return
        try:
            self._dispatch("session.interrupt", {"session_id": self._session_id})
        except Exception:
            pass
        self._busy = False
        self._send_btn.setEnabled(True)
        self._stop_btn.setEnabled(False)

    def _drain_queue(self) -> None:
        while True:
            try:
                obj = self._event_q.get_nowait()
            except queue.Empty:
                break
            self._handle_frame(obj)

    def _handle_frame(self, obj: dict[str, Any]) -> None:
        if obj.get("method") != "event":
            return
        params = obj.get("params") or {}
        sid = params.get("session_id") or ""
        if self._session_id and sid and sid != self._session_id:
            return
        et = params.get("type")
        payload = params.get("payload") or {}

        if et == "session.info":
            model = (payload.get("model") or "—").split("/")[-1]
            warn = (payload.get("credential_warning") or "").strip()
            line = f"模型：{model} · 会话 {self._session_id or '—'}"
            if warn:
                line += f"\n⚠ {warn}"
            self._status.setText(line)
            return

        if et == "message.start":
            self._assistant_buffer = ""
            self._assistant_open = True
            self._render_transcript()
            return

        if et == "message.delta":
            chunk = str(payload.get("text") or "")
            if chunk:
                self._assistant_buffer += chunk
                self._render_transcript()
            return

        if et == "message.complete":
            final = str(payload.get("text") or "") or self._assistant_buffer
            self._committed += f"\n── 助手 ──\n{final}\n"
            self._assistant_buffer = ""
            self._assistant_open = False
            self._render_transcript()
            self._busy = False
            self._send_btn.setEnabled(True)
            self._stop_btn.setEnabled(False)
            warn = payload.get("warning")
            if warn:
                self._committed += f"\n── 提示 ──\n{warn}\n"
                self._render_transcript()
            return

        if et == "error":
            msg = str(payload.get("message") or "未知错误")
            self._committed += f"\n── 错误 ──\n{msg}\n"
            self._assistant_open = False
            self._assistant_buffer = ""
            self._render_transcript()
            self._busy = False
            self._send_btn.setEnabled(True)
            self._stop_btn.setEnabled(False)
            return

        if et == "tool.start":
            tid = str(payload.get("tool_id") or "")
            name = str(payload.get("name") or "tool")
            ctx = str(payload.get("context") or "")
            line = f"● {name}  {ctx}".strip()
            item = QListWidgetItem(line[:500])
            item.setData(Qt.ItemDataRole.UserRole, tid)
            self._tool_list.addItem(item)
            self._tools[tid] = item
            return

        if et == "tool.progress":
            name = str(payload.get("name") or "")
            preview = str(payload.get("preview") or "")
            for tid, it in list(self._tools.items()):
                if name and name in it.text():
                    base = it.text().split("…")[0]
                    it.setText(f"{base}… {preview}"[:800])
                    break
            return

        if et == "tool.complete":
            tid = str(payload.get("tool_id") or "")
            it = self._tools.get(tid)
            if it is None:
                return
            err = payload.get("error")
            summary = str(payload.get("summary") or "")
            if err:
                it.setText(f"✗ {it.text()} — {err}"[:800])
            else:
                it.setText(f"✓ {it.text()} — {summary}"[:800])
            return

        if et == "approval.request":
            self._on_approval(payload)
            return

        if et == "clarify.request":
            self._on_clarify(payload)
            return

        if et == "sudo.request":
            self._on_secret_prompt(payload, sudo=True)
            return

        if et == "secret.request":
            self._on_secret_prompt(payload, sudo=False)
            return

    def _on_approval(self, payload: dict) -> None:
        if not self._session_id:
            return
        dlg = QDialog(self)
        dlg.setWindowTitle("需要确认")
        lay = QVBoxLayout(dlg)
        lay.addWidget(QLabel(str(payload.get("description") or "危险操作")))
        cmd = QPlainTextEdit(str(payload.get("command") or ""))
        cmd.setReadOnly(True)
        cmd.setMaximumHeight(120)
        lay.addWidget(cmd)
        row = QHBoxLayout()

        def pick(choice: str) -> None:
            dlg.accept()
            try:
                self._dispatch(
                    "approval.respond",
                    {"session_id": self._session_id, "choice": choice},
                )
            except Exception as e:
                QMessageBox.warning(self, "approval", str(e))

        for label, choice in (
            ("允许一次", "once"),
            ("本会话允许", "session"),
            ("始终允许", "always"),
            ("拒绝", "deny"),
        ):
            b = QPushButton(label)
            b.clicked.connect(partial(pick, choice))
            row.addWidget(b)
        lay.addLayout(row)
        dlg.exec()

    def _on_clarify(self, payload: dict) -> None:
        if not self._session_id:
            return
        q = str(payload.get("question") or "")
        rid = str(payload.get("request_id") or "")
        choices = payload.get("choices")
        dlg = QDialog(self)
        dlg.setWindowTitle("请选择")
        form = QFormLayout(dlg)
        form.addRow(QLabel(q))
        answer = QLineEdit()
        pick = QComboBox()
        if isinstance(choices, list) and choices:
            pick.addItems([str(c) for c in choices])
        form.addRow("选项", pick)
        form.addRow("或输入", answer)
        bb = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        form.addRow(bb)
        bb.accepted.connect(dlg.accept)
        bb.rejected.connect(dlg.reject)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        text = answer.text().strip() or pick.currentText()
        if not text:
            return
        try:
            self._dispatch(
                "clarify.respond",
                {
                    "session_id": self._session_id,
                    "request_id": rid,
                    "answer": text,
                },
            )
        except Exception as e:
            QMessageBox.warning(self, "clarify", str(e))

    def _on_secret_prompt(self, payload: dict, *, sudo: bool) -> None:
        if not self._session_id:
            return
        rid = str(payload.get("request_id") or "")
        dlg = QDialog(self)
        dlg.setWindowTitle("Sudo" if sudo else "密钥")
        lay = QFormLayout(dlg)
        prompt = str(payload.get("prompt") or ("密码" if sudo else "值"))
        lay.addRow(QLabel(prompt))
        if not sudo and payload.get("env_var"):
            lay.addRow("变量", QLabel(str(payload.get("env_var"))))
        edit = QLineEdit()
        edit.setEchoMode(QLineEdit.EchoMode.Password)
        lay.addRow(edit)
        bb = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        lay.addRow(bb)
        bb.accepted.connect(dlg.accept)
        bb.rejected.connect(dlg.reject)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        val = edit.text()
        try:
            if sudo:
                self._dispatch(
                    "sudo.respond",
                    {
                        "session_id": self._session_id,
                        "request_id": rid,
                        "password": val,
                    },
                )
            else:
                self._dispatch(
                    "secret.respond",
                    {
                        "session_id": self._session_id,
                        "request_id": rid,
                        "value": val,
                    },
                )
        except Exception as e:
            QMessageBox.warning(self, "输入", str(e))

/**
 * Visual chat surface — drives Hermes via the same tui_gateway JSON-RPC as Ink,
 * without embedding the PTY / xterm TUI. Layout inspired by productivity shells
 * (hero, mode pills, bottom composer, light chrome).
 */

import { Button, Badge, Typography } from "@nous-research/ui";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/Markdown";
import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import { GatewayClient, type ConnectionState } from "@/lib/gatewayClient";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  Loader2,
  MessageSquare,
  PanelRight,
  RefreshCw,
  SendHorizontal,
  Square,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOL_LIMIT = 24;

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: "idle",
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
  error: "错误",
};

const STATE_TONE: Record<
  ConnectionState,
  "secondary" | "warning" | "success" | "destructive"
> = {
  idle: "secondary",
  connecting: "warning",
  open: "success",
  closed: "secondary",
  error: "destructive",
};

type ChatMsg =
  | { role: "user"; id: string; text: string }
  | {
      role: "assistant";
      id: string;
      text: string;
      streaming?: boolean;
    };

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const QUICK_MODES = [
  { label: "日常办公", hint: "帮我整理今天的工作要点和待办。" },
  { label: "代码开发", hint: "请阅读当前项目并说明入口与构建方式。" },
  { label: "深度研究", hint: "请分步骤调研这个主题并给出引用建议。" },
  { label: "文档处理", hint: "请帮我总结附件/文档的核心结论。" },
] as const;

interface VisualChatPaneProps {
  isActive: boolean;
  onSwitchToTerminal: () => void;
}

export function VisualChatPane({
  isActive,
  onSwitchToTerminal,
}: VisualChatPaneProps) {
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gw = useMemo(() => new GatewayClient(), [version]);

  const [conn, setConn] = useState<ConnectionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model?: string }>({});
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1023px)").matches,
  );
  const [toolsSheetOpen, setToolsSheetOpen] = useState(false);
  const [portalRoot] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null,
  );

  const streamingIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const [approval, setApproval] = useState<{
    command: string;
    description: string;
  } | null>(null);
  const [clarify, setClarify] = useState<{
    question: string;
    choices: string[] | null;
    request_id: string;
  } | null>(null);
  const [sudoSecret, setSudoSecret] = useState<{
    kind: "sudo" | "secret";
    request_id: string;
    prompt: string;
    env_var?: string;
  } | null>(null);
  const [sudoSecretValue, setSudoSecretValue] = useState("");
  const [clarifyCustom, setClarifyCustom] = useState("");

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1023px)");
    const sync = () => setNarrow(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, tools, busy]);

  const bootstrapSession = useCallback(async () => {
    const created = await gw.request<{ session_id: string }>("session.create", {
      cols: 100,
    });
    if (created?.session_id) {
      setSessionId(created.session_id);
    }
  }, [gw]);

  useEffect(() => {
    let cancelled = false;
    const offState = gw.onState(setConn);

    const offSession = gw.on<{ model?: string }>("session.info", (ev) => {
      if (ev.payload?.model) {
        setModelInfo((p) => ({ ...p, ...ev.payload }));
      }
    });

    const offStart = gw.on("message.start", () => {
      const id = genId();
      streamingIdRef.current = id;
      setMessages((m) => [...m, { role: "assistant", id, text: "", streaming: true }]);
    });

    const offDelta = gw.on<{ text?: string }>("message.delta", (ev) => {
      const chunk = ev.payload?.text ?? "";
      const sid = streamingIdRef.current;
      if (!sid || !chunk) return;
      setMessages((m) =>
        m.map((row) =>
          row.role === "assistant" && row.id === sid
            ? { ...row, text: row.text + chunk }
            : row,
        ),
      );
    });

    const offComplete = gw.on<{
      text?: string;
      status?: string;
      warning?: string;
    }>("message.complete", (ev) => {
      const sid = streamingIdRef.current;
      const finalText = (ev.payload?.text ?? "").trim();
      streamingIdRef.current = null;
      setBusy(false);
      setMessages((m) =>
        m.map((row) => {
          if (row.role !== "assistant") return row;
          if (sid && row.id === sid) {
            const text =
              finalText || row.text || (ev.payload?.status === "error" ? "（出错）" : "");
            return {
              ...row,
              text,
              streaming: false,
            };
          }
          return row.streaming ? { ...row, streaming: false } : row;
        }),
      );
      if (ev.payload?.warning) {
        setBanner(ev.payload.warning);
      }
    });

    const offErr = gw.on<{ message?: string }>("error", (ev) => {
      const msg = ev.payload?.message;
      if (msg) setBanner(msg);
      setBusy(false);
      streamingIdRef.current = null;
    });

    const offToolStart = gw.on<{
      tool_id?: string;
      name?: string;
      context?: string;
    }>("tool.start", (ev) => {
      const p = ev.payload;
      const toolId = p?.tool_id;
      if (!toolId) return;
      setTools((prev) =>
        [
          ...prev,
          {
            kind: "tool" as const,
            id: `tool-${toolId}-${prev.length}`,
            tool_id: toolId,
            name: p?.name ?? "tool",
            context: p?.context,
            status: "running" as const,
            startedAt: Date.now(),
          },
        ].slice(-TOOL_LIMIT),
      );
    });

    const offToolProg = gw.on<{ name?: string; preview?: string }>(
      "tool.progress",
      (ev) => {
        const p = ev.payload;
        if (!p?.name || !p.preview) return;
        setTools((prev) =>
          prev.map((t) =>
            t.status === "running" && t.name === p.name
              ? { ...t, preview: p.preview }
              : t,
          ),
        );
      },
    );

    const offToolDone = gw.on<{
      tool_id?: string;
      summary?: string;
      error?: string;
      inline_diff?: string;
    }>("tool.complete", (ev) => {
      const p = ev.payload;
      if (!p?.tool_id) return;
      setTools((prev) =>
        prev.map((t) =>
          t.tool_id === p.tool_id
            ? {
                ...t,
                status: p.error ? "error" : "done",
                summary: p.summary,
                error: p.error,
                inline_diff: p.inline_diff,
                completedAt: Date.now(),
              }
            : t,
        ),
      );
    });

    const offApproval = gw.on<{
      command?: string;
      description?: string;
    }>("approval.request", (ev) => {
      setApproval({
        command: String(ev.payload?.command ?? ""),
        description: String(ev.payload?.description ?? "需要确认的操作"),
      });
    });

    const offClarify = gw.on<{
      choices: string[] | null;
      question: string;
      request_id: string;
    }>("clarify.request", (ev) => {
      const p = ev.payload;
      if (!p?.request_id) return;
      setClarifyCustom("");
      setClarify({
        question: p.question,
        choices: p.choices,
        request_id: p.request_id,
      });
    });

    const offSudo = gw.on<{ request_id: string }>("sudo.request", (ev) => {
      const id = ev.payload?.request_id;
      if (!id) return;
      setSudoSecretValue("");
      setSudoSecret({ kind: "sudo", request_id: id, prompt: "需要 sudo 密码" });
    });

    const offSecret = gw.on<{
      request_id: string;
      env_var?: string;
      prompt?: string;
    }>("secret.request", (ev) => {
      const id = ev.payload?.request_id;
      if (!id) return;
      setSudoSecretValue("");
      setSudoSecret({
        kind: "secret",
        request_id: id,
        prompt: String(ev.payload?.prompt ?? "请输入密钥"),
        env_var: ev.payload?.env_var,
      });
    });

    gw.connect()
      .then(() => {
        if (cancelled) return;
        return bootstrapSession();
      })
      .catch((e: Error) => {
        if (!cancelled) setBanner(e.message);
      });

    return () => {
      cancelled = true;
      offState();
      offSession();
      offStart();
      offDelta();
      offComplete();
      offErr();
      offToolStart();
      offToolProg();
      offToolDone();
      offApproval();
      offClarify();
      offSudo();
      offSecret();
      gw.close();
    };
  }, [gw, version, bootstrapSession]);

  const reconnect = useCallback(() => {
    setBanner(null);
    setTools([]);
    setMessages([]);
    setBusy(false);
    streamingIdRef.current = null;
    setSessionId(null);
    setVersion((v) => v + 1);
  }, []);

  const sendPrompt = useCallback(async () => {
    const text = input.trim();
    if (!text || !sessionId || busy) return;
    setInput("");
    setBanner(null);
    setMessages((m) => [...m, { role: "user", id: genId(), text }]);
    setBusy(true);
    try {
      await gw.request("prompt.submit", { session_id: sessionId, text });
    } catch (e) {
      setBusy(false);
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }, [gw, input, sessionId, busy]);

  const stopTurn = useCallback(async () => {
    if (!sessionId) return;
    try {
      await gw.request("session.interrupt", { session_id: sessionId });
    } catch {
      /* ignore */
    }
    setBusy(false);
    streamingIdRef.current = null;
  }, [gw, sessionId]);

  const newChat = useCallback(async () => {
    setMessages([]);
    setTools([]);
    setBusy(false);
    streamingIdRef.current = null;
    setBanner(null);
    try {
      await bootstrapSession();
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }, [bootstrapSession]);

  const onModelSlash = useCallback(
    (slashCommand: string) => {
      if (!sessionId) return;
      void gw.request("slash.exec", {
        session_id: sessionId,
        command: slashCommand,
      });
      setModelOpen(false);
    },
    [gw, sessionId],
  );

  const respondApproval = useCallback(
    async (choice: string) => {
      if (!sessionId) return;
      setApproval(null);
      try {
        await gw.request("approval.respond", { session_id: sessionId, choice });
      } catch (e) {
        setBanner(e instanceof Error ? e.message : String(e));
      }
    },
    [gw, sessionId],
  );

  const respondClarify = useCallback(
    async (answer: string) => {
      if (!clarify) return;
      const rid = clarify.request_id;
      setClarify(null);
      try {
        await gw.request("clarify.respond", {
          session_id: sessionId,
          request_id: rid,
          answer,
        });
      } catch (e) {
        setBanner(e instanceof Error ? e.message : String(e));
      }
    },
    [gw, sessionId, clarify],
  );

  const respondSudoSecret = useCallback(async () => {
    if (!sudoSecret || !sessionId) return;
    const { kind, request_id } = sudoSecret;
    const value = sudoSecretValue;
    setSudoSecretValue("");
    setSudoSecret(null);
    try {
      if (kind === "sudo") {
        await gw.request("sudo.respond", {
          session_id: sessionId,
          request_id,
          password: value,
        });
      } else {
        await gw.request("secret.respond", {
          session_id: sessionId,
          request_id,
          value,
        });
      }
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }, [gw, sessionId, sudoSecret, sudoSecretValue]);

  const modelLabel = (modelInfo.model ?? "—").split("/").slice(-1)[0] ?? "—";
  const canPickModel = conn === "open" && !!sessionId;

  const toolsPanel = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Card className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            模型
          </div>
          <Button
            ghost
            size="sm"
            disabled={!canPickModel}
            onClick={() => setModelOpen(true)}
            suffix={canPickModel ? <ChevronDown className="opacity-60" /> : undefined}
            className="min-w-0 px-0 py-0 text-sm font-medium normal-case tracking-normal hover:underline disabled:no-underline"
          >
            <span className="truncate">{modelLabel}</span>
          </Button>
        </div>
        <Badge tone={STATE_TONE[conn]}>{STATE_LABEL[conn]}</Badge>
      </Card>

      {banner && (
        <Card className="flex items-start gap-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="wrap-break-word text-destructive">{banner}</div>
            <Button
              size="sm"
              outlined
              className="mt-1"
              onClick={reconnect}
              prefix={<RefreshCw className="h-3 w-3" />}
            >
              重新连接
            </Button>
          </div>
        </Card>
      )}

      <Card className="flex min-h-0 flex-1 flex-col px-2 py-2">
        <div className="px-1 pb-2 text-[0.65rem] uppercase tracking-wider text-muted-foreground">
          工具与步骤
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
          {tools.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              尚无工具调用
            </div>
          ) : (
            tools.map((t) => <ToolCall key={t.id} tool={t} />)
          )}
        </div>
      </Card>
    </div>
  );

  const mobileSheet =
    narrow &&
    isActive &&
    portalRoot &&
    createPortal(
      <>
        {toolsSheetOpen && (
          <button
            type="button"
            aria-label="关闭工具面板"
            className="fixed inset-0 z-[55] bg-black/50 backdrop-blur-sm"
            onClick={() => setToolsSheetOpen(false)}
          />
        )}
        <div
          className={cn(
            "fixed top-0 right-0 z-[60] flex h-dvh w-[min(20rem,100vw)] flex-col gap-2 border-l border-border/60 bg-background-base p-3 shadow-xl transition-transform",
            toolsSheetOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
          )}
        >
          <div className="flex items-center justify-between">
            <Typography className="text-sm font-semibold">模型与工具</Typography>
            <Button ghost size="icon" onClick={() => setToolsSheetOpen(false)}>
              ×
            </Button>
          </div>
          {toolsPanel}
        </div>
      </>,
      portalRoot,
    );

  if (!isActive) {
    return (
      <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 text-sm text-muted-foreground">
        切换到「聊天」标签以继续使用图形界面
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 normal-case">
      {mobileSheet}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="secondary" className="normal-case">
            <MessageSquare className="mr-1 h-3 w-3" />
            图形聊天
          </Badge>
          <Button
            size="sm"
            outlined
            onClick={newChat}
            disabled={!sessionId || busy}
            className="normal-case"
          >
            新对话
          </Button>
          {busy && (
            <Button
              size="sm"
              outlined
              onClick={stopTurn}
              prefix={<Square className="h-3 w-3" />}
              className="normal-case"
            >
              停止
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {narrow && (
            <Button
              size="sm"
              outlined
              onClick={() => setToolsSheetOpen(true)}
              prefix={<PanelRight className="h-3 w-3" />}
              className="normal-case"
            >
              工具
            </Button>
          )}
          <Button
            size="sm"
            ghost
            onClick={onSwitchToTerminal}
            prefix={<Terminal className="h-3 w-3" />}
            className="normal-case text-muted-foreground"
          >
            终端模式
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm",
            "dark:border-border dark:bg-card",
          )}
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-8">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-6 pb-8 pt-4 text-center">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-600 dark:bg-muted dark:text-muted-foreground">
                  <Bot className="h-10 w-10" strokeWidth={1.25} />
                </div>
                <div>
                  <h1 className="text-balance text-2xl font-semibold tracking-tight text-neutral-900 dark:text-midground sm:text-3xl">
                    连接一切，无所不能
                  </h1>
                  <p className="mt-2 max-w-md text-sm text-neutral-500 dark:text-muted-foreground">
                    在下方输入问题，或通过快捷场景快速开始。能力与终端版 Hermes 一致。
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {QUICK_MODES.map((m) => (
                    <button
                      key={m.label}
                      type="button"
                      onClick={() => setInput(m.hint)}
                      className={cn(
                        "rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs font-medium text-neutral-700",
                        "transition-colors hover:border-neutral-300 hover:bg-white",
                        "dark:border-border dark:bg-muted/30 dark:text-midground dark:hover:bg-muted/50",
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "flex w-full",
                  m.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[min(100%,42rem)] rounded-2xl px-4 py-3 text-sm shadow-sm",
                    m.role === "user"
                      ? "bg-neutral-900 text-neutral-50 dark:bg-primary dark:text-primary-foreground"
                      : "border border-neutral-100 bg-neutral-50 text-neutral-900 dark:border-border dark:bg-muted/40 dark:text-midground",
                  )}
                >
                  {m.role === "user" ? (
                    <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                  ) : (
                    <div className="space-y-2">
                      {m.streaming && !m.text && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          正在思考…
                        </div>
                      )}
                      {m.text ? (
                        <Markdown content={m.text} streaming={!!m.streaming} />
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="border-t border-neutral-100 bg-neutral-50/80 p-3 sm:p-4 dark:border-border dark:bg-muted/20">
            <div className="mx-auto max-w-3xl rounded-2xl border border-neutral-200 bg-white p-2 shadow-inner dark:border-border dark:bg-background/80">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendPrompt();
                  }
                }}
                rows={3}
                placeholder="输入消息…"
                disabled={!sessionId || busy}
                className={cn(
                  "w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400",
                  "disabled:opacity-50",
                )}
              />
              <div className="flex items-center justify-between gap-2 border-t border-neutral-100 px-2 py-2 dark:border-border">
                <span className="text-[0.65rem] text-neutral-400 dark:text-muted-foreground">
                  Enter 发送 · Shift+Enter 换行
                </span>
                <Button
                  size="sm"
                  onClick={() => void sendPrompt()}
                  disabled={!sessionId || busy || !input.trim()}
                  prefix={<SendHorizontal className="h-3.5 w-3.5" />}
                  className="normal-case"
                >
                  发送
                </Button>
              </div>
            </div>
            <p className="mt-2 text-center text-[0.65rem] text-neutral-400 dark:text-muted-foreground">
              内容由 AI 生成，请核实重要信息。
            </p>
          </div>
        </div>

        {!narrow && (
          <div className="flex w-full min-h-0 shrink-0 flex-col lg:w-80">{toolsPanel}</div>
        )}
      </div>

      {modelOpen && canPickModel && sessionId && (
        <ModelPickerDialog
          gw={gw}
          sessionId={sessionId}
          onClose={() => setModelOpen(false)}
          onSubmit={onModelSlash}
        />
      )}

      {approval && sessionId && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <Card className="max-w-md p-4 shadow-xl">
            <Typography className="text-base font-semibold">需要确认</Typography>
            <p className="mt-2 text-sm text-muted-foreground">{approval.description}</p>
            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-xs">
              {approval.command}
            </pre>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => respondApproval("once")}>
                允许一次
              </Button>
              <Button size="sm" outlined onClick={() => respondApproval("session")}>
                本会话允许
              </Button>
              <Button size="sm" outlined onClick={() => respondApproval("always")}>
                始终允许
              </Button>
              <Button size="sm" outlined onClick={() => respondApproval("deny")}>
                拒绝
              </Button>
            </div>
          </Card>
        </div>
      )}

      {clarify && sessionId && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <Card className="max-w-md p-4 shadow-xl">
            <Typography className="text-base font-semibold">请选择</Typography>
            <p className="mt-2 text-sm">{clarify.question}</p>
            <div className="mt-3 flex flex-col gap-2">
              {clarify.choices?.map((c) => (
                <Button key={c} size="sm" outlined onClick={() => void respondClarify(c)}>
                  {c}
                </Button>
              ))}
              <div className="flex gap-2 pt-2">
                <Input
                  value={clarifyCustom}
                  onChange={(e) => setClarifyCustom(e.target.value)}
                  placeholder="自定义回答"
                />
                <Button size="sm" onClick={() => void respondClarify(clarifyCustom)}>
                  提交
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {sudoSecret && sessionId && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <Card className="max-w-md p-4 shadow-xl">
            <Typography className="text-base font-semibold">
              {sudoSecret.kind === "sudo" ? "Sudo" : "密钥"}
            </Typography>
            <p className="mt-2 text-sm text-muted-foreground">
              {sudoSecret.prompt}
              {sudoSecret.env_var ? ` (${sudoSecret.env_var})` : ""}
            </p>
            <Input
              type="password"
              className="mt-2"
              value={sudoSecretValue}
              onChange={(e) => setSudoSecretValue(e.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" outlined onClick={() => setSudoSecret(null)}>
                取消
              </Button>
              <Button size="sm" onClick={() => void respondSudoSecret()}>
                确定
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

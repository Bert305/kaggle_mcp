"""Persistent MCP client for the web backend.

A browser cannot speak MCP: the transport here is stdio, which needs a spawned
child process and a pipe. So the backend plays the role Claude Desktop plays --
it launches ``mcp_server.py`` once, speaks the real MCP protocol over stdio, and
forwards tool calls on behalf of HTTP requests. This is the same path
``client_test.py`` exercises, so if that script passes, this bridge works.

One session is shared by every request. MCP multiplexes concurrent requests over
the single pipe via JSON-RPC ids, and FastMCP runs each sync tool in a worker
thread, so a slow ``train_model`` does not block the read loop.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent.parent
SERVER_SCRIPT = ROOT / "mcp_server.py"


class MCPToolError(RuntimeError):
    """A tool ran but reported failure back over the protocol."""


class MCPBridge:
    """Owns the lifetime of one MCP stdio session."""

    def __init__(self) -> None:
        self._stack: AsyncExitStack | None = None
        self.session: ClientSession | None = None
        self.tools: list[Any] = []
        self.prompts: list[Any] = []

    async def start(self) -> None:
        # Spawn with the interpreter already running this backend so the child
        # inherits the same virtualenv -- no dependency on `uv` being on PATH.
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(SERVER_SCRIPT)],
            cwd=str(ROOT),
            env=dict(os.environ),
        )
        self._stack = AsyncExitStack()
        read, write = await self._stack.enter_async_context(stdio_client(params))
        self.session = await self._stack.enter_async_context(ClientSession(read, write))
        await self.session.initialize()
        self.tools = list((await self.session.list_tools()).tools)
        try:
            self.prompts = list((await self.session.list_prompts()).prompts)
        except Exception:  # noqa: BLE001 -- prompts are optional for the UI
            self.prompts = []

    async def stop(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._stack = None
        self.session = None

    def _require_session(self) -> ClientSession:
        if self.session is None:
            raise RuntimeError("MCP session is not running.")
        return self.session

    async def call_text(self, name: str, arguments: dict[str, Any] | None = None) -> str:
        """Call a tool and return its text payload."""
        session = self._require_session()
        result = await session.call_tool(name, arguments or {})
        text = "\n".join(
            block.text for block in result.content if getattr(block, "type", None) == "text"
        )
        if result.isError:
            raise MCPToolError(text or f"Tool {name!r} failed.")
        return text

    async def call_json(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call a tool and parse its JSON payload.

        Several tools return a bare sentence instead of JSON when there is
        nothing to report (e.g. "No missing values found"). Those come back as
        ``{"message": ...}`` so the frontend has one shape to branch on.
        """
        text = await self.call_text(name, arguments)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"message": text.strip()}

    async def read_resource_text(self, uri: str) -> str:
        session = self._require_session()
        result = await session.read_resource(uri)
        return "\n".join(
            block.text for block in result.contents if getattr(block, "text", None)
        )

"""Convenience entry point — runs the Kaggle Analyst MCP server.

Equivalent to `uv run mcp_server.py`.
"""

from mcp_server import mcp


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

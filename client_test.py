"""Full MCP client <-> server round-trip test.

Launches mcp_server.py as a subprocess over stdio (using python.exe, which is
trusted) and speaks the real MCP protocol: initialize, list capabilities, and
call a tool. This is what an MCP client like Claude Desktop does under the hood.

Run:  uv run python client_test.py
"""

import asyncio
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Launch the server with the SAME interpreter running this script, so it uses
# the project's virtual environment.
SERVER = StdioServerParameters(command=sys.executable, args=["mcp_server.py"])


async def main() -> None:
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print("Connected to server\n")

            tools = await session.list_tools()
            print("TOOLS:", [t.name for t in tools.tools])

            prompts = await session.list_prompts()
            print("PROMPTS:", [p.name for p in prompts.prompts])

            resources = await session.list_resources()
            print("RESOURCES:", [str(r.uri) for r in resources.resources])

            print("\n--- Calling profile_dataset('train.csv') ---")
            result = await session.call_tool(
                "profile_dataset", {"filename": "train.csv", "sample_rows": 1}
            )
            # Show the first chunk of the returned text content.
            print(result.content[0].text[:400], "...")

            print("\n--- Calling train_model -> predict Survived ---")
            result = await session.call_tool(
                "train_model",
                {
                    "filename": "train.csv",
                    "target": "Survived",
                    "features": ["Pclass", "Sex", "Age", "Fare", "Embarked"],
                },
            )
            import json

            data = json.loads(result.content[0].text)
            print("task:", data["task"], "| accuracy:", data["metrics"]["accuracy"])

            print("\n--- Calling predict on two new passengers ---")
            result = await session.call_tool(
                "predict",
                {
                    "model": "train_Survived_classification",
                    "records": [
                        {"Pclass": 1, "Sex": "female", "Age": 38, "Fare": 71.3, "Embarked": "C"},
                        {"Pclass": 3, "Sex": "male", "Age": 22, "Fare": 7.25, "Embarked": "S"},
                    ],
                },
            )
            data = json.loads(result.content[0].text)
            print("predictions:", data["predictions"])

            print("\n--- Reading resource dataset://train.csv/schema ---")
            res = await session.read_resource("dataset://train.csv/schema")
            print(res.contents[0].text[:200], "...")

            print("\nFULL PROTOCOL ROUND-TRIP SUCCEEDED")


if __name__ == "__main__":
    asyncio.run(main())

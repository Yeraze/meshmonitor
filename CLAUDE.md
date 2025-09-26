- Always use context7 when I need code generation, setup or configuration steps, or
library/API documentation. This means you should automatically use the Context7 MCP
tools to resolve library id and get library docs without me having to explicitly ask.
- Only the backend talks to the Node. the Frontend never talks directly to the node.
- When sending messages for testing, use the "gauntlet" channel. Never send on Primary!
- Always use context7 when I need code generation, setup or configuration steps, or
library/API documentation. This means you should automatically use the Context7 MCP
tools to resolve library id and get library docs without me having to explicitly ask.
- Only the backend talks to the Node. the Frontend never talks directly to the node.
- When sending messages for testing, use the "gauntlet" channel. Never send on Primary!
- Always start the Dev environment via docker, and make sure to 'build' first
- You can't have both the Docker and the local npm version running at the same time, or they interfere. If you want to switch, you need to let me know.
- Load up the system on port 8080
- Never push directly to main, always push to a branch.
- Our container doesn't have sqlite3 as a binary available.
- When testing locally, use the docker-compose.dev.yml to build the local code.  Also, always make sure the proper code was deployed once the container is launched.
- Official meshtastic protobuf definitions can be found at https://github.com/meshtastic/protobufs/
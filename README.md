# opencode-cursor-oauth

OpenCode plugin that connects to Cursor's API, giving you access to Cursor
models inside OpenCode with full tool-calling support.

## OpenCode 2

Install the plugin:

```sh
opencode2 plugin add opencode-cursor-oauth
```

The command adds the package to your global configuration.

Start `opencode2`.
Run `/connect`.
Select Cursor.

You can sign in with a Cursor API key or with browser login. API keys are created in the [Cursor dashboard](https://cursor.com/dashboard). The key looks like `crsr_...`. The plugin checks it with `GET https://api.cursor.com/v1/me`, sending the key as a bearer token and retrying with basic auth (the key as the username and an empty password) when that request is unauthorized. That matches the [Cursor API authentication docs](https://cursor.com/docs/api).

`CURSOR_API_KEY` is picked up on its own when that variable is set.

The plugin registers the Cursor provider and the models returned by `GET /v1/models`.

You can also add the package directly to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-cursor-oauth"
  ]
}
```

## OpenCode V1

Add the package to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-cursor-oauth"
  ]
}
```

Connect Cursor:

```sh
opencode auth login --provider cursor
```

OpenCode V1 and OpenCode V2 add the `cursor` provider and its models.
OpenCode installs npm plugins during startup.
You do not have to clone this repository.

## Use

Start OpenCode and select any Cursor model. The plugin starts a local
OpenAI-compatible proxy on demand and routes requests through Cursor's gRPC API.

## How it works

1. Auth — a Cursor API key (`GET /v1/me`) or browser OAuth via PKCE.
2. Model discovery — `GET /v1/models` for API keys, and Cursor's gRPC model list for OAuth sessions.
3. Local proxy — translates `POST /v1/chat/completions` into Cursor's
   protobuf/HTTP/2 Connect protocol.
4. Native tool routing — redirects Cursor's built-in filesystem/shell tools
   to the equivalent OpenCode tools, and exposes OpenCode's tool surface via
   Cursor MCP.

HTTP/2 transport runs through a Node child process (`h2-bridge.mjs`) because
Bun's `node:http2` support is not reliable against Cursor's API.

## Architecture

```
OpenCode  -->  /v1/chat/completions  -->  Bun.serve (proxy)
                                              |
                                    Node child process (h2-bridge.mjs)
                                              |
                                     HTTP/2 Connect stream
                                              |
                                    api2.cursor.sh gRPC
                                      /agent.v1.AgentService/Run
```

### Tool call flow

```
1. Cursor model receives OpenAI tools via RequestContext (as MCP tool defs)
2. Model calls a tool:
   - native tools (readArgs, shellArgs, grepArgs, ...) with an OpenCode
     equivalent are redirected to it (read, bash, grep, glob, webfetch, write)
   - native tools without an equivalent are rejected with a typed error
   - MCP tools arrive as mcpArgs exec messages
3. Proxy emits OpenAI tool_calls SSE chunk, pauses H2 stream
4. OpenCode executes tool, sends result in follow-up request
5. Proxy resumes H2 stream with the typed native result (or mcpResult),
   streams continuation
```

### Conversation state

Conversation history is rebuilt from the OpenAI messages on every request
(`rootPromptMessagesJson` + content-addressed turn blobs), and server
checkpoints are persisted to `~/.cache/opencode-cursor/conversations/` so
context survives restarts. Set `CURSOR_PROXY_DEBUG=1` to log the KV blob
handshake and exec traffic when debugging.

## Develop locally

```sh
bun install
bun run build
bun test/smoke.ts
```

## Requirements

- [OpenCode](https://opencode.ai)
- [Bun](https://bun.sh)
- [Node.js](https://nodejs.org) >= 18 for the HTTP/2 bridge process
- Active [Cursor](https://cursor.com) subscription
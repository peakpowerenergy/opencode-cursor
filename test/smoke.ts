import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/proto/agent_pb";
import { Credential, Integration } from "@opencode/plugin";
import type CursorV2PluginModule from "../src/v2";

type DiscoveryMode = "success" | "empty" | "auth-error";

interface TestModules {
  startProxy: typeof import("../src/proxy").startProxy;
  stopProxy: typeof import("../src/proxy").stopProxy;
  getProxyPort: typeof import("../src/proxy").getProxyPort;
  generateCursorAuthParams: typeof import("../src/auth").generateCursorAuthParams;
  getTokenExpiry: typeof import("../src/auth").getTokenExpiry;
  CursorAuthPlugin: typeof import("../src/index").CursorAuthPlugin;
  CursorV2Plugin: typeof CursorV2PluginModule;
  getCursorModels: typeof import("../src/models").getCursorModels;
  clearModelCache: typeof import("../src/models").clearModelCache;
}

type V2Context = Parameters<TestModules["CursorV2Plugin"]["setup"]>[0];
type IntegrationTransform = Parameters<
  V2Context["integration"]["transform"]
>[0];
type IntegrationDraft = Parameters<IntegrationTransform>[0];
type IntegrationMethod = Parameters<IntegrationDraft["method"]["update"]>[0];
type ProviderTransform = Parameters<V2Context["provider"]["transform"]>[0];
type ProviderEditor = Parameters<ProviderTransform>[0];

interface TestCursorBackend {
  apiUrl: string;
  refreshUrl: string;
  setDiscoveryMode: (mode: DiscoveryMode) => void;
  setDiscoveredModels: (models: Array<{ id: string; name: string; reasoning?: boolean }>) => void;
  resetObservations: () => void;
  getDiscoveryAuthHeaders: () => string[];
  getDiscoveryRequestBodies: () => Uint8Array[];
  getRefreshAuthHeaders: () => string[];
  close: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function makeJwt(expiresAtSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ exp: expiresAtSeconds }));
  return `${header}.${payload}.fakesig`;
}

function frameConnectUnaryMessage(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

async function createTestCursorBackend(): Promise<TestCursorBackend> {
  let discoveryMode: DiscoveryMode = "success";
  let discoveredModels: Array<{ id: string; name: string; reasoning?: boolean }> = [
    { id: "composer-2", name: "Composer 2", reasoning: true },
  ];
  const discoveryAuthHeaders: string[] = [];
  const discoveryRequestBodies: Uint8Array[] = [];
  const refreshAuthHeaders: string[] = [];

  const refreshServer = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/auth/exchange_user_api_key") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    refreshAuthHeaders.push(authHeader);

    if (authHeader !== "Bearer valid-refresh") {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad refresh token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        accessToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        refreshToken: "valid-refresh",
      }),
    );
  });
  await new Promise<void>((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
  const refreshPort = (refreshServer.address() as AddressInfo).port;

  const apiServer = http2.createServer();
  apiServer.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    const authHeader = String(headers.authorization ?? "");
    if (path === "/agent.v1.AgentService/Run") {
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.end();
      return;
    }

    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      if (path === "/agent.v1.AgentService/GetUsableModels") {
        discoveryAuthHeaders.push(authHeader);
        discoveryRequestBodies.push(new Uint8Array(Buffer.concat(chunks)));

        if (
          discoveryMode === "auth-error" ||
          authHeader === "Bearer expired-access"
        ) {
          stream.respond({
            ":status": 401,
            "content-type": "application/json",
          });
          stream.end(
            JSON.stringify({ code: "unauthenticated", message: "expired token" }),
          );
          return;
        }

        const responseBody = discoveryMode === "empty"
          ? frameConnectUnaryMessage(new Uint8Array())
          : frameConnectUnaryMessage(
              toBinary(
                GetUsableModelsResponseSchema,
                create(GetUsableModelsResponseSchema, {
                  models: discoveredModels.map((model) =>
                    create(ModelDetailsSchema, {
                      modelId: model.id,
                      displayModelId: model.id,
                      displayName: model.name,
                      displayNameShort: model.name,
                      aliases: [],
                    }),
                  ),
                }),
              ),
            );
        stream.respond({
          ":status": 200,
          "content-type": "application/connect+proto",
        });
        stream.end(responseBody);
        return;
      }

      stream.respond({ ":status": 404 });
      stream.end();
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiPort = (apiServer.address() as AddressInfo).port;

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    refreshUrl: `http://127.0.0.1:${refreshPort}/auth/exchange_user_api_key`,
    setDiscoveryMode(mode) {
      discoveryMode = mode;
    },
    setDiscoveredModels(models) {
      discoveredModels = models;
    },
    resetObservations() {
      discoveryAuthHeaders.length = 0;
      discoveryRequestBodies.length = 0;
      refreshAuthHeaders.length = 0;
    },
    getDiscoveryAuthHeaders() {
      return [...discoveryAuthHeaders];
    },
    getDiscoveryRequestBodies() {
      return discoveryRequestBodies.map((body) => new Uint8Array(body));
    },
    getRefreshAuthHeaders() {
      return [...refreshAuthHeaders];
    },
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          apiServer.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          refreshServer.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    },
  };
}

async function loadModules(): Promise<TestModules> {
  // These imports must run after the test sets the Cursor endpoint environment variables.
  const proxy = await import("../src/proxy");
  const auth = await import("../src/auth");
  const index = await import("../src/index");
  const v2 = await import("../src/v2");
  const models = await import("../src/models");
  return {
    startProxy: proxy.startProxy,
    stopProxy: proxy.stopProxy,
    getProxyPort: proxy.getProxyPort,
    generateCursorAuthParams: auth.generateCursorAuthParams,
    getTokenExpiry: auth.getTokenExpiry,
    CursorAuthPlugin: index.CursorAuthPlugin,
    CursorV2Plugin: v2.default,
    getCursorModels: models.getCursorModels,
    clearModelCache: models.clearModelCache,
  };
}

async function testProxyStartStop(modules: TestModules) {
  console.log("[test] Starting proxy...");
  const port = await modules.startProxy(async () => "test-token");
  console.log(`[test] Proxy started on port ${port}`);

  if (port < 1) {
    throw new Error(`Expected a valid port number, got ${port}`);
  }
  if (modules.getProxyPort() !== port) {
    throw new Error("getProxyPort() mismatch");
  }

  const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
  if (!modelsRes.ok) {
    throw new Error(`/v1/models returned ${modelsRes.status}`);
  }
  const modelsBody = await modelsRes.json();
  if (modelsBody.object !== "list") {
    throw new Error(`Expected object=list, got ${modelsBody.object}`);
  }
  if (!Array.isArray(modelsBody.data) || modelsBody.data.length !== 0) {
    throw new Error(`Expected empty model list data array, got ${JSON.stringify(modelsBody.data)}`);
  }
  console.log("[test] /v1/models OK");

  const badRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  if (badRes.status !== 400) {
    throw new Error(`Expected 400 for missing user message, got ${badRes.status}`);
  }
  const badBody = await badRes.json();
  if (!badBody.error?.message?.includes("No user message")) {
    throw new Error(`Expected 'No user message' error, got: ${badBody.error?.message}`);
  }
  console.log("[test] Missing user message validation OK");

  const notFoundRes = await fetch(`http://localhost:${port}/unknown`);
  if (notFoundRes.status !== 404) {
    throw new Error(`Expected 404, got ${notFoundRes.status}`);
  }
  console.log("[test] 404 handling OK");

  modules.stopProxy();
  if (modules.getProxyPort() !== undefined) {
    throw new Error("Proxy port should be undefined after stop");
  }
  console.log("[test] Proxy stop OK");
}

async function testAuthParams(modules: TestModules) {
  console.log("[test] Generating auth params...");
  const params = await modules.generateCursorAuthParams();

  if (!params.verifier || !params.challenge || !params.uuid || !params.loginUrl) {
    throw new Error("Missing auth params");
  }
  if (!params.loginUrl.includes("cursor.com/loginDeepControl")) {
    throw new Error(`Unexpected login URL: ${params.loginUrl}`);
  }
  if (!params.loginUrl.includes(params.uuid)) {
    throw new Error("Login URL missing UUID");
  }

  const data = new TextEncoder().encode(params.verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const expectedChallenge = Buffer.from(hashBuffer).toString("base64url");
  if (params.challenge !== expectedChallenge) {
    throw new Error(
      `PKCE challenge mismatch: expected ${expectedChallenge}, got ${params.challenge}`,
    );
  }

  console.log("[test] Auth params OK");
}

async function testTokenExpiry(modules: TestModules) {
  console.log("[test] Testing token expiry parsing...");

  const futureExp = Math.floor(Date.now() / 1000) + 7200;
  const fakeJwt = makeJwt(futureExp);

  const expiry = modules.getTokenExpiry(fakeJwt);
  const expectedMin = futureExp * 1000 - 5 * 60 * 1000 - 1000;
  const expectedMax = futureExp * 1000 - 5 * 60 * 1000 + 1000;

  if (expiry < expectedMin || expiry > expectedMax) {
    throw new Error(`Token expiry ${expiry} out of expected range [${expectedMin}, ${expectedMax}]`);
  }

  const fallbackExpiry = modules.getTokenExpiry("not-a-jwt");
  const now = Date.now();
  const expectedFallback = now + 3600 * 1000;
  if (Math.abs(fallbackExpiry - expectedFallback) > 5000) {
    throw new Error(
      `Fallback expiry off by ${Math.abs(fallbackExpiry - expectedFallback)}ms, expected ~1h from now`,
    );
  }

  console.log("[test] Token expiry OK");
}

async function testPluginShape(modules: TestModules) {
  console.log("[test] Checking plugin export shape...");

  const fakeInput = {
    client: { auth: { set: async () => {} } },
  } as any;
  const hooks = await modules.CursorAuthPlugin(fakeInput);

  if (!hooks.auth) {
    throw new Error("Plugin hooks missing 'auth'");
  }
  if (hooks.auth.provider !== "cursor") {
    throw new Error(`Expected provider 'cursor', got '${hooks.auth.provider}'`);
  }
  if (typeof hooks.auth.loader !== "function") {
    throw new Error("Plugin hooks.auth.loader is not a function");
  }
  if (!Array.isArray(hooks.auth.methods) || hooks.auth.methods.length === 0) {
    throw new Error("Plugin hooks.auth.methods missing or empty");
  }
  if (hooks.auth.methods[0].type !== "oauth") {
    throw new Error(`Expected method type 'oauth', got '${hooks.auth.methods[0].type}'`);
  }
  if (typeof hooks.auth.methods[0].authorize !== "function") {
    throw new Error("Plugin auth method missing authorize function");
  }

  console.log("[test] Plugin shape OK");
}

async function testV2Plugin(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Checking V2 plugin...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "v2-model", name: "V2 Model", reasoning: true },
  ]);

  let integrationTransform: IntegrationTransform | undefined;
  let providerTransform: ProviderTransform | undefined;
  let authMethod: IntegrationMethod | undefined;
  const registeredMethods: IntegrationMethod[] = [];
  let integrationName: string | undefined;
  let providerPackage: string | undefined;
  let providerIntegrationID: string | undefined;
  let providerBaseURL: unknown;
  const modelIDs: string[] = [];

  const integration = { id: "cursor", name: "cursor" };
  const integrationDraft: IntegrationDraft = {
    list() {
      return [integration];
    },
    get(id) {
      return id === integration.id ? integration : undefined;
    },
    update(id, update) {
      assertEqual(id, integration.id, "Expected Cursor integration update");
      update(integration);
      integrationName = integration.name;
    },
    remove() {},
    method: {
      list() {
        return [];
      },
      update(method) {
        registeredMethods.push(method);
        if (method.method.type === "oauth") authMethod = method;
      },
      remove() {},
    },
  };

  const providerEditor: ProviderEditor = {
    list() {
      return [];
    },
    get() {
      return undefined;
    },
    add(input) {
      providerPackage = input.info.package;
      providerIntegrationID = input.info.integrationID;
      providerBaseURL = input.info.settings?.baseURL;
      modelIDs.push(...input.models.map((model) => model.id));
    },
    update() {},
    remove() {},
    models: {
      set() {},
      update() {},
      remove() {},
    },
  };

  let markReload: (() => void) | undefined;
  let failReload = false;
  function waitForReload(): Promise<void> {
    const pending = Promise.withResolvers<void>();
    markReload = pending.resolve;
    return Promise.race([
      pending.promise,
      Bun.sleep(500).then(() => {
        throw new Error("Expected V2 provider reload");
      }),
    ]);
  }
  let connected = true;
  let credential = Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("cursor-oauth"),
    refresh: "valid-refresh",
    access: "expired-access",
    expires: Date.now() - 1,
  });
  const connectionEvent = {
    id: "cursor-connection-updated",
    created: Date.now(),
    type: "integration.connection.updated" as const,
    data: { integrationID: "cursor" },
  };
  let eventClosed = false;
  const eventQueue: Array<typeof connectionEvent> = [];
  let sendEvent:
    | ((result: IteratorResult<typeof connectionEvent>) => void)
    | undefined;
  function emitUpdate(): void {
    if (sendEvent) {
      const send = sendEvent;
      sendEvent = undefined;
      send({ done: false, value: connectionEvent });
      return;
    }
    eventQueue.push(connectionEvent);
  }
  const eventStream = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<typeof connectionEvent>> {
          if (eventClosed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const event = eventQueue.shift();
          if (event) {
            return Promise.resolve({ done: false, value: event });
          }
          return new Promise((resolve) => {
            sendEvent = resolve;
          });
        },
        return(): Promise<IteratorResult<typeof connectionEvent>> {
          eventClosed = true;
          sendEvent?.({ done: true, value: undefined });
          sendEvent = undefined;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  const context = {
    integration: {
      async transform(transform: IntegrationTransform) {
        integrationTransform = transform;
        return { async dispose() {} };
      },
      async reload() {
        assert(integrationTransform, "Expected V2 integration transform");
        integrationTransform(integrationDraft);
      },
      connection: {
        async active() {
          if (!connected) return undefined;
          return {
            type: "credential" as const,
            id: "cursor-test",
            label: "Cursor",
          };
        },
        async resolve() {
          if (
            credential.expires <= Date.now() + 5 * 60 * 1000 &&
            authMethod &&
            "refresh" in authMethod &&
            authMethod.refresh
          ) {
            credential = await authMethod.refresh(credential);
          }
          return credential;
        },
      },
    },
    provider: {
      async transform(transform: ProviderTransform) {
        providerTransform = transform;
        return { async dispose() {} };
      },
      async reload() {
        modelIDs.length = 0;
        assert(providerTransform, "Expected V2 provider transform");
        providerTransform(providerEditor);
        markReload?.();
        markReload = undefined;
        if (failReload) {
          failReload = false;
          throw new Error("Injected provider reload failure");
        }
      },
    },
    event: {
      subscribe() {
        return eventStream;
      },
    },
  };

  // SAFETY: The plugin only reads the integration, provider, and event domains
  // supplied by this public-entrypoint harness.
  const cleanup = await modules.CursorV2Plugin.setup(
    context as unknown as V2Context,
  );
  assert(integrationTransform, "Expected V2 integration transform");
  failReload = true;
  const failedReload = waitForReload();
  emitUpdate();
  await failedReload;

  const retry = waitForReload();
  emitUpdate();
  await retry;
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected V2 startup to refresh an expired credential",
  );
  const discoveryHeaders = backend.getDiscoveryAuthHeaders();
  assert(
    discoveryHeaders.length > 0 &&
      discoveryHeaders.every((header) => header !== "Bearer expired-access"),
    `Expected V2 discovery to use refreshed auth, got ${JSON.stringify(discoveryHeaders)}`,
  );

  assertEqual(
    modules.CursorV2Plugin.id,
    "opencode.cursor-oauth",
    "Expected stable V2 plugin ID",
  );
  assertEqual(integrationName, "Cursor", "Expected Cursor integration name");
  assert(
    authMethod && "authorize" in authMethod,
    "Expected Cursor OAuth method",
  );
  assertEqual(authMethod.method.type, "oauth", "Expected OAuth method type");
  assertEqual(
    providerIntegrationID,
    "cursor",
    "Expected Cursor provider integration",
  );
  assertEqual(
    providerPackage,
    "@opencode/ai/providers/openai-compatible",
    "Expected V2 OpenAI-compatible provider",
  );
  assert(
    registeredMethods.some((method) => method.method.type === "key"),
    "Expected Cursor API key method",
  );
  assert(
    registeredMethods.some(
      (method) =>
        method.method.type === "env" &&
        method.method.names.includes("CURSOR_API_KEY"),
    ),
    "Expected CURSOR_API_KEY env method",
  );
  assert(
    typeof providerBaseURL === "string",
    "Expected V2 provider base URL",
  );
  assertArrayEqual(
    modelIDs.sort(),
    ["auto", "v2-model"],
    "Expected V2 provider models",
  );

  const modelsResponse = await fetch(`${providerBaseURL}/models`);
  assertEqual(modelsResponse.status, 200, "Expected V2 proxy model list");
  const modelsBody = await modelsResponse.json();
  assertArrayEqual(
    modelsBody.data.map((model: { id: string }) => model.id).sort(),
    ["auto", "v2-model"],
    "Expected V2 proxy models",
  );

  assert(authMethod.refresh, "Expected V2 OAuth refresh callback");
  backend.resetObservations();
  const refreshed = await authMethod.refresh(
    Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("cursor-oauth"),
      refresh: "valid-refresh",
      access: "expired",
      expires: Date.now() - 1,
    }),
  );
  assertEqual(
    refreshed.methodID,
    Integration.MethodID.make("cursor-oauth"),
    "Expected refreshed V2 credential method",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected V2 refresh token request",
  );

  connected = false;
  const stopped = waitForReload();
  emitUpdate();
  await stopped;
  assertEqual(
    modules.getProxyPort(),
    undefined,
    "Expected V2 disconnect to stop the proxy",
  );

  assert(typeof cleanup === "function", "Expected V2 cleanup");
  const cleanedUp = await Promise.race([
    cleanup().then(() => true),
    Bun.sleep(500).then(() => false),
  ]);
  assert(cleanedUp, "Expected V2 cleanup to finish");
  assert(eventClosed, "Expected V2 cleanup to close the event stream");
  assertEqual(
    modules.getProxyPort(),
    undefined,
    "Expected V2 cleanup to stop the proxy",
  );
  console.log("[test] V2 plugin OK");
}

async function testArrayContentParsing(modules: TestModules) {
  console.log("[test] Testing array content (plan-mode) parsing...");
  const port = await modules.startProxy(async () => "test-token");

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a helpful assistant." },
            { type: "text", text: "Plan mode is active." },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "lazy-load recharts" },
            { type: "text", text: "work on a plan" },
          ],
        },
      ],
    }),
  });

  if (res.status === 400) {
    const body = await res.json();
    if (body.error?.message?.includes("No user message")) {
      throw new Error(
        "Array content not normalized — plan mode messages lost",
      );
    }
  }

  modules.stopProxy();
  console.log("[test] Array content parsing OK");
}

async function testExpiredTokenRefreshBeforeDiscovery(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing refresh-before-discovery...");
  modules.clearModelCache();
  backend.resetObservations();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "fresh-model", name: "Fresh Model", reasoning: true },
  ]);

  let authState = {
    type: "oauth" as const,
    access: "expired-access",
    refresh: "valid-refresh",
    expires: Date.now() - 10_000,
  };
  const writes: Array<{ access: string; refresh: string; expires: number }> = [];
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async ({ body }: any) => {
          writes.push(body);
          authState = body;
        },
      },
    },
  } as any);
  const provider = { models: {} as Record<string, unknown> } as any;

  await hooks.auth!.loader(async () => authState, provider);

  assertEqual(writes.length, 1, "Expected refreshed auth to be persisted once");
  assert(
    writes[0]?.access && writes[0].access !== "expired-access",
    "Expected refreshed access token to replace the expired token",
  );
  assertArrayEqual(
    backend.getRefreshAuthHeaders(),
    ["Bearer valid-refresh"],
    "Expected refresh endpoint to be called with the stored refresh token",
  );
  assert(
    backend.getDiscoveryAuthHeaders().every((header) => header === `Bearer ${writes[0]?.access}`),
    `Expected discovery to use the refreshed token, got ${JSON.stringify(backend.getDiscoveryAuthHeaders())}`,
  );
  assertArrayEqual(
    Object.keys(provider.models),
    ["auto", "fresh-model"],
    "Expected provider models to come from successful discovery",
  );

  modules.stopProxy();
  console.log("[test] Refresh-before-discovery OK");
}

async function testDiscoveryFallbackAndSuccess(
  modules: TestModules,
  backend: TestCursorBackend,
) {
  console.log("[test] Testing discovery fallback and success...");

  const authState = {
    type: "oauth" as const,
    access: makeJwt(Math.floor(Date.now() / 1000) + 3600),
    refresh: "valid-refresh",
    expires: Date.now() + 3_600_000,
  };
  const hooks = await modules.CursorAuthPlugin({
    client: {
      auth: {
        set: async () => {},
      },
    },
  } as any);
  const provider = { models: { stale: { id: "stale" } } } as any;

  // Failed discovery should fall back to hardcoded models
  modules.clearModelCache();
  backend.setDiscoveryMode("empty");
  const degradedConfig = await hooks.auth!.loader(async () => authState, provider);
  assert(
    Object.keys(provider.models).length > 0,
    "Expected fallback models to be registered when discovery fails",
  );
  assert(
    !("stale" in provider.models),
    "Expected stale models to be replaced",
  );
  const degradedModelsRes = await fetch(`${degradedConfig.baseURL}/models`);
  assertEqual(degradedModelsRes.status, 200, "Expected degraded /v1/models to succeed");
  const degradedModelsBody = await degradedModelsRes.json();
  assert(
    degradedModelsBody.data.length > 0,
    "Expected proxy /v1/models to expose fallback models",
  );

  // Successful discovery should replace with real models
  modules.clearModelCache();
  backend.setDiscoveryMode("success");
  backend.setDiscoveredModels([
    { id: "real-model-a", name: "Real Model A" },
    { id: "real-model-b", name: "Real Model B", reasoning: true },
  ]);
  const discoveredConfig = await hooks.auth!.loader(async () => authState, provider);
  assertArrayEqual(
    Object.keys(provider.models).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected successful discovery to replace fallback models",
  );
  const discoveredModelsRes = await fetch(`${discoveredConfig.baseURL}/models`);
  assertEqual(discoveredModelsRes.status, 200, "Expected discovered /v1/models to succeed");
  const discoveredModelsBody = await discoveredModelsRes.json();
  assertArrayEqual(
    discoveredModelsBody.data.map((model: { id: string }) => model.id).sort(),
    ["auto", "real-model-a", "real-model-b"],
    "Expected proxy /v1/models to expose discovered models",
  );

  modules.stopProxy();
  console.log("[test] Discovery fallback and success OK");
}

async function testV2ApiKey(modules: TestModules) {
  console.log("[test] Checking V2 Cursor API key auth...");
  modules.clearModelCache();
  modules.stopProxy();

  const meAuthHeaders: string[] = [];
  const acceptedKey = "crsr_test";
  const cloudServer = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const basic = (key: string) =>
      auth === `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
    const authorized = basic(acceptedKey);
    if (req.url === "/v1/me") {
      meAuthHeaders.push(auth);
      if (!authorized) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ apiKeyName: "opencode", userEmail: "dev@example.com" }));
      return;
    }
    if (req.url === "/v1/models") {
      if (!authorized) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            { id: "composer-2", displayName: "Composer 2" },
            { id: "claude-4.6-sonnet-thinking", displayName: "Claude 4.6 Sonnet (Thinking)" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => cloudServer.listen(0, "127.0.0.1", resolve));
  const cloudPort = (cloudServer.address() as AddressInfo).port;
  process.env.CURSOR_CLOUD_API_URL = `http://127.0.0.1:${cloudPort}`;

  const modelIDs: string[] = [];
  const statuses: string[] = [];
  let providerTransform: ProviderTransform | undefined;
  let markReload: (() => void) | undefined;
  function waitForReload(): Promise<void> {
    const pending = Promise.withResolvers<void>();
    markReload = pending.resolve;
    return pending.promise;
  }

  let eventClosed = false;
  const eventQueue: Array<{ type: string; data: { integrationID: string } }> = [];
  let sendEvent: ((result: IteratorResult<{ type: string; data: { integrationID: string } }>) => void) | undefined;
  const eventStream = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<{ type: string; data: { integrationID: string } }>> {
          if (eventClosed) return Promise.resolve({ done: true, value: undefined });
          const event = eventQueue.shift();
          if (event) return Promise.resolve({ done: false, value: event });
          return new Promise((resolve) => {
            sendEvent = resolve;
          });
        },
        return(): Promise<IteratorResult<{ type: string; data: { integrationID: string } }>> {
          eventClosed = true;
          sendEvent?.({ done: true, value: undefined });
          sendEvent = undefined;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  function contextFor(key: string) {
    const connection = {
      type: "credential" as const,
      id: "cursor-key",
      label: "Cursor API key",
      method: "key" as const,
    };
    return {
      integration: {
        async transform(transform: IntegrationTransform) {
          transform({
            list: () => [{ id: "cursor", name: "cursor" }],
            get: (id: string) => (id === "cursor" ? { id: "cursor", name: "cursor" } : undefined),
            update: (_id: string, update: (integration: { id: string; name: string }) => void) => {
              update({ id: "cursor", name: "cursor" });
            },
            remove() {},
            method: { list: () => [], update() {}, remove() {} },
          });
          return { async dispose() {} };
        },
        async reload() {},
        connection: {
          async active() {
            return connection;
          },
          async resolve() {
            return { type: "key" as const, key };
          },
          async status(input: { status?: { status?: string } }) {
            if (input.status?.status) statuses.push(input.status.status);
          },
        },
      },
      provider: {
        async transform(transform: ProviderTransform) {
          providerTransform = transform;
          return { async dispose() {} };
        },
        async reload() {
          modelIDs.length = 0;
          providerTransform?.({
            list: () => [],
            get: () => undefined,
            add(input) {
              modelIDs.push(...input.models.map((model) => model.id));
            },
            update() {},
            remove() {},
            models: { set() {}, update() {}, remove() {} },
          });
          markReload?.();
          markReload = undefined;
        },
      },
      event: { subscribe: () => eventStream },
    };
  }

  try {
    const rejected = await modules.CursorV2Plugin.setup(
      contextFor("crsr_rejected") as unknown as V2Context,
    );
    assert(typeof rejected === "function", "Expected rejected-key cleanup");
    await rejected();
    assertArrayEqual(
      meAuthHeaders.slice(0, 2),
      ["Bearer crsr_rejected", `Basic ${Buffer.from("crsr_rejected:").toString("base64")}`],
      "Expected API key check to try Bearer, then Basic",
    );
    assertArrayEqual(statuses, ["needs_auth"], "Expected a rejected API key to need auth");
    assertEqual(modelIDs.length, 0, "Expected a rejected API key to register no models");

    meAuthHeaders.length = 0;
    statuses.length = 0;
    eventClosed = false;
    const accepted = await modules.CursorV2Plugin.setup(
      contextFor(acceptedKey) as unknown as V2Context,
    );
    const loaded = waitForReload();
    const switched = {
      type: "credential.switched",
      data: { integrationID: "cursor" },
    };
    if (sendEvent) {
      const send = sendEvent;
      sendEvent = undefined;
      send({ done: false, value: switched });
    } else {
      eventQueue.push(switched);
    }
    await loaded;
    assertArrayEqual(
      meAuthHeaders.slice(0, 2),
      [
        `Bearer ${acceptedKey}`,
        `Basic ${Buffer.from(`${acceptedKey}:`).toString("base64")}`,
      ],
      "Expected a valid API key to fall back from Bearer to Basic",
    );
    assertArrayEqual(
      modelIDs.sort(),
      ["auto", "claude-4.6-sonnet-thinking", "composer-2"],
      "Expected models from GET /v1/models",
    );
    assert(
      modelIDs.includes("claude-4.6-sonnet-thinking"),
      "Expected thinking models to stay addressable",
    );
    assertEqual(modules.getProxyPort() === undefined, false, "Expected the API key to start the proxy");
    assert(typeof accepted === "function", "Expected API key cleanup");
    await accepted();
    assert(eventClosed, "Expected API key cleanup to close the event stream");
    console.log("[test] V2 Cursor API key auth OK");
  } finally {
    delete process.env.CURSOR_CLOUD_API_URL;
    modules.stopProxy();
    await new Promise<void>((resolve, reject) =>
      cloudServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function main() {
  const backend = await createTestCursorBackend();
  process.env.CURSOR_API_URL = backend.apiUrl;
  process.env.CURSOR_REFRESH_URL = backend.refreshUrl;

  const modules = await loadModules();

  try {
    await testProxyStartStop(modules);
    await testAuthParams(modules);
    await testTokenExpiry(modules);
    await testPluginShape(modules);
    await testArrayContentParsing(modules);
    await testExpiredTokenRefreshBeforeDiscovery(modules, backend);
    await testDiscoveryFallbackAndSuccess(modules, backend);
    await testV2Plugin(modules, backend);
    await testV2ApiKey(modules);
    console.log("\n✓ All smoke tests passed");
    process.exitCode = 0;
  } catch (err) {
    console.error("\n✗ Smoke test failed:", err);
    process.exitCode = 1;
  } finally {
    modules.stopProxy();
    await backend.close();
  }
}

main();

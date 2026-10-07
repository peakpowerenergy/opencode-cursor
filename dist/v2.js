import { Credential, Integration, Model, Plugin, Provider, } from "@opencode/plugin";
import { generateCursorAuthParams, getTokenExpiry, pollCursorAuth, refreshCursorToken, } from "./auth";
import { accessTokenForCursorApiKey, listCursorCloudModels, } from "./cursor-api";
import { clearModelCache, getCursorModels, } from "./models";
import { startProxy, stopProxy } from "./proxy";
const CURSOR_ID = "cursor";
const CURSOR_INTEGRATION_ID = Integration.ID.make(CURSOR_ID);
const CURSOR_METHOD_ID = Integration.MethodID.make("cursor-oauth");
const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";
const CursorV2Plugin = Plugin.define({
    id: "opencode.cursor-oauth",
    setup: async (ctx) => {
        await ctx.integration.transform((draft) => {
            draft.update(CURSOR_ID, (integration) => {
                integration.name = "Cursor";
            });
            draft.method.update({
                integrationID: CURSOR_INTEGRATION_ID,
                method: {
                    id: CURSOR_METHOD_ID,
                    type: "oauth",
                    label: "Login with Cursor",
                },
                async authorize() {
                    const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
                    return {
                        mode: "auto",
                        url: loginUrl,
                        instructions: "Complete login in your browser. This window will close automatically.",
                        callback: pollCursorAuth(uuid, verifier).then(({ accessToken, refreshToken }) => Credential.OAuth.make({
                            type: "oauth",
                            methodID: CURSOR_METHOD_ID,
                            refresh: refreshToken,
                            access: accessToken,
                            expires: getTokenExpiry(accessToken),
                        })),
                    };
                },
                async refresh(credential) {
                    const refreshed = await refreshCursorToken(credential.refresh);
                    return Credential.OAuth.make({
                        ...credential,
                        methodID: CURSOR_METHOD_ID,
                        refresh: refreshed.refresh,
                        access: refreshed.access,
                        expires: refreshed.expires,
                    });
                },
            });
            draft.method.update({
                integrationID: CURSOR_INTEGRATION_ID,
                method: {
                    type: "key",
                    label: "Cursor API key",
                },
            });
            draft.method.update({
                integrationID: CURSOR_INTEGRATION_ID,
                method: {
                    type: "env",
                    names: ["CURSOR_API_KEY"],
                },
            });
        });
        // Setup batches transforms, so apply auth before loading providers.
        await ctx.integration.reload();
        let catalog = await loadCatalog(ctx);
        await ctx.provider.transform((editor) => {
            const current = catalog;
            if (!current)
                return;
            const providerID = Provider.ID.make(CURSOR_ID);
            editor.add({
                info: {
                    ...Provider.Info.empty(providerID),
                    integrationID: CURSOR_INTEGRATION_ID,
                    name: "Cursor",
                    activation: "auto",
                    package: OPENAI_COMPATIBLE_PACKAGE,
                    settings: {
                        baseURL: `http://localhost:${current.port}/v1`,
                    },
                },
                models: current.models.map((cursorModel) => ({
                    ...Model.Info.default(providerID, Model.ID.make(cursorModel.id)),
                    name: cursorModel.name,
                    capabilities: {
                        tools: true,
                        input: ["text"],
                        output: ["text"],
                    },
                    limit: {
                        context: cursorModel.contextWindow,
                        output: cursorModel.maxTokens,
                    },
                    status: "active",
                    enabled: true,
                })),
                sourceConnection: current.connection,
            });
        });
        const stopWatching = watchConnections(ctx, async () => {
            clearModelCache();
            catalog = await loadCatalog(ctx);
            if (!catalog)
                stopProxy();
            await ctx.provider.reload();
        });
        return async () => {
            try {
                await stopWatching();
            }
            finally {
                stopProxy();
            }
        };
    },
});
export default CursorV2Plugin;
async function loadCatalog(ctx) {
    try {
        const auth = await resolveAuth(ctx);
        const connection = await ctx.integration.connection.active(CURSOR_ID);
        const models = await loadModels(auth);
        const port = await startProxy(() => resolveAccessToken(ctx), models);
        return {
            models,
            port,
            connection: connection,
        };
    }
    catch (error) {
        await reportAuthFailure(ctx, error);
        return undefined;
    }
}
async function loadModels(auth) {
    if (auth.kind === "api") {
        const cloudModels = await listCursorCloudModels(auth.key);
        if (cloudModels && cloudModels.length > 0)
            return cloudModels;
    }
    return getCursorModels(auth.access);
}
async function resolveAccessToken(ctx) {
    const auth = await resolveAuth(ctx);
    return auth.access;
}
async function resolveAuth(ctx) {
    const connection = await ctx.integration.connection.active(CURSOR_ID);
    if (!connection)
        throw new Error("Cursor auth not configured");
    if (connection.type === "env") {
        const key = process.env[connection.name]?.trim();
        if (!key)
            throw new Error("Cursor auth not configured");
        return {
            kind: "api",
            key,
            access: await accessTokenForCursorApiKey(key),
        };
    }
    const credential = await ctx.integration.connection.resolve(connection);
    if (!credential)
        throw new Error("Cursor auth not configured");
    if (credential.type === "oauth") {
        if (!credential.access)
            throw new Error("Cursor auth not configured");
        return { kind: "oauth", access: credential.access };
    }
    const key = credential.key.trim();
    if (!key)
        throw new Error("Cursor auth not configured");
    return {
        kind: "api",
        key,
        access: await accessTokenForCursorApiKey(key),
    };
}
async function reportAuthFailure(ctx, error) {
    const message = error instanceof Error ? error.message : "Cursor authentication failed";
    if (!message.includes("rejected") && !message.includes("check failed"))
        return;
    const connection = await ctx.integration.connection
        .active(CURSOR_ID)
        .catch(() => undefined);
    if (!connection)
        return;
    await ctx.integration.connection
        .status({
        integrationID: CURSOR_ID,
        connection,
        status: { status: "needs_auth", message },
    })
        .catch(() => { });
}
function watchConnections(ctx, refresh) {
    const events = ctx.event.subscribe()[Symbol.asyncIterator]();
    const watcher = (async () => {
        try {
            while (true) {
                const next = await events.next();
                if (next.done)
                    return;
                if (isCursorAuthEvent(next.value)) {
                    await refresh().catch(() => { });
                }
            }
        }
        catch { }
    })();
    return async () => {
        await events.return?.();
        await watcher;
    };
}
function isCursorAuthEvent(event) {
    const integrationID = integrationIdFromEvent(event);
    return ((event.type === "credential.switched" ||
        event.type === "integration.connection.updated") &&
        integrationID === CURSOR_ID);
}
function integrationIdFromEvent(event) {
    if (!event.data || typeof event.data !== "object")
        return undefined;
    const integrationID = event.data.integrationID;
    return typeof integrationID === "string" ? integrationID : undefined;
}

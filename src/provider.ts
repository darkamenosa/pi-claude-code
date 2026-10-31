import { createProvider, type AuthContext, type ProviderEnv } from "@earendil-works/pi-ai";
import { discoverClaudeModels, resolveClaudeExecutable } from "./claude-cli.ts";
import { API_ID, CLAUDE_CODE_MODELS, modelFromDiscovery, PROVIDER_ID } from "./model-catalog.ts";
import { streamClaudeCode } from "./stream.ts";

const PROVIDER_ENV_NAMES = ["PI_CLAUDE_CODE_COMMAND", "PI_CLAUDE_CODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

async function providerEnvironment(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

// Pi resolves provider-scoped settings (such as PI_CLAUDE_CODE_COMMAND) only
// through auth hooks. Remember the latest values so model discovery and the
// status command look at the same Claude Code installation as requests do.
let lastProviderEnv: ProviderEnv | undefined;

/** The environment used to locate and configure Claude Code. */
export function claudeCodeEnv(): Record<string, string | undefined> {
  return { ...process.env, ...lastProviderEnv };
}

export function createClaudeCodeProvider() {
  let discoveredIds: Set<string> | undefined;
  const externalOAuthMarker = () => ({
    type: "oauth" as const,
    access: "claude-code-external",
    refresh: "claude-code-external",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });
  return createProvider({
    id: PROVIDER_ID,
    name: "Claude Code Subscription (Experimental)",
    baseUrl: "process://claude-code",
    auth: {
      apiKey: {
        name: "Claude Code login",
        // Claude Code owns authentication. Assume a subscription so Pi can
        // label list-price accounting as "(sub)" without running an auth probe.
        async check({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          const command = await resolveClaudeExecutable(claudeCodeEnv());
          signal.throwIfAborted();
          if (!command) return undefined;
          return {
            type: "oauth",
            source: "Claude Code subscription (assumed)",
          };
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          return {
            auth: { apiKey: "external-process" },
            env: providerEnv,
            source: "Claude Code CLI",
          };
        },
      },
      // Metadata marker for Pi's subscription-aware UI. This is deliberately
      // not the request auth path and never imports Claude Code credentials.
      // Login and logout are handled by the Claude Code CLI itself.
      oauth: {
        name: "Claude Code subscription (managed by Claude Code)",
        isSubscription: true,
        async login() {
          throw new Error(
            "Claude Code manages its own login. Run `claude auth login` in a terminal instead; " +
              "this provider uses it automatically.",
          );
        },
        async refresh(_credential, signal) {
          signal.throwIfAborted();
          return externalOAuthMarker();
        },
        async toAuth() {
          return { apiKey: "external-process" };
        },
      },
    },
    models: CLAUDE_CODE_MODELS,
    async fetchModels({ signal }) {
      const models = (await discoverClaudeModels(claudeCodeEnv(), signal)).map(modelFromDiscovery);
      discoveredIds = new Set(models.map((model) => model.id));
      return models;
    },
    filterModels(models) {
      const ids = discoveredIds;
      return ids ? models.filter((model) => ids.has(model.id)) : models;
    },
    api: {
      stream: streamClaudeCode,
      streamSimple: streamClaudeCode,
    },
  });
}

export { API_ID, PROVIDER_ID };

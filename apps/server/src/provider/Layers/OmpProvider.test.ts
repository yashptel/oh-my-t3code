import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeCursorCommandCatalog } from "./CursorProvider.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  parseOmpModelsJson,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// Trimmed from `omp models --json` (OMP v18.2.3). Cost fields dropped.
const OMP_MODELS_JSON = JSON.stringify({
  models: [
    {
      provider: "anthropic",
      id: "claude-3-5-sonnet-20240620",
      selector: "anthropic/claude-3-5-sonnet-20240620",
      name: "Claude Sonnet 3.5",
      contextWindow: 200000,
      maxTokens: 8192,
      reasoning: false,
      thinking: null,
      input: ["text", "image"],
    },
    {
      provider: "anthropic",
      id: "claude-haiku-4-5",
      selector: "anthropic/claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      thinking: ["minimal", "low", "medium", "high", "xhigh"],
      contextWindow: 200000,
      maxTokens: 64000,
      input: ["text", "image"],
    },
    {
      provider: "google-antigravity",
      id: "gemini-2.5-flash",
      selector: "google-antigravity/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      reasoning: true,
      thinking: ["minimal", "low", "medium", "high"],
      contextWindow: 1048576,
      maxTokens: 65535,
      input: ["text", "image"],
    },
    {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      selector: "openai-codex/gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      reasoning: true,
      thinking: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 272000,
      maxTokens: 128000,
      input: ["text", "image"],
    },
    {
      provider: "openrouter",
      id: "openai/gpt-4.1",
      selector: "openrouter/openai/gpt-4.1",
      name: "GPT-4.1",
      reasoning: false,
      thinking: null,
      contextWindow: 1047576,
      maxTokens: 32768,
      input: ["text", "image"],
    },
    {
      provider: "openrouter",
      id: "x-ai/grok-4-fast",
      selector: "openrouter/x-ai/grok-4-fast",
      name: "Grok 4 Fast",
      reasoning: true,
      thinking: ["minimal", "low", "medium", "high"],
      contextWindow: 2000000,
      maxTokens: 30000,
      input: ["text", "image"],
    },
  ],
});

// First frame OMP pushes after `session/new`, trimmed to representative entries.
const OMP_AVAILABLE_COMMANDS: ReadonlyArray<EffectAcpSchema.AvailableCommand> = [
  {
    name: "security",
    description: "Plan, run, inspect, import, and compare OMP-native security scans",
    input: {
      hint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
    },
  },
  { name: "model", description: "Show current model selection" },
  { name: "switch", description: "Switch model for this session only", input: { hint: "[model]" } },
  {
    name: "skill:ai-sdk",
    description: "Answer questions about the AI SDK and help build AI-powered features.",
    input: { hint: "arguments" },
  },
  {
    name: "compact",
    description: "Compact the conversation",
    input: { hint: "[soft|remote|snapcompact] [focus]" },
  },
];

describe("parseOmpModelsJson", () => {
  it("lists the sentinel first and one model per selector", () => {
    const models = parseOmpModelsJson(OMP_MODELS_JSON);
    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "anthropic/claude-3-5-sonnet-20240620",
      "anthropic/claude-haiku-4-5",
      "google-antigravity/gemini-2.5-flash",
      "openai-codex/gpt-5.6-sol",
      "openrouter/openai/gpt-4.1",
      "openrouter/x-ai/grok-4-fast",
    ]);
    expect(models[0]).toEqual({
      slug: "default",
      name: "OMP default model",
      isDefault: true,
      isCustom: false,
      capabilities: null,
    });
    expect(models.slice(1).every((model) => model.isDefault === undefined)).toBe(true);
  });

  it("carries the OMP provider as subProvider", () => {
    const models = parseOmpModelsJson(OMP_MODELS_JSON);
    expect(models.find((model) => model.slug === "openrouter/openai/gpt-4.1")?.subProvider).toBe(
      "openrouter",
    );
    expect(models.find((model) => model.slug === "openai-codex/gpt-5.6-sol")?.name).toBe(
      "GPT-5.6-Sol",
    );
  });

  it("exposes a thinking select only for reasoning models", () => {
    const models = parseOmpModelsJson(OMP_MODELS_JSON);
    const haiku = models.find((model) => model.slug === "anthropic/claude-haiku-4-5");
    expect(haiku?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: ["minimal", "low", "medium", "high", "xhigh"].map((level) => ({
          id: level,
          label: level,
        })),
      },
    ]);
    expect(
      models.find((model) => model.slug === "anthropic/claude-3-5-sonnet-20240620")?.capabilities,
    ).toBeNull();
  });

  it("returns nothing for output that is not the models document", () => {
    expect(parseOmpModelsJson("Working...\n")).toEqual([]);
    expect(parseOmpModelsJson(JSON.stringify({ models: "nope" }))).toEqual([]);
  });
});

describe("buildInitialOmpProviderSnapshot", () => {
  it.effect("marks a disabled provider as disabled without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      expect(snapshot.displayName).toBe("Oh My Pi");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(
        decodeOmpSettings({ enabled: true, customModels: [{ slug: "my-org/custom" }] }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking Oh My Pi");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "my-org/custom"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  const writeFakeOmpCli = (input: {
    readonly modelsJson: string;
    readonly modelsExitCode: number;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "omp",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("omp/18.2.3\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "models" && process.argv[3] === "--json") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.modelsJson)});`,
          `  process.exit(${input.modelsExitCode});`,
          "}",
          "process.exit(9);",
          "",
        ].join("\n"),
      });
    });

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({ enabled: true, binaryPath: "/definitely/not/installed/omp-binary" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports ready with discovered models and OMP-owned credentials", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const ompPath = yield* writeFakeOmpCli({
            modelsJson: OMP_MODELS_JSON,
            modelsExitCode: 0,
          });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("18.2.3");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "agent",
        label: "OMP credentials",
      });
      expect(snapshot.models[0]?.slug).toBe("default");
      expect(snapshot.models).toHaveLength(7);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("degrades to the sentinel when the model listing fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const ompPath = yield* writeFakeOmpCli({ modelsJson: "boom", modelsExitCode: 1 });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      expect(snapshot.message).toContain("returned no models");
    }),
  );

  it.effect("publishes OMP slash commands per workspace through the command catalog", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const ompPath = yield* writeFakeOmpCli({
            modelsJson: OMP_MODELS_JSON,
            modelsExitCode: 0,
          });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );
      const machineSnapshot: ServerProvider = {
        ...snapshot,
        instanceId: ProviderInstanceId.make("omp"),
        driver: ProviderDriverKind.make("omp"),
      };
      const catalog = yield* makeCursorCommandCatalog({
        resolveMaintenance: () => Effect.die("unused"),
        getSnapshot: Effect.succeed(machineSnapshot),
        refresh: Effect.succeed(machineSnapshot),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      });
      yield* catalog.onAvailableCommands(OMP_AVAILABLE_COMMANDS, "/work/a", []);
      const forWorkspace = yield* catalog.snapshotForCwd("/work/a", []);
      expect(forWorkspace.slashCommands.map((command) => command.name)).toEqual([
        "compact",
        "security",
        "model",
        "switch",
        "skill:ai-sdk",
      ]);
      expect(
        forWorkspace.slashCommands.find((command) => command.name === "switch")?.input,
      ).toEqual({ hint: "[model]" });
      const elsewhere = yield* catalog.snapshotForCwd("/work/b", []);
      expect(elsewhere.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );
});

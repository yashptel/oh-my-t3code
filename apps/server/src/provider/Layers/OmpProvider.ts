import type {
  CustomModelSetting,
  ModelCapabilities,
  OmpSettings,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { OMP_DEFAULT_MODEL_SLUG, OMP_THINKING_OPTION_ID } from "../acp/OmpAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: OMP_DEFAULT_MODEL_SLUG,
  name: "OMP default model",
  isDefault: true,
  isCustom: false,
  capabilities: null,
};

/** One entry of `omp models --json`. Cost and context fields are ignored. */
const OmpModelsJson = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      selector: Schema.String,
      name: Schema.String,
      reasoning: Schema.Boolean,
      thinking: Schema.NullOr(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeOmpModelsJson = Schema.decodeUnknownOption(Schema.fromJsonString(OmpModelsJson));

/** Discovered models after the sentinel. Non-reasoning models expose no options. */
export function parseOmpModelsJson(stdout: string): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeOmpModelsJson(stdout);
  if (Option.isNone(decoded)) return [];
  const seen = new Set<string>([OMP_DEFAULT_MODEL_SLUG]);
  const models: ServerProviderModel[] = [OMP_DEFAULT_MODEL];
  for (const entry of decoded.value.models) {
    const slug = entry.selector.trim();
    const provider = entry.provider.trim();
    if (!slug || !provider || seen.has(slug)) continue;
    seen.add(slug);
    const thinking = entry.thinking?.filter((level) => level.trim().length > 0) ?? [];
    models.push({
      slug,
      name: entry.name.trim() || slug,
      subProvider: provider,
      isCustom: false,
      capabilities:
        entry.reasoning && thinking.length > 0
          ? createModelCapabilities({
              optionDescriptors: [
                buildSelectOptionDescriptor({
                  id: OMP_THINKING_OPTION_ID,
                  label: "Thinking",
                  options: thinking.map((level) => ({ value: level, label: level })),
                }),
              ],
            })
          : null,
    });
  }
  return models;
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [OMP_DEFAULT_MODEL],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: ompModelsFromSettings(ompSettings.customModels),
      probe: {
        // Unknown until the probe runs; `!installed && warning` is what the
        // registry treats as a pending initial probe and keeps cached models for.
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: ompSettings.enabled
          ? "Checking Oh My Pi CLI availability..."
          : "Oh My Pi is disabled in T3 Code settings.",
      },
    }),
  );
}

const runOmpCliCommand = (
  ompSettings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  });

/**
 * Health probe. Only `omp --version` and `omp models --json` run here; `session/new`
 * would persist a session file under `~/.omp`, so the ACP surface is never touched.
 */
export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpCliCommand(ompSettings, ["--version"], environment, cwd).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Oh My Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Oh My Pi CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute Oh My Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Oh My Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but failed to run.",
      },
    });
  }

  const modelsResult = yield* runOmpCliCommand(
    ompSettings,
    ["models", "--json"],
    environment,
    cwd,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const discoveredModels = modelsOutput ? parseOmpModelsJson(modelsOutput.stdout) : [];
  if (discoveredModels.length === 0) {
    yield* Effect.logWarning("Oh My Pi CLI model listing failed, timed out, or was empty.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models:
      discoveredModels.length > 0
        ? ompModelsFromSettings(ompSettings.customModels, discoveredModels)
        : fallbackModels,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed model listing degrades the picker to the sentinel; chats still work.
      status: discoveredModels.length > 0 ? "ready" : "warning",
      // OMP owns credentials under ~/.omp; T3 never authenticates on its behalf.
      auth: { status: "authenticated", type: "agent", label: "OMP credentials" },
      ...(discoveredModels.length > 0
        ? {}
        : { message: "Oh My Pi CLI is installed but `omp models --json` returned no models." }),
    },
  });
});

import type {
  OmpSettings,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Sentinel slug for "whatever model OMP's configured default role resolves to".
 * It is never sent over the wire; selecting it leaves the session's model alone.
 */
export const OMP_DEFAULT_MODEL_SLUG = "default";
/** Per-model option descriptor id the composer round-trips as a `ProviderOptionSelection`. */
export const OMP_THINKING_OPTION_ID = "thinking";
const OMP_MODEL_CONFIG_ID = "model";
/** OMP authenticates with the provider keys already configured under `~/.omp`. */
const OMP_AUTH_METHOD_ID = "agent";

type OmpAcpRuntimeSettings = Pick<OmpSettings, "binaryPath" | "launchArgs">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings.binaryPath || "omp",
    args: ["acp", ...tokenizeCliArgs(ompSettings.launchArgs)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment),
        authMethodId: OMP_AUTH_METHOD_ID,
        resumeMethod: "resume",
        // OMP answers `session/cancel` by finishing the prompt with `cancelled`;
        // waiting for it keeps the turn's final events ordered before completion.
        cancelBehavior: "wait-for-prompt",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

function selectConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  configId: string,
) {
  const option = configOptions.find((entry) => entry.id === configId);
  return option?.type === "select" ? option : undefined;
}

function currentSelectValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  configId: string,
): string | undefined {
  return selectConfigOption(configOptions, configId)?.currentValue.trim() || undefined;
}

export function currentOmpModelIdFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  return currentSelectValue(configOptions, OMP_MODEL_CONFIG_ID);
}

function selectOptionValues(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  configId: string,
): ReadonlyArray<string> {
  const option = selectConfigOption(configOptions, configId);
  return option
    ? option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
      )
    : [];
}

/**
 * Applies a T3 model selection to a live OMP session. The sentinel keeps the
 * session's current model. A `thinking` selection is applied after the model
 * so it is validated against the option list OMP publishes for that model.
 */
export const applyOmpAcpModelSelection = Effect.fn("applyOmpAcpModelSelection")(function* <
  E,
>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | undefined, E> {
  const requested = input.model?.trim();
  const model = requested && requested !== OMP_DEFAULT_MODEL_SLUG ? requested : undefined;
  let configOptions = yield* input.runtime.getConfigOptions;
  if (model !== undefined && model !== currentOmpModelIdFromConfigOptions(configOptions)) {
    yield* input.runtime.setModel(model).pipe(Effect.mapError(input.mapError));
    configOptions = yield* input.runtime.getConfigOptions;
  }

  const thinking = getProviderOptionStringSelectionValue(input.selections, OMP_THINKING_OPTION_ID);
  if (
    thinking !== undefined &&
    thinking !== currentSelectValue(configOptions, OMP_THINKING_OPTION_ID)
  ) {
    const allowed = selectOptionValues(configOptions, OMP_THINKING_OPTION_ID);
    if (allowed.length > 0 && !allowed.includes(thinking)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Oh My Pi does not offer thinking level '${thinking}' for this model. Choose one of: ${allowed.join(", ")}.`,
          ),
        ),
      );
    }
    yield* input.runtime
      .setConfigOption(OMP_THINKING_OPTION_ID, thinking)
      .pipe(Effect.mapError(input.mapError));
  }
  return model ?? currentOmpModelIdFromConfigOptions(configOptions);
});

/** OMP ships two session modes: `default` for coding and `plan` for read-only planning. */
export function ompModeId(interactionMode: ProviderInteractionMode | undefined): string {
  return interactionMode === "plan" ? "plan" : "default";
}

export function selectOmpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKinds =
    decision === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision === "accept"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const optionId = request.options.find((entry) => entry.kind === kind)?.optionId.trim();
    if (optionId) return optionId;
  }
  return undefined;
}

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";
import { CustomModelSetting } from "./model.ts";
import { makeBinaryPathSetting, makeProviderSettingsSchema } from "./settings.ts";

/**
 * Oh My Pi (`omp`) instance config. Lives outside `ServerSettings.providers`
 * so the fork never edits upstream's closed provider struct; the registry
 * decodes it through `OmpDriver.configSchema` from a `providerInstances`
 * envelope.
 */
export const OmpSettings = makeProviderSettingsSchema(
  {
    // Off by default like the other ACP-backed drivers. Users opt in from
    // Settings once `omp` is on PATH.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("omp").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Oh My Pi binary.",
        providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to `omp acp` on session start.",
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "launchArgs"],
  },
);
export type OmpSettings = typeof OmpSettings.Type;

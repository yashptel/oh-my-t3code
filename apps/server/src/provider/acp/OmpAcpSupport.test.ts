import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyOmpAcpModelSelection,
  buildOmpAcpSpawnInput,
  currentOmpModelIdFromConfigOptions,
  ompModeId,
  selectOmpPermissionOptionId,
} from "./OmpAcpSupport.ts";

describe("buildOmpAcpSpawnInput", () => {
  it("runs `omp acp` with tokenized launch args in the workspace", () => {
    expect(
      buildOmpAcpSpawnInput(
        { binaryPath: "/opt/omp", launchArgs: '--verbose --profile "my profile"' },
        "/tmp/project",
        { HOME: "/home/x" },
      ),
    ).toEqual({
      command: "/opt/omp",
      args: ["acp", "--verbose", "--profile", "my profile"],
      cwd: "/tmp/project",
      env: { HOME: "/home/x" },
    });
  });

  it("falls back to `omp` on PATH when the binary path is empty", () => {
    expect(buildOmpAcpSpawnInput({ binaryPath: "", launchArgs: "" }, "/tmp/project")).toEqual({
      command: "omp",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("ompModeId", () => {
  it("maps the T3 interaction mode onto OMP's default and plan modes", () => {
    expect(ompModeId(undefined)).toBe("default");
    expect(ompModeId("default")).toBe("default");
    expect(ompModeId("plan")).toBe("plan");
  });
});

describe("selectOmpPermissionOptionId", () => {
  const request = {
    sessionId: "s",
    toolCall: { toolCallId: "t" },
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "never", name: "Reject", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  it("falls back to allow_once when the agent offers no allow_always", () => {
    expect(selectOmpPermissionOptionId(request, "acceptForSession")).toBe("once");
    expect(selectOmpPermissionOptionId(request, "accept")).toBe("once");
    expect(selectOmpPermissionOptionId(request, "decline")).toBe("never");
  });

  it("returns undefined when no option of the requested family exists", () => {
    expect(
      selectOmpPermissionOptionId({ ...request, options: [request.options[0]!] }, "decline"),
    ).toBeUndefined();
  });
});

describe("applyOmpAcpModelSelection", () => {
  const configOptions = (state: {
    model: string;
    thinking?: string;
    thinkingValues?: ReadonlyArray<string>;
  }): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.model,
      options: [
        { value: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
        { value: "openai-codex/gpt-5.6-sol", name: "GPT-5.6-Sol" },
      ],
    },
    ...(state.thinking === undefined
      ? []
      : [
          {
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            type: "select",
            currentValue: state.thinking,
            options: (state.thinkingValues ?? ["off", "low", "medium", "high"]).map((value) => ({
              value,
              name: value,
            })),
          } satisfies EffectAcpSchema.SessionConfigOption,
        ]),
  ];

  const makeRecordingRuntime = (
    initial: Parameters<typeof configOptions>[0],
    failure?: EffectAcpErrors.AcpError,
  ) => {
    const state = { ...initial };
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      getConfigOptions: Effect.sync(() => configOptions(state)),
      setModel: (model: string) =>
        Effect.gen(function* () {
          calls.push({ configId: "model", value: model });
          if (failure) return yield* failure;
          state.model = model;
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          calls.push({ configId, value });
          if (failure) return yield* failure;
          if (configId === "thinking" && typeof value === "string") state.thinking = value;
          return { configOptions: configOptions(state) };
        }),
    };
    return { runtime, calls };
  };

  it.effect("keeps the session model when the sentinel is selected", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime({ model: "openai-codex/gpt-5.6-sol" });
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        model: "default",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result).toBe("openai-codex/gpt-5.6-sol");
    }),
  );

  it.effect("switches the model when it differs from the current config option", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime({ model: "openai-codex/gpt-5.6-sol" });
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-haiku-4-5",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([{ configId: "model", value: "anthropic/claude-haiku-4-5" }]);
      expect(result).toBe("anthropic/claude-haiku-4-5");
    }),
  );

  it.effect("applies a changed thinking level after the model", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime({
        model: "openai-codex/gpt-5.6-sol",
        thinking: "medium",
      });
      yield* applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-haiku-4-5",
        selections: [{ id: "thinking", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([
        { configId: "model", value: "anthropic/claude-haiku-4-5" },
        { configId: "thinking", value: "high" },
      ]);
    }),
  );

  it.effect("sends nothing when model and thinking already match", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime({
        model: "anthropic/claude-haiku-4-5",
        thinking: "high",
      });
      yield* applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-haiku-4-5",
        selections: [{ id: "thinking", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("rejects a thinking level the model's option list does not offer", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime({
        model: "anthropic/claude-haiku-4-5",
        thinking: "off",
        thinkingValues: ["off"],
      });
      const failure = yield* applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-haiku-4-5",
        selections: [{ id: "thinking", value: "xhigh" }],
        mapError: (cause) => cause.message,
      }).pipe(Effect.flip);
      expect(failure).toContain("'xhigh'");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("maps ACP failures through mapError", () =>
    Effect.gen(function* () {
      const { runtime } = makeRecordingRuntime(
        { model: "openai-codex/gpt-5.6-sol" },
        EffectAcpErrors.AcpRequestError.invalidParams("nope"),
      );
      const failure = yield* applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-haiku-4-5",
        mapError: (cause) => `mapped:${cause._tag}`,
      }).pipe(Effect.flip);
      expect(failure).toBe("mapped:AcpRequestError");
    }),
  );
});

describe("currentOmpModelIdFromConfigOptions", () => {
  it("reads the model select and ignores other categories", () => {
    expect(
      currentOmpModelIdFromConfigOptions([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "plan",
          options: [{ value: "plan", name: "Plan" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: " openai-codex/gpt-5.6-sol ",
          options: [{ value: "openai-codex/gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        },
      ]),
    ).toBe("openai-codex/gpt-5.6-sol");
    expect(currentOmpModelIdFromConfigOptions([])).toBeUndefined();
  });
});

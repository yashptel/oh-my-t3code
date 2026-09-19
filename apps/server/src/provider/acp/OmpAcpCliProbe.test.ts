/**
 * Optional integration check against a real `omp acp` install.
 * Enable with: T3_OMP_ACP_PROBE=1 vp test run OmpAcpCliProbe
 *
 * `session/new` persists a session file under `~/.omp/agent/sessions/<cwd-slug>/`,
 * so this runs in a temp directory and never in the developer's checkout.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  applyOmpAcpModelSelection,
  currentOmpModelIdFromConfigOptions,
  makeOmpAcpRuntime,
} from "./OmpAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-omp-probe-" });
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeOmpAcpRuntime({
    ompSettings: { binaryPath: "omp", launchArgs: "" },
    environment: process.env,
    childProcessSpawner,
    cwd,
    clientInfo: { name: "t3-omp-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_OMP_ACP_PROBE === "1")("Oh My Pi ACP CLI probe", () => {
  it.effect("initialize advertises the agent auth method and session resume", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const initialized = yield* runtime.initialize();
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentInfo?.name).toBe("oh-my-pi");
      expect(initialized.authMethods?.map((method) => method.id)).toContain("agent");
      expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
      expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new publishes mode, model, and thinking config options", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(typeof started.sessionId).toBe("string");
      const configOptions = yield* runtime.getConfigOptions;
      expect(configOptions.map((option) => option.id)).toEqual(["mode", "model", "thinking"]);
      expect(configOptions.every((option) => option.type === "select")).toBe(true);
      expect(currentOmpModelIdFromConfigOptions(configOptions)).toBeDefined();
      const modes = yield* runtime.getModeState;
      expect(modes?.availableModes.map((mode) => mode.id)).toEqual(["default", "plan"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("switches model and thinking through session/set_config_option", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      yield* runtime.start();
      const model = yield* applyOmpAcpModelSelection({
        runtime,
        model: "anthropic/claude-haiku-4-5",
        selections: [{ id: "thinking", value: "high" }],
        mapError: (cause) => cause,
      });
      expect(model).toBe("anthropic/claude-haiku-4-5");
      const configOptions = yield* runtime.getConfigOptions;
      expect(currentOmpModelIdFromConfigOptions(configOptions)).toBe("anthropic/claude-haiku-4-5");
      const thinking = configOptions.find((option) => option.id === "thinking");
      expect(thinking?.type === "select" ? thinking.currentValue : undefined).toBe("high");
      yield* runtime.setMode("plan");
      expect((yield* runtime.getModeState)?.currentModeId).toBe("plan");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

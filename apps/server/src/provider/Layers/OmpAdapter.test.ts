// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const PROVIDER = ProviderDriverKind.make("omp");
const INSTANCE_ID = ProviderInstanceId.make("omp");

const ompAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

async function makeMockOmp(extraEnv: Record<string, string> = {}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const requestLogPath = NodePath.join(dir, "requests.ndjson");
  const binaryPath = writeFakeCli({
    directory: dir,
    name: "omp",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
  });
  return { binaryPath, requestLogPath };
}

async function readRequests(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

type EventType = ProviderRuntimeEvent["type"];

/** Subscribes once, before the session starts, so no event can slip past a late subscriber. */
const recordEvents = Effect.fn("recordEvents")(function* (
  stream: Stream.Stream<ProviderRuntimeEvent>,
) {
  const events: ProviderRuntimeEvent[] = [];
  const waiters: Array<{ type: EventType; done: Deferred.Deferred<void> }> = [];
  yield* Stream.runForEach(stream, (event) =>
    Effect.gen(function* () {
      events.push(event);
      for (const waiter of waiters.splice(0)) {
        if (waiter.type === event.type) yield* Deferred.succeed(waiter.done, undefined);
        else waiters.push(waiter);
      }
    }),
  ).pipe(Effect.forkChild);
  const waitForNext = (type: EventType) => {
    const done = Deferred.makeUnsafe<void>();
    waiters.push({ type, done });
    return Deferred.await(done);
  };
  const waitFor = (type: EventType) =>
    events.some((event) => event.type === type) ? Effect.void : waitForNext(type);
  const find = <T extends EventType>(type: T) =>
    events.find(
      (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type,
    );
  return { events, waitFor, waitForNext, find };
});

const startMockSession = (input: {
  readonly binaryPath: string;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly resumeCursor?: unknown;
}) =>
  Effect.gen(function* () {
    const adapter = yield* makeOmpAdapter(
      decodeOmpSettings({ enabled: true, binaryPath: input.binaryPath }),
      { instanceId: INSTANCE_ID },
    ).pipe(Effect.orDie);
    const recorder = yield* recordEvents(adapter.streamEvents);
    const session = yield* adapter.startSession({
      threadId: input.threadId,
      provider: PROVIDER,
      providerInstanceId: INSTANCE_ID,
      cwd: process.cwd(),
      runtimeMode: input.runtimeMode,
      ...(input.model ? { modelSelection: { instanceId: INSTANCE_ID, model: input.model } } : {}),
      ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    });
    return { adapter, session, recorder };
  });

it.layer(ompAdapterTestLayer)("OmpAdapter", (it) => {
  it.effect("starts a session, selects the model, and maps a mock turn to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-thread");
      const mock = yield* Effect.promise(() => makeMockOmp());
      const { adapter, session, recorder } = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId,
        runtimeMode: "full-access",
        model: "composer-2",
      });
      assert.equal(session.provider, "omp");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      const result = yield* adapter.sendTurn({ threadId, input: "hello omp", attachments: [] });
      yield* recorder.waitFor("turn.completed");

      assert.deepStrictEqual(result.resumeCursor, session.resumeCursor);
      assert.includeMembers(
        recorder.events.map((event) => event.type),
        [
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "item.started",
          "content.delta",
          "turn.plan.updated",
          "item.completed",
          "turn.completed",
        ],
      );
      assert.equal(recorder.find("content.delta")?.payload.delta, "hello from mock");
      assert.deepStrictEqual(recorder.find("turn.started")?.payload, { model: "composer-2" });
      assert.deepStrictEqual(recorder.find("turn.completed")?.payload, {
        state: "completed",
        stopReason: "end_turn",
      });

      yield* adapter.stopSession(threadId);
      const requests = yield* Effect.promise(() => readRequests(mock.requestLogPath));
      assert.deepStrictEqual(
        requests.find((request) => request.method === "authenticate")?.params,
        { methodId: "agent" },
      );
      const configWrites = requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => [request.params?.configId, request.params?.value]);
      assert.deepStrictEqual(configWrites, [
        ["model", "composer-2"],
        ["mode", "default"],
      ]);
      const prompt = requests.find((request) => request.method === "session/prompt")?.params
        ?.prompt as ReadonlyArray<{ type: string; text?: string }>;
      assert.deepStrictEqual(prompt[0], { type: "text", text: "hello omp" });
      assert.include(prompt[1]?.text, "Oh My Pi harness, as composer-2");
    }),
  );

  it.effect("resumes a saved session through session/resume", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-resume");
      const mock = yield* Effect.promise(() => makeMockOmp());
      const { adapter, session } = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* adapter.stopSession(threadId);
      const requests = yield* Effect.promise(() => readRequests(mock.requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.include(methods, "session/resume");
      assert.notInclude(methods, "session/new");
      assert.equal(
        requests.find((request) => request.method === "session/resume")?.params?.sessionId,
        "mock-session-1",
      );
    }),
  );

  it.effect("rejects an unreadable resume cursor before spawning", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockOmp());
      const failure = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId: ThreadId.make("omp-mock-bad-cursor"),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 2, sessionId: "x" },
      }).pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("surfaces a permission request and forwards the user's decision", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-permission");
      const mock = yield* Effect.promise(() => makeMockOmp({ T3_ACP_EMIT_TOOL_CALLS: "1" }));
      const { adapter, recorder } = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId,
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "run it", attachments: [] })
        .pipe(Effect.forkChild);
      yield* recorder.waitFor("request.opened");
      const request = recorder.find("request.opened");
      assert.isDefined(request?.requestId);
      if (!request?.requestId) return;
      assert.equal(request.payload.requestType, "exec_command_approval");
      assert.equal(request.payload.detail, "cat server/package.json");

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(request.requestId),
        "accept",
      );
      const result = yield* Fiber.join(turnFiber);
      yield* recorder.waitFor("turn.completed");
      assert.equal(result.threadId, threadId);
      assert.equal(recorder.find("request.resolved")?.payload.decision, "accept");
      assert.equal(recorder.find("turn.completed")?.payload.state, "completed");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves permission requests under full access", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-auto-approve");
      const mock = yield* Effect.promise(() => makeMockOmp({ T3_ACP_EMIT_TOOL_CALLS: "1" }));
      const { adapter, recorder } = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run it", attachments: [] });
      yield* recorder.waitFor("turn.completed");
      const types = recorder.events.map((event) => event.type);
      assert.notInclude(types, "request.opened");
      assert.include(types, "item.completed");
      assert.equal(recorder.find("turn.completed")?.payload.stopReason, "end_turn");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupting a turn cancels pending approvals and completes it as cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-interrupt");
      const mock = yield* Effect.promise(() => makeMockOmp({ T3_ACP_EMIT_TOOL_CALLS: "1" }));
      const { adapter, recorder } = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId,
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "run it", attachments: [] })
        .pipe(Effect.forkChild);
      yield* recorder.waitFor("request.opened");

      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turnFiber);
      yield* recorder.waitFor("turn.completed");

      assert.equal(recorder.find("request.resolved")?.payload.decision, "cancel");
      assert.deepStrictEqual(recorder.find("turn.completed")?.payload, {
        state: "cancelled",
        stopReason: "cancelled",
      });
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
      assert.isUndefined(sessions[0]?.activeTurnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refuses free-form questions and emits session.exited on stop", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-stop");
      const mock = yield* Effect.promise(() => makeMockOmp());
      const { adapter, recorder } = yield* startMockSession({
        binaryPath: mock.binaryPath,
        threadId,
        runtimeMode: "full-access",
      });
      const failure = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("req"), {})
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterRequestError");
      yield* adapter.stopSession(threadId);
      yield* recorder.waitFor("session.exited");
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.equal(recorder.find("session.exited")?.payload.exitKind, "graceful");
    }),
  );
});

const LIVE_MODEL = process.env.T3_OMP_LIVE_MODEL ?? "anthropic/claude-haiku-4-5";

describe.runIf(process.env.T3_OMP_LIVE_TURN === "1")("OmpAdapter live omp", () => {
  it.layer(ompAdapterTestLayer)("against the installed omp binary", (it) => {
    it.effect(
      "streams a prompt, cancels a turn, and resumes the session",
      () =>
        Effect.gen(function* () {
          const cwd = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-live-")),
          );
          const threadId = ThreadId.make("omp-live-thread");
          const adapter = yield* makeOmpAdapter(decodeOmpSettings({ enabled: true }), {
            instanceId: INSTANCE_ID,
          }).pipe(Effect.orDie);
          const recorder = yield* recordEvents(adapter.streamEvents);
          const session = yield* adapter.startSession({
            threadId,
            provider: PROVIDER,
            providerInstanceId: INSTANCE_ID,
            cwd,
            runtimeMode: "full-access",
            modelSelection: { instanceId: INSTANCE_ID, model: LIVE_MODEL },
          });
          assert.equal(session.model, LIVE_MODEL);
          assert.deepStrictEqual(session.resumeCursor, {
            schemaVersion: 1,
            sessionId: recorder.find("thread.started")?.payload.providerThreadId,
          });

          yield* adapter.sendTurn({
            threadId,
            input: "Reply with exactly the word pong and nothing else.",
            attachments: [],
          });
          yield* recorder.waitFor("turn.completed");
          const streamed = recorder.events
            .filter((event) => event.type === "content.delta")
            .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
            .join("");
          assert.include(streamed.toLowerCase(), "pong");
          assert.equal(recorder.find("turn.completed")?.payload.state, "completed");

          const nextDelta = recorder.waitForNext("content.delta");
          const longTurn = yield* adapter
            .sendTurn({
              threadId,
              input: "Count slowly from 1 to 400, one number per line, no other text.",
              attachments: [],
            })
            .pipe(Effect.forkChild);
          yield* nextDelta;
          yield* adapter.interruptTurn(threadId);
          yield* Fiber.await(longTurn);
          const completions = recorder.events.filter((event) => event.type === "turn.completed");
          assert.equal(completions.length, 2);
          assert.equal(
            completions[1]?.type === "turn.completed" && completions[1].payload.state,
            "cancelled",
          );

          yield* adapter.stopSession(threadId);
          yield* recorder.waitFor("session.exited");
          const resumed = yield* adapter.startSession({
            threadId,
            provider: PROVIDER,
            providerInstanceId: INSTANCE_ID,
            cwd,
            runtimeMode: "full-access",
            resumeCursor: session.resumeCursor,
          });
          assert.deepStrictEqual(resumed.resumeCursor, session.resumeCursor);
          assert.isTrue(yield* adapter.hasSession(threadId));
          yield* adapter.stopSession(threadId);
        }),
      { timeout: 90_000 },
    );
  });
});

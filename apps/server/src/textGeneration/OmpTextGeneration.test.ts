// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

/** A stand-in for `omp -p`: records argv and stdin, then prints the canned answer. */
function makeFakeOmp(input: { readonly output: string; readonly exitCode?: number }) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-"));
  const capturePath = NodePath.join(dir, "capture.json");
  const binaryPath = writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "omp",
    env: {
      T3_FAKE_OMP_OUTPUT: input.output,
      T3_FAKE_OMP_EXIT_CODE: String(input.exitCode ?? 0),
      T3_FAKE_OMP_CAPTURE: capturePath,
    },
    source: [
      'import { writeFileSync } from "node:fs";',
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "writeFileSync(",
      "  process.env.T3_FAKE_OMP_CAPTURE,",
      '  JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString("utf8") }),',
      ");",
      'process.stderr.write("Working...\\n");',
      "process.stdout.write(process.env.T3_FAKE_OMP_OUTPUT);",
      "process.exit(Number(process.env.T3_FAKE_OMP_EXIT_CODE));",
      "",
    ].join("\n"),
  });
  const readCapture = () =>
    JSON.parse(NodeFS.readFileSync(capturePath, "utf8")) as {
      readonly argv: ReadonlyArray<string>;
      readonly stdin: string;
    };
  return { binaryPath, readCapture };
}

const instanceId = ProviderInstanceId.make("omp");

it.layer(NodeServices.layer)("OmpTextGeneration", (it) => {
  it.effect("runs print mode without a session or tools and omits --model for the sentinel", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmp({
        output: 'Sure!\n{"subject": "Add OMP provider", "body": "Wire the ACP runtime."}\n',
      });
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({ enabled: true, binaryPath: fake.binaryPath }),
      );
      const result = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "1 file changed",
        stagedPatch: "diff --git a/x b/x",
        modelSelection: createModelSelection(instanceId, "default"),
      });
      expect(result).toEqual({ subject: "Add OMP provider", body: "Wire the ACP runtime." });
      const capture = fake.readCapture();
      expect(capture.argv).toEqual(["-p", "--no-session", "--no-tools"]);
      expect(capture.stdin).toContain("diff --git a/x b/x");
    }),
  );

  it.effect("forwards an explicit model selector with --model", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmp({
        output: '{"title": "Rename the thing", "needsRefinement": false}',
      });
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({ enabled: true, binaryPath: fake.binaryPath }),
      );
      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "rename the thing",
        modelSelection: createModelSelection(instanceId, "anthropic/claude-haiku-4-5"),
      });
      expect(result.title).toBe("Rename the thing");
      expect(fake.readCapture().argv).toEqual([
        "-p",
        "--no-session",
        "--no-tools",
        "--model",
        "anthropic/claude-haiku-4-5",
      ]);
    }),
  );

  it.effect("fails with the CLI's stderr when print mode exits non-zero", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmp({ output: "", exitCode: 3 });
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({ enabled: true, binaryPath: fake.binaryPath }),
      );
      const failure = yield* textGeneration
        .generateBranchName({
          cwd: process.cwd(),
          message: "fix it",
          modelSelection: createModelSelection(instanceId, "default"),
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("TextGenerationError");
      expect(failure.detail).toContain("Working...");
    }),
  );
});

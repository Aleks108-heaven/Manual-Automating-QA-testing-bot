// The command line with a live provider: choosing the model from the server's list, checking the provider, and running a case.
// The server is a fake on a loopback port (see helpers/fake-llm.ts), so no real model is involved.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptSchema } from "../../src/model/scripted.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/cli.ts", ...args], {
      env: { ...process.env, QA_RUNS_DIR: mkdtempSync(join(tmpdir(), "qa-bot-live-cli-")), QA_ASSERTION_TIMEOUT_MS: "1000", QA_CANARY_CASES: "", QA_REQUIRE_CANARIES: "0", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

let fake: FakeLlm | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

const formScript = ScriptSchema.parse(JSON.parse(readFileSync("tests/ci/scripts/TC-FORM-001.json", "utf8")));

describe("provider models and provider check", () => {
  it("lists the server's models before any is chosen, and marks the chosen one", async () => {
    fake = await FakeLlm.start({ models: ["codestral-22b-v0.1", "qwen2.5-coder-14b", "glm-5.2:cloud"] });
    const none = await cli(["provider", "models"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(none.code).toBe(0);
    expect(none.out).toContain("codestral-22b-v0.1");
    expect(none.out).toContain("glm-5.2:cloud   (runs off this machine)");
    expect(none.out).toContain("None is chosen");
    const chosen = await cli(["provider", "models", "--model", "qwen2.5-coder-14b"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(chosen.out).toMatch(/\* qwen2\.5-coder-14b/);
  });

  it("says when the server is not running", async () => {
    fake = await FakeLlm.start();
    const url = fake.baseUrl;
    await fake.close();
    fake = null;
    const r = await cli(["provider", "models"], { QA_PROVIDER_URL: url });
    expect(r.code).toBe(3);
    expect(r.err).toContain("could not be reached");
    expect(r.err).toContain("Is the server running?");
  });

  it("check passes for a listed model and fails for one that is not listed", async () => {
    fake = await FakeLlm.start({ models: ["qwen2.5-coder-14b"] });
    const ok = await cli(["provider", "check", "--model", "qwen2.5-coder-14b"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("on this machine");
    expect(ok.out).toContain("OK");
    const missing = await cli(["provider", "check", "--model", "mistral-nemo"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("mistral-nemo is not in the provider's model list");
  });

  it("check --probe-context passes for a server that takes in the declared context, and fails, with the cause, for one that cuts it", async () => {
    const windowed = (window: number) =>
      FakeLlm.start({
        models: ["m"],
        respond: (body) => ({ content: "OK", usage: { prompt_tokens: Math.min(String(body.messages[0]!.content).split(/\s+/).length, window), completion_tokens: 1 } }),
      });
    fake = await windowed(8192);
    const ok = await cli(["provider", "check", "--model", "m", "--probe-context"], { QA_PROVIDER_URL: fake.baseUrl, QA_PROVIDER_CONTEXT: "2000" });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("so its context holds at least the 2000 declared");
    await fake.close();
    fake = await windowed(1024);
    const cut = await cli(["provider", "check", "--model", "m", "--probe-context"], { QA_PROVIDER_URL: fake.baseUrl, QA_PROVIDER_CONTEXT: "2000" });
    expect(cut.code).toBe(2);
    expect(cut.err).toContain("CONTEXT TOO SMALL: the server took in 1024 of about 1900 prompt tokens");
    expect(cut.err).toContain("OLLAMA_CONTEXT_LENGTH");
  });

  it("check needs a model to be chosen", async () => {
    fake = await FakeLlm.start();
    const r = await cli(["provider", "check"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(r.code).toBe(64);
    expect(r.err).toContain("modelId");
  });
});

describe("commands that must keep working when the provider settings are wrong", () => {
  // QA_PROVIDER=openai-compatible with no model is a configuration that does not load.
  const broken = { QA_PROVIDER: "openai-compatible", QA_PROVIDER_URL: "http://127.0.0.1:9/v1" };

  it("the kill switch status and engage work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bot-live-ks-"));
    const status = await cli(["kill-switch", "status"], { ...broken, QA_RUNS_DIR: dir });
    expect(status.code).toBe(0);
    expect(status.out).toContain("Not engaged");
    const engaged = await cli(["kill-switch", "engage", "--by", "tester", "--reason", "provider env test", "--target", "http://127.0.0.1:9"], { ...broken, QA_RUNS_DIR: dir });
    expect(engaged.code).toBe(0);
    expect(engaged.out).toContain("PAUSED");
  });

  it("a run with those settings is a usage error that names the provider, not a crash", async () => {
    const r = await cli(["run", "cases/TC-FORM-001.yaml"], broken);
    expect(r.code).toBe(64);
    expect(r.err).toContain("The provider settings are not allowed");
  });

  it("listing the models works, to choose the model that is missing", async () => {
    fake = await FakeLlm.start({ models: ["codestral-22b-v0.1"] });
    const r = await cli(["provider", "models"], { QA_PROVIDER: "openai-compatible", QA_PROVIDER_URL: fake.baseUrl });
    expect(r.code).toBe(0);
    expect(r.out).toContain("codestral-22b-v0.1");
  });

  it("listing the models refuses a server off this machine before sending anything (it would send the API key)", async () => {
    const r = await cli(["provider", "models"], { QA_PROVIDER_URL: "http://192.0.2.7:1234/v1" });
    expect(r.code).toBe(64);
    expect(r.err).toContain("nothing was sent");
  });
});

describe("run --live", () => {
  it("runs a case with the model from the server, and the report says it was a language model", async () => {
    fake = await FakeLlm.start({ models: ["qwen2.5-coder-14b"], script: formScript });
    const r = await cli(["run", "cases/TC-FORM-001.yaml", "--live", "--model", "qwen2.5-coder-14b"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Provider: qwen2.5-coder-14b at");
    expect(r.out).toContain("Verdict: PASS");
    expect(r.out).toContain("qwen2.5-coder-14b (live)");
    expect(r.out).not.toContain("a scripted fake, not a language model");
    expect(fake.chatBodies.length).toBeGreaterThan(3);
  });

  it("takes the whole provider from the environment too", async () => {
    fake = await FakeLlm.start({ models: ["codestral-22b-v0.1"], script: formScript });
    const r = await cli(["run", "cases/TC-FORM-001.yaml"], { QA_PROVIDER: "openai-compatible", QA_PROVIDER_URL: fake.baseUrl, QA_PROVIDER_MODEL: "codestral-22b-v0.1", QA_PROVIDER_MODE: "tools" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("mode tools");
  });

  it("the pre-flight check refuses a run when the chosen model is not on the server", async () => {
    fake = await FakeLlm.start({ models: ["something-else"], script: formScript });
    const r = await cli(["run", "cases/TC-FORM-001.yaml", "--live", "--model", "qwen2.5-coder-14b"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/provider reachable\s+.*not in the provider's model list/);
    expect(fake.chatBodies).toHaveLength(0);
  });

  it("refuses a server off this machine without a provider register entry, before anything is sent", async () => {
    const r = await cli(["run", "cases/TC-FORM-001.yaml", "--live", "--model", "m"], { QA_PROVIDER_URL: "http://192.0.2.7:1234/v1" });
    expect(r.code).toBe(64);
    expect(r.err).toContain("registerEntry");
  });

  it("does not mix a live provider with script files", async () => {
    fake = await FakeLlm.start();
    const r = await cli(["run", "cases/TC-FORM-001.yaml", "--live", "--model", "m", "--script", "tests/ci/scripts/TC-FORM-001.json"], { QA_PROVIDER_URL: fake.baseUrl });
    expect(r.code).toBe(64);
    expect(r.err).toContain("A live provider has no script");
  });

  it("refuses --model without --live instead of running the scripted fake as if that model had done it", async () => {
    const r = await cli(["run", "cases/TC-FORM-001.yaml", "--model", "qwen2.5-coder-14b"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("--model and --judge-model need a live provider");
  });

  it("without --live the scripted fake is still the default", async () => {
    const r = await cli(["run", "cases/TC-FORM-001.yaml"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("a scripted fake, not a language model");
  });
});

import { describe, expect, it } from "vitest";
import { restartGateway } from "../../src/core/gateway-process.js";

const NOW = () => "2026-10-14T12:00:00.000Z";
function fakes(status: string) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      status: async () => ({ status }),
      stop: async () => (calls.push("stop"), { status: "stopped" }),
      start: async () => (calls.push("start"), { status: "started" }),
    },
  };
}

describe("restarting the gateway so it reads a newly added channel (D134)", () => {
  it("stops a running gateway and starts it again", async () => {
    const { calls, deps } = fakes("running");
    await restartGateway("/h", NOW, deps);
    expect(calls).toEqual(["stop", "start"]);
  });

  it.each(["stopped", "stale"])("just starts one that is %s", async (status) => {
    const { calls, deps } = fakes(status);
    await restartGateway("/h", NOW, deps);
    expect(calls).toEqual(["start"]);
  });
});

import { describe, expect, it } from "vitest";
import { reviewProcessEnvironment } from "./runner.js";

describe("review actor environment", () => {
  it("keeps runtime and isolated Pi variables without inheriting host secrets or outer-agent state", () => {
    const environment = reviewProcessEnvironment(
      {},
      { PI_CODING_AGENT_DIR: "/isolated/pi-home", PI_OFFLINE: "1" },
      {
        PATH: "/runtime/bin",
        PATHEXT: ".COM;.EXE;.CMD",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        LANG: "en_US.UTF-8",
        PIONEER_HOST_SECRET: "must-not-leak",
        OUTER_AGENT_PROJECT_ROOT: "/outer/project",
        OPENROUTER_API_KEY: "must-not-leak",
      },
    );

    expect(environment.PATH).toBe("/runtime/bin");
    expect(environment.PATHEXT).toBe(".COM;.EXE;.CMD");
    expect(environment.SystemRoot).toBe("C:\\Windows");
    expect(environment.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(environment.LANG).toBe("en_US.UTF-8");
    expect(environment.PI_CODING_AGENT_DIR).toBe("/isolated/pi-home");
    expect(environment.PIONEER_HOST_SECRET).toBeUndefined();
    expect(environment.OUTER_AGENT_PROJECT_ROOT).toBeUndefined();
    expect(environment.OPENROUTER_API_KEY).toBeUndefined();
  });
});

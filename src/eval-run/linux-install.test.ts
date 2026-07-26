import { describe, expect, it } from "vitest";
import {
  LINUX_APPARMOR_PROFILE,
  LINUX_APPARMOR_PROFILE_PATH,
  LINUX_BWRAP_INSTALL_PATH,
} from "./linux-install.js";

describe("Linux sandbox installation", () => {
  it("grants user namespaces only to fixed root-owned sandbox executables", () => {
    expect(LINUX_APPARMOR_PROFILE).toContain(`profile pioneer-bwrap ${LINUX_BWRAP_INSTALL_PATH}`);
    expect(LINUX_APPARMOR_PROFILE.match(/userns,/g)).toHaveLength(1);
    expect(LINUX_APPARMOR_PROFILE).not.toContain("/usr/bin/bwrap");
    expect(LINUX_APPARMOR_PROFILE).not.toContain("/**");
    expect(LINUX_APPARMOR_PROFILE).not.toContain("unpriv_bwrap");
    expect(LINUX_APPARMOR_PROFILE_PATH).toBe("/etc/apparmor.d/pioneer-eval");
  });
});

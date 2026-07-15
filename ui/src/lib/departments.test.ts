import { describe, it, expect } from "vitest";
import { UI_DEPARTMENT_IDS, departmentsForRole } from "./departments";
// The server registry is the canonical source; importing only its id list keeps
// this console mirror from silently drifting out of sync.
import { DEPARTMENT_IDS } from "../../../src/departments/registry";

describe("department mirror parity", () => {
  it("lists the same departments, in the same order, as the server registry", () => {
    expect(UI_DEPARTMENT_IDS).toEqual(DEPARTMENT_IDS);
  });
});

describe("departmentsForRole (console)", () => {
  it("shows nothing to an unauthenticated shell", () => {
    expect(departmentsForRole(undefined)).toHaveLength(0);
  });

  it("scopes the finance role to Finance + Management", () => {
    expect(departmentsForRole("finance").map((d) => d.id).sort()).toEqual(["finance", "management"]);
  });

  it("shows every department to an admin", () => {
    expect(departmentsForRole("admin")).toHaveLength(UI_DEPARTMENT_IDS.length);
  });
});

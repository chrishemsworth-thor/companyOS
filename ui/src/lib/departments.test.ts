import { describe, it, expect } from "vitest";
import { DEPARTMENTS, UI_DEPARTMENT_IDS, departmentsForRole } from "./departments";
// The server registry is the canonical source; importing its id list and module
// map keeps this console mirror from silently drifting out of sync.
import {
  DEPARTMENT_IDS,
  DEPARTMENTS as SERVER_DEPARTMENTS,
} from "../../../src/departments/registry";

describe("department mirror parity", () => {
  it("lists the same departments, in the same order, as the server registry", () => {
    expect(UI_DEPARTMENT_IDS).toEqual(DEPARTMENT_IDS);
  });

  // Visibility is computed from these module lists on both sides (PRD-008), so a
  // drifted module list would mean the sidebar and the API disagree about who
  // may see a department.
  it("surfaces the same modules per department as the server registry", () => {
    const server = new Map(SERVER_DEPARTMENTS.map((d) => [d.id, d.modules]));
    for (const dept of DEPARTMENTS) {
      expect(dept.modules).toEqual(server.get(dept.id));
    }
  });
});

describe("departmentsForRole (console)", () => {
  it("shows nothing to an unauthenticated shell", () => {
    expect(departmentsForRole(undefined)).toHaveLength(0);
  });

  // Finance reads customers because you cannot invoice one you cannot see, so
  // Sales is visible — read-only, with its write actions hidden by capability.
  it("scopes the finance role to Finance + Sales + Management", () => {
    expect(departmentsForRole("finance").map((d) => d.id).sort()).toEqual([
      "finance",
      "management",
      "sales",
    ]);
  });

  it("shows the self-service tier no business departments", () => {
    expect(departmentsForRole("employee")).toHaveLength(0);
  });

  it("shows every department to an admin", () => {
    expect(departmentsForRole("admin")).toHaveLength(UI_DEPARTMENT_IDS.length);
  });
});

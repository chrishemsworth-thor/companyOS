import { describe, it, expect } from "vitest";
import { adfToPlainText, normalizeJira } from "../src/webhooks/normalize/jira";
import { normalizeGithub } from "../src/webhooks/normalize/github";
import { normalizeBitbucket } from "../src/webhooks/normalize/bitbucket";

/** Pure mapping-table tests — no HTTP, no DB. */

function jiraPayload(opts: {
  event?: string;
  statusCategory?: string;
  resolution?: string;
  priority?: string;
  description?: unknown;
}) {
  return {
    webhookEvent: opts.event ?? "jira:issue_updated",
    issue: {
      key: "PROJ-7",
      self: "https://acme.atlassian.net/rest/api/2/issue/10002",
      fields: {
        summary: "Fix the flux capacitor",
        description: opts.description ?? null,
        status: { statusCategory: { key: opts.statusCategory ?? "new" } },
        resolution: opts.resolution ? { name: opts.resolution } : null,
        priority: opts.priority ? { name: opts.priority } : null,
        assignee: { displayName: "Aisha" },
        project: { key: "PROJ" },
      },
    },
  };
}

describe("normalizeJira", () => {
  it.each([
    ["new", undefined, "todo"],
    ["indeterminate", undefined, "in_progress"],
    ["done", undefined, "done"],
    ["done", "Done", "done"],
    ["done", "Won't Do", "cancelled"],
    ["done", "Cancelled", "cancelled"],
    ["done", "Declined", "cancelled"],
  ])("statusCategory %s + resolution %s → %s", (cat, res, expected) => {
    const n = normalizeJira(jiraPayload({ statusCategory: cat, resolution: res }));
    expect(n).toMatchObject({ kind: "issue_upsert", status: expected });
  });

  it.each([
    ["Highest", "urgent"],
    ["High", "high"],
    ["Medium", "medium"],
    ["Low", "low"],
    ["Lowest", "low"],
    [undefined, "medium"],
  ])("priority %s → %s", (name, expected) => {
    const n = normalizeJira(jiraPayload({ priority: name }));
    expect(n).toMatchObject({ priority: expected });
  });

  it("maps identity, project key, and browse URL", () => {
    const n = normalizeJira(jiraPayload({}));
    expect(n).toMatchObject({
      external_id: "PROJ-7",
      external_project: "PROJ",
      external_url: "https://acme.atlassian.net/browse/PROJ-7",
      assignee: "Aisha",
    });
  });

  it("mirrors a deleted issue as cancelled", () => {
    const n = normalizeJira(jiraPayload({ event: "jira:issue_deleted", statusCategory: "new" }));
    expect(n).toMatchObject({ kind: "issue_upsert", status: "cancelled" });
  });

  it("ignores non-issue events", () => {
    expect(normalizeJira({ webhookEvent: "comment_created" }).kind).toBe("ignored");
    expect(normalizeJira({}).kind).toBe("ignored");
  });
});

describe("adfToPlainText", () => {
  it("flattens an ADF document to plain text", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First " }, { type: "text", text: "line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    };
    expect(adfToPlainText(adf)).toBe("First line\nSecond line");
  });

  it("passes plain strings through and drops empties", () => {
    expect(adfToPlainText("already text")).toBe("already text");
    expect(adfToPlainText(null)).toBeUndefined();
    expect(adfToPlainText({ type: "doc", content: [] })).toBeUndefined();
  });
});

function githubIssue(opts: { action?: string; state?: string; state_reason?: string | null }) {
  return {
    action: opts.action ?? "opened",
    repository: { full_name: "acme/api" },
    sender: { login: "octocat" },
    issue: {
      number: 42,
      title: "Login broken",
      body: "Steps to reproduce…",
      state: opts.state ?? "open",
      state_reason: opts.state_reason ?? null,
      html_url: "https://github.com/acme/api/issues/42",
      assignee: { login: "hubber" },
    },
  };
}

describe("normalizeGithub", () => {
  it.each([
    ["opened", "open", null, "todo"],
    ["reopened", "open", null, "todo"],
    ["closed", "closed", "completed", "done"],
    ["closed", "closed", null, "done"],
    ["closed", "closed", "not_planned", "cancelled"],
    ["deleted", "open", null, "cancelled"],
  ])("issues %s (state %s, reason %s) → %s", (action, state, reason, expected) => {
    const n = normalizeGithub("issues", githubIssue({ action, state, state_reason: reason }));
    expect(n).toMatchObject({ kind: "issue_upsert", status: expected, priority: "medium" });
  });

  it("maps identity fields", () => {
    const n = normalizeGithub("issues", githubIssue({}));
    expect(n).toMatchObject({
      external_id: "acme/api#42",
      external_project: "acme/api",
      external_url: "https://github.com/acme/api/issues/42",
      assignee: "hubber",
    });
  });

  it("maps ping, push, and pull_request events", () => {
    expect(normalizeGithub("ping", { zen: "Design for failure." }).kind).toBe("ping");

    const push = normalizeGithub("push", {
      repository: { full_name: "acme/api" },
      sender: { login: "octocat" },
      ref: "refs/heads/main",
      commits: [{}, {}],
      compare: "https://github.com/acme/api/compare/a...b",
    });
    expect(push).toMatchObject({
      kind: "code_event",
      event_type: "code.push",
      payload: { provider: "github", repo: "acme/api", ref: "refs/heads/main", commit_count: 2 },
    });

    const pr = (action: string, merged: boolean) =>
      normalizeGithub("pull_request", {
        action,
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 7,
          title: "Add webhooks",
          merged,
          head: { ref: "feat/webhooks" },
          base: { ref: "main" },
          html_url: "https://github.com/acme/api/pull/7",
        },
      });
    expect(pr("opened", false)).toMatchObject({ event_type: "code.pr_opened" });
    expect(pr("closed", true)).toMatchObject({ event_type: "code.pr_merged" });
    expect(pr("closed", false).kind).toBe("ignored");
    expect(pr("synchronize", false).kind).toBe("ignored");
  });

  it("ignores unknown events and missing header", () => {
    expect(normalizeGithub("watch", {}).kind).toBe("ignored");
    expect(normalizeGithub(undefined, {}).kind).toBe("ignored");
  });
});

function bitbucketIssue(opts: { state?: string; priority?: string }) {
  return {
    repository: { full_name: "acme/legacy" },
    actor: { display_name: "Sam" },
    issue: {
      id: 3,
      title: "Old bug",
      content: { raw: "It broke." },
      state: opts.state ?? "new",
      priority: opts.priority ?? "major",
      assignee: { display_name: "Sam" },
      links: { html: { href: "https://bitbucket.org/acme/legacy/issues/3" } },
    },
  };
}

describe("normalizeBitbucket", () => {
  it.each([
    ["new", "todo"],
    ["open", "in_progress"],
    ["on hold", "in_progress"],
    ["resolved", "done"],
    ["closed", "done"],
    ["invalid", "cancelled"],
    ["duplicate", "cancelled"],
    ["wontfix", "cancelled"],
  ])("issue state %s → %s", (state, expected) => {
    const n = normalizeBitbucket("issue:updated", bitbucketIssue({ state }));
    expect(n).toMatchObject({ kind: "issue_upsert", status: expected });
  });

  it.each([
    ["trivial", "low"],
    ["minor", "low"],
    ["major", "medium"],
    ["critical", "high"],
    ["blocker", "urgent"],
  ])("priority %s → %s", (priority, expected) => {
    const n = normalizeBitbucket("issue:created", bitbucketIssue({ priority }));
    expect(n).toMatchObject({ priority: expected, external_id: "acme/legacy#3" });
  });

  it("maps push and pull request events", () => {
    const push = normalizeBitbucket("repo:push", {
      repository: {
        full_name: "acme/legacy",
        links: { html: { href: "https://bitbucket.org/acme/legacy" } },
      },
      actor: { display_name: "Sam" },
      push: { changes: [{}] },
    });
    expect(push).toMatchObject({
      kind: "code_event",
      event_type: "code.push",
      payload: { provider: "bitbucket", repo: "acme/legacy", commit_count: 1 },
    });

    const pr = (eventKey: string) =>
      normalizeBitbucket(eventKey, {
        repository: { full_name: "acme/legacy" },
        actor: { display_name: "Sam" },
        pullrequest: {
          id: 9,
          title: "Port to Workers",
          source: { branch: { name: "feature" } },
          destination: { branch: { name: "main" } },
          links: { html: { href: "https://bitbucket.org/acme/legacy/pull-requests/9" } },
        },
      });
    expect(pr("pullrequest:created")).toMatchObject({ event_type: "code.pr_opened" });
    expect(pr("pullrequest:fulfilled")).toMatchObject({ event_type: "code.pr_merged" });
  });

  it("ignores unknown events", () => {
    expect(normalizeBitbucket("issue:comment_created", {}).kind).toBe("ignored");
    expect(normalizeBitbucket(undefined, {}).kind).toBe("ignored");
  });
});

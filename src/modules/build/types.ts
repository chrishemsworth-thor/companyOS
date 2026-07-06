/** Build module domain types. */

export interface Project {
  project_id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
}

export type IssueStatus = "todo" | "in_progress" | "done" | "cancelled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

export interface Issue {
  issue_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

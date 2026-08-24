import { useEffect, useState } from "react";
import { pickFiles } from "../bridge";
import { useStore } from "../store";

type IssueStatus = "inbox" | "triaged" | "fixed" | "dismissed";
type Issue = { id: string; description: string; severity: string; source: string; status: IssueStatus; timestamp: number };
type Envelope<T> = { ok: boolean; data?: T; error?: string };

export function IssueInbox({ onClose }: { onClose: () => void }) {
  const exec = useStore((s) => s.exec);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [filter, setFilter] = useState<IssueStatus | "all">("inbox");
  const [message, setMessage] = useState("");
  const reload = async () => {
    const result = await exec("list_issues", filter === "all" ? {} : { status: filter }) as Envelope<{ issues: Issue[] }>;
    if (result.ok) setIssues(result.data?.issues ?? []); else setMessage(result.error ?? "Could not load issues");
  };
  useEffect(() => { void reload(); }, [filter]);
  const update = async (issueId: string, status: IssueStatus) => {
    const result = await exec("update_issue", { issueId, status }) as Envelope<unknown>;
    setMessage(result.ok ? `Moved to ${status}` : result.error ?? "Update failed"); await reload();
  };
  const exportMarkdown = async (issueId: string) => {
    const result = await exec("export_issue", { issueId }) as Envelope<{ file: string }>;
    setMessage(result.ok ? `Exported ${result.data?.file ?? "Markdown"}` : result.error ?? "Export failed");
  };
  const attach = async (issueId: string) => {
    const picked = await pickFiles({ title: "Attach a screenshot", filters: "*.png;*.jpg;*.jpeg" });
    const file = picked.files?.[0]; if (!file) return;
    const result = await exec("attach_issue_file", { issueId, file }) as Envelope<unknown>;
    setMessage(result.ok ? "Screenshot attached locally" : result.error ?? "Attachment failed");
  };
  return <div className="issue-inbox" role="dialog" aria-label="Issue Inbox">
    <div className="issue-inbox-head"><strong>Issue Inbox</strong><button onClick={onClose}>Close</button></div>
    <div className="issue-tabs">{(["inbox", "triaged", "fixed", "dismissed", "all"] as const).map((s) =>
      <button key={s} className={filter === s ? "active" : ""} onClick={() => setFilter(s)}>{s}</button>)}</div>
    {message && <div className="issue-message" role="status">{message}</div>}
    <div className="issue-list">{issues.length === 0 ? <p>No reports here.</p> : issues.map((issue) =>
      <article key={issue.id} className="issue-card">
        <div><b>{issue.severity}</b> · {issue.source}</div><p>{issue.description}</p>
        <small>{new Date(issue.timestamp).toLocaleString()} · {issue.id}</small>
        <div className="issue-actions">
          {issue.status === "inbox" && <button onClick={() => void update(issue.id, "triaged")}>Triaged</button>}
          {issue.status !== "fixed" && <button onClick={() => void update(issue.id, "fixed")}>Fixed</button>}
          {issue.status !== "dismissed" && <button onClick={() => void update(issue.id, "dismissed")}>Dismiss</button>}
          <button onClick={() => void exportMarkdown(issue.id)}>Export Markdown</button>
          <button onClick={() => void attach(issue.id)}>Attach screenshot</button>
        </div>
      </article>)}</div>
  </div>;
}

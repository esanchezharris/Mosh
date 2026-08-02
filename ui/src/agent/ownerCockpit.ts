export type ReportKind = "blocker" | "bug" | "note";

export type DraftReportInput = {
  readonly kind: ReportKind;
  readonly title: string;
  readonly body: string;
};

export type DraftReport = DraftReportInput & {
  readonly id: string;
  readonly status: "draft" | "approved" | "approved_pending_sync";
};

export type ReportHost = {
  createReport(input: DraftReportInput): Promise<DraftReport>;
  approveReport(id: string): Promise<unknown>;
};

const REPORT_TRIGGER = /(?:^|[^\p{L}\p{N}_])(log\s+this|blocker|bug|note)(?=$|[^\p{L}\p{N}_])/iu;

export function classifyReportTrigger(text: string): ReportKind | null {
  const trigger = text.match(REPORT_TRIGGER)?.[1]?.toLocaleLowerCase();
  if (trigger === "blocker") return "blocker";
  if (trigger === "bug") return "bug";
  if (trigger === "log this" || trigger === "note") return "note";
  return null;
}

export class ReportApprovalInbox {
  private reports: DraftReport[] = [];

  constructor(
    private readonly host: ReportHost,
    private readonly onChange?: (reports: readonly DraftReport[]) => void,
  ) {}

  get items(): readonly DraftReport[] {
    return this.reports;
  }

  async create(input: DraftReportInput): Promise<DraftReport> {
    const durable = await this.host.createReport(input);
    this.reports = [...this.reports, durable];
    this.onChange?.(this.reports);
    return durable;
  }

  async approve(id: string): Promise<void> {
    await this.host.approveReport(id);
    this.reports = this.reports.filter((report) => report.id !== id);
    this.onChange?.(this.reports);
  }
}

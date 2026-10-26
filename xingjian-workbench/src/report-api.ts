import type { PdfJob, ReportPreview, ReportRequest } from "../shared/contracts";
import { ApiError } from "./api";

async function reportRequest(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`/api/reports/${path}`, {
    method: "POST",
    headers: {
      "X-Xingjian-Client": "workspace-v1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(
      data?.error?.message ?? "暂时无法准备报告，请稍后重试。",
      response.status,
      data?.error?.code ?? "REPORT_REQUEST_FAILED",
    );
  }
  return response;
}

async function reportJson<T>(path: string, body: unknown): Promise<T> {
  const response = await reportRequest(path, body);
  const data = await response.json().catch(() => null);
  if (!data)
    throw new ApiError("无法读取报告状态，请重试。", 502, "INVALID_RESPONSE");
  return data as T;
}

export const previewReport = (projectId: string, request: ReportRequest) =>
  reportJson<ReportPreview>("preview", { projectId, request });
export const startReportPdf = (projectId: string, reportId: string) =>
  reportJson<PdfJob>("pdf", { projectId, reportId });
export const getReportPdfStatus = (projectId: string, reportId: string) =>
  reportJson<PdfJob>("pdf-status", { projectId, reportId });

export type ReportFormat = "html" | "jats" | "json" | "pdf";
export async function downloadReport(
  projectId: string,
  reportId: string,
  format: ReportFormat,
) {
  const response = await reportRequest("download", {
    projectId,
    reportId,
    format,
  });
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  let filename = `xingjian-report.${format === "jats" ? "xml" : format}`;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="([^"]+)"/i)?.[1];
  try {
    filename = encoded ? decodeURIComponent(encoded) : (plain ?? filename);
  } catch {
    // A malformed filename must not prevent a valid saved report download.
  }
  filename = filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

import type { Project } from "./contracts";
import type { EvidenceTarget, EvidenceLocation } from "../src/evidence-types";
export function resolveEvidenceLocation(
  project: Project,
  target: EvidenceTarget,
): EvidenceLocation;

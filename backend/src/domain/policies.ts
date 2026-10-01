import type { DocumentKind, DocumentSide, OnboardingSession, Policy } from "./types.js";

export const policies: Record<string, Policy> = {
  "id-only": {
    id: "id-only",
    version: 1,
    label: "National identity card",
    selection: "all",
    allowedDocuments: ["dz-id"],
    minimumDocuments: 1,
  },
  "passport-only": {
    id: "passport-only",
    version: 1,
    label: "Passport",
    selection: "all",
    allowedDocuments: ["dz-passport"],
    minimumDocuments: 1,
  },
  "licence-only": {
    id: "licence-only",
    version: 1,
    label: "Driving licence",
    selection: "all",
    allowedDocuments: ["dz-driving-licence"],
    minimumDocuments: 1,
  },
  "id-and-passport": {
    id: "id-and-passport",
    version: 1,
    label: "Identity card and passport",
    selection: "all",
    allowedDocuments: ["dz-id", "dz-passport"],
    minimumDocuments: 2,
  },
  "id-and-licence": {
    id: "id-and-licence",
    version: 1,
    label: "Identity card and driving licence",
    selection: "all",
    allowedDocuments: ["dz-driving-licence", "dz-id"],
    minimumDocuments: 2,
  },
  "licence-and-passport": {
    id: "licence-and-passport",
    version: 1,
    label: "Driving licence and passport",
    selection: "all",
    allowedDocuments: ["dz-driving-licence", "dz-passport"],
    minimumDocuments: 2,
  },
  "two-of-three": {
    id: "two-of-three",
    version: 1,
    label: "Two identity documents",
    selection: "minimum",
    allowedDocuments: ["dz-id", "dz-driving-licence", "dz-passport"],
    minimumDocuments: 2,
  },
  "all-three": {
    id: "all-three",
    version: 1,
    label: "All identity documents",
    selection: "all",
    allowedDocuments: ["dz-id", "dz-driving-licence", "dz-passport"],
    minimumDocuments: 3,
  },
};

export function requiredSides(kind: DocumentKind): DocumentSide[] {
  return kind === "dz-passport" ? ["single"] : ["front", "back"];
}

export function sessionPolicy(session: OnboardingSession): Policy | undefined {
  return session.policy ?? policies[session.policyId];
}

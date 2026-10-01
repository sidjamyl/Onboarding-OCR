import type { DocumentKind, DocumentSide, PublicSession } from "./types";

export const canonicalDocumentOrder: DocumentKind[] = ["dz-id", "dz-driving-licence", "dz-passport"];

type SessionDocument = NonNullable<PublicSession["documents"][DocumentKind]>;

export type ProjectedDocument = {
  document: SessionDocument;
  state: "completed" | "current" | "upcoming";
};

export type FlowProjection = {
  documents: ProjectedDocument[];
  current?: SessionDocument;
  nextSide?: DocumentSide;
  phase: "capture" | "processing" | "review" | "incomplete" | "consistency" | "complete";
  completedCount: number;
};

export function projectOnboarding(session: PublicSession): FlowProjection {
  const order =
    session.documentSelection.mode === "all" ? session.documentSelection.allowedDocuments : canonicalDocumentOrder;
  const ordered = order.flatMap((kind) => {
    const document = session.documents[kind];
    return document ? [document] : [];
  });
  const current = ordered.find((document) => !document.confirmed);
  const nextSide = current?.requiredSides.find((side) => !current.captures[side]);
  const phase = !current
    ? session.consistency?.blocking
      ? "consistency"
      : "complete"
    : nextSide
      ? "capture"
      : current.status === "processing"
        ? "processing"
        : current.consistency?.blocking
          ? "consistency"
          : current.status === "incomplete"
            ? "incomplete"
            : current.status === "ready"
              ? "review"
              : "processing";
  return {
    documents: ordered.map((document) => ({
      document,
      state: document.confirmed ? "completed" : document.kind === current?.kind ? "current" : "upcoming",
    })),
    current,
    nextSide,
    phase,
    completedCount: ordered.filter((document) => document.confirmed).length,
  };
}

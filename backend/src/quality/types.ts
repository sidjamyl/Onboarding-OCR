export type NormalizedRegion = { x: number; y: number; width: number; height: number };

export type OrbTemplate = {
  id: string;
  name: string;
  documentKind: string;
  version: number;
  width: number;
  height: number;
  image: {
    fileName: string;
    mimeType: "image/jpeg" | "image/png";
  };
  zones: Array<
    NormalizedRegion & {
      id: string;
      label: string;
      role: "required" | "optional";
      content: "arabic" | "latin" | "numeric" | "date" | "mixed";
    }
  >;
  ignoredRegions: NormalizedRegion[];
  orb: {
    keypoints: Array<{ x: number; y: number }>;
    descriptors: number[];
    rows: number;
    cols: number;
  };
  parameters: {
    ratioThreshold: number;
    minimumGoodMatches: number;
    minimumInlierRatio: number;
    ransacThreshold: number;
  };
  useWolfBinarization: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrbTemplateSummary = Pick<
  OrbTemplate,
  "id" | "name" | "documentKind" | "version" | "width" | "height" | "createdAt" | "updatedAt"
> & {
  zoneCount: number;
  ignoredRegionCount: number;
  keypointCount: number;
};

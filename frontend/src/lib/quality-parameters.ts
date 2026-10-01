import type { CheckKey, QualityProfile } from "./quality-core";

type Section = "capture" | "document" | "image" | "preprocess" | "orb";

export type NumericParameter = {
  section: Section;
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Whether the measured value must stay above (`min`) or below (`max`) this threshold. */
  bound?: "min" | "max";
};

export type ToggleParameter = { section: Section; key: string; label: string; hint: string; toggle: true };
export type Parameter = NumericParameter | ToggleParameter;

export type CheckDescriptor = {
  key: CheckKey;
  label: string;
  description: string;
  /** Flattened metric key sent by the phone and the server (`group.metric`). */
  metric?: string;
  format?: (value: number) => string;
  parameters: NumericParameter[];
};

const n = (
  section: Section,
  key: string,
  label: string,
  hint: string,
  min: number,
  max: number,
  step: number,
  bound?: "min" | "max",
  unit?: string,
): NumericParameter => ({
  section,
  key,
  label,
  hint,
  min,
  max,
  step,
  ...(bound ? { bound } : {}),
  ...(unit ? { unit } : {}),
});

const percent = (value: number) => `${Math.round(value * 1000) / 10} %`;
const fixed = (digits: number) => (value: number) => value.toFixed(digits);

/** Checks in guidance priority order, with the thresholds each one uses. */
const allCheckCatalog: CheckDescriptor[] = [
  {
    key: "document_found",
    label: "Document détecté",
    description: "Quatre coins localisés dans l’image.",
    parameters: [],
  },
  {
    key: "document_inside",
    label: "Coins dans le cadre",
    description: "Distance minimale entre un coin et le bord visible.",
    metric: "geometry.margin",
    format: percent,
    parameters: [
      n("document", "edgeMargin", "Marge minimale", "Part du plus petit côté de l’image", 0, 0.1, 0.002, "min"),
    ],
  },
  {
    key: "document_fill",
    label: "Distance",
    description: "Part du cadre couverte par le document sur son axe dominant.",
    metric: "geometry.fill",
    format: percent,
    parameters: [
      n("document", "minFill", "Couverture minimale", "En dessous : « Rapprochez-vous »", 0.2, 0.95, 0.01, "min"),
      n("document", "maxFill", "Couverture maximale", "Au-dessus : « Éloignez-vous »", 0.6, 1, 0.01, "max"),
    ],
  },
  {
    key: "aspect_ratio",
    label: "Format du document",
    description: "Écart relatif au format attendu (ID-1 ou passeport).",
    metric: "geometry.aspectError",
    format: percent,
    parameters: [
      n(
        "document",
        "aspectTolerance",
        "Écart maximal",
        "Au-delà : mauvais document ou forte inclinaison",
        0.02,
        0.5,
        0.01,
        "max",
      ),
    ],
  },
  {
    key: "perspective",
    label: "Perspective",
    description: "Déviation maximale des angles et rapport des côtés opposés.",
    metric: "geometry.angleDeviation",
    format: (value) => `${value.toFixed(1)}°`,
    parameters: [
      n(
        "document",
        "maxAngleDeviation",
        "Angle maximal",
        "Écart à 90° du coin le plus déformé",
        2,
        40,
        0.5,
        "max",
        "°",
      ),
      n("document", "maxSideRatio", "Rapport des côtés", "Côté opposé le plus long / le plus court", 1.02, 2, 0.01),
    ],
  },
  {
    key: "stability",
    label: "Stabilité",
    description: "Déplacement moyen des coins entre deux analyses (direct uniquement).",
    metric: "cornerMotion",
    format: percent,
    parameters: [
      n(
        "capture",
        "maxCornerMotion",
        "Mouvement maximal",
        "Part de la diagonale de l’image",
        0.002,
        0.08,
        0.001,
        "max",
      ),
    ],
  },
  {
    key: "resolution",
    label: "Résolution utile",
    description: "Points par pouce du document sur le capteur.",
    metric: "geometry.dpi",
    format: (value) => `${Math.round(value)} dpi`,
    parameters: [
      n(
        "document",
        "minDpi",
        "Résolution minimale",
        "300 dpi est la référence OCR classique",
        120,
        600,
        5,
        "min",
        "dpi",
      ),
    ],
  },
  {
    key: "sharpness",
    label: "Netteté",
    description: "Variance du Laplacien sur le document redressé.",
    metric: "image.sharpness",
    format: fixed(0),
    parameters: [
      n(
        "image",
        "minSharpnessLive",
        "Seuil en direct",
        "Images d’aperçu, plus petites et plus douces",
        5,
        600,
        1,
        "min",
      ),
      n("image", "minSharpness", "Seuil photo finale", "Photo pleine résolution ramenée à ~300 dpi", 5, 1200, 1, "min"),
    ],
  },
  {
    key: "motion_blur",
    label: "Flou de bougé",
    description: "Équilibre des gradients horizontaux et verticaux (1 = isotrope).",
    metric: "image.motionIsotropy",
    format: fixed(2),
    parameters: [
      n("image", "minMotionIsotropy", "Isotropie minimale", "Un bougé écrase une direction", 0, 0.9, 0.01, "min"),
    ],
  },
  {
    key: "focus_uniformity",
    label: "Mise au point uniforme",
    description: "Netteté de la zone la plus floue rapportée à la médiane.",
    metric: "image.focusUniformity",
    format: fixed(2),
    parameters: [
      n(
        "image",
        "minFocusUniformity",
        "Uniformité minimale",
        "Détecte un bord hors profondeur de champ",
        0,
        1,
        0.01,
        "min",
      ),
    ],
  },
  {
    key: "exposure",
    label: "Exposition",
    description: "Luminosité du fond du document (90ᵉ centile).",
    metric: "image.paper",
    format: fixed(0),
    parameters: [
      n("image", "exposureMin", "Fond minimal", "En dessous : trop sombre", 40, 220, 1, "min"),
      n("image", "exposureMax", "Fond maximal", "Au-dessus : surexposé", 180, 255, 1, "max"),
    ],
  },
  {
    key: "highlights",
    label: "Hautes lumières brûlées",
    description: "Pixels écrêtés (≥ 250).",
    metric: "image.highlightClip",
    format: percent,
    parameters: [n("image", "maxHighlightClip", "Écrêtage maximal", "Part du document", 0, 0.3, 0.002, "max")],
  },
  {
    key: "shadows_clipped",
    label: "Ombres bouchées",
    description: "Pixels quasi noirs (≤ 8).",
    metric: "image.shadowClip",
    format: percent,
    parameters: [n("image", "maxShadowClip", "Noirs maximum", "Part du document", 0, 0.5, 0.005, "max")],
  },
  {
    key: "contrast",
    label: "Contraste",
    description: "Dynamique entre le 2ᵉ et le 98ᵉ centile.",
    metric: "image.contrast",
    format: fixed(2),
    parameters: [n("image", "minContrast", "Contraste minimal", "0 à 1", 0, 1, 0.01, "min")],
  },
  {
    key: "glare",
    label: "Reflets",
    description: "Pixels saturés et incolores, et plus grande tache.",
    metric: "image.glareRatio",
    format: percent,
    parameters: [
      n("image", "maxGlareRatio", "Surface totale", "Part du document en reflet", 0, 0.1, 0.001, "max"),
      n("image", "maxGlareBlob", "Plus grande tache", "Part du document", 0, 0.1, 0.001, "max"),
    ],
  },
  {
    key: "color_glare",
    label: "Reflets colorés",
    description: "Expérimental : surface lumineuse et saturée. À calibrer aussi sur les motifs imprimés sans reflet.",
    metric: "image.colorGlareRatio",
    format: percent,
    parameters: [
      n(
        "image",
        "maxColorGlareRatio",
        "Surface colorée maximale",
        "Part du document ; abaisser rend le contrôle plus strict",
        0,
        0.3,
        0.001,
        "max",
      ),
      n(
        "image",
        "minColorGlareValue",
        "Luminosité minimale (V)",
        "0–255 ; abaisser inclut les reflets moins lumineux",
        0,
        255,
        1,
      ),
      n(
        "image",
        "minColorGlareSaturation",
        "Saturation minimale (S)",
        "0–1 ; augmenter exclut les couleurs pâles",
        0,
        1,
        0.01,
      ),
    ],
  },
  {
    key: "illumination",
    label: "Éclairage uniforme",
    description: "Fond le plus sombre / fond le plus clair sur une grille 6×4.",
    metric: "image.illumination",
    format: fixed(2),
    parameters: [
      n(
        "image",
        "minIllumination",
        "Uniformité minimale",
        "Une ombre portée fait chuter ce rapport",
        0.2,
        1,
        0.01,
        "min",
      ),
    ],
  },
  {
    key: "noise",
    label: "Bruit",
    description: "Écart-type du bruit capteur (Immerkaer, zones planes).",
    metric: "image.noise",
    format: fixed(1),
    parameters: [n("image", "maxNoise", "Bruit maximal", "Monte en faible lumière", 0.5, 25, 0.1, "max")],
  },
];

export const checkCatalog = allCheckCatalog;

export const captureParameters: Parameter[] = [
  {
    section: "capture",
    key: "autoCapture",
    label: "Capture automatique",
    hint: "Déclenche seule après stabilité",
    toggle: true,
  },
  n("capture", "stableFrames", "Images valides consécutives", "Avant le déclenchement automatique", 1, 12, 1),
  n(
    "capture",
    "samplingIntervalMs",
    "Pause entre analyses",
    "Après chaque image mesurée",
    60,
    1500,
    10,
    undefined,
    "ms",
  ),
  n(
    "capture",
    "analysisSize",
    "Taille d’analyse",
    "Plus grand côté de l’image d’aperçu",
    640,
    1920,
    32,
    undefined,
    "px",
  ),
  n("capture", "burstFrames", "Rafale finale", "Images pleine résolution comparées", 1, 6, 1),
  {
    section: "capture",
    key: "stillCapture",
    label: "Photo native (Android)",
    hint: "ImageCapture.takePhoto si disponible",
    toggle: true,
  },
  n(
    "capture",
    "idealVideoWidth",
    "Résolution vidéo demandée",
    "Largeur idéale négociée avec la caméra",
    1280,
    4096,
    64,
    undefined,
    "px",
  ),
  n("capture", "jpegQuality", "Qualité JPEG", "Photo envoyée au serveur", 0.7, 1, 0.01),
];

export const preprocessParameters: Parameter[] = [
  {
    section: "preprocess",
    key: "enabled",
    label: "Copie OCR pré-traitée",
    hint: "Sinon l’original est envoyé",
    toggle: true,
  },
  n("preprocess", "targetDpi", "Résolution cible", "Jamais agrandie au-delà de 1,25×", 200, 600, 10, undefined, "dpi"),
  n("preprocess", "marginRatio", "Marge autour du document", "Évite de rogner un bord", 0, 0.05, 0.005),
  n("preprocess", "illuminationStrength", "Correction d’éclairage", "Division par le fond estimé", 0, 1, 0.05),
  n("preprocess", "claheClipLimit", "Contraste local (CLAHE)", "0 = désactivé", 0, 4, 0.1),
  n("preprocess", "claheTileGrid", "Grille CLAHE", "Nombre de tuiles par côté", 2, 16, 1),
  n("preprocess", "denoiseAboveNoise", "Débruiter au-delà de", "Bruit mesuré (σ)", 0, 20, 0.5),
  n("preprocess", "sharpenAmount", "Accentuation", "Masque flou, 0 = désactivé", 0, 1.5, 0.05),
  n("preprocess", "sharpenSigma", "Rayon d’accentuation", "σ du flou gaussien", 0.3, 3, 0.1),
  {
    section: "preprocess",
    key: "whiteBalance",
    label: "Balance des blancs",
    hint: "Neutralise le fond, gain limité à ±10 %",
    toggle: true,
  },
  n("preprocess", "jpegQuality", "Qualité JPEG OCR", "Sous-échantillonnage 4:4:4", 70, 100, 1),
];

export const orbParameters: NumericParameter[] = [
  n("orb", "ratioThreshold", "Ratio de correspondance", "Test de Lowe sur la distance de Hamming", 0.5, 0.95, 0.01),
  n("orb", "minimumGoodMatches", "Correspondances minimum", "Points nécessaires avant homographie", 4, 200, 1),
  n("orb", "minimumInlierRatio", "Ratio d’inliers minimum", "Correspondances confirmées par RANSAC", 0, 1, 0.01),
  n("orb", "ransacThreshold", "Tolérance RANSAC", "Erreur tolérée en pixels", 0.5, 20, 0.1),
  n("orb", "minSpatialCoverage", "Couverture spatiale minimale", "Répartition des points dans l’image", 0, 1, 0.01),
  n("orb", "maxReprojectionError", "Erreur de reprojection maximum", "Erreur moyenne en pixels", 0.5, 30, 0.1),
  n("orb", "projectionMinAreaRatio", "Échelle projetée minimale", "Surface par rapport au gabarit", 0.1, 2, 0.05),
  n("orb", "projectionMaxAreaRatio", "Échelle projetée maximale", "Surface par rapport au gabarit", 0.5, 5, 0.05),
  n("orb", "projectionMarginRatio", "Marge projetée maximum", "Dépassement toléré autour du gabarit", 0, 1, 0.05),
];

export function readParameter(profile: QualityProfile, parameter: Parameter): number | boolean {
  return (profile[parameter.section] as Record<string, number | boolean>)[parameter.key] ?? 0;
}

export function writeParameter(profile: QualityProfile, parameter: Parameter, value: number | boolean): QualityProfile {
  return { ...profile, [parameter.section]: { ...profile[parameter.section], [parameter.key]: value } };
}

export const checkLabels: Record<string, string> = {
  ...Object.fromEntries(checkCatalog.map((check) => [check.key, check.label])),
  template_alignment: "Alignement du gabarit",
  orb_spatial_coverage: "Répartition ORB",
  orb_reprojection: "Reprojection ORB",
  orb_geometry: "Géométrie ORB",
};

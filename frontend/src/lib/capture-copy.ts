import type { CaptureHint } from "./quality-core";
import type { Locale } from "./types";

/** One short, actionable instruction per capture hint, shared by the phone and the server report. */
export const hintCopy: Record<Locale, Record<CaptureHint, string>> = {
  fr: {
    find_document: "Posez le document sur une surface unie et sombre",
    show_whole_document: "Montrez les quatre coins du document",
    move_closer: "Rapprochez-vous du document",
    move_back: "Éloignez-vous un peu",
    wrong_document: "Présentez le document à plat, en entier",
    hold_parallel: "Tenez le téléphone bien parallèle",
    hold_still: "Ne bougez plus…",
    focus: "Stabilisez, la mise au point se fait",
    more_light: "Allez vers un endroit plus éclairé",
    less_light: "Trop de lumière, évitez le soleil direct",
    avoid_glare: "Inclinez légèrement pour enlever le reflet",
    even_light: "Évitez l’ombre sur le document",
    ready: "Parfait, ne bougez plus",
  },
  en: {
    find_document: "Place the document on a plain, dark surface",
    show_whole_document: "Show all four corners of the document",
    move_closer: "Move closer to the document",
    move_back: "Move back a little",
    wrong_document: "Show the whole document, flat",
    hold_parallel: "Hold the phone parallel to the document",
    hold_still: "Hold still…",
    focus: "Hold steady while the camera focuses",
    more_light: "Move somewhere brighter",
    less_light: "Too bright, avoid direct sunlight",
    avoid_glare: "Tilt slightly to remove the reflection",
    even_light: "Avoid shadows on the document",
    ready: "Perfect, hold still",
  },
  ar: {
    find_document: "ضع الوثيقة على سطح موحّد وداكن",
    show_whole_document: "أظهر الزوايا الأربع للوثيقة",
    move_closer: "قرّب الهاتف من الوثيقة",
    move_back: "أبعد الهاتف قليلًا",
    wrong_document: "اعرض الوثيقة كاملة ومسطحة",
    hold_parallel: "اجعل الهاتف موازيًا للوثيقة",
    hold_still: "لا تتحرك…",
    focus: "ثبّت الهاتف ليتم ضبط التركيز",
    more_light: "انتقل إلى مكان أكثر إضاءة",
    less_light: "الإضاءة قوية، تجنّب أشعة الشمس المباشرة",
    avoid_glare: "أمل الوثيقة قليلًا لإزالة الانعكاس",
    even_light: "تجنّب الظل على الوثيقة",
    ready: "ممتاز، لا تتحرك",
  },
};

export const cameraCopy: Record<
  Locale,
  {
    starting: string;
    cameraDenied: string;
    cameraFailed: string;
    analyzerFailed: string;
    auto: string;
    manual: string;
    capture: string;
    checking: string;
    retrying: string;
    reviewTitle: string;
    reviewReady: string;
    usePhoto: string;
    retake: string;
    sending: string;
    torch: string;
    back: string;
    attempts: (remaining: number) => string;
    simulate: string;
    sent: string;
  }
> = {
  fr: {
    starting: "Préparation de la caméra…",
    cameraDenied: "Autorisez l’accès à la caméra dans les réglages du navigateur, puis réessayez.",
    cameraFailed: "La caméra n’a pas pu démarrer. Fermez les autres applications qui l’utilisent.",
    analyzerFailed: "L’analyse est indisponible. Relancez la caméra pour continuer.",
    auto: "Capture automatique",
    manual: "Prendre la photo",
    capture: "Photo en cours…",
    checking: "Vérification de la netteté…",
    retrying: "Photo pas assez nette, on recommence",
    reviewTitle: "Votre document",
    reviewReady: "Photo nette et lisible",
    usePhoto: "Utiliser cette photo",
    retake: "Reprendre",
    sending: "Envoi sécurisé…",
    torch: "Lampe",
    back: "Retour",
    attempts: (remaining) => `${remaining} lecture${remaining > 1 ? "s" : ""} restante${remaining > 1 ? "s" : ""}`,
    simulate: "Simuler un scan valide",
    sent: "Photo envoyée au poste",
  },
  en: {
    starting: "Starting the camera…",
    cameraDenied: "Allow camera access in your browser settings, then try again.",
    cameraFailed: "The camera could not start. Close other apps that may be using it.",
    analyzerFailed: "Quality checks are unavailable. Restart the camera to continue.",
    auto: "Automatic capture",
    manual: "Take photo",
    capture: "Taking photo…",
    checking: "Checking sharpness…",
    retrying: "Not sharp enough, trying again",
    reviewTitle: "Your document",
    reviewReady: "Sharp and readable",
    usePhoto: "Use this photo",
    retake: "Retake",
    sending: "Sending securely…",
    torch: "Torch",
    back: "Back",
    attempts: (remaining) => `${remaining} reading${remaining === 1 ? "" : "s"} left`,
    simulate: "Simulate a valid scan",
    sent: "Photo sent to the workstation",
  },
  ar: {
    starting: "جارٍ تشغيل الكاميرا…",
    cameraDenied: "اسمح باستخدام الكاميرا من إعدادات المتصفح ثم أعد المحاولة.",
    cameraFailed: "تعذر تشغيل الكاميرا. أغلق التطبيقات الأخرى التي تستخدمها.",
    analyzerFailed: "فحص الجودة غير متاح. أعد تشغيل الكاميرا للمتابعة.",
    auto: "التقاط تلقائي",
    manual: "التقاط الصورة",
    capture: "جارٍ الالتقاط…",
    checking: "جارٍ التحقق من الوضوح…",
    retrying: "الصورة غير واضحة بما يكفي، نعيد المحاولة",
    reviewTitle: "وثيقتك",
    reviewReady: "صورة واضحة ومقروءة",
    usePhoto: "استخدام هذه الصورة",
    retake: "إعادة التصوير",
    sending: "إرسال آمن…",
    torch: "المصباح",
    back: "رجوع",
    attempts: (remaining) => `${remaining} قراءات متبقية`,
    simulate: "محاكاة مسح صالح",
    sent: "أُرسلت الصورة إلى محطة المعايرة",
  },
};

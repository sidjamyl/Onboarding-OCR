# Document-quality validation

The authoritative final-photo path is `DocumentQualityEngine.assess`. It locates the document, measures geometry and image quality on a rectified document, optionally checks a matching ORB template and its required zones, rejects blocking failures, and creates a document-only OCR copy only for accepted photos. The original remains available for auditing; OCR receives the copy.

The bundled `quality-templates/dz-id-front-24b430d57956.json` is the unchanged version-1 export supplied by `template-ocr-lab`. Its 2,650 ORB keypoints, 11 zones, and per-template matching parameters are loaded directly. As in `OCR/src/infra/templates/orb-worker.ts`, ORB runs on the localized document, not the entire camera frame. No ready back-side, driving-licence, or passport export was available in this checkout; those sides still use generic geometry until their exports are added.

Use `npm run benchmark -- <manifest.json>` from `onboarding/backend` with a private, labeled corpus. Keep photographs and ground truth outside the repository. Example manifest:

```json
{
  "cases": [
    { "id": "id-front-good-01", "image": "photos/good-01.jpg", "documentKind": "dz-id", "templateId": "dz-id-front", "expected": "accept", "fields": { "nin": "123456789012345678" } },
    { "id": "id-front-glare-01", "image": "photos/glare-01.jpg", "documentKind": "dz-id", "templateId": "dz-id-front", "expected": "reject" }
  ]
}
```

Image paths are relative to the manifest. The backend reads version-1 ORB JSON exports from `quality-templates` by default and also checks that bundled directory if `TEMPLATE_DIRECTORY` points at another writable store. Use `QUALITY_TEMPLATE_DIR` to select a benchmark directory. Descriptors and per-template ORB parameters are used unchanged. Use a side-specific ID in the manifest; the production capture route automatically requests `${documentKind}-${side}`. With no saved variant, ORB is not proof of identity and the engine falls back to generic geometric checks.

The command reports false accepts, false rejects, failing check keys, and latency without printing images or labeled field values. To compare OCR on the original and prepared copy, also set `OCR_BASE_URL`, `OCR_BASIC_USERNAME`, and `OCR_BASIC_PASSWORD`, and include `fields` on accepted cases. Ground-truth field keys must match the single-document OCR response field keys. OCR comparison runs only for quality-accepted photos with an OCR copy; rejected photos are intentionally never sent to OCR. Compare `correctFields/labeledFields`, errors, and latency for both variants. Do not assume the prepared copy is better until the labeled results show it.

Build a representative corpus for each document kind and side: good captures across phones and lighting, then deliberately bad captures with blur, reflections, shadow, clipped corners, wrong side/document, folds, and low resolution. Include photos that are close to each threshold. Review every false accept and false reject, adjust the versioned profile in the Quality Lab, then rerun the same held-out corpus. A green unit-test suite is not a substitute for this validation.

The backend-only live phone signal viewer is served in development at `/dev/quality/calibrations/:id/phone-diagnostics`; it is linked from the Quality Lab and is not part of the public frontend.

// ============================================================
// Concord TrackSync - Dual-Scan workflow (Finishing departments)
//
// Pure, dependency-free logic behind the two-scan process in
// /transactions:
//   Scan 1 = Inner Box QR   (captured, no write)
//   Scan 2 = Shoe QR        (validated by the standard guards and
//                            inserted into data_updates together
//                            with the captured inner_qr)
//
// Dual-Scan is enabled ONLY when BOTH hold:
//   1. the logged-in user's department is 'Finishing 01',
//      'Finishing 02' or 'Finishing 03', AND
//   2. the locked QC status is NOT 'B Grade', 'C Grade' or
//      'Lab Testing' (the bypass condition - those statuses revert
//      to the single Shoe QR scan mode, inner_qr = null).
// Comparisons are case-insensitive and whitespace tolerant.
// ============================================================

/** Departments where the Dual-Scan process applies (exact names). */
export const FINISHING_DEPARTMENTS = ['Finishing 01', 'Finishing 02', 'Finishing 03'];

/** QC statuses that bypass Dual-Scan, even inside Finishing departments. */
export const DUAL_SCAN_BYPASS_QC = ['B Grade', 'C Grade', 'Lab Testing'];

/** The two capture stages of a dual-scan pair. */
export const DUAL_SCAN_STAGES = { INNER: 'inner', SHOE: 'shoe' };

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

/** True when the department is one of the Finishing lines. */
export function isFinishingDepartment(department) {
  return FINISHING_DEPARTMENTS.some((name) => norm(name) === norm(department));
}

/** True when the selected QC status bypasses Dual-Scan. */
export function isDualScanQcBypass(qcStatus) {
  return DUAL_SCAN_BYPASS_QC.some((status) => norm(status) === norm(qcStatus));
}

/**
 * Normal Dual-Scan condition: a Finishing department whose QC status
 * is NOT one of the bypass statuses.
 */
export function isDualScanEnabled(department, qcStatus) {
  return isFinishingDepartment(department) && !isDualScanQcBypass(qcStatus);
}

/**
 * Fresh dual-scan state: stage 1 (Inner Box QR) with nothing captured.
 * @param {boolean} enabled
 */
export function createDualScanState(enabled) {
  return { enabled: Boolean(enabled), stage: DUAL_SCAN_STAGES.INNER, innerQr: null };
}

/**
 * Pure step: route ONE scanned code through the dual-scan state.
 *
 * Returns { next, submitCode, innerQrForSubmit }:
 *  - Dual-Scan active, stage 1  -> next = stage 2 + captured innerQr,
 *    submitCode = null (nothing recorded yet).
 *  - Dual-Scan active, stage 2  -> submitCode = the Shoe QR,
 *    innerQrForSubmit = the captured Inner Box QR; next is RESET to a
 *    fresh stage-1 state for the next pair.
 *  - Dual-Scan disabled (bypass / non-Finishing) -> single Shoe QR
 *    mode: submitCode = the code immediately, innerQrForSubmit = null
 *    (any stale captured inner is dropped).
 */
export function applyDualScanScan(state, scannedCode) {
  const code = String(scannedCode || '').trim();
  if (!state?.enabled) {
    return {
      next: createDualScanState(false),
      submitCode: code,
      innerQrForSubmit: null,
    };
  }
  if (state.stage === DUAL_SCAN_STAGES.INNER) {
    return {
      next: { enabled: true, stage: DUAL_SCAN_STAGES.SHOE, innerQr: code },
      submitCode: null,
      innerQrForSubmit: null,
    };
  }
  return {
    next: createDualScanState(true),
    submitCode: code,
    innerQrForSubmit: state.innerQr,
  };
}

/**
 * Build the exact data_updates payload for one standard transaction.
 * `inner_qr` carries the Inner Box QR captured in Dual-Scan mode and
 * is null for single scans (bypassed QC statuses / non-Finishing).
 * `count` is -1 for Return and 1 for every other QC status.
 */
export function buildStandardTransactionPayload({
  user,
  orgQr,
  recordStatus,
  qcStatus,
  innerQr = null,
}) {
  const trimmedInner = innerQr == null ? '' : String(innerQr).trim();
  return {
    qr_code: orgQr,
    inner_qr: trimmedInner || null,
    record_status: recordStatus,
    qc_status: qcStatus,
    department: user?.department || '-',
    count: qcStatus === 'Return' ? -1 : 1,
    created_by: user?.username || 'unknown',
    created_at: new Date().toISOString(), // scan timestamp (NOW)
  };
}

/* ====================================================================
 * Inner Box QR validation (Dual-Scan pairs, Finishing departments)
 *
 * The Inner Box QR is a blaklader URL label. Three checks run at
 * submit time (scan 2) BEFORE the standard sequence guards:
 *   V1. URL structure - must contain the exact 'http://blaklader.com'
 *       substring.
 *   V2. PO match     - the inner PO code from the GS1 `10` (batch/lot)
 *       element must equal the shoe org_qr PO code (hyphen-aware
 *       last-4 extraction).
 *   V3. Size match   - srl_num.size for the inner 13-digit box code
 *       must equal the size encoded in the shoe org_qr.
 * ==================================================================== */

/** Exact substring every Inner Box QR must contain (V1). */
export const INNER_BOX_URL_TOKEN = 'http://blaklader.com';

/** V1 failure message (exact). */
export const BLOCK_INNER_BOX_FORMAT =
  'Invalid Inner Box QR format: Must contain http://blaklader.com';

/** V2 failure message (exact). */
export const BLOCK_PO_MISMATCH =
  'PO Number Mismatch between Inner Box QR and Shoe QR';

/** V3 failure message (exact). */
export const BLOCK_SIZE_MISMATCH =
  'Size Mismatch: Inner Box Size does not match Shoe Size';

/**
 * GS1 group separator (ASCII 29, "\u001d") that terminates every
 * variable-length Application Identifier element on the label.
 */
export const GS1_GROUP_SEPARATOR = '\u001d';

function isDigitChar(ch) {
  return ch >= '0' && ch <= '9';
}

/** Trailing 4 digits of a numeric run (null when shorter than 4). */
function trailingFourDigits(digits) {
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** V1: the inner QR must contain the exact blaklader URL token. */
export function isInnerBoxQrFormatValid(innerQr) {
  return String(innerQr || '').includes(INNER_BOX_URL_TOKEN);
}

/**
 * V2 (inner side): extract the 4-digit PO code from the GS1 `10`
 * (batch/lot = PO) element of the Inner Box QR.
 *
 * Real label structure (GS1, group-separated):
 *   010733050996397521028002291\u001d10148925\u001d8200http://blaklader.com
 *   |01 + 14-digit GTIN|  |21 + serial|  |10 + PO|   |8200 + URL|
 *
 * A naive backwards digit scan breaks on this structure: the `8200`
 * digits after the PO and the fixed-length 01/21 elements corrupt the
 * count. Strategy (first match wins):
 *   1. Split on the GS1 group separator and take the segment that IS
 *      the `10` element (starts with "10", digits only after it).
 *   2. Separator-less variant: scan the contiguous digit run that ends
 *      directly before the 8200/http URL AI and drop a leading "10" -
 *      control characters and other AIs cannot leak in because any
 *      non-digit stops the scan.
 *   3. Legacy fallback for URL-path labels: the original backwards
 *      skip-8-take-4 digit scan.
 * Returns the 4-digit code, or null when no PO element is found.
 */
export function extractInnerBoxPo(innerQr) {
  const text = String(innerQr || '');
  if (!text) return null;

  // 1) Authoritative GS1 parse: the `10` element is its own segment.
  if (text.includes(GS1_GROUP_SEPARATOR)) {
    for (const segment of text.split(GS1_GROUP_SEPARATOR)) {
      const match = /^10(\d{4,})$/.exec(segment.trim());
      if (match) return trailingFourDigits(match[1]);
    }
  }

  // 2) Separator-less variant: digits run straight into the 8200/http
  //    URL AI - walk backwards from there over that run only.
  const urlIndex = text.indexOf(INNER_BOX_URL_TOKEN);
  if (urlIndex > 0) {
    let end = urlIndex;
    if (end >= 4 && text.slice(end - 4, end) === '8200') end -= 4;
    const collected = [];
    for (let i = end - 1; i >= 0 && collected.length < 12; i -= 1) {
      if (!isDigitChar(text[i])) break;
      collected.push(text[i]);
    }
    let run = collected.reverse().join('');
    if (run.startsWith('10')) run = run.slice(2);
    const code = trailingFourDigits(run);
    if (code) return code;
  }

  // 3) Legacy fallback: URL-path labels with the digits after the URL.
  const legacy = [];
  for (let i = text.length - 1; i >= 0 && legacy.length < 12; i -= 1) {
    if (isDigitChar(text[i])) legacy.push(text[i]);
  }
  if (legacy.length < 12) return null;
  return legacy.slice(8, 12).reverse().join('');
}

/**
 * V3 (inner side): the 13-digit Box Code - skip the first 3 digits
 * from the start, then extract the next 13 digits (non-digit URL
 * separators are skipped while scanning). Returns null when the QR
 * does not carry 16 leading digits.
 */
export function extractInnerBoxCode(innerQr) {
  const text = String(innerQr || '');
  let skipped = 0;
  let collected = '';
  for (let i = 0; i < text.length && collected.length < 13; i += 1) {
    if (!isDigitChar(text[i])) continue;
    if (skipped < 3) {
      skipped += 1;
      continue;
    }
    collected += text[i];
  }
  return collected.length === 13 ? collected : null;
}

/**
 * Parse the shoe org_qr ";mqc;po;size;scanned;" (empty MQC gives a
 * leading ";;"). Falls back to treating the whole value as the PO
 * when the semicolon structure is absent.
 */
export function parseOrgQr(orgQr) {
  const text = String(orgQr || '').trim();
  const parts = text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    return {
      mqc: parts[0],
      po: parts[1],
      size: parts[2],
      scanned: parts.slice(3).join(';') || null,
    };
  }
  return { mqc: null, po: text || null, size: null, scanned: null };
}

/**
 * V2 (shoe side): the 4-digit PO code from the org_qr PO segment.
 *  - hyphenated PO "148925-01" -> strip "-01" -> "148925" -> "8925"
 *  - standard PO  "144065"     -> last 4 digits directly -> "4065"
 */
export function extractShoePoCode(orgQr) {
  const po = parseOrgQr(orgQr).po;
  if (!po) return null;
  const digits = String(po).split('-')[0].replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Normalize a size for comparison: numeric when both sides are. */
export function normalizeSizeValue(size) {
  const text = String(size ?? '').trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return String(Number(text));
  return text.toLowerCase();
}

/** V3 comparison: numeric-aware, case- and whitespace-tolerant. */
export function sizesMatch(a, b) {
  if (a == null || b == null) return false;
  return normalizeSizeValue(a) === normalizeSizeValue(b);
}

/**
 * Run the three Inner Box validations for one dual-scan pair.
 * @param {object} params
 * @param {string} params.innerQr  captured Inner Box QR (URL label)
 * @param {string} params.orgQr    shoe org_qr resolved by guard Rule 1
 * @param {string|number|null} params.srlSize size fetched from the
 *        srl_num table for the inner box code (null = row missing)
 * @returns {null | {reason: string}} null when every check passes.
 */
export function validateDualScanPair({ innerQr, orgQr, srlSize }) {
  // V1: URL structure.
  if (!isInnerBoxQrFormatValid(innerQr)) {
    return { reason: BLOCK_INNER_BOX_FORMAT };
  }
  // V2: the two 4-digit PO codes must match exactly.
  const innerPo = extractInnerBoxPo(innerQr);
  const shoePo = extractShoePoCode(orgQr);
  if (!innerPo || !shoePo || innerPo !== shoePo) {
    return { reason: BLOCK_PO_MISMATCH };
  }
  // V3: the srl_num size must match the shoe size. A missing srl_num
  // row blocks too - the match cannot be proven, so nothing is written.
  const boxCode = extractInnerBoxCode(innerQr);
  const shoeSize = parseOrgQr(orgQr).size;
  if (!boxCode || !sizesMatch(srlSize, shoeSize)) {
    return { reason: BLOCK_SIZE_MISMATCH };
  }
  return null;
}
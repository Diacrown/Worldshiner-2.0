// Ports the "client's own stone / semi-mount" safeguard from the old Texas
// app (settingChargeGuard / jobNeedsSettingCharge). Original behaviour: when
// a job moves to "Quote Given" and India only quoted the semi-mount, the
// office must record the local setting charge before the status can change.
//
// Important difference from the old system: the old app enforced this with
// a browser prompt() ONLY — nothing stopped a direct Firestore write (or a
// buggy client) from skipping it. Here the same rule is enforced in this
// function, called from the API route, so it can't be bypassed by the client.
//
// NOTE: the original regex also matched the literal phrase "texas stock",
// which was specific to how the Texas office phrased notes. Generalised here
// to "<office> stock" — pass the office's display name in when calling this
// so the same rule works for every office, not just Texas. Confirm this
// generalisation still makes sense for each office during migration.
export function jobNeedsSettingCharge({ notes, designEntryDescriptions = [], clientItemCount = 0, officeName = '' }) {
  if (clientItemCount > 0) return true;
  const haystack = [notes || '', ...designEntryDescriptions].join(' ').toLowerCase();
  const officePattern = officeName ? `${escapeRegex(officeName.toLowerCase())}\\s+stock` : 'texas\\s+stock';
  const pattern = new RegExp(`client'?s?\\s+stone|stone\\s+from\\s+${officeName ? escapeRegex(officeName.toLowerCase()) : 'texas'}|${officePattern}`);
  return pattern.test(haystack);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function evaluateSettingChargeGuard({
  newStatusCode,
  clientStoneSemiMount,
  settingChargeConfirmed,
  needsCharge,
  providedSettingCharge, // string from the request body — the amount, or "none"/"None"
}) {
  const triggered = newStatusCode === 'quote_given' && (clientStoneSemiMount || needsCharge) && !settingChargeConfirmed;
  if (!triggered) return { ok: true, data: {} };

  if (providedSettingCharge == null || String(providedSettingCharge).trim() === '') {
    return {
      ok: false,
      error:
        "This job needs the local setting charge confirmed before it can move to Quote Given " +
        "(India quoted the semi-mount only). Provide settingCharge — an amount, or \"None\".",
    };
  }
  const cleaned = String(providedSettingCharge).trim();
  const isNone = /^(none|no|n\/a|na|0|nil)$/i.test(cleaned);
  return {
    ok: true,
    data: { settingChargeConfirmed: true, settingCharge: isNone ? 'None' : cleaned },
  };
}

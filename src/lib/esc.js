// Ninety · a single HTML escape for interpolating untrusted data into innerHTML.
// Untrusted sources: node and subscription names/hosts (the subscription server / a shared link),
// live process names and connection hosts (OS / clash API). It escapes both
// quotes → safe both for text content and for attributes in double/single
// quotes. Consolidates the former local copies (proxies-view/main/edit-modal
// escapeHtml; dpi-view/routing-view esc did NOT escape ' (a latent breakout of
// single-quoted attributes); settings-view escapeAttr escaped only "/< (incomplete)).
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => MAP[c]);
}

// The attribute context is covered by the same set (both quotes escaped).
export const escapeAttr = escapeHtml;

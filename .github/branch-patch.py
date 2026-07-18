from pathlib import Path

p = Path("src-tauri/src/backup.rs")
s = p.read_text()
old = '''    match root.get("keys") {
        Some(serde_json::Value::Object(keys)) => Some(keys),
        _ => Some(root),
    }
'''
new = '''    match root.get("keys") {
        None => Some(root),
        Some(serde_json::Value::Object(keys)) => Some(keys),
        Some(_) => None,
    }
'''
assert old in s
s = s.replace(old, new, 1)
anchor = '''    #[test]
    fn non_object_json_is_not_a_snapshot() {
'''
test = '''    #[test]
    fn malformed_keys_wrapper_is_rejected() {
        let wrapped = serde_json::json!({
            "keys": [],
            "__schemaVersion": 2,
            "ninety.options.v1": "{}",
            "ninety.profiles.v1": "[]",
            "ninety.subscriptions.v1": "[]"
        })
        .to_string();
        assert!(valid_snapshot_json(wrapped).is_none());
    }

'''
assert anchor in s
s = s.replace(anchor, test + anchor, 1)
p.write_text(s)

p = Path("src/lib/state-backup.js")
s = p.read_text()
anchor = '''// true → ключи восстановлены; вызывающий делает location.reload(), чтобы все
'''
helper = '''export function unwrapSnapshotEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  if (!Object.prototype.hasOwnProperty.call(parsed, "keys")) return parsed;
  const keys = parsed.keys;
  return keys && typeof keys === "object" && !Array.isArray(keys) ? keys : null;
}

'''
assert anchor in s
s = s.replace(anchor, helper + anchor, 1)
old = '  const snap = parsed?.keys && typeof parsed.keys === "object" ? parsed.keys : parsed;'
new = '  const snap = unwrapSnapshotEnvelope(parsed);'
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

p = Path("tests/state-backup.test.mjs")
s = p.read_text()
old = '''const { backupForUpdate, backupNow, restoreIfEmpty, validateSnapshot } = await import("/lib/state-backup.js");
'''
new = '''const {
  backupForUpdate,
  backupNow,
  restoreIfEmpty,
  unwrapSnapshotEnvelope,
  validateSnapshot,
} = await import("/lib/state-backup.js");
'''
assert old in s
s = s.replace(old, new, 1)
anchor = '''test("partial/corrupt backup отклоняется до записи", () => {
'''
test = '''test("backup envelope принимает только object в поле keys", () => {
  const keys = {
    __schemaVersion: 2,
    "ninety.options.v1": "{}",
    "ninety.profiles.v1": "[]",
    "ninety.subscriptions.v1": "[]",
  };
  assert.equal(unwrapSnapshotEnvelope(keys), keys);
  assert.equal(unwrapSnapshotEnvelope({ keys }), keys);
  assert.equal(unwrapSnapshotEnvelope({ keys: [] }), null);
  assert.equal(unwrapSnapshotEnvelope({ keys: "invalid" }), null);
});

'''
assert anchor in s
s = s.replace(anchor, test + anchor, 1)
p.write_text(s)

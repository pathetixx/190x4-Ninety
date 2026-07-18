from pathlib import Path

p = Path("src-tauri/src/quality.rs")
s = p.read_text()
anchor = "const MAX_REDIRECTS: usize = 3;\n"
insert = '''const MAX_REDIRECTS: usize = 3;
const ALLOWED_QUALITY_HOSTS: &[&str] = &["speed.cloudflare.com"];

fn quality_host_allowed(host: &str) -> bool {
    ALLOWED_QUALITY_HOSTS
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
}
'''
assert s.count(anchor) == 1
s = s.replace(anchor, insert, 1)
old = '''            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("quality endpoint credentials are not allowed".into());
            }
            Ok(endpoint.to_string())
'''
new = '''            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("quality endpoint credentials are not allowed".into());
            }
            let host = parsed.host_str().ok_or("quality endpoint host is missing")?;
            if !quality_host_allowed(host) {
                return Err(format!("quality endpoint host is not allowed: {host}"));
            }
            Ok(endpoint.to_string())
'''
assert old in s
s = s.replace(old, new, 1)
old = '''        assert!(validate_endpoints(vec!["https://user:pass@example.com/file".into()]).is_err());
        assert!(validate_endpoints(vec!["https://example.com".into(); MAX_ENDPOINTS + 1]).is_err());
'''
new = '''        assert!(validate_endpoints(vec!["https://user:pass@example.com/file".into()]).is_err());
        assert!(validate_endpoints(vec!["https://127.0.0.1/probe".into()]).is_err());
        assert!(validate_endpoints(vec!["https://localhost/probe".into()]).is_err());
        assert!(validate_endpoints(vec!["https://192.168.1.1/probe".into()]).is_err());
        assert!(validate_endpoints(vec!["https://example.com/file".into()]).is_err());
        assert!(validate_endpoints(vec!["https://speed.cloudflare.com".into(); MAX_ENDPOINTS + 1]).is_err());
'''
assert old in s
s = s.replace(old, new, 1)
test_anchor = '''    #[test]
    fn redirects_stay_on_the_same_https_origin() {
'''
test = '''    #[test]
    fn quality_host_allowlist_is_exact_and_case_insensitive() {
        assert!(quality_host_allowed("speed.cloudflare.com"));
        assert!(quality_host_allowed("SPEED.CLOUDFLARE.COM"));
        assert!(!quality_host_allowed("localhost"));
        assert!(!quality_host_allowed("speed.cloudflare.com.evil.example"));
    }

'''
assert test_anchor in s
s = s.replace(test_anchor, test + test_anchor, 1)
p.write_text(s)

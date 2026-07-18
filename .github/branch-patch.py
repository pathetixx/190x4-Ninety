from pathlib import Path

p = Path("src-tauri/src/proxy_win.rs")
s = p.read_text()
anchor = 'const LEGACY_PROXY_SERVER: &str = "127.0.0.1:7890";\n'
helper = r'''

fn validate_proxy_endpoint(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() || value.contains("//") || value.chars().any(char::is_whitespace) {
        return Err("system proxy endpoint must be loopback host:port".into());
    }

    if let Ok(address) = value.parse::<std::net::SocketAddr>() {
        let allowed = match address.ip() {
            std::net::IpAddr::V4(ip) => ip == std::net::Ipv4Addr::LOCALHOST,
            std::net::IpAddr::V6(ip) => ip == std::net::Ipv6Addr::LOCALHOST,
        };
        if allowed && address.port() != 0 {
            return Ok(address.to_string());
        }
        return Err("system proxy endpoint must use 127.0.0.1 or ::1".into());
    }

    let Some((host, port)) = value.rsplit_once(':') else {
        return Err("system proxy endpoint must include a port".into());
    };
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or("system proxy port must be in 1..=65535")?;
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(format!("localhost:{port}"));
    }
    Err("system proxy endpoint must use 127.0.0.1, localhost or ::1".into())
}
'''
assert s.count(anchor) == 1
s = s.replace(anchor, anchor + helper, 1)
old = '        let hp = host_port.unwrap_or("127.0.0.1:7890");'
new = '        let hp = validate_proxy_endpoint(host_port.unwrap_or("127.0.0.1:7890"))?;'
assert s.count(old) == 1
s = s.replace(old, new, 1)
test_anchor = '    use super::*;\n    use std::cell::Cell;\n'
tests = r'''

    #[test]
    fn system_proxy_endpoint_accepts_only_explicit_loopback_hosts() {
        assert_eq!(
            validate_proxy_endpoint("127.0.0.1:7890").unwrap(),
            "127.0.0.1:7890"
        );
        assert_eq!(
            validate_proxy_endpoint("LOCALHOST:8080").unwrap(),
            "localhost:8080"
        );
        assert_eq!(
            validate_proxy_endpoint("[::1]:1080").unwrap(),
            "[::1]:1080"
        );
        for invalid in [
            "0.0.0.0:7890",
            "127.0.0.2:7890",
            "192.168.1.10:7890",
            "example.com:7890",
            "http://127.0.0.1:7890",
            "localhost:0",
            "localhost",
        ] {
            assert!(validate_proxy_endpoint(invalid).is_err(), "accepted {invalid}");
        }
    }
'''
assert s.count(test_anchor) == 1
s = s.replace(test_anchor, test_anchor + tests, 1)
p.write_text(s)

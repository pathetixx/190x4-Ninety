// Ninety · user-defined DPI strategies.
//
// A custom strategy has the same shape as a built-in one: a name, a description,
// an `experimental` flag and the full winws argument list split into sections by
// `--new`. The editor lets the user start from a built-in strategy and change
// only the sections they need, so a tweak for one game never means retyping the
// profiles that keep sites, video and voice working.
//
// winws runs with administrator rights while the stored strategy lives in a
// directory a regular user can write, so it is never trusted on read. Every
// check and every launch re-parses it through an allowlist that is wider than
// the channel one (users paste zapret options the curated set doesn't use) but
// lets no file path, config file or process option through: payloads resolve
// only inside our bin-data directory, lists only to the app's own list files.
//
// The WinDivert interception (`--wf-tcp`/`--wf-udp`) is always assembled from
// the section filters, so a section on a new port can't be left without
// packets. The app's own substitutions (paths, game filter, autolist gate, VPN
// endpoint exclusion) are applied at launch exactly as for built-in strategies.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub(super) const CUSTOM_ID_PREFIX: &str = "custom-";
pub(super) const MAX_CUSTOM_STRATEGIES: usize = 3;
pub(super) const MAX_CUSTOM_TEXT_BYTES: usize = 64 * 1024;
pub(super) const MAX_CUSTOM_NAME_CHARS: usize = 40;
pub(super) const MAX_CUSTOM_DESC_CHARS: usize = 300;
const CUSTOM_STORE_FILE: &str = "custom-strategies.json";
const CUSTOM_STORE_VERSION: u32 = 2;
// Reported issues are capped: one typo must not flood the editor.
const MAX_ISSUES: usize = 12;
const MAX_LIST_ITEMS: usize = 256;

/// A stored custom strategy, in the built-in strategy format plus its origin.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct CustomStrategy {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) desc: String,
    #[serde(default)]
    pub(super) experimental: bool,
    // The built-in strategy the user started from. Only the editor uses it, to
    // mark which sections differ; the launch never reads the base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) base: Option<String>,
    #[serde(default)]
    pub(super) args: Vec<String>,
}

#[derive(Default, Deserialize)]
pub(super) struct CustomStore {
    // The file also carries a "version" (see save_store); serde skips it on read.
    #[serde(default)]
    pub(super) items: Vec<CustomStrategy>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Issue {
    pub(super) level: &'static str,
    pub(super) code: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(super) arg: String,
    // Zero-based section index, when the issue belongs to one section.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) section: Option<usize>,
}

impl Issue {
    fn error(code: &'static str, arg: &str) -> Self {
        Self {
            level: "error",
            code,
            arg: shown_arg(arg),
            section: None,
        }
    }

    fn warn(code: &'static str) -> Self {
        Self {
            level: "warn",
            code,
            arg: String::new(),
            section: None,
        }
    }

    fn at(mut self, section: usize) -> Self {
        self.section = Some(section);
        self
    }

    pub(super) fn is_error(&self) -> bool {
        self.level == "error"
    }

    // Catalog token for the frontend localizer (see util::i18n_error).
    pub(super) fn token(&self) -> String {
        let key = format!("dpi.custom.issue.{}", self.code);
        crate::util::i18n_error_with(&key, &[("arg", &self.arg)])
    }
}

// The offending fragment as shown in the UI: bounded, single-line and free of
// the braces that would break the backend error token.
fn shown_arg(arg: &str) -> String {
    let clean: String = arg
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '{' | '}' | '[' | ']'))
        .collect();
    if clean.chars().count() > 80 {
        let mut short: String = clean.chars().take(77).collect();
        short.push('…');
        short
    } else {
        clean
    }
}

/// Name, description and flag carried by a pasted or imported JSON strategy.
#[derive(Debug, Default, Serialize)]
pub(super) struct Meta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) experimental: Option<bool>,
}

#[derive(Debug, Default, Serialize)]
pub(super) struct Report {
    pub(super) ok: bool,
    pub(super) issues: Vec<Issue>,
    // Canonical arguments of each section, without --wf-* and --new.
    pub(super) sections: Vec<Vec<String>>,
    // Explicit --wf-* ports the section filters don't already imply (needed
    // only next to `*` or negated filters); kept with the stored strategy.
    pub(super) wf_extra: Vec<String>,
    // Final winws arguments before placeholder substitution (empty on error).
    pub(super) args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) meta: Option<Meta>,
    #[serde(skip)]
    pub(super) bins: Vec<String>,
}

impl Report {
    pub(super) fn first_error(&self) -> Option<&Issue> {
        self.issues.iter().find(|issue| issue.is_error())
    }

    /// The form a strategy is stored in: sections plus only the interception
    /// the filters can't imply. The full --wf-* is assembled on every launch,
    /// so deleting a section also drops its ports.
    pub(super) fn stored_args(&self) -> Vec<String> {
        let mut out = self.wf_extra.clone();
        for (index, section) in self.sections.iter().enumerate() {
            if index > 0 {
                out.push("--new".to_string());
            }
            out.extend(section.iter().cloned());
        }
        out
    }

    fn push(&mut self, issue: Issue) {
        if self.issues.len() < MAX_ISSUES && !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }
}

// ── Input ──────────────────────────────────────────────────────────────

/// Split pasted text into winws tokens. Understands double and single quotes,
/// .bat line continuations (`^`) and comment lines (`#`, `::`, `//`).
fn tokenize(text: &str) -> Result<Vec<String>, Issue> {
    let mut tokens = Vec::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with("::")
            || line.starts_with("//")
        {
            continue;
        }
        let line = line.strip_suffix('^').unwrap_or(line);
        let mut current = String::new();
        let mut in_token = false;
        let mut quote: Option<char> = None;
        for c in line.chars() {
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => current.push(c),
                None if c == '"' || c == '\'' => {
                    quote = Some(c);
                    in_token = true;
                }
                None if c.is_whitespace() => {
                    if in_token {
                        tokens.push(std::mem::take(&mut current));
                        in_token = false;
                    }
                }
                None => {
                    current.push(c);
                    in_token = true;
                }
            }
        }
        if quote.is_some() {
            return Err(Issue::error("quote", line));
        }
        if in_token {
            tokens.push(current);
        }
    }
    tokens.retain(|token| token != "^");
    Ok(tokens)
}

/// Drop a leading launcher (`winws.exe`, `start "zapret" /min "%BIN%winws.exe"`)
/// so a whole .bat line can be pasted. Anything else before the first option
/// is a mistake and is reported, not silently skipped.
fn strip_launcher(tokens: Vec<String>) -> Result<Vec<String>, Issue> {
    let first_option = tokens
        .iter()
        .position(|t| t.starts_with("--"))
        .unwrap_or(tokens.len());
    if first_option == 0 {
        return Ok(tokens);
    }
    let launcher = tokens[..first_option].iter().rposition(|t| {
        let lower = t.to_ascii_lowercase();
        lower == "winws" || lower.ends_with("winws.exe")
    });
    match launcher {
        Some(end) => Ok(tokens.into_iter().skip(end + 1).collect()),
        None => Err(Issue::error("stray", &tokens[0])),
    }
}

#[derive(Deserialize)]
struct JsonStrategy {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    desc: Option<String>,
    #[serde(default)]
    experimental: Option<bool>,
    args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum JsonInput {
    Strategy(JsonStrategy),
    Args(Vec<String>),
    // strategies.json: the first strategy is taken.
    Set(Vec<JsonStrategy>),
}

/// Text, a .bat line or JSON in the built-in strategy format → tokens.
fn parse_input(text: &str) -> Result<(Vec<String>, Option<Meta>), Issue> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let parsed: JsonInput =
            serde_json::from_str(trimmed).map_err(|e| Issue::error("json", &e.to_string()))?;
        let strategy = match parsed {
            JsonInput::Args(args) => return Ok((args, None)),
            JsonInput::Strategy(strategy) => strategy,
            JsonInput::Set(mut set) => {
                if set.is_empty() {
                    return Err(Issue::error("empty", ""));
                }
                set.swap_remove(0)
            }
        };
        let meta = Meta {
            name: strategy.name,
            desc: strategy.desc,
            experimental: strategy.experimental,
        };
        return Ok((strategy.args, Some(meta)));
    }
    let tokens = strip_launcher(tokenize(trimmed)?)?;
    Ok((tokens, None))
}

// ── Option schema ──────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Proto {
    Tcp,
    Udp,
}

#[derive(Clone, Copy)]
enum Kind {
    // No value.
    Flag,
    // No value or 0|1.
    OptBool,
    Int(i64, i64),
    // Signed int or 0xHEX.
    Signed,
    Enum(&'static [&'static str]),
    EnumList(&'static [&'static str]),
    FilterPorts(Proto),
    WfPorts(Proto),
    Desync,
    Positions,
    Position,
    Cutoff,
    // Value is optional.
    AutoTtl,
    TcpFlags,
    Domains,
    Ips,
    Payload,
    PayloadTls,
    TlsMod,
    FakedsplitMod,
    HostfakesplitMod,
    WsSize,
    HostSpell,
    // One of the app's list files, see super::allowed_list_values.
    ListFile,
}

const FOOLING: &[&str] = &[
    "none",
    "md5sig",
    "badseq",
    "badsum",
    "datanoack",
    "ts",
    "hopbyhop",
    "hopbyhop2",
];
const L3: &[&str] = &["ipv4", "ipv6"];
const L7: &[&str] = &[
    "http",
    "tls",
    "quic",
    "wireguard",
    "dht",
    "discord",
    "stun",
    "unknown",
];
const ZERO_ONE: &[&str] = &["0", "1"];
const IP_ID: &[&str] = &["zero", "seq", "seqgroup", "rnd"];
const DUP_IP_ID: &[&str] = &["same", "zero", "seq", "rnd"];
const SYNACK_SPLIT: &[&str] = &["syn", "synack", "acksyn"];
const FAKE_TCP_MOD: &[&str] = &["none", "seq"];
const TLS_MODS: &[&str] = &["none", "rnd", "rndsni", "dupsid", "padencap"];
const MARKERS: &[&str] = &[
    "method", "host", "endhost", "sld", "endsld", "midsld", "sniext",
];
const TCP_FLAGS: &[&str] = &[
    "FIN", "SYN", "RST", "PSH", "ACK", "URG", "ECE", "CWR", "AE", "R1", "R2", "R3",
];
// --dpi-desync=[<mode0>,]<mode>[,<mode2>]: at most one mode from each group, in
// this order (winws rejects anything else as "invalid desync combo").
const DESYNC_GROUPS: [&[&str]; 3] = [
    &["synack", "syndata"],
    &[
        "fake",
        "fakeknown",
        "rst",
        "rstack",
        "hopbyhop",
        "destopt",
        "ipfrag1",
    ],
    &[
        "multisplit",
        "multidisorder",
        "fakedsplit",
        "fakeddisorder",
        "hostfakesplit",
        "ipfrag2",
        "udplen",
        "tamper",
        "split",
        "split2",
        "disorder",
        "disorder2",
    ],
];

// Options that write files, read arbitrary files, replace the WinDivert filter
// or are driven by the app itself (autolist, logs). They exist in winws, so they
// get a clearer message than "unknown".
const MANAGED: &[&str] = &[
    "--debug",
    "--dry-run",
    "--version",
    "--daemon",
    "--pidfile",
    "--wf-raw",
    "--wf-raw-part",
    "--wf-save",
    "--wf-iface",
    "--wf-filter-lan",
    "--hostlist-auto",
    "--hostlist-auto-fail-threshold",
    "--hostlist-auto-fail-time",
    "--hostlist-auto-retrans-threshold",
    "--hostlist-auto-debug",
    "--ssid-filter",
    "--nlm-filter",
    "--nlm-list",
    "--ctrack-timeouts",
    "--ctrack-disable",
    "--ipcache-lifetime",
    "--ipcache-hostname",
];

fn kind_of(flag: &str) -> Option<Kind> {
    use Kind::*;
    Some(match flag {
        "--new" | "--hostcase" | "--hostnospace" | "--domcase" | "--methodeol" => Flag,
        "--dup-replace" => OptBool,
        "--filter-l3" | "--wf-l3" => EnumList(L3),
        "--filter-l7" => EnumList(L7),
        "--filter-tcp" => FilterPorts(Proto::Tcp),
        "--filter-udp" => FilterPorts(Proto::Udp),
        "--wf-tcp" => WfPorts(Proto::Tcp),
        "--wf-udp" => WfPorts(Proto::Udp),
        "--hostlist" | "--hostlist-exclude" | "--ipset" | "--ipset-exclude" => ListFile,
        "--hostlist-domains" | "--hostlist-exclude-domains" => Domains,
        "--ipset-ip" | "--ipset-exclude-ip" => Ips,
        "--dpi-desync" => Desync,
        "--dpi-desync-ttl" | "--dpi-desync-ttl6" | "--orig-ttl" | "--orig-ttl6" | "--dup-ttl"
        | "--dup-ttl6" => Int(1, 255),
        "--dpi-desync-autottl"
        | "--dpi-desync-autottl6"
        | "--orig-autottl"
        | "--orig-autottl6"
        | "--dup-autottl"
        | "--dup-autottl6" => AutoTtl,
        "--dpi-desync-tcp-flags-set"
        | "--dpi-desync-tcp-flags-unset"
        | "--orig-tcp-flags-set"
        | "--orig-tcp-flags-unset"
        | "--dup-tcp-flags-set"
        | "--dup-tcp-flags-unset" => TcpFlags,
        "--dpi-desync-fooling" | "--dup-fooling" => EnumList(FOOLING),
        "--dpi-desync-repeats" => Int(1, 1024),
        "--dup" => Int(0, 1024),
        "--dpi-desync-skip-nosni" | "--dpi-desync-any-protocol" | "--wssize-forced-cutoff" => {
            Enum(ZERO_ONE)
        }
        "--dpi-desync-split-pos" => Positions,
        "--dpi-desync-split-seqovl" | "--dpi-desync-hostfakesplit-midhost" => Position,
        "--dpi-desync-split-seqovl-pattern"
        | "--dpi-desync-fakedsplit-pattern"
        | "--dpi-desync-fake-http"
        | "--dpi-desync-fake-unknown"
        | "--dpi-desync-fake-syndata"
        | "--dpi-desync-fake-quic"
        | "--dpi-desync-fake-wireguard"
        | "--dpi-desync-fake-dht"
        | "--dpi-desync-fake-discord"
        | "--dpi-desync-fake-stun"
        | "--dpi-desync-fake-unknown-udp"
        | "--dpi-desync-udplen-pattern" => Payload,
        "--dpi-desync-fake-tls" => PayloadTls,
        "--dpi-desync-fake-tls-mod" => TlsMod,
        "--dpi-desync-fakedsplit-mod" => FakedsplitMod,
        "--dpi-desync-hostfakesplit-mod" => HostfakesplitMod,
        "--dpi-desync-ipfrag-pos-udp" | "--dpi-desync-ipfrag-pos-tcp" => Int(8, 65528),
        "--dpi-desync-ts-increment"
        | "--dpi-desync-badseq-increment"
        | "--dpi-desync-badack-increment"
        | "--dup-ts-increment"
        | "--dup-badseq-increment"
        | "--dup-badack-increment" => Signed,
        "--dpi-desync-fake-tcp-mod" => EnumList(FAKE_TCP_MOD),
        "--dpi-desync-udplen-increment" => Int(-32768, 32767),
        "--dpi-desync-start"
        | "--dpi-desync-cutoff"
        | "--orig-mod-start"
        | "--orig-mod-cutoff"
        | "--dup-start"
        | "--dup-cutoff"
        | "--wssize-cutoff" => Cutoff,
        "--dup-ip-id" => Enum(DUP_IP_ID),
        "--ip-id" => Enum(IP_ID),
        "--hostspell" => HostSpell,
        "--wssize" => WsSize,
        "--synack-split" => Enum(SYNACK_SPLIT),
        _ => return None,
    })
}

fn takes_value(kind: Kind) -> bool {
    !matches!(kind, Kind::Flag | Kind::OptBool | Kind::AutoTtl)
}

// ── Value validators ───────────────────────────────────────────────────

fn digits(raw: &str, max_len: usize) -> bool {
    (1..=max_len).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_digit())
}

fn int_in(raw: &str, low: i64, high: i64) -> bool {
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);
    digits(unsigned, 10) && raw.parse::<i64>().is_ok_and(|n| (low..=high).contains(&n))
}

fn hex_digits(raw: &str, max_len: usize) -> bool {
    (1..=max_len).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_hexdigit())
}

fn signed_or_hex(raw: &str) -> bool {
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);
    match unsigned
        .strip_prefix("0x")
        .or_else(|| unsigned.strip_prefix("0X"))
    {
        Some(hex) => hex_digits(hex, 8),
        None => int_in(raw, i64::from(i32::MIN), i64::from(i32::MAX)),
    }
}

fn enum_list(raw: &str, allowed: &[&str]) -> bool {
    !raw.is_empty() && raw.split(',').all(|item| allowed.contains(&item))
}

fn port_list(raw: &str, proto: Proto, star: bool) -> bool {
    let items: Vec<&str> = raw.split(',').collect();
    items.len() <= 64
        && items.iter().all(|item| {
            match (proto, *item) {
                (_, "%GameFilter%")
                | (Proto::Tcp, "%GameFilterTCP%")
                | (Proto::Udp, "%GameFilterUDP%") => return true,
                (_, "*") => return star,
                _ => {}
            }
            let item = item.strip_prefix('~').unwrap_or(item);
            let (start, end) = item.split_once('-').unwrap_or((item, item));
            let port = |p: &str| -> Option<u32> {
                if digits(p, 5) {
                    p.parse().ok()
                } else {
                    None
                }
            };
            match (port(start), port(end)) {
                (Some(start), Some(end)) => (1..=end).contains(&start) && end <= 65535,
                _ => false,
            }
        })
}

fn desync_modes(raw: &str) -> Result<(), &'static str> {
    let modes: Vec<&str> = raw.split(',').collect();
    if modes.is_empty() || modes.len() > 3 {
        return Err("value");
    }
    let mut next_group = 0;
    for mode in modes {
        let group = DESYNC_GROUPS
            .iter()
            .position(|group| group.contains(&mode))
            .ok_or("value")?;
        if group < next_group {
            return Err("combo");
        }
        next_group = group + 1;
    }
    Ok(())
}

fn position(raw: &str) -> bool {
    if let Some(n) = raw.strip_prefix('-') {
        return digits(n, 5);
    }
    if digits(raw, 5) {
        return true;
    }
    let (marker, offset) = match raw.find(['+', '-']) {
        Some(at) => (&raw[..at], Some(&raw[at + 1..])),
        None => (raw, None),
    };
    MARKERS.contains(&marker) && offset.is_none_or(|n| digits(n, 5))
}

fn cutoff(raw: &str) -> bool {
    let n = raw.strip_prefix(['n', 'd', 's']).unwrap_or(raw);
    digits(n, 10) && n.parse::<u64>().is_ok_and(|v| v <= u64::from(u32::MAX))
}

fn auto_ttl(raw: &str) -> bool {
    if raw.is_empty() || raw == "-" {
        return true;
    }
    let ttl = |n: &str| digits(n, 3) && n.parse::<u16>().is_ok_and(|v| v <= 255);
    let (delta, range) = match raw.split_once(':') {
        Some((delta, range)) => (delta, Some(range)),
        None => (raw, None),
    };
    let delta = delta.strip_prefix(['+', '-']).unwrap_or(delta);
    digits(delta, 3)
        && range.is_none_or(|range| match range.split_once('-') {
            Some((low, high)) => ttl(low) && ttl(high),
            None => ttl(range),
        })
}

fn tcp_flags(raw: &str) -> bool {
    if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        return hex_digits(hex, 3);
    }
    if digits(raw, 4) {
        return raw.parse::<u16>().is_ok_and(|v| v <= 0xFFF);
    }
    !raw.is_empty()
        && raw.split(',').all(|flag| {
            TCP_FLAGS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(flag))
        })
}

// Hostname label rules plus a punycode top-level domain (xn--p1ai), which the
// channel validator doesn't need but Russian users do.
fn domain(raw: &str) -> bool {
    let labels: Vec<&str> = raw.split('.').collect();
    let Some((tld, rest)) = labels.split_last() else {
        return false;
    };
    let label_ok = |label: &str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let tld_ok = ((2..=63).contains(&tld.len()) && tld.bytes().all(|b| b.is_ascii_alphabetic()))
        || (tld.to_ascii_lowercase().starts_with("xn--") && label_ok(tld));
    raw.len() <= 253 && !rest.is_empty() && tld_ok && rest.iter().all(|label| label_ok(label))
}

fn domains(raw: &str) -> Option<String> {
    let items: Vec<&str> = raw.split(',').collect();
    (items.len() <= MAX_LIST_ITEMS && items.iter().all(|item| domain(item)))
        .then(|| raw.to_ascii_lowercase())
}

fn ip_entry(raw: &str) -> bool {
    let (addr, prefix) = match raw.split_once('/') {
        Some((addr, prefix)) => (addr, Some(prefix)),
        None => (raw, None),
    };
    let Ok(addr) = addr.parse::<std::net::IpAddr>() else {
        return false;
    };
    let max = if addr.is_ipv4() { 32 } else { 128 };
    prefix.is_none_or(|p| digits(p, 3) && p.parse::<u32>().is_ok_and(|v| v <= max))
}

fn ips(raw: &str) -> bool {
    let items: Vec<&str> = raw.split(',').collect();
    items.len() <= MAX_LIST_ITEMS && items.iter().all(|item| ip_entry(item))
}

fn mods(raw: &str, item_ok: impl Fn(&str) -> bool) -> bool {
    !raw.is_empty() && raw.split(',').all(item_ok)
}

/// Fake payload: `0xHEX`, a bin-data file (`@name.bin`, `%BIN%name.bin`,
/// `name.bin`, `+ofs@name.bin`) or, for TLS, `!`/`!+ofs`. Files are rewritten
/// to `%BIN%` so they resolve only inside our bin-data directory.
fn payload(raw: &str, tls: bool, bins: &mut Vec<String>) -> Result<String, &'static str> {
    if tls && (raw == "!" || raw.strip_prefix("!+").is_some_and(|n| digits(n, 5))) {
        return Ok(raw.to_string());
    }
    if let Some(hex) = raw.strip_prefix("0x") {
        return if hex_digits(hex, 4096) && hex.len() % 2 == 0 {
            Ok(raw.to_string())
        } else {
            Err("value")
        };
    }
    let (offset, rest) = match raw.strip_prefix('+') {
        Some(rest) => {
            let (n, file) = rest.split_once('@').ok_or("value")?;
            if !digits(n, 5) {
                return Err("value");
            }
            (Some(n), file)
        }
        None => (None, raw.strip_prefix('@').unwrap_or(raw)),
    };
    let name = rest.strip_prefix("%BIN%").unwrap_or(rest);
    if name.contains(['/', '\\', ':']) || name.contains('%') {
        return Err("path");
    }
    if !super::valid_bin_filename(name) || name.contains("..") {
        return Err("value");
    }
    if !bins.iter().any(|known| known == name) {
        bins.push(name.to_string());
    }
    Ok(match offset {
        Some(n) => format!("+{n}@%BIN%{name}"),
        None => format!("%BIN%{name}"),
    })
}

fn list_file(flag: &str, raw: &str) -> Result<String, &'static str> {
    let allowed = super::allowed_list_values(flag).ok_or("list")?;
    let name = raw
        .strip_prefix("%LISTS%")
        .or_else(|| raw.strip_prefix("lists\\"))
        .or_else(|| raw.strip_prefix("lists/"))
        .unwrap_or(raw);
    allowed
        .iter()
        .find(|entry| {
            entry
                .strip_prefix("%LISTS%")
                .is_some_and(|known| known.eq_ignore_ascii_case(name))
        })
        .map(|entry| entry.to_string())
        .ok_or("list")
}

/// Check one option and return it in canonical `--flag[=value]` form.
fn canonical_arg(
    flag: &str,
    value: Option<&str>,
    bins: &mut Vec<String>,
) -> Result<String, &'static str> {
    if MANAGED.contains(&flag) || flag.starts_with("--hostlist-auto") {
        return Err("managed");
    }
    let kind = kind_of(flag).ok_or("unknown")?;
    let Some(value) = value else {
        return if takes_value(kind) {
            Err("noValue")
        } else {
            Ok(flag.to_string())
        };
    };
    if value.len() > super::MAX_STRATEGY_ARG_LEN || value.contains(['\0', '\r', '\n']) {
        return Err("value");
    }
    let ok = |valid: bool| {
        if valid {
            Ok(format!("{flag}={value}"))
        } else {
            Err("value")
        }
    };
    match kind {
        Kind::Flag => Err("value"),
        Kind::OptBool => ok(ZERO_ONE.contains(&value)),
        Kind::Int(low, high) => ok(int_in(value, low, high)),
        Kind::Signed => ok(signed_or_hex(value)),
        Kind::Enum(allowed) => ok(allowed.contains(&value)),
        Kind::EnumList(allowed) => ok(enum_list(value, allowed)),
        Kind::FilterPorts(proto) => ok(port_list(value, proto, true)),
        Kind::WfPorts(proto) => ok(port_list(value, proto, false)),
        Kind::Desync => desync_modes(value).map(|()| format!("{flag}={value}")),
        Kind::Positions => {
            let items: Vec<&str> = value.split(',').collect();
            ok(items.len() <= 16 && items.iter().all(|item| position(item)))
        }
        Kind::Position => ok(position(value)),
        Kind::Cutoff => ok(cutoff(value)),
        Kind::AutoTtl => ok(auto_ttl(value)),
        Kind::TcpFlags => ok(tcp_flags(value)),
        Kind::Domains => domains(value).map(|v| format!("{flag}={v}")).ok_or("value"),
        Kind::Ips => ok(ips(value)),
        Kind::Payload => payload(value, false, bins).map(|v| format!("{flag}={v}")),
        Kind::PayloadTls => payload(value, true, bins).map(|v| format!("{flag}={v}")),
        Kind::TlsMod => ok(mods(value, |m| {
            TLS_MODS.contains(&m) || m.strip_prefix("sni=").is_some_and(domain)
        })),
        Kind::FakedsplitMod => ok(mods(value, |m| {
            m == "none" || m.strip_prefix("altorder=").is_some_and(|n| digits(n, 2))
        })),
        Kind::HostfakesplitMod => ok(mods(value, |m| {
            m == "none"
                || m == "altorder=0"
                || m == "altorder=1"
                || m.strip_prefix("host=").is_some_and(domain)
        })),
        Kind::WsSize => ok(match value.split_once(':') {
            Some((size, scale)) => digits(size, 5) && digits(scale, 2),
            None => digits(value, 5),
        }),
        Kind::HostSpell => ok(value.len() == 4 && value.bytes().all(|b| b.is_ascii_alphabetic())),
        Kind::ListFile => list_file(flag, value).map(|v| format!("{flag}={v}")),
    }
}

fn valid_flag_name(flag: &str) -> bool {
    flag.len() > 2
        && flag.len() <= 64
        && flag[2..]
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Tokens → canonical options. Accepts both `--flag=value` and `--flag value`.
/// Issues carry the index of the section (counted by `--new`) they occur in.
fn parse_options(tokens: &[String], report: &mut Report) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len());
    let mut section = 0usize;
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        i += 1;
        if !token.starts_with("--") {
            report.push(Issue::error("stray", token).at(section));
            continue;
        }
        let (flag, mut value) = match token.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (token.as_str(), None),
        };
        if !valid_flag_name(flag) {
            report.push(Issue::error("unknown", token).at(section));
            continue;
        }
        let wants_value = value.is_none() && kind_of(flag).is_some_and(takes_value);
        if wants_value && i < tokens.len() && !tokens[i].starts_with("--") {
            value = Some(tokens[i].clone());
            i += 1;
        }
        let shown = match &value {
            Some(v) => format!("{flag}={v}"),
            None => flag.to_string(),
        };
        match canonical_arg(flag, value.as_deref(), &mut report.bins) {
            Ok(arg) => {
                if arg == "--new" {
                    section += 1;
                }
                out.push(arg);
            }
            Err(code) => report.push(Issue::error(code, &shown).at(section)),
        }
    }
    out
}

// ── Assembly ───────────────────────────────────────────────────────────

fn flag_of(arg: &str) -> &str {
    arg.split('=').next().unwrap_or(arg)
}

fn value_of<'a>(arg: &'a str, flag: &str) -> Option<&'a str> {
    arg.strip_prefix(flag)?.strip_prefix('=')
}

fn push_ports(into: &mut Vec<String>, value: &str) {
    for item in value.split(',') {
        if !item.is_empty() && !into.iter().any(|known| known == item) {
            into.push(item.to_string());
        }
    }
}

/// Union of one protocol's section filters. Err(section) when a section uses
/// `*` or a negation: the interception set can't be inferred from it.
fn derive_wf(sections: &[Vec<String>], flag: &str) -> Result<Vec<String>, usize> {
    let mut ports = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        for arg in section {
            let Some(value) = value_of(arg, flag) else {
                continue;
            };
            if value
                .split(',')
                .any(|item| item == "*" || item.starts_with('~'))
            {
                return Err(index);
            }
            push_ports(&mut ports, value);
        }
    }
    Ok(ports)
}

/// Check a custom strategy and build its final winws arguments (before
/// placeholder substitution). `bin_exists` tells whether a payload file is
/// present in the active bin-data; launch-time callers that check files later
/// pass `|_| true`.
pub(super) fn check_tokens(tokens: &[String], bin_exists: &dyn Fn(&str) -> bool) -> Report {
    let mut report = Report::default();
    if tokens.is_empty() {
        report.push(Issue::error("empty", ""));
        return report;
    }
    let options = parse_options(tokens, &mut report);
    for name in report.bins.clone() {
        if !bin_exists(&name) {
            report.push(Issue::error("binMissing", &name));
        }
    }

    // Explicit interception is kept (a section with `*` needs it), the rest is
    // derived from the filters below.
    let mut explicit_tcp = Vec::new();
    let mut explicit_udp = Vec::new();
    let mut sections: Vec<Vec<String>> = vec![Vec::new()];
    for arg in options {
        if let Some(value) = value_of(&arg, "--wf-tcp") {
            push_ports(&mut explicit_tcp, value);
        } else if let Some(value) = value_of(&arg, "--wf-udp") {
            push_ports(&mut explicit_udp, value);
        } else if arg == "--new" {
            sections.push(Vec::new());
        } else if let Some(current) = sections.last_mut() {
            current.push(arg);
        }
    }
    let last = sections.len() - 1;
    for (index, section) in sections.iter().enumerate() {
        if section.is_empty() {
            report.push(Issue::error("emptySection", "").at(index));
            continue;
        }
        let has = |flags: &[&str]| section.iter().any(|arg| flags.contains(&flag_of(arg)));
        // A section without an l4 filter takes every intercepted packet, so the
        // sections below it never see traffic.
        if index < last && !has(&["--filter-tcp", "--filter-udp"]) {
            report.push(Issue::warn("noFilter").at(index));
        }
        if !has(&["--dpi-desync"]) {
            report.push(Issue::warn("noDesync").at(index));
        }
    }
    let derived_tcp = derive_wf(&sections, "--filter-tcp");
    let derived_udp = derive_wf(&sections, "--filter-udp");
    let mut interception: Vec<(&str, Vec<String>)> = Vec::with_capacity(2);
    for (flag, explicit, derived) in [
        ("--wf-tcp", &explicit_tcp, &derived_tcp),
        ("--wf-udp", &explicit_udp, &derived_udp),
    ] {
        let derived_ports: &[String] = match derived {
            Ok(ports) => ports,
            Err(index) => {
                if explicit.is_empty() {
                    report.push(Issue::error("wfNeeded", "").at(*index));
                }
                &[]
            }
        };
        let extra: Vec<String> = explicit
            .iter()
            .filter(|port| !derived_ports.contains(port))
            .cloned()
            .collect();
        if !extra.is_empty() {
            report.wf_extra.push(format!("{flag}={}", extra.join(",")));
        }
        let mut ports = explicit.clone();
        for port in derived_ports {
            push_ports(&mut ports, port);
        }
        interception.push((flag, ports));
    }
    if interception.iter().all(|(_, ports)| ports.is_empty()) {
        report.push(Issue::error("wfNeeded", ""));
    }
    if report.first_error().is_some() {
        return report;
    }

    let mut args = Vec::with_capacity(tokens.len() + 2);
    for (flag, ports) in &interception {
        if !ports.is_empty() {
            args.push(format!("{flag}={}", ports.join(",")));
        }
    }
    for (index, section) in sections.iter().enumerate() {
        if index > 0 {
            args.push("--new".to_string());
        }
        args.extend(section.iter().cloned());
    }
    if args.len() > super::MAX_STRATEGY_ARGS {
        report.push(Issue::error("tooLong", ""));
        return report;
    }
    report.ok = true;
    report.sections = sections;
    report.args = args;
    report
}

/// Check text typed or imported in the editor.
pub(super) fn check_text(text: &str, bin_exists: &dyn Fn(&str) -> bool) -> Report {
    if text.len() > MAX_CUSTOM_TEXT_BYTES {
        let mut report = Report::default();
        report.push(Issue::error("tooLong", ""));
        return report;
    }
    match parse_input(text) {
        Ok((tokens, meta)) => {
            let mut report = check_tokens(&tokens, bin_exists);
            report.meta = meta;
            report
        }
        Err(issue) => {
            let mut report = Report::default();
            report.push(issue);
            report
        }
    }
}

// ── Names, ids and storage ─────────────────────────────────────────────

pub(super) fn is_custom_id(id: &str) -> bool {
    id.strip_prefix(CUSTOM_ID_PREFIX)
        .is_some_and(|rest| hex_digits(rest, 16))
}

/// Trim, collapse whitespace and drop control characters.
pub(super) fn normalize_name(raw: &str) -> Result<String, &'static str> {
    let name = collapse(raw);
    if name.is_empty() {
        Err("nameEmpty")
    } else if name.chars().count() > MAX_CUSTOM_NAME_CHARS {
        Err("nameLong")
    } else {
        Ok(name)
    }
}

pub(super) fn normalize_desc(raw: &str) -> Result<String, &'static str> {
    let desc = collapse(raw);
    if desc.chars().count() > MAX_CUSTOM_DESC_CHARS {
        Err("descLong")
    } else {
        Ok(desc)
    }
}

fn collapse(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn new_id(existing: &[CustomStrategy]) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    // Truncation is intended: only the low bits seed the id.
    let mut seed = (nanos as u64) ^ u64::from(std::process::id()).rotate_left(32);
    loop {
        let id = format!("{CUSTOM_ID_PREFIX}{:08x}", seed as u32);
        if !existing.iter().any(|item| item.id == id) {
            return id;
        }
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
    }
}

fn store_path(dpi_data: &Path) -> PathBuf {
    dpi_data.join(CUSTOM_STORE_FILE)
}

/// Keep only well-formed entries: the file is user-writable, and a manual
/// edit must neither crash listing nor smuggle in more than the limit. The
/// arguments themselves are checked on every use, not here.
fn sanitize_store(store: CustomStore) -> CustomStore {
    let mut items: Vec<CustomStrategy> = Vec::new();
    for item in store.items {
        if items.len() >= MAX_CUSTOM_STRATEGIES {
            break;
        }
        let (Ok(name), Ok(desc)) = (normalize_name(&item.name), normalize_desc(&item.desc)) else {
            continue;
        };
        if !is_custom_id(&item.id)
            || item.args.len() > super::MAX_STRATEGY_ARGS
            || item
                .args
                .iter()
                .any(|arg| arg.len() > super::MAX_STRATEGY_ARG_LEN)
            || items.iter().any(|known| known.id == item.id)
        {
            continue;
        }
        items.push(CustomStrategy { name, desc, ..item });
    }
    CustomStore { items }
}

/// Read the store. A corrupt file is moved aside (not overwritten by the next
/// save) and an empty store is returned, so the bypass keeps working.
pub(super) fn load_store(dpi_data: &Path) -> CustomStore {
    let path = store_path(dpi_data);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return CustomStore::default(),
    };
    match serde_json::from_str::<CustomStore>(&raw) {
        Ok(store) => sanitize_store(store),
        Err(error) => {
            eprintln!("DPI custom strategies unreadable, moved aside: {error}");
            let _ = std::fs::rename(&path, path.with_extension("json.bad"));
            CustomStore::default()
        }
    }
}

pub(super) fn save_store(dpi_data: &Path, items: &[CustomStrategy]) -> Result<(), String> {
    #[derive(Serialize)]
    struct Stored<'a> {
        version: u32,
        items: &'a [CustomStrategy],
    }
    std::fs::create_dir_all(dpi_data).map_err(|e| format!("mkdir dpi data: {e}"))?;
    let raw = serde_json::to_string_pretty(&Stored {
        version: CUSTOM_STORE_VERSION,
        items,
    })
    .map_err(|e| format!("serialize custom strategies: {e}"))?;
    crate::atomic_file::write_replace(
        &store_path(dpi_data),
        &format!("{raw}\n"),
        "custom strategies",
    )
}

/// One custom strategy as the UI lists it: the built-in shape plus `custom`.
#[derive(Serialize)]
pub(super) struct ListItem<'a> {
    pub(super) id: &'a str,
    pub(super) name: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub(super) desc: &'a str,
    pub(super) experimental: bool,
    pub(super) custom: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) base: Option<&'a str>,
    pub(super) args: &'a [String],
    // First blocking problem, if the strategy can't start as stored (for
    // example, a payload file left the channel set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) problem: Option<&'static str>,
}

pub(super) fn list_item(item: &CustomStrategy) -> ListItem<'_> {
    let report = check_tokens(&item.args, &|_| true);
    ListItem {
        id: &item.id,
        name: &item.name,
        desc: &item.desc,
        experimental: item.experimental,
        custom: true,
        base: item.base.as_deref(),
        args: &item.args,
        problem: report.first_error().map(|issue| issue.code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_bins(_: &str) -> bool {
        true
    }

    fn check(text: &str) -> Report {
        check_text(text, &all_bins)
    }

    // The strategy Dima tested: ALT11 with only the game TCP section replaced.
    const ALT11_GAME: &str = include_str!("custom_alt11_game.json");

    #[test]
    fn imported_json_strategy_keeps_every_section() {
        let report = check(ALT11_GAME);
        assert!(report.ok, "{:?}", report.issues);
        let meta = report.meta.as_ref().unwrap();
        assert_eq!(meta.name.as_deref(), Some("ALT11 + GAME TLS FAKE"));
        assert_eq!(meta.experimental, Some(true));
        assert_eq!(report.sections.len(), 9);
        // The interception assembled from the filters equals the one ALT11 spells out.
        assert_eq!(
            report.args[0],
            "--wf-tcp=80,443,2053,2083,2087,2096,8443,%GameFilterTCP%"
        );
        assert_eq!(
            report.args[1],
            "--wf-udp=443,19294-19344,50000-50100,%GameFilterUDP%"
        );
        let original: serde_json::Value = serde_json::from_str(ALT11_GAME).unwrap();
        let original: Vec<String> = original["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(report.args, original);
        assert!(report.issues.is_empty(), "{:?}", report.issues);
        // ALT11's interception is fully implied by its filters: nothing extra is stored.
        assert!(report.wf_extra.is_empty());
        assert_eq!(report.stored_args(), original[2..].to_vec());
    }

    #[test]
    fn interception_is_assembled_from_section_filters() {
        let report = check(
            "--filter-tcp=443 --dpi-desync=fake\n--new\n--filter-udp=50000-50100 --dpi-desync=fake",
        );
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.args[0], "--wf-tcp=443");
        assert_eq!(report.args[1], "--wf-udp=50000-50100");
        // A custom section on a new port is added to an explicit interception list.
        let report = check("--wf-tcp=80 --filter-tcp=443,5222 --dpi-desync=fake");
        assert_eq!(report.args[0], "--wf-tcp=80,443,5222");
        assert_eq!(report.wf_extra, vec!["--wf-tcp=80"]);
        assert_eq!(report.stored_args()[0], "--wf-tcp=80");
    }

    #[test]
    fn user_example_section_with_filter() {
        let report = check(
            "--filter-tcp=%GameFilterTCP% --dpi-desync=fake --dpi-desync-any-protocol=1 --dpi-desync-fooling=ts --dpi-desync-repeats=6 --dpi-desync-cutoff=d2 --dpi-desync-fake-unknown=@tls_clienthello_max_ru.bin",
        );
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.args[0], "--wf-tcp=%GameFilterTCP%");
        assert!(report
            .args
            .contains(&"--dpi-desync-fake-unknown=%BIN%tls_clienthello_max_ru.bin".to_string()));
        assert_eq!(report.bins, vec!["tls_clienthello_max_ru.bin"]);
    }

    #[test]
    fn filterless_section_needs_interception_and_warns_when_not_last() {
        let report = check("--dpi-desync=fake --dpi-desync-fooling=ts");
        assert_eq!(report.first_error().map(|i| i.code), Some("wfNeeded"));
        let report = check("--dpi-desync=fake\n--new\n--filter-tcp=443 --dpi-desync=fake");
        assert!(report.ok, "{:?}", report.issues);
        assert!(report
            .issues
            .iter()
            .any(|i| i.code == "noFilter" && i.section == Some(0)));
    }

    #[test]
    fn issues_point_at_their_section() {
        let report =
            check("--filter-tcp=443 --dpi-desync=fake\n--new\n--filter-tcp=80 --dpi-desync=bogus");
        let issue = report.first_error().unwrap();
        assert_eq!((issue.code, issue.section), ("value", Some(1)));
        let report = check(
            "--filter-tcp=443 --dpi-desync=fake --new --new --filter-tcp=80 --dpi-desync=fake",
        );
        let issue = report.first_error().unwrap();
        assert_eq!((issue.code, issue.section), ("emptySection", Some(1)));
    }

    #[test]
    fn flowseal_bat_line_is_accepted() {
        let text = "start \"zapret: %~n0\" /min \"%BIN%winws.exe\" --wf-tcp=80,443 ^\n\
            --filter-tcp=443 --hostlist=\"%LISTS%list-general.txt\" --dpi-desync=fake,multisplit ^\n\
            --dpi-desync-split-pos=1,midsld --dpi-desync-fake-tls=\"%BIN%tls_clienthello_www_google_com.bin\" --new ^\n\
            --filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6";
        let report = check(text);
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.sections.len(), 2);
        assert_eq!(report.args[0], "--wf-tcp=80,443");
        assert_eq!(report.args[1], "--wf-udp=443");
    }

    #[test]
    fn json_args_array_and_strategy_set_are_accepted() {
        let report = check(r#"["--filter-udp=443", "--dpi-desync=fake"]"#);
        assert!(report.ok, "{:?}", report.issues);
        assert!(report.meta.is_none());
        let report = check(r#"[{"name": "A", "args": ["--filter-tcp=443", "--dpi-desync=fake"]}]"#);
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.meta.unwrap().name.as_deref(), Some("A"));
        let report = check(r#"{"name": "broken""#);
        assert_eq!(report.first_error().map(|i| i.code), Some("json"));
    }

    #[test]
    fn dangerous_and_unknown_options_are_rejected() {
        for (text, code) in [
            ("--filter-tcp=443 --debug=@C:\\Windows\\x.txt", "managed"),
            ("--filter-tcp=443 --wf-raw=@C:\\x", "managed"),
            ("--filter-tcp=443 --hostlist-auto=C:\\x.txt", "managed"),
            ("--filter-tcp=443 --pidfile=C:\\x", "managed"),
            ("--filter-tcp=443 --frobnicate=1", "unknown"),
            ("@C:\\config.txt", "stray"),
            ("--filter-tcp=443 --hostlist=C:\\Windows\\win.ini", "list"),
            (
                "--filter-tcp=443 --dpi-desync-fake-tls=C:\\Windows\\x.bin",
                "path",
            ),
            (
                "--filter-tcp=443 --dpi-desync-fake-tls=@..\\..\\x.bin",
                "path",
            ),
            (
                "--filter-tcp=443 --dpi-desync-fake-tls=@%LISTS%x.bin",
                "path",
            ),
            (
                "--filter-tcp=443 --dpi-desync=fake,multisplit,fake",
                "combo",
            ),
            ("--filter-tcp=443 --dpi-desync=multisplit,fake", "combo"),
            ("--filter-tcp=443 --dpi-desync=nonsense", "value"),
            ("--filter-tcp=443 --dpi-desync-repeats=0", "value"),
            ("--filter-tcp=443 --dpi-desync-cutoff=x2", "value"),
            ("--filter-tcp=443 --dpi-desync-ttl", "noValue"),
            ("--filter-tcp=443 --dpi-desync=\"fake", "quote"),
        ] {
            let report = check(text);
            assert!(!report.ok, "{text} must be rejected");
            assert_eq!(
                report.first_error().map(|i| i.code),
                Some(code),
                "{text}: {:?}",
                report.issues
            );
            assert!(report.args.is_empty());
        }
    }

    #[test]
    fn unknown_protocol_filter_is_allowed() {
        let report = check(
            "--filter-tcp=%GameFilterTCP% --filter-l7=unknown --dpi-desync=fake --dpi-desync-any-protocol=1",
        );
        assert!(report.ok, "{:?}", report.issues);
    }

    #[test]
    fn missing_payload_is_reported() {
        let report = check_text(
            "--filter-tcp=443 --dpi-desync=fake --dpi-desync-fake-tls=@nope.bin",
            &|_| false,
        );
        assert_eq!(report.first_error().map(|i| i.code), Some("binMissing"));
    }

    #[test]
    fn payload_forms_are_canonical() {
        let mut bins = Vec::new();
        assert_eq!(
            payload("+12@stun.bin", false, &mut bins),
            Ok("+12@%BIN%stun.bin".to_string())
        );
        assert_eq!(
            payload("0x0a0b", false, &mut bins),
            Ok("0x0a0b".to_string())
        );
        assert_eq!(payload("0x0a0", false, &mut bins), Err("value"));
        assert_eq!(payload("!+2", true, &mut bins), Ok("!+2".to_string()));
        assert_eq!(payload("!", false, &mut bins), Err("value"));
        assert_eq!(bins, vec!["stun.bin"]);
    }

    #[test]
    fn domains_and_ips_validate() {
        assert!(domain("xn--80aswg.xn--p1ai"));
        assert!(domain("max.ru"));
        assert!(!domain("localhost"));
        assert!(!domain("-bad.ru"));
        assert!(ips("1.2.3.0/24,2001:db8::/32"));
        assert!(!ips("1.2.3.0/33"));
        assert!(!ips("1.2.3"));
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(
            normalize_name("  Мой   обход \n"),
            Ok("Мой обход".to_string())
        );
        assert_eq!(normalize_name("   "), Err("nameEmpty"));
        assert_eq!(normalize_name(&"я".repeat(41)), Err("nameLong"));
        assert_eq!(normalize_desc(&"d".repeat(301)), Err("descLong"));
        let id = new_id(&[]);
        assert!(is_custom_id(&id), "{id}");
        assert!(!is_custom_id("alt11"));
        assert!(!is_custom_id("custom-../x"));
    }

    #[test]
    fn store_is_sanitized_and_capped() {
        let item = |id: &str| CustomStrategy {
            id: id.to_string(),
            name: "n".to_string(),
            desc: String::new(),
            experimental: false,
            base: None,
            args: vec![
                "--filter-tcp=443".to_string(),
                "--dpi-desync=fake".to_string(),
            ],
        };
        let store = sanitize_store(CustomStore {
            items: vec![
                item("custom-1"),
                item("custom-1"),
                item("bad-id"),
                item("custom-2"),
                item("custom-3"),
                item("custom-4"),
            ],
        });
        let ids: Vec<&str> = store.items.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["custom-1", "custom-2", "custom-3"]);
    }
}

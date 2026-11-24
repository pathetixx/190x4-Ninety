// Ninety · user-defined DPI strategies.
//
// A custom strategy is winws arguments typed by the user. winws runs with
// administrator rights while this text lives in a directory a regular user can
// write, so it gets the same treatment as channel data: it is never trusted on
// read. Every launch re-parses the stored text and passes it through an
// allowlist that is wider than the channel one (users paste zapret options the
// curated set doesn't use), but still lets no file path, config file or process
// option through: payloads resolve only inside our bin-data directory, lists
// only to the app's own list names.
//
// Two shapes of input are accepted:
//   - a snippet: desync options without filters, the way zapret strategies are
//     usually shared (`--dpi-desync=fake --dpi-desync-fooling=ts …`). It is
//     wrapped into a TCP 80/443 section for the chosen target;
//   - sections: a full zapret line with `--filter-*`, `--new` and optionally
//     `--wf-*` (a Flowseal .bat line is accepted as is).
// An optional built-in base strategy is appended after the custom part: the
// user's sections win the first match, everything else keeps working as in
// the base.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub(super) const CUSTOM_ID_PREFIX: &str = "custom-";
pub(super) const MAX_CUSTOM_STRATEGIES: usize = 3;
pub(super) const MAX_CUSTOM_TEXT_BYTES: usize = 16 * 1024;
pub(super) const MAX_CUSTOM_NAME_CHARS: usize = 40;
const CUSTOM_STORE_FILE: &str = "custom-strategies.json";
const CUSTOM_STORE_VERSION: u32 = 1;
// Reported issues are capped: one typo must not flood the editor.
const MAX_ISSUES: usize = 8;
const MAX_LIST_ITEMS: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Target {
    // Domains from the built-in lists and "My domains".
    #[default]
    Lists,
    // Every TCP 80/443 connection, including apps without a hostname.
    All,
}

impl Target {
    pub(super) fn parse(raw: &str) -> Self {
        match raw {
            "all" => Self::All,
            _ => Self::Lists,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Lists => "lists",
            Self::All => "all",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct CustomStrategy {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) base: Option<String>,
    // Kept as a string: an unknown value from a newer build degrades to the
    // default target instead of failing the whole store.
    #[serde(default)]
    pub(super) target: String,
    pub(super) text: String,
}

impl CustomStrategy {
    pub(super) fn target(&self) -> Target {
        Target::parse(&self.target)
    }
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
}

impl Issue {
    fn error(code: &'static str, arg: &str) -> Self {
        Self {
            level: "error",
            code,
            arg: shown_arg(arg),
        }
    }

    fn warn(code: &'static str) -> Self {
        Self {
            level: "warn",
            code,
            arg: String::new(),
        }
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

/// What a built-in base reference resolved to.
#[derive(Clone, Copy)]
pub(super) enum Base<'a> {
    None,
    Found(&'a [String]),
    Missing(&'a str),
}

#[derive(Debug, Default, Serialize)]
pub(super) struct Report {
    pub(super) ok: bool,
    // "snippet" | "sections"
    pub(super) mode: &'static str,
    pub(super) sections: usize,
    pub(super) own_hosts: bool,
    pub(super) any_protocol: bool,
    pub(super) issues: Vec<Issue>,
    // Final winws arguments before placeholder substitution (empty on error).
    pub(super) args: Vec<String>,
    #[serde(skip)]
    pub(super) bins: Vec<String>,
}

impl Report {
    pub(super) fn first_error(&self) -> Option<&Issue> {
        self.issues.iter().find(|issue| issue.is_error())
    }

    fn push(&mut self, issue: Issue) {
        if self.issues.len() < MAX_ISSUES && !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }
}

// ── Tokenizer ──────────────────────────────────────────────────────────

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
fn parse_options(tokens: &[String], report: &mut Report) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len());
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        i += 1;
        if !token.starts_with("--") {
            report.push(Issue::error("stray", token));
            continue;
        }
        let (flag, mut value) = match token.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (token.as_str(), None),
        };
        if !valid_flag_name(flag) {
            report.push(Issue::error("unknown", token));
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
            Ok(arg) => out.push(arg),
            Err(code) => report.push(Issue::error(code, &shown)),
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

const WRAP_PORTS: &str = "80,443";
const LIST_INCLUDES: [&str; 3] = [
    "--hostlist=%LISTS%list-general.txt",
    "--hostlist=%LISTS%list-general-user.txt",
    "--hostlist=%LISTS%list-google.txt",
];
const DOMAIN_EXCLUDES: [&str; 2] = [
    "--hostlist-exclude=%LISTS%list-exclude.txt",
    "--hostlist-exclude=%LISTS%list-exclude-user.txt",
];
const IP_EXCLUDES: [&str; 2] = [
    "--ipset-exclude=%LISTS%ipset-exclude.txt",
    "--ipset-exclude=%LISTS%ipset-exclude-user.txt",
];

/// A filterless snippet becomes one TCP 80/443 section. User exclusions are
/// kept; domain exclusions are left out only where they would make the
/// section skip traffic without a hostname, which "all traffic" with
/// any-protocol exists for.
fn wrap_snippet(
    user: Vec<String>,
    target: Target,
    own_hosts: bool,
    any_protocol: bool,
) -> Vec<String> {
    let mut out = vec![format!("--filter-tcp={WRAP_PORTS}")];
    let lists = target == Target::Lists && !own_hosts;
    if lists {
        out.extend(LIST_INCLUDES.iter().map(|arg| arg.to_string()));
    }
    let hostname_aware = user
        .iter()
        .any(|arg| matches!(flag_of(arg), "--hostlist" | "--hostlist-domains"));
    let mut extra: Vec<&str> = Vec::new();
    if lists || hostname_aware || !any_protocol {
        extra.extend(DOMAIN_EXCLUDES);
    }
    extra.extend(IP_EXCLUDES);
    for arg in extra {
        if !user.iter().any(|existing| existing == arg) {
            out.push(arg.to_string());
        }
    }
    out.extend(user);
    out
}

/// Derive the WinDivert ports from section filters when the user gave none.
/// Returns None when a section uses `*` or a negation: the interception set
/// can't be inferred then and must be spelled out with --wf-*.
fn derive_wf(options: &[String], flag: &str) -> Option<Vec<String>> {
    let mut ports = Vec::new();
    for arg in options {
        let Some(value) = value_of(arg, flag) else {
            continue;
        };
        if value
            .split(',')
            .any(|item| item == "*" || item.starts_with('~'))
        {
            return None;
        }
        push_ports(&mut ports, value);
    }
    Some(ports)
}

/// Build the final winws arguments of a custom strategy (before placeholder
/// substitution). `bin_exists` tells whether a payload file is present in the
/// active bin-data; launch-time callers that check files later pass `|_| true`.
pub(super) fn build(
    text: &str,
    target: Target,
    base: Base<'_>,
    bin_exists: &dyn Fn(&str) -> bool,
) -> Report {
    let mut report = Report {
        mode: "snippet",
        sections: 1,
        ..Report::default()
    };
    if text.len() > MAX_CUSTOM_TEXT_BYTES {
        report.push(Issue::error("tooLong", ""));
        return report;
    }
    let tokens = match tokenize(text).and_then(strip_launcher) {
        Ok(tokens) => tokens,
        Err(issue) => {
            report.push(issue);
            return report;
        }
    };
    if tokens.is_empty() {
        report.push(Issue::error("empty", ""));
        return report;
    }
    let options = parse_options(&tokens, &mut report);
    for name in report.bins.clone() {
        if !bin_exists(&name) {
            report.push(Issue::error("binMissing", &name));
        }
    }
    if let Base::Missing(id) = base {
        report.push(Issue::error("baseMissing", id));
    }
    if report.first_error().is_some() {
        return report;
    }

    let has = |flags: &[&str]| options.iter().any(|arg| flags.contains(&flag_of(arg)));
    report.any_protocol = options
        .iter()
        .any(|arg| arg == "--dpi-desync-any-protocol=1");
    report.own_hosts = has(&["--hostlist", "--hostlist-domains", "--ipset", "--ipset-ip"]);
    let sections_mode = has(&[
        "--new",
        "--filter-tcp",
        "--filter-udp",
        "--wf-tcp",
        "--wf-udp",
    ]);

    let mut wf_tcp = Vec::new();
    let mut wf_udp = Vec::new();
    let custom: Vec<String> = if sections_mode {
        report.mode = "sections";
        for (flag, into) in [("--wf-tcp", &mut wf_tcp), ("--wf-udp", &mut wf_udp)] {
            for arg in &options {
                if let Some(value) = value_of(arg, flag) {
                    push_ports(into, value);
                }
            }
        }
        let sections: Vec<String> = options
            .iter()
            .filter(|arg| !matches!(flag_of(arg), "--wf-tcp" | "--wf-udp"))
            .cloned()
            .collect();
        let mut current = 0usize;
        report.sections = 1;
        for arg in &sections {
            if arg == "--new" {
                if current == 0 {
                    report.push(Issue::error("emptySection", ""));
                }
                report.sections += 1;
                current = 0;
            } else {
                current += 1;
            }
        }
        if current == 0 {
            report.push(Issue::error("emptySection", ""));
        }
        for (wf, flag) in [(&mut wf_tcp, "--filter-tcp"), (&mut wf_udp, "--filter-udp")] {
            if wf.is_empty() {
                match derive_wf(&sections, flag) {
                    Some(ports) => *wf = ports,
                    None => report.push(Issue::error("wfNeeded", "")),
                }
            }
        }
        if wf_tcp.is_empty() && wf_udp.is_empty() {
            report.push(Issue::error("wfNeeded", ""));
        }
        sections
    } else {
        if !has(&["--dpi-desync"]) {
            report.push(Issue::error("noDesync", ""));
        }
        push_ports(&mut wf_tcp, WRAP_PORTS);
        wrap_snippet(options, target, report.own_hosts, report.any_protocol)
    };
    if report.first_error().is_some() {
        return report;
    }

    let mut base_sections = Vec::new();
    if let Base::Found(args) = base {
        for arg in args {
            if let Some(value) = value_of(arg, "--wf-tcp") {
                push_ports(&mut wf_tcp, value);
            } else if let Some(value) = value_of(arg, "--wf-udp") {
                push_ports(&mut wf_udp, value);
            } else {
                base_sections.push(arg.clone());
            }
        }
    }

    let mut args = Vec::with_capacity(custom.len() + base_sections.len() + 3);
    if !wf_tcp.is_empty() {
        args.push(format!("--wf-tcp={}", wf_tcp.join(",")));
    }
    if !wf_udp.is_empty() {
        args.push(format!("--wf-udp={}", wf_udp.join(",")));
    }
    args.extend(custom);
    if !base_sections.is_empty() {
        args.push("--new".to_string());
        args.extend(base_sections);
    }
    if args.len() > super::MAX_STRATEGY_ARGS {
        report.push(Issue::error("tooLong", ""));
        return report;
    }

    if report.mode == "snippet" {
        if target == Target::Lists && !report.own_hosts && report.any_protocol {
            report.push(Issue::warn("anyProtocolLists"));
        }
        if matches!(base, Base::None) {
            report.push(Issue::warn("noBase"));
        }
    }
    report.ok = true;
    report.args = args;
    report
}

/// Resolve the base reference against the active built-in set and build.
pub(super) fn build_strategy(
    item: &CustomStrategy,
    builtins: &[super::Strategy],
    bin_exists: &dyn Fn(&str) -> bool,
) -> Report {
    build(
        &item.text,
        item.target(),
        resolve_base(item.base.as_deref(), builtins),
        bin_exists,
    )
}

pub(super) fn resolve_base<'a>(base: Option<&'a str>, builtins: &'a [super::Strategy]) -> Base<'a> {
    match base.map(str::trim).filter(|id| !id.is_empty()) {
        None => Base::None,
        Some(id) => match builtins.iter().find(|s| s.id == id) {
            Some(strategy) => Base::Found(&strategy.args),
            None => Base::Missing(id),
        },
    }
}

// ── Names, ids and storage ─────────────────────────────────────────────

pub(super) fn is_custom_id(id: &str) -> bool {
    id.strip_prefix(CUSTOM_ID_PREFIX)
        .is_some_and(|rest| hex_digits(rest, 16))
}

/// Trim, collapse whitespace and drop control characters.
pub(super) fn normalize_name(raw: &str) -> Result<String, &'static str> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let name = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        Err("nameEmpty")
    } else if name.chars().count() > MAX_CUSTOM_NAME_CHARS {
        Err("nameLong")
    } else {
        Ok(name)
    }
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
/// edit must neither crash listing nor smuggle in more than the limit.
fn sanitize_store(store: CustomStore) -> CustomStore {
    let mut items: Vec<CustomStrategy> = Vec::new();
    for item in store.items {
        if items.len() >= MAX_CUSTOM_STRATEGIES {
            break;
        }
        let Ok(name) = normalize_name(&item.name) else {
            continue;
        };
        if !is_custom_id(&item.id)
            || item.text.len() > MAX_CUSTOM_TEXT_BYTES
            || items.iter().any(|known| known.id == item.id)
        {
            continue;
        }
        items.push(CustomStrategy {
            name,
            target: Target::parse(&item.target).as_str().to_string(),
            ..item
        });
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

/// One custom strategy as the UI lists it.
#[derive(Serialize)]
pub(super) struct ListItem<'a> {
    pub(super) id: &'a str,
    pub(super) name: &'a str,
    pub(super) custom: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) base: Option<&'a str>,
    pub(super) target: &'static str,
    pub(super) text: &'a str,
    // First blocking problem, if the strategy can't start as stored (for
    // example, its base left the channel set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) problem: Option<&'static str>,
}

pub(super) fn list_item<'a>(
    item: &'a CustomStrategy,
    builtins: &[super::Strategy],
) -> ListItem<'a> {
    let report = build_strategy(item, builtins, &|_| true);
    ListItem {
        id: &item.id,
        name: &item.name,
        custom: true,
        base: item.base.as_deref(),
        target: item.target().as_str(),
        text: &item.text,
        problem: report.first_error().map(|issue| issue.code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_bins(_: &str) -> bool {
        true
    }

    fn snippet(text: &str, target: Target) -> Report {
        build(text, target, Base::None, &all_bins)
    }

    const USER_EXAMPLE: &str = "--dpi-desync=fake --dpi-desync-any-protocol=1 --dpi-desync-fooling=ts --dpi-desync-repeats=6 --dpi-desync-cutoff=d2 --dpi-desync-fake-unknown=@tls_clienthello_max_ru.bin";

    #[test]
    fn user_example_wraps_into_all_traffic_section() {
        let report = snippet(USER_EXAMPLE, Target::All);
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.mode, "snippet");
        assert!(report.any_protocol);
        assert_eq!(
            report.args,
            vec![
                "--wf-tcp=80,443",
                "--filter-tcp=80,443",
                "--ipset-exclude=%LISTS%ipset-exclude.txt",
                "--ipset-exclude=%LISTS%ipset-exclude-user.txt",
                "--dpi-desync=fake",
                "--dpi-desync-any-protocol=1",
                "--dpi-desync-fooling=ts",
                "--dpi-desync-repeats=6",
                "--dpi-desync-cutoff=d2",
                "--dpi-desync-fake-unknown=%BIN%tls_clienthello_max_ru.bin",
            ]
        );
        assert_eq!(report.bins, vec!["tls_clienthello_max_ru.bin"]);
        // Without a base only this section runs: the UI warns about it.
        assert!(report.issues.iter().any(|i| i.code == "noBase"));
    }

    #[test]
    fn lists_target_gates_by_hostlists_and_warns_about_any_protocol() {
        let report = snippet(USER_EXAMPLE, Target::Lists);
        assert!(report.ok);
        assert!(report
            .args
            .contains(&"--hostlist=%LISTS%list-general-user.txt".to_string()));
        assert!(report
            .args
            .contains(&"--hostlist-exclude=%LISTS%list-exclude-user.txt".to_string()));
        assert!(report.issues.iter().any(|i| i.code == "anyProtocolLists"));
    }

    #[test]
    fn all_traffic_keeps_domain_exclusions_without_any_protocol() {
        let report = snippet("--dpi-desync=fake --dpi-desync-fooling=ts", Target::All);
        assert!(report.ok);
        assert!(report
            .args
            .contains(&"--hostlist-exclude=%LISTS%list-exclude.txt".to_string()));
    }

    #[test]
    fn base_sections_follow_custom_part_and_ports_merge() {
        let base = vec![
            "--wf-tcp=80,443,2053,%GameFilterTCP%".to_string(),
            "--wf-udp=443,%GameFilterUDP%".to_string(),
            "--filter-udp=443".to_string(),
            "--dpi-desync=fake".to_string(),
        ];
        let report = build(USER_EXAMPLE, Target::All, Base::Found(&base), &all_bins);
        assert!(report.ok);
        assert_eq!(report.args[0], "--wf-tcp=80,443,2053,%GameFilterTCP%");
        assert_eq!(report.args[1], "--wf-udp=443,%GameFilterUDP%");
        let new_at = report.args.iter().position(|a| a == "--new").unwrap();
        assert_eq!(&report.args[new_at + 1..], &base[2..]);
        assert!(!report.issues.iter().any(|i| i.code == "noBase"));
    }

    #[test]
    fn flowseal_bat_line_is_accepted() {
        let text = "start \"zapret: %~n0\" /min \"%BIN%winws.exe\" --wf-tcp=80,443 ^\n\
            --filter-tcp=443 --hostlist=\"%LISTS%list-general.txt\" --dpi-desync=fake,multisplit ^\n\
            --dpi-desync-split-pos=1,midsld --dpi-desync-fake-tls=\"%BIN%tls_clienthello_www_google_com.bin\" --new ^\n\
            --filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6";
        let report = snippet(text, Target::Lists);
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.mode, "sections");
        assert_eq!(report.sections, 2);
        assert_eq!(report.args[0], "--wf-tcp=80,443");
        // UDP interception is derived from the section filter.
        assert_eq!(report.args[1], "--wf-udp=443");
        assert!(report
            .args
            .contains(&"--hostlist=%LISTS%list-general.txt".to_string()));
    }

    #[test]
    fn space_separated_values_are_joined() {
        let report = snippet("--dpi-desync fake --dpi-desync-repeats 6", Target::Lists);
        assert!(report.ok, "{:?}", report.issues);
        assert!(report.args.contains(&"--dpi-desync-repeats=6".to_string()));
    }

    #[test]
    fn dangerous_and_unknown_options_are_rejected() {
        for (text, code) in [
            ("--dpi-desync=fake --debug=@C:\\Windows\\x.txt", "managed"),
            ("--dpi-desync=fake --wf-raw=@C:\\x", "managed"),
            ("--dpi-desync=fake --hostlist-auto=C:\\x.txt", "managed"),
            ("--dpi-desync=fake --pidfile=C:\\x", "managed"),
            ("--dpi-desync=fake --frobnicate=1", "unknown"),
            ("@C:\\config.txt", "stray"),
            ("--dpi-desync=fake --hostlist=C:\\Windows\\win.ini", "list"),
            (
                "--dpi-desync=fake --dpi-desync-fake-tls=C:\\Windows\\x.bin",
                "path",
            ),
            (
                "--dpi-desync=fake --dpi-desync-fake-tls=@..\\..\\x.bin",
                "path",
            ),
            (
                "--dpi-desync=fake --dpi-desync-fake-tls=@%LISTS%x.bin",
                "path",
            ),
            ("--dpi-desync=fake,multisplit,fake", "combo"),
            ("--dpi-desync=multisplit,fake", "combo"),
            ("--dpi-desync=nonsense", "value"),
            ("--dpi-desync=fake --dpi-desync-repeats=0", "value"),
            ("--dpi-desync=fake --dpi-desync-cutoff=x2", "value"),
            ("--dpi-desync-fooling=ts", "noDesync"),
            ("--dpi-desync=fake --dpi-desync-ttl", "noValue"),
            ("--dpi-desync=\"fake", "quote"),
        ] {
            let report = snippet(text, Target::Lists);
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
    fn missing_payload_and_base_are_reported() {
        let report = build(USER_EXAMPLE, Target::All, Base::None, &|_| false);
        assert_eq!(report.first_error().map(|i| i.code), Some("binMissing"));
        let report = build(USER_EXAMPLE, Target::All, Base::Missing("alt99"), &all_bins);
        assert_eq!(report.first_error().map(|i| i.code), Some("baseMissing"));
    }

    #[test]
    fn sections_need_derivable_interception() {
        let report = snippet("--filter-tcp=* --dpi-desync=fake", Target::Lists);
        assert_eq!(report.first_error().map(|i| i.code), Some("wfNeeded"));
        let report = snippet(
            "--wf-tcp=443 --filter-tcp=* --dpi-desync=fake",
            Target::Lists,
        );
        assert!(report.ok, "{:?}", report.issues);
        let report = snippet("--filter-tcp=443 --dpi-desync=fake --new", Target::Lists);
        assert_eq!(report.first_error().map(|i| i.code), Some("emptySection"));
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
            base: None,
            target: "weird".to_string(),
            text: "--dpi-desync=fake".to_string(),
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
        assert!(store.items.iter().all(|s| s.target == "lists"));
    }
}

#!/usr/bin/env python3
# Парсер .bat-стратегий → strategies.json для Ninety (DPI-обход).
# Каждый general*.bat запускает один winws.exe с длинной командой (чейны через
# --new, перенос строк через ^). Извлекаем аргументы в массив, плейсхолдеры
# %BIN%/%LISTS%/%GameFilter*% сохраняем — Rust подставит их при запуске.
#
# Использование (когда обновляется набор стратегий):
#   python3 gen_strategies.py <каталог-с-.bat> src-tauri/dpi/strategies.json
# Движок (winws.exe/WinDivert/.bin) обновляется отдельно — см. RELEASING/память.
import os, re, json, glob, sys

SRC = sys.argv[1]   # каталог с .bat (клон Flowseal)
OUT = sys.argv[2]   # путь к strategies.json

# Описания по семействам (RU). Базовые — из дизайн-референса.
DESC = {
    "general":   "Базовый профиль — split по SNI и подмена окна. Работает у большинства.",
    "alt":       "FakeTLS + disorder. Лёгкий вариант для мягких блокировок.",
    "alt2":      "Disorder с двойным сегментом. Чуть агрессивнее general.",
    "alt3":      "Split на 2 + fake. Для нестабильных провайдеров.",
    "alt4":      "FakeTLS mod + seqovl. Обходит фильтрацию по TLS-ClientHello.",
    "alt5":      "Multisplit по позициям SNI. Средняя нагрузка.",
    "alt6":      "Disorder + fake с TTL-автоподбором.",
    "alt7":      "FakeTLS auto + split-pos 1. Хорош для видео и голосовых сервисов.",
    "alt8":      "Двойной fake + seqovl. Тяжёлый DPI.",
    "alt9":      "Multidisorder + fake mod. Для глубокой инспекции.",
    "alt10":     "FakeTLS rnd + split SNI + padding. Универсальный тяжёлый.",
    "alt11":     "FakeTLS auto + multisplit + multidisorder. Самый стойкий профиль.",
    "alt12":     "ALT11 + IP-фрагментация. Для самых строгих сетей.",
    "fake_tls_auto":      "Автоподбор fake-ClientHello под целевой хост.",
    "fake_tls_auto_alt":  "FakeTLS auto, вариант с другим split.",
    "fake_tls_auto_alt2": "FakeTLS auto, агрессивный вариант 2.",
    "fake_tls_auto_alt3": "FakeTLS auto, агрессивный вариант 3.",
    "simple_fake":        "Минимальный fake-пакет. Самый быстрый, но слабее всех.",
    "simple_fake_alt":    "Simple fake, вариант с disorder.",
    "simple_fake_alt2":   "Simple fake, вариант 2.",
    "exp":                "Экспериментальный профиль 1.10. Проверяйте вручную перед постоянным использованием.",
}

# Автоканал подписывает результат этого парсера, а Ninety затем передаёт args
# elevated winws.exe. Поэтому BAT — не просто «текстовые данные»: неизвестный
# флаг может заставить winws писать файлы/включить debug и пересечь trust boundary.
# Разрешаем только нужную стратегическую поверхность, пути — строго через наши
# %BIN%/%LISTS%, всё новое fail-closed до review этого allowlist.
AUTO_PICK_IDS = {
    "general",
    *("alt" if i == 1 else f"alt{i}" for i in range(1, 13)),
    "fake_tls_auto",
    "fake_tls_auto_alt",
    "fake_tls_auto_alt2",
    "fake_tls_auto_alt3",
    "simple_fake",
    "simple_fake_alt",
    "simple_fake_alt2",
}

DESYNC_VALUES = {
    "fake",
    "fake,fakedsplit",
    "fake,hostfakesplit",
    "fake,multidisorder",
    "fake,multisplit",
    "hostfakesplit",
    "multisplit",
    "syndata",
    "syndata,multidisorder",
}
FOOLING_VALUES = {"badseq", "ts", "ts,md5sig"}
L7_VALUES = {"quic", "discord,stun", "discord,stun,unknown"}
BIN_FLAGS = {
    "--dpi-desync-fake-discord",
    "--dpi-desync-fake-http",
    "--dpi-desync-fake-quic",
    "--dpi-desync-fake-stun",
    "--dpi-desync-fake-unknown-udp",
    "--dpi-desync-split-seqovl-pattern",
}
LIST_VALUES = {
    "--hostlist": {
        "%LISTS%list-general.txt",
        "%LISTS%list-general-user.txt",
        "%LISTS%list-google.txt",
    },
    "--hostlist-exclude": {
        "%LISTS%list-exclude.txt",
        "%LISTS%list-exclude-user.txt",
    },
    "--ipset": {"%LISTS%ipset-all.txt"},
    "--ipset-exclude": {
        "%LISTS%ipset-exclude.txt",
        "%LISTS%ipset-exclude-user.txt",
    },
}
SAFE_BIN = re.compile(r"%BIN%[A-Za-z0-9._-]+\.bin\Z")
SAFE_DOMAIN = re.compile(
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}\Z"
)
SAFE_HEX = re.compile(r"0x[0-9A-Fa-f]{2,4096}\Z")

def bounded_int(value, low, high):
    return value.isascii() and value.isdigit() and low <= int(value) <= high

def valid_ports(value, placeholder):
    for part in value.split(","):
        if part == placeholder:
            continue
        m = re.fullmatch(r"(\d{1,5})(?:-(\d{1,5}))?", part)
        if not m:
            return False
        start = int(m.group(1))
        end = int(m.group(2) or start)
        if not (1 <= start <= end <= 65535):
            return False
    return True

def validate_arg(arg, stem):
    if len(arg) > 4096 or "\0" in arg or "\r" in arg or "\n" in arg:
        raise SystemExit(f"REJECT {stem}: oversized/control-character argument")
    flag, sep, value = arg.partition("=")
    if flag == "--new":
        ok = not sep
    elif not sep:
        ok = False
    elif flag == "--dpi-desync":
        ok = value in DESYNC_VALUES
    elif flag == "--dpi-desync-any-protocol":
        ok = value == "1"
    elif flag == "--dpi-desync-badseq-increment":
        ok = bounded_int(value, 0, 2_147_483_647)
    elif flag == "--dpi-desync-cutoff":
        ok = bool(re.fullmatch(r"n(?:[1-9]|[1-9]\d)", value))
    elif flag in BIN_FLAGS:
        ok = bool(SAFE_BIN.fullmatch(value))
    elif flag == "--dpi-desync-fake-tls":
        ok = value == "!" or bool(SAFE_BIN.fullmatch(value)) or bool(SAFE_HEX.fullmatch(value))
    elif flag == "--dpi-desync-fakedsplit-pattern":
        ok = bool(SAFE_HEX.fullmatch(value))
    elif flag == "--dpi-desync-fooling":
        ok = value in FOOLING_VALUES
    elif flag == "--dpi-desync-repeats":
        ok = bounded_int(value, 1, 1000)
    elif flag == "--dpi-desync-split-seqovl":
        ok = bounded_int(value, 0, 65535)
    elif flag == "--dpi-desync-split-pos":
        ok = bool(re.fullmatch(r"\d{1,5}(?:,(?:midsld|sniext\+\d{1,5}))?", value))
    elif flag == "--dpi-desync-fake-tls-mod":
        ok = value == "none" or bool(
            re.fullmatch(r"rnd,dupsid,sni=([A-Za-z0-9.-]+)", value)
            and SAFE_DOMAIN.fullmatch(value.rsplit("=", 1)[1])
        )
    elif flag == "--dpi-desync-hostfakesplit-mod":
        match = re.fullmatch(r"host=([A-Za-z0-9.-]+)(?:,altorder=1)?", value)
        ok = bool(match and SAFE_DOMAIN.fullmatch(match.group(1)))
    elif flag == "--filter-l3":
        ok = value == "ipv4"
    elif flag == "--filter-l7":
        ok = value in L7_VALUES
    elif flag == "--filter-tcp":
        ok = valid_ports(value, "%GameFilterTCP%")
    elif flag == "--filter-udp":
        ok = valid_ports(value, "%GameFilterUDP%")
    elif flag == "--wf-tcp":
        ok = valid_ports(value, "%GameFilterTCP%")
    elif flag == "--wf-udp":
        ok = valid_ports(value, "%GameFilterUDP%")
    elif flag in LIST_VALUES:
        ok = value in LIST_VALUES[flag]
    elif flag in {"--hostlist-domains", "--hostlist-exclude-domains"}:
        ok = all(SAFE_DOMAIN.fullmatch(domain) for domain in value.split(","))
    elif flag == "--ip-id":
        ok = value == "zero"
    else:
        ok = False
    if not ok:
        raise SystemExit(f"REJECT {stem}: unsafe/unknown winws argument {arg!r}")

def make_id(stem):
    # "general" → general; "general (ALT11)" → alt11;
    # "general (FAKE TLS AUTO ALT2)" → fake_tls_auto_alt2
    m = re.search(r"\(([^)]+)\)", stem)
    if not m:
        return "general", "general"
    inner = m.group(1).strip()
    sid = re.sub(r"[^a-z0-9]+", "_", inner.lower()).strip("_")
    return sid, inner   # name = как в скобках (ALT11, FAKE TLS AUTO ALT2)

def parse_args(text):
    # text — содержимое .bat. Берём команду от winws.exe" до конца блока start.
    i = text.find('winws.exe"')
    if i < 0:
        return None
    rest = text[i + len('winws.exe"'):]
    # склеиваем переносы ^\n, режем по строкам пока есть продолжение
    lines = rest.splitlines()
    buf = []
    for ln in lines:
        s = ln.rstrip()
        cont = s.endswith("^")
        if cont:
            s = s[:-1]
        buf.append(s)
        if not cont:
            break
    joined = " ".join(buf)
    # токенизация: пробелы вне кавычек; кавычки убираем (Command сам квотит)
    args = []
    for tok in re.findall(r'(?:[^\s"]|"[^"]*")+', joined):
        tok = tok.replace('"', "")
        # cmd-escape: внутри батника `^` экранирует следующий символ. В стратегиях
        # встречается только `^!` (значение fake-tls для авто-ClientHello при
        # enabledelayedexpansion) — winws должен получить литерал `!`, иначе
        # читает `^!` как путь к файлу и падает «could not read ^!».
        tok = tok.replace("^!", "!")
        if tok:
            args.append(tok)
    return args

strategies = []
for path in sorted(glob.glob(os.path.join(SRC, "general*.bat"))):
    stem = os.path.splitext(os.path.basename(path))[0]
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    args = parse_args(text)
    if not args:
        print(f"SKIP (нет winws): {stem}", file=sys.stderr)
        continue
    if len(args) > 512:
        raise SystemExit(f"REJECT {stem}: too many winws arguments ({len(args)})")
    for arg in args:
        validate_arg(arg, stem)
    sid, name = make_id(stem)
    strategies.append({
        "id": sid,
        "name": name,
        "desc": DESC.get(sid, "Профиль обхода DPI на движке winws."),
        # Любая новая upstream-стратегия остаётся ручной, пока мы явно не
        # рассмотрим её и не добавим id в проверенный auto-pick набор.
        "experimental": sid not in AUTO_PICK_IDS,
        "args": args,
    })

ids = [strategy["id"] for strategy in strategies]
if len(ids) != len(set(ids)):
    raise SystemExit("REJECT: duplicate strategy ids")
missing = sorted(AUTO_PICK_IDS - set(ids))
if missing:
    raise SystemExit("REJECT: required strategies missing: " + ", ".join(missing))
if len(strategies) > 64:
    raise SystemExit(f"REJECT: too many strategies ({len(strategies)})")

# Сортировка: general, ALT…, FAKE TLS…, SIMPLE FAKE…
def sortkey(s):
    order = {"general": 0}
    base = 5
    if s["id"] == "general": return (0, 0)
    if s["id"].startswith("fake_tls"): return (2, s["id"])
    if s["id"].startswith("simple_fake"): return (3, s["id"])
    # alt, alt2..alt12
    m = re.match(r"alt(\d*)$", s["id"])
    if m:
        return (1, int(m.group(1) or "1"))
    return (4, s["id"])
strategies.sort(key=sortkey)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(strategies, f, ensure_ascii=False, indent=1)
print(f"OK: {len(strategies)} стратегий → {OUT}")
for s in strategies:
    print(f"  {s['id']:24} ({len(s['args'])} args)  {s['name']}")

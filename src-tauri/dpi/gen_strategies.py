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
}

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
    sid, name = make_id(stem)
    strategies.append({
        "id": sid,
        "name": name,
        "desc": DESC.get(sid, "Профиль обхода DPI на движке winws."),
        "args": args,
    })

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

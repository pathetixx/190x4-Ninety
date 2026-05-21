# Ninety

Кастомный VPN-клиент под Windows в эстетике [190x4](https://190x4.pw).
Tauri 2 (Rust + WebView2) поверх [sing-box](https://github.com/SagerNet/sing-box).

> Дизайн-язык вынесен из [hub190x4-app](https://github.com/pathetixx/hub190x4-app) (Android-приложения): Liquid-Glass на тёмном багровом фоне, системный sans в теле, Orbitron — только в лого и мелких капс-метках.

## Статус

🚧 В разработке. Первая сборка — скелет окна.

## Стек

- **UI:** Tauri 2.x (frameless, кастомный titlebar) + vanilla HTML/CSS/JS
- **VPN-движок:** [sing-box](https://github.com/SagerNet/sing-box) (bundled, запускается subprocess'ом)
- **Протоколы:** VLESS / Reality / XHTTP / VMess / Trojan / Shadowsocks / Hysteria2 / TUIC
- **Режимы:** системный прокси + TUN (WinTun, UAC при включении)
- **Сборка:** GitHub Actions → `.msi` / `.exe` в Releases

## Сборка локально

Требуется: Rust stable, Node ≥18, MSVC build tools.

```powershell
npm install
npm run tauri dev   # dev-окно
npm run tauri build # релиз .msi
```

## Лицензия

[MIT](./LICENSE).

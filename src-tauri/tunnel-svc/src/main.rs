#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("ninety-tunnel-svc собирается и запускается только под Windows");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
mod consts;
#[cfg(target_os = "windows")]
mod logging;
#[cfg(target_os = "windows")]
mod scm;
#[cfg(target_os = "windows")]
mod singbox;
#[cfg(target_os = "windows")]
mod ipc;
#[cfg(target_os = "windows")]
mod runner;

#[cfg(target_os = "windows")]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");

    let code = match cmd {
        "install" => match scm::install() {
            Ok(()) => {
                println!("OK");
                0
            }
            Err(e) => {
                eprintln!("install failed: {e}");
                1
            }
        },
        "uninstall" => match scm::uninstall() {
            Ok(()) => {
                println!("OK");
                0
            }
            Err(e) => {
                eprintln!("uninstall failed: {e}");
                1
            }
        },
        "status" => match scm::status() {
            Ok(s) => {
                println!("{s}");
                0
            }
            Err(e) => {
                eprintln!("status failed: {e}");
                1
            }
        },
        "run" => match runner::run_as_service() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("run failed: {e}");
                1
            }
        },
        "" | "--help" | "-h" => {
            println!(
                "ninety-tunnel-svc — Windows-сервис, управляющий sing-box в TUN-режиме.\n\
                 \n\
                 Команды:\n  \
                 install     зарегистрировать службу {name} (требует admin)\n  \
                 uninstall   остановить и удалить службу (требует admin)\n  \
                 status      вывести состояние службы\n  \
                 run         внутренний запуск через SCM (не вызывать вручную)",
                name = consts::SERVICE_NAME
            );
            0
        }
        other => {
            eprintln!("Неизвестная команда: {other}. Используйте --help.");
            2
        }
    };
    std::process::exit(code);
}

// Ninety · Job Object как последний рубеж жизненного цикла движков.
//
// Штатная остановка ядра и мостов идёт через stop_singbox/force_cleanup: PID
// сверяется по времени создания, порты ждут освобождения bind-пробой. Всё это
// работает изнутри ЖИВОГО Ninety. Если процесс убили из диспетчера, он словил
// OOM или упал так, что не дошёл даже до panic-hook, дети остаются жить:
// sing-box продолжает гнать трафик, а фиксированные порты (mixed 7890, clash
// 9090) держатся занятыми — следующий старт падает «address already in use».
// Мостовые порты подбираются свободными, поэтому их сирота не блокирует, но
// сам мост тоже переживает родителя.
//
// Job Object с KILL_ON_JOB_CLOSE закрывает это на уровне ядра Windows: когда
// закрывается последний хэндл job'а — а он закрывается при смерти процесса,
// какой бы она ни была, — ОС уничтожает все назначенные процессы.
//
// Хэндл ОБЯЗАН жить всё время работы приложения: закрытие раньше немедленно
// убьёт уже назначенные движки. Поэтому он лежит в OnceLock, наружу не
// отдаётся и никогда не закрывается явно — его освобождает выход процесса.
//
// Job безымянный намеренно: именованный шарился бы между инстансами (portable
// рядом с установленной сборкой), и выход одного гасил бы движки другого.
//
// Назначаем по PID, а не по хэндлу child: движки ядра запускаются через
// tauri-plugin-shell, чей CommandChild отдаёт наружу только pid() — хэндла
// процесса у него нет. Тот же путь, что у prioritize_datapath_process.

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// Владелец хэндла job'а. HANDLE не Send/Sync, но этот конкретный хэндл
    /// неизменяем после создания и живёт до конца процесса.
    struct Job(HANDLE);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn create() -> Result<Job, String> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|error| format!("CreateJobObjectW: {error}"))?;
            // Через структуру целиком, а не присваиванием поля после default():
            // clippy::field_reassign_with_default гейтит сборку.
            let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    ..Default::default()
                },
                ..Default::default()
            };
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if let Err(error) = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                size,
            ) {
                // Job без KILL_ON_JOB_CLOSE бесполезен и при этом продолжал бы
                // собирать в себя движки — закрываем сразу.
                let _ = CloseHandle(handle);
                return Err(format!("SetInformationJobObject: {error}"));
            }
            Ok(Job(handle))
        }
    }

    /// Создаёт job один раз за жизнь процесса. Неудача не фатальна: движки
    /// просто остаются без страховки, как было до этого механизма.
    pub fn init() {
        JOB.get_or_init(|| match create() {
            Ok(job) => Some(job),
            Err(error) => {
                eprintln!("process job object unavailable: {error}");
                None
            }
        });
    }

    /// Назначает уже запущенный движок в job. Вызывается сразу после spawn.
    /// Ошибку только логируем: процесс уже работает, и отменять из-за
    /// отсутствия страховки рабочее подключение незачем.
    pub fn bind_pid(pid: u32) {
        let Some(Some(job)) = JOB.get() else {
            return;
        };
        unsafe {
            // PROCESS_SET_QUOTA | PROCESS_TERMINATE — минимум, который требует
            // AssignProcessToJobObject.
            match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
                Ok(handle) => {
                    if let Err(error) = AssignProcessToJobObject(job.0, handle) {
                        eprintln!("job assign failed for pid {pid}: {error}");
                    }
                    let _ = CloseHandle(handle);
                }
                Err(error) => eprintln!("job open failed for pid {pid}: {error}"),
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn init() {}

    pub fn bind_pid(_pid: u32) {}
}

pub use imp::{bind_pid, init};

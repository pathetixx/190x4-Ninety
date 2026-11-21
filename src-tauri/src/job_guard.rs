// Ninety · Job Object as the last line of defense in the engine lifecycle.
//
// Regular shutdown of the core and bridges goes through stop_singbox/force_cleanup: the PID
// is matched by creation time, ports are waited on with a bind probe. All of this
// works from inside a LIVE Ninety. If the process was killed from Task Manager, hit
// OOM or crashed so hard it didn't even reach the panic hook, the children keep living:
// sing-box keeps pushing traffic, and the fixed ports (mixed 7890, clash
// 9090) stay occupied — the next start fails with "address already in use".
// Bridge ports are picked from free ones, so their orphan doesn't block, but
// the bridge itself also outlives the parent.
//
// A Job Object with KILL_ON_JOB_CLOSE closes this at the Windows kernel level: when
// the job's last handle is closed — and it is closed when the process dies,
// however that happens — the OS destroys all assigned processes.
//
// The handle MUST live for the whole app run: closing it earlier would immediately
// kill the already assigned engines. So it sits in a OnceLock, is never
// handed out and never closed explicitly — process exit frees it.
//
// The job is deliberately unnamed: a named one would be shared between instances (portable
// next to an installed build), and one exiting would kill the other's engines.
//
// 🔴 Ninety.exe itself is NOT in the job and must not be. Membership is inherited
// by children: if the controller got in there, a new elevated instance on restart via
// UAC would inherit the job, the old process would do exit(0), the last handle would close —
// and Windows would kill the freshly started instance. For the same reason the OTA installer
// and Mullvad Browser stay outside the job: they must survive the exit.
//
// We assign by PID, not by the child handle: the core engines are launched via
// tauri-plugin-shell, whose CommandChild only exposes pid() — it has no
// process handle. The same path as prioritize_datapath_process.

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

    /// Owner of the job handle. HANDLE is not Send/Sync, but this particular handle
    /// is immutable after creation and lives until the end of the process.
    struct Job(HANDLE);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn create() -> Result<Job, String> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|error| format!("CreateJobObjectW: {error}"))?;
            // Through the whole struct, not by assigning a field after default():
            // clippy::field_reassign_with_default gates the build.
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
                // A job without KILL_ON_JOB_CLOSE is useless and would still keep
                // collecting engines — close it right away.
                let _ = CloseHandle(handle);
                return Err(format!("SetInformationJobObject: {error}"));
            }
            Ok(Job(handle))
        }
    }

    /// Creates the job once per process lifetime. Failure isn't fatal: the engines
    /// simply stay without the safety net, as before this mechanism existed.
    pub fn init() {
        JOB.get_or_init(|| match create() {
            Ok(job) => Some(job),
            Err(error) => {
                eprintln!("process job object unavailable: {error}");
                None
            }
        });
    }

    /// Assigns an already running engine to the job. Called right after spawn.
    /// The error is only logged: the process is already running, and there is no reason to cancel
    /// a working connection over a missing safety net.
    pub fn bind_pid(pid: u32) {
        let Some(Some(job)) = JOB.get() else {
            return;
        };
        unsafe {
            // PROCESS_SET_QUOTA | PROCESS_TERMINATE — the minimum required by
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

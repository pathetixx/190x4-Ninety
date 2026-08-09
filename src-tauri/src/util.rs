// Ninety · мелкие общие утилиты бэкенда.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Взятие std-мьютекса с восстановлением после отравления.
///
/// `Mutex::lock().unwrap()` паникует, если поток запаниковал, держа этот лок
/// (poisoning). У нас за такими локами живут хэндлы процессов-движков
/// (sing-box/xray/winws), флаги смерти и WFP-хэндл: одна паника под локом
/// отравила бы мьютекс, и КАЖДАЯ последующая команда с этим `State` тоже
/// паниковала бы на `.unwrap()` — приложение «залипало» бы без внятной причины
/// (ядро не остановить, kill switch не снять). Данные под нашими локами при этом
/// консистентны (короткие критические секции без инвариант-ломающих паник), так
/// что продолжить с восстановленным guard'ом безопаснее, чем ронять всё.
pub trait MutexExt<T> {
    /// Как `lock().unwrap()`, но при отравлении возвращает guard, а не паникует.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Абсолютный путь к системному каталогу Windows (`...\System32`).
///
/// `%SystemRoot%` — переменная окружения процесса, и писать её может в том числе
/// `HKCU\Environment`, то есть обычный пользователь без прав администратора.
/// Отсюда берутся пути к `schtasks.exe`, `sc.exe`, `taskkill.exe` и
/// `powershell.exe`, которые запускаются через `runas`: подменённая переменная
/// превращала бы UAC-подтверждение пользователя в запуск чужого бинаря от
/// администратора. `GetSystemDirectoryW` окружение не читает.
#[cfg(target_os = "windows")]
pub fn system_directory() -> std::path::PathBuf {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if len == 0 || len > buffer.len() {
        return std::path::PathBuf::from(r"C:\Windows\System32");
    }
    std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..len]))
}

fn checked_body_len(current: usize, incoming: usize, max_bytes: usize) -> Result<usize, String> {
    let next = current
        .checked_add(incoming)
        .ok_or_else(|| "HTTP response size overflow".to_string())?;
    if next > max_bytes {
        return Err(format!("HTTP response exceeds {max_bytes} bytes"));
    }
    Ok(next)
}

/// Читает HTTP body потоково с реальным лимитом, не доверяя Content-Length.
pub async fn read_response_capped(
    mut response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if let Some(len) = response.content_length() {
        if len > max_bytes as u64 {
            return Err(format!("{label}: response exceeds {max_bytes} bytes"));
        }
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("{label}: body read: {e}"))?
    {
        checked_body_len(body.len(), chunk.len(), max_bytes)
            .map_err(|e| format!("{label}: {e}"))?;
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn read_response_text_capped(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let body = read_response_capped(response, max_bytes, label).await?;
    String::from_utf8(body).map_err(|e| format!("{label}: invalid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_size_guard_rejects_overflow_and_limit_excess() {
        assert_eq!(checked_body_len(10, 5, 20).unwrap(), 15);
        assert!(checked_body_len(10, 11, 20).is_err());
        assert!(checked_body_len(usize::MAX, 1, usize::MAX).is_err());
    }
}

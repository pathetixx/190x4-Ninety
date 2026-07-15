// Ninety · секреты на диске: DPAPI-обёртка (Windows, user-scope).
//
// warp.json (приватный WG-ключ, access_token CF) и state-backup.json (снапшот
// localStorage: URL подписок, UUID/пароли нод) лежали в app_config_dir открытым
// текстом — вразрез с политикой vpn.rs (purge_* стирает креды движков после
// сессии). Шифруем через CryptProtectData: прозрачно для юзера, без мастер-
// пароля, ключ привязан к Windows-аккаунту (расшифровать может только этот же
// юзер на этой же машине). Легаси-файлы (plaintext-JSON) читаются как есть —
// детект по первому непробельному байту '{' (DPAPI-блоб начинается с байта
// версии 0x01, коллизий нет); перешифровка — при следующей записи файла.
//
// Full Portable: passthrough, потому что DPAPI привязал бы переносимый каталог
// к одному Windows-пользователю и сломал бы профили/WARP на другом ПК. Это не
// ослабляет уже существующий localStorage: он и так лежит в переносимом профиле
// WebView2. README явно предупреждает защищать NinetyData как чувствительные
// пользовательские данные. Не-Windows (dev-стенд): тоже passthrough.

pub fn seal_for_app(_app: &tauri::AppHandle, data: &[u8]) -> Result<Vec<u8>, String> {
    if crate::app_paths::is_portable() {
        Ok(data.to_vec())
    } else {
        seal(data)
    }
}

/// true если содержимое — легаси plaintext-JSON (не DPAPI-блоб).
pub fn is_plaintext_json(bytes: &[u8]) -> bool {
    bytes.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'{')
}

#[cfg(target_os = "windows")]
pub fn seal(data: &[u8]) -> Result<Vec<u8>, String> {
    win::protect(data)
}
#[cfg(target_os = "windows")]
pub fn unseal(data: &[u8]) -> Result<Vec<u8>, String> {
    win::unprotect(data)
}

#[cfg(not(target_os = "windows"))]
pub fn seal(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}
#[cfg(not(target_os = "windows"))]
pub fn unseal(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    // Входной блоб API. pbData объявлен *mut, но на вход API не пишет —
    // const-cast безопасен.
    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    // Копирует выходной блоб в Vec и освобождает LocalAlloc-память API.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        v
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut out: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            CryptProtectData(
                &blob(data),
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| format!("CryptProtectData: {e}"))?;
            Ok(take(out))
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut out: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            CryptUnprotectData(
                &blob(data),
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| format!("CryptUnprotectData: {e}"))?;
            Ok(take(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_json_detection() {
        assert!(is_plaintext_json(b"{\"a\":1}"));
        assert!(is_plaintext_json(b"  \n\t{}"));
        assert!(!is_plaintext_json(b"\x01\x00\x00\x00blob"));
        assert!(!is_plaintext_json(b""));
    }

    #[test]
    fn seal_unseal_roundtrip() {
        let secret = b"{\"private_key\":\"abc\"}";
        let sealed = seal(secret).expect("seal");
        // На Windows блоб не должен выглядеть как plaintext-JSON.
        #[cfg(target_os = "windows")]
        assert!(!is_plaintext_json(&sealed));
        let opened = unseal(&sealed).expect("unseal");
        assert_eq!(opened, secret);
    }
}

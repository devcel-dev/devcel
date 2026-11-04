//! Existing owner-only filesystem helpers shared by sessions and write locks.
use std::{fs, io, path::Path};
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Local session authentication unavailable or rejected",
    )
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    extern "C" {
        fn geteuid() -> u32;
    }
    pub(crate) fn owner_key() -> io::Result<String> {
        Ok(unsafe { geteuid() }.to_string())
    }
    pub(crate) fn create_directory(path: &Path) -> io::Result<()> {
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    pub(crate) fn create_file(path: &Path) -> io::Result<fs::File> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
    }
    pub(crate) fn verify(path: &Path, directory: bool) -> io::Result<()> {
        let meta = fs::symlink_metadata(path)?;
        // No group/world access; the file is never repaired in place.
        if meta.uid() != unsafe { geteuid() }
            || meta.mode() & 0o777 != if directory { 0o700 } else { 0o600 }
        {
            return Err(denied());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
    };
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL},
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
                    ConvertStringSecurityDescriptorToSecurityDescriptorW,
                },
                GetFileSecurityW, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
                OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
                TOKEN_USER,
            },
            Storage::FileSystem::{
                CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(HLOCAL(self.0));
            }
        }
    }
    fn error(_: windows::core::Error) -> io::Error {
        denied()
    }
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    fn descriptor() -> io::Result<Local> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(error)?;
            let result = (|| {
                let mut required = 0;
                let _ = GetTokenInformation(token, TokenUser, None, 0, &mut required);
                if required == 0 {
                    return Err(denied());
                }
                let mut buffer =
                    vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
                GetTokenInformation(
                    token,
                    TokenUser,
                    Some(buffer.as_mut_ptr().cast()),
                    required,
                    &mut required,
                )
                .map_err(error)?;
                let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
                let mut sid = PWSTR::null();
                ConvertSidToStringSidW(user.User.Sid, &mut sid).map_err(error)?;
                let allocation = Local(sid.0.cast());
                let sid = sid.to_string().map_err(|_| denied())?;
                let text: Vec<u16> = format!("O:{sid}D:P(A;;FA;;;{sid})")
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let mut descriptor = PSECURITY_DESCRIPTOR::default();
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(text.as_ptr()),
                    1,
                    &mut descriptor,
                    None,
                )
                .map_err(error)?;
                drop(allocation);
                Ok(Local(descriptor.0))
            })();
            let _ = CloseHandle(token);
            result
        }
    }
    unsafe fn text(descriptor: PSECURITY_DESCRIPTOR) -> io::Result<String> {
        let mut output = PWSTR::null();
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            1,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut output,
            None,
        )
        .map_err(error)?;
        let allocation = Local(output.0.cast());
        let text = output.to_string().map_err(|_| denied())?;
        drop(allocation);
        Ok(text)
    }
    pub(crate) fn owner_key() -> io::Result<String> {
        let descriptor = descriptor()?;
        // This string contains the current user's SID, not a process-specific address.
        unsafe { text(PSECURITY_DESCRIPTOR(descriptor.0)) }
    }
    pub(crate) fn verify(path: &Path, _: bool) -> io::Result<()> {
        let path = wide(path);
        let expected = descriptor()?;
        unsafe {
            let mut required = 0;
            let flags = (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION).0;
            let _ = GetFileSecurityW(
                PCWSTR(path.as_ptr()),
                flags,
                PSECURITY_DESCRIPTOR::default(),
                0,
                &mut required,
            );
            if required == 0 {
                return Err(denied());
            }
            let mut buffer =
                vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
            GetFileSecurityW(
                PCWSTR(path.as_ptr()),
                flags,
                PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast()),
                required,
                &mut required,
            )
            .ok()
            .map_err(error)?;
            if text(PSECURITY_DESCRIPTOR(buffer.as_mut_ptr().cast()))?
                != text(PSECURITY_DESCRIPTOR(expected.0))?
            {
                return Err(denied());
            }
        }
        Ok(())
    }
    pub(crate) fn create_directory(path: &Path) -> io::Result<()> {
        let descriptor = descriptor()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let path = wide(path);
        unsafe {
            CreateDirectoryW(PCWSTR(path.as_ptr()), Some(&attributes))
                .map_err(|e| io::Error::from_raw_os_error(e.code().0 & 0xffff))
        }
    }
    pub(crate) fn create_file(path: &Path) -> io::Result<fs::File> {
        let descriptor = descriptor()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let path = wide(path);
        let handle = unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                0x40000000,
                FILE_SHARE_MODE(7),
                Some(&attributes),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
            .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?
        };
        Ok(unsafe { fs::File::from_raw_handle(handle.0) })
    }
}

pub(crate) use platform::{create_directory, create_file, owner_key, verify};
